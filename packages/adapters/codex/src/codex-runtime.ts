import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createApprovalGate, invalid, unavailable } from '@agent-hub/domain';
import type {
  AgentRuntime,
  ApprovalDecision,
  DomainError,
  McpLaunch,
  PromptInput,
  Result,
  RuntimeOption,
  RuntimeSession,
  SessionAssets,
  SessionEvent,
  StartSpec
} from '@agent-hub/domain';
import { CODEX_CLIENT_VERSION, JsonRpcPeer } from './jsonrpc.ts';
import { createCodexEventMapper } from './map-event.ts';
import {
  CODEX_APPROVALS,
  CODEX_EFFORTS,
  CODEX_SANDBOXES,
  codexDescriptorFor,
  codexOptions,
  defaultCodexSettings,
  type CodexSettings
} from './descriptor.ts';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

const HANDSHAKE_TIMEOUT_MS = 30_000;
const TURN_START_TIMEOUT_MS = 30_000;
const INTERRUPT_TIMEOUT_MS = 5_000;
const TERM_GRACE_MS = 3_000;
const KILL_GRACE_MS = 2_000;

export interface CodexRuntimeOptions {
  /** `codex` 或 `CODEX_COMMAND` 解析出来的绝对路径。 */
  readonly command?: string;
  /** 默认 `['app-server']`；测试用 `[fake-app-server.mjs]` 顶掉。 */
  readonly args?: readonly string[];
  readonly models?: readonly string[];
  readonly defaultModel?: string;
  readonly defaultEffort?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly onAgentSessionRef?: (sessionId: string, ref: string) => void;
  readonly onOptions?: (sessionId: string, options: readonly RuntimeOption[]) => void;
}

export function createCodexRuntime(options: CodexRuntimeOptions = {}): AgentRuntime {
  const command = options.command ?? 'codex';
  const args = [...(options.args ?? ['app-server'])];
  const models = options.models ?? [];
  const defaultModel = options.defaultModel ?? (models[0] ?? '');
  const descriptor = codexDescriptorFor(models, defaultModel, { effort: options.defaultEffort ?? '' });

  return {
    descriptor,
    async start(spec: StartSpec): Promise<Result<RuntimeSession, DomainError>> {
      if (spec.provider !== undefined) {
        return failed(invalid('Codex 暂时不支持 hub 模型提供商，请用 opencode / pi'));
      }
      if (spec.branch !== undefined) {
        return failed(invalid('Codex 没有从某条消息分叉的原生接口，换个新会话吧'));
      }

      const settings = defaultCodexSettings({
        model: defaultModel,
        effort: options.defaultEffort === undefined || options.defaultEffort === '' ? 'medium' : options.defaultEffort
      });
      let effortChosen = false;
      for (const [id, value] of Object.entries(spec.options)) {
        const error = applyCodexOption(settings, models, id, value);
        if (error !== null) return failed(error);
        if (id === 'effort') effortChosen = true;
      }

      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(command, args, {
          cwd: spec.workspaceRoot,
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
          env: { ...process.env, ...(options.env ?? {}) }
        });
      } catch (error) {
        return failed(unavailable(`无法启动 codex：${errorText(error)}`));
      }

      const spawnFailure = await waitForSpawn(child);
      if (spawnFailure !== null) {
        try {
          child.kill('SIGKILL');
        } catch {
          // 进程没起来，杀不掉也无所谓
        }
        return failed(unavailable(`无法启动 codex：${spawnFailure.message}`));
      }

      const session = new CodexSession({
        spec,
        child,
        models,
        settings,
        effortChosen,
        ...(options.onAgentSessionRef === undefined ? {} : { onAgentSessionRef: options.onAgentSessionRef }),
        ...(options.onOptions === undefined ? {} : { onOptions: options.onOptions })
      });
      const initialized = await session.initialize();
      if (!initialized.ok) {
        await session.dispose();
        return initialized;
      }
      return { ok: true, value: session };
    }
  };
}

interface CodexSessionOptions {
  readonly spec: StartSpec;
  readonly child: ChildProcessWithoutNullStreams;
  readonly models: readonly string[];
  readonly settings: CodexSettings;
  readonly effortChosen: boolean;
  readonly onAgentSessionRef?: (sessionId: string, ref: string) => void;
  readonly onOptions?: (sessionId: string, options: readonly RuntimeOption[]) => void;
}

interface ApprovalBinding {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly respond: (result: unknown) => void;
}

class CodexSession implements RuntimeSession {
  readonly sessionId: StartSpec['sessionId'];
  private readonly spec: StartSpec;
  private readonly models: readonly string[];
  private readonly settings: CodexSettings;
  private effortChosen: boolean;
  private readonly onAgentSessionRef: CodexSessionOptions['onAgentSessionRef'];
  private readonly onOptions: CodexSessionOptions['onOptions'];
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly peer: JsonRpcPeer;
  private readonly gate: ReturnType<typeof createApprovalGate>;
  private readonly queue = new EventQueue();
  private readonly mapper = createCodexEventMapper();
  private readonly approvalBindings = new Map<string, ApprovalBinding>();
  private readonly exited: Promise<void>;
  private approvalSeq = 0;
  private threadId = '';
  private activeTurn: string | null = null;
  private turnEnded = false;
  private disposed = false;
  private ended = false;
  private lastStderr = '';

  constructor(options: CodexSessionOptions) {
    this.sessionId = options.spec.sessionId;
    this.spec = options.spec;
    this.models = options.models;
    this.settings = options.settings;
    this.effortChosen = options.effortChosen;
    this.onAgentSessionRef = options.onAgentSessionRef;
    this.onOptions = options.onOptions;
    this.child = options.child;
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.lastStderr = `${this.lastStderr}${chunk}`.slice(-2000);
    });
    this.child.stdin.on('error', () => undefined);
    this.child.on('error', (error) => {
      this.lastStderr = `${this.lastStderr}\n${error.message}`.trim().slice(-2000);
    });
    this.exited = new Promise<void>((resolve) => {
      this.child.once('exit', () => resolve());
    });
    this.peer = new JsonRpcPeer({
      input: this.child.stdout,
      output: this.child.stdin,
      onNotification: (method, params) => this.handleNotification(method, params),
      onRequest: (method, params, respond, respondError) => this.handleServerRequest(method, params, respond, respondError)
    });
    this.gate = createApprovalGate({
      push: (event) => this.push(event),
      send: (id, decision) => this.replyApproval(id, decision)
    });
    this.child.once('exit', (code) => {
      void this.handleExit(code);
    });
  }

  async initialize(): Promise<Result<void, DomainError>> {
    try {
      await this.peer.request(
        'initialize',
        { clientInfo: { name: 'agent-hub', version: CODEX_CLIENT_VERSION }, capabilities: {} },
        HANDSHAKE_TIMEOUT_MS
      );
    } catch (error) {
      return failed(unavailable(`codex 握手失败：${this.withStderr(errorText(error))}`));
    }
    this.peer.notify('initialized');

    const spec = this.spec;
    const base = this.threadParams(spec);
    const resumeRef = spec.resume?.agentSessionRef ?? '';
    try {
      const response =
        resumeRef === ''
          ? await this.peer.request('thread/start', { ...base, ephemeral: false }, HANDSHAKE_TIMEOUT_MS)
          : await this.peer.request('thread/resume', { ...base, threadId: resumeRef }, HANDSHAKE_TIMEOUT_MS);
      const responseRecord = asRecord(response);
      const threadId = textOf(asRecord(responseRecord['thread'])['id']);
      if (threadId === '') return failed(unavailable('codex 没有返回会话 id'));
      this.threadId = threadId;
      const model = textOf(responseRecord['model']);
      if (this.settings.model === '' && model !== '') this.settings.model = model;
      this.onAgentSessionRef?.(spec.sessionId, threadId);
      this.onOptions?.(spec.sessionId, this.options());
      return { ok: true, value: undefined };
    } catch (error) {
      if (resumeRef !== '' && isMissingThread(error)) {
        return failed(invalid('这条会话在 Codex 里已经不存在了，换个新会话吧'));
      }
      const action = resumeRef === '' ? '建会话' : '恢复会话';
      return failed(unavailable(`codex ${action}失败：${this.withStderr(errorText(error))}`));
    }
  }

  async prompt(input: PromptInput): Promise<Result<void, DomainError>> {
    if (this.disposed || this.ended) return failed(unavailable('这条 Codex 会话已经结束了'));
    if (input.parts.length > 0) return failed(invalid('Codex 适配器暂时不支持附件，先把文字发过来'));
    if (input.text.trim() === '') return failed(invalid('消息不能为空'));
    if (this.activeTurn !== null) return failed(invalid('上一轮还没跑完，等它结束再发'));
    this.turnEnded = false;
    try {
      const response = await this.peer.request('turn/start', this.turnParams(input.text), TURN_START_TIMEOUT_MS);
      const turnId = textOf(asRecord(asRecord(response)['turn'])['id']);
      if (turnId !== '') this.activeTurn = turnId;
      return { ok: true, value: undefined };
    } catch (error) {
      return failed(unavailable(`codex 没能开始这一轮：${this.withStderr(errorText(error))}`));
    }
  }

  async interrupt(): Promise<void> {
    if (this.disposed || this.ended || this.activeTurn === null) return;
    // schema 里 turn/interrupt 的 threadId / turnId 都是必填（设计文档写的是 turnId 可选）。
    try {
      await this.peer.request(
        'turn/interrupt',
        { threadId: this.threadId, turnId: this.activeTurn },
        INTERRUPT_TIMEOUT_MS
      );
    } catch {
      // 进程已经没了 / 打断失败：交给 dispose 和 exit 处理
    }
  }

  events(): AsyncIterable<SessionEvent> {
    return this.queue;
  }

  async adopt(): Promise<void> {
    // Codex thread 自带完整历史；cursor 由 hub 记，运行时不需要追。
  }

  options(): readonly RuntimeOption[] {
    return codexOptions(this.models, this.settings);
  }

  async changeOption(id: string, value: string | boolean): Promise<Result<readonly RuntimeOption[], DomainError>> {
    if (this.disposed || this.ended) return failed(unavailable('这条 Codex 会话已经结束了'));
    const error = applyCodexOption(this.settings, this.models, id, value);
    if (error !== null) return failed(error);
    if (id === 'effort') this.effortChosen = true;
    const next = this.options();
    this.onOptions?.(this.sessionId, next);
    return { ok: true, value: next };
  }

  async respondApproval(id: string, decision: ApprovalDecision): Promise<Result<void, DomainError>> {
    const accepted = await this.gate.respond(id, decision);
    if (!accepted) return failed(invalid('这个批准请求已经收尾了，或者被撤回了'));
    return { ok: true, value: undefined };
  }

  pid(): number | null {
    return this.child.pid ?? null;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.activeTurn !== null && !this.ended) {
      try {
        await withTimeout(
          this.peer.request(
            'turn/interrupt',
            { threadId: this.threadId, turnId: this.activeTurn },
            INTERRUPT_TIMEOUT_MS
          ),
          INTERRUPT_TIMEOUT_MS + 500,
          'codex 没有在超时内回应 turn/interrupt'
        );
      } catch {
        // 打断失败就直接往下杀
      }
    }
    // 还没回答的审批当拒绝，别让 gate 的 180s 定时器把进程吊着。
    await this.gate.close();
    killTree(this.child, 'SIGTERM');
    const exitedGracefully = await withTimeout(this.exited.then(() => true), TERM_GRACE_MS, 'wait exit').catch(
      () => false
    );
    if (!exitedGracefully) {
      killTree(this.child, 'SIGKILL');
      await withTimeout(this.exited, KILL_GRACE_MS, 'wait kill').catch(() => undefined);
    }
    this.peer.close('会话已结束');
  }

  private threadParams(spec: StartSpec): Record<string, unknown> {
    const params: Record<string, unknown> = {
      cwd: spec.workspaceRoot,
      approvalPolicy: this.settings.approval,
      sandbox: this.settings.sandbox
    };
    if (this.settings.model !== '') params['model'] = this.settings.model;
    const config = codexMcpConfig(spec.mcp, spec.tools?.token);
    if (config !== null) params['config'] = config;
    const instructions = developerInstructions(spec.assets);
    if (instructions !== '') params['developerInstructions'] = instructions;
    return params;
  }

  private turnParams(text: string): Record<string, unknown> {
    const params: Record<string, unknown> = {
      threadId: this.threadId,
      input: [{ type: 'text', text }],
      approvalPolicy: this.settings.approval,
      sandboxPolicy: sandboxPolicyFor(this.settings.sandbox)
    };
    if (this.settings.model !== '') params['model'] = this.settings.model;
    if (this.effortChosen && this.settings.effort !== '') params['effort'] = this.settings.effort;
    return params;
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    for (const event of this.mapper.map({ method, params })) this.push(event);
    if (method === 'turn/started') {
      const turnId = textOf(asRecord(params['turn'])['id']);
      if (turnId !== '') this.activeTurn = turnId;
    }
    if (method === 'turn/completed') {
      this.activeTurn = null;
      // 这一轮收尾了，还挂着的审批已经没有意义：撤掉卡片，别再等 180s。
      for (const id of this.gate.pending()) {
        this.gate.withdraw(id);
        this.approvalBindings.delete(id);
      }
    }
  }

  private handleServerRequest(
    method: string,
    params: Record<string, unknown>,
    respond: (result: unknown) => void,
    respondError: (code: number, message: string) => void
  ): void {
    if (method === 'item/tool/requestUserInput') {
      this.push({ kind: 'diagnostic', level: 'info', text: 'Codex 想让用户回答问题，v1 先跳过这一问' });
      respond({ answers: {} });
      return;
    }
    if (method === 'attestation/generate') {
      this.push({ kind: 'diagnostic', level: 'info', text: 'Codex 请求生成 attestation，v1 先跳过' });
      respond({});
      return;
    }
    if (method === 'item/tool/call') {
      this.push({ kind: 'diagnostic', level: 'warn', text: 'Codex 请求动态工具调用，v1 不支持' });
      respondError(-32601, 'agent-hub 的 Codex 适配器 v1 不支持动态工具调用');
      return;
    }

    const approval = describeApproval(method, params);
    if (approval === null) {
      respondError(-32601, `没有实现的方法：${method}`);
      return;
    }
    const baseId = textOf(params['itemId']) || textOf(params['callId']) || `request-${++this.approvalSeq}`;
    let id = `codex-${baseId}`;
    if (this.approvalBindings.has(id)) id = `${id}-${++this.approvalSeq}`;
    this.approvalBindings.set(id, { method, params, respond });
    this.gate.request({
      id,
      title: approval.title,
      ...(approval.detail === '' ? {} : { detail: approval.detail })
    });
  }

  private async replyApproval(id: string, decision: ApprovalDecision): Promise<void> {
    const binding = this.approvalBindings.get(id);
    if (binding === undefined) return;
    this.approvalBindings.delete(id);
    binding.respond(approvalResult(binding.method, binding.params, decision));
  }

  private push(event: SessionEvent): void {
    if (event.kind === 'ended') this.turnEnded = true;
    this.queue.push(event);
  }

  private async handleExit(code: number | null): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.activeTurn = null;
    // 未决审批全部当拒绝（send 走的是已经死掉的 stdin，会静默失败）。
    await this.gate.close();
    if (!this.turnEnded) {
      const reason =
        this.disposed || code === 0
          ? undefined
          : `codex 进程退出了（code ${code ?? 'unknown'}）${this.lastStderr === '' ? '' : `：${this.lastStderr}`}`;
      this.queue.push(
        reason === undefined ? { kind: 'ended', outcome: 'stopped' } : { kind: 'ended', outcome: 'failed', reason }
      );
    }
    this.queue.close();
  }

  private withStderr(message: string): string {
    return this.lastStderr === '' ? message : `${message}：${this.lastStderr}`;
  }
}

class EventQueue implements AsyncIterable<SessionEvent> {
  private readonly values: SessionEvent[] = [];
  private readonly waiters: ((result: IteratorResult<SessionEvent>) => void)[] = [];
  private closed = false;

  push(event: SessionEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter({ value: event, done: false });
      return;
    }
    this.values.push(event);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SessionEvent> {
    return {
      next: (): Promise<IteratorResult<SessionEvent>> => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<SessionEvent>>((resolve) => {
          this.waiters.push(resolve);
        });
      }
    };
  }
}

function applyCodexOption(
  settings: CodexSettings,
  models: readonly string[],
  id: string,
  value: string | boolean
): DomainError | null {
  if (typeof value !== 'string') return invalid(`${id} 需要一个字符串值`);
  switch (id) {
    case 'model':
      if (value === '') return invalid('model 不能为空');
      if (models.length > 0 && !models.includes(value)) return invalid(`Codex 不认识这个模型：${value}`);
      settings.model = value;
      return null;
    case 'effort':
      if (!(CODEX_EFFORTS as readonly string[]).includes(value)) {
        return invalid('effort 只能是 minimal / low / medium / high');
      }
      settings.effort = value;
      return null;
    case 'approval':
      if (!(CODEX_APPROVALS as readonly string[]).includes(value)) {
        return invalid('approval 只能是 on-request / untrusted / never');
      }
      settings.approval = value;
      return null;
    case 'sandbox':
      if (!(CODEX_SANDBOXES as readonly string[]).includes(value)) {
        return invalid('sandbox 只能是 read-only / workspace-write / danger-full-access');
      }
      settings.sandbox = value;
      return null;
    default:
      // 未知 option id 照 Pi 的做法忽略：老 hub 可能带新 adapter 不认识的键。
      return null;
  }
}

function sandboxPolicyFor(sandbox: string): Record<string, unknown> {
  switch (sandbox) {
    case 'read-only':
      return { type: 'readOnly' };
    case 'danger-full-access':
      return { type: 'dangerFullAccess' };
    default:
      return { type: 'workspaceWrite' };
  }
}

/** `thread/start.config.mcp_servers`：stdio 的 env 里是已展开的密钥，只进这个进程。 */
function codexMcpConfig(mcp: readonly McpLaunch[] | undefined, token: string | undefined): Record<string, unknown> | null {
  if (mcp === undefined || mcp.length === 0) return null;
  const servers: Record<string, unknown> = {};
  for (const server of mcp) {
    if (server.transport === 'stdio') {
      servers[server.name] = {
        command: server.command,
        args: [...server.args],
        env: { ...server.env }
      };
      continue;
    }
    servers[server.name] = {
      url: server.url,
      ...(token === undefined || token === '' ? {} : { http_headers: { Authorization: `Bearer ${token}` } })
    };
  }
  return { mcp_servers: servers };
}

/** 指令原文 + 技能索引（名字、描述、SKILL.md 绝对路径），照 Grok 的交接方式。 */
function developerInstructions(assets: SessionAssets | undefined): string {
  if (assets === undefined) return '';
  const parts: string[] = [];
  for (const instruction of assets.instructions) {
    try {
      parts.push(`# ${instruction.name}\n\n${readFileSync(instruction.path, 'utf8')}`);
    } catch {
      // 文件读不到就不塞，别让整条会话起不来
    }
  }
  if (assets.skills.length > 0) {
    const lines = assets.skills.map((skill) => `- ${skill.name}：${skill.description}（${skill.path}）`);
    parts.push(`# 可用技能\n\n需要时打开对应的 SKILL.md：\n${lines.join('\n')}`);
  }
  return parts.join('\n\n');
}

function describeApproval(
  method: string,
  params: Record<string, unknown>
): { readonly title: string; readonly detail: string } | null {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'execCommandApproval': {
      const command =
        method === 'execCommandApproval'
          ? (Array.isArray(params['command']) ? params['command'].map(textOf).join(' ') : '')
          : textOf(params['command']);
      return {
        title: textOf(params['reason']) || 'Codex 要执行命令',
        detail: (command || textOf(params['cwd'])).slice(0, 2048)
      };
    }
    case 'item/fileChange/requestApproval': {
      return {
        title: textOf(params['reason']) || 'Codex 要改文件',
        detail: (textOf(params['grantRoot']) || '').slice(0, 2048)
      };
    }
    case 'applyPatchApproval': {
      const changes = asRecord(params['fileChanges']);
      return {
        title: textOf(params['reason']) || 'Codex 要改文件',
        detail: Object.keys(changes).join('\n').slice(0, 2048)
      };
    }
    case 'item/permissions/requestApproval': {
      return {
        title: textOf(params['reason']) || 'Codex 要申请额外权限',
        detail: safeJson(params['permissions']).slice(0, 2048)
      };
    }
    case 'mcpServer/elicitation/request': {
      return {
        title: `Codex 需要 ${textOf(params['serverName']) || 'MCP 服务'} 的输入`,
        detail: textOf(params['message']).slice(0, 2048)
      };
    }
    default:
      return null;
  }
}

/**
 * 各审批方法的响应形状不一样（0.168.0 schema）：
 * 新 API 是 `decision`/`action` 枚举；`item/permissions` 要回权限档案；
 * 旧版 exec/patch 用 ReviewDecision（approved / {denied}）。
 */
function approvalResult(
  method: string,
  params: Record<string, unknown>,
  decision: ApprovalDecision
): Record<string, unknown> {
  const allow = decision === 'allow';
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { decision: allow ? 'accept' : 'decline' };
    case 'item/permissions/requestApproval':
      return allow ? { permissions: params['permissions'] ?? {}, scope: 'turn' } : { permissions: {} };
    case 'mcpServer/elicitation/request':
      return { action: allow ? 'accept' : 'decline' };
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return { decision: allow ? 'approved' : { denied: { rejection: '用户拒绝' } } };
    default:
      return { decision: allow ? 'accept' : 'decline' };
  }
}

function isMissingThread(error: unknown): boolean {
  return /not found|unknown thread|no rollout|does not exist|不存在/i.test(errorText(error));
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<Error | null> {
  return new Promise<Error | null>((resolve) => {
    let settled = false;
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      resolve(null);
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      resolve(error);
    });
  });
}

export function killTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // 不是进程组组长（或已经退出）：退回单进程 kill
    }
  }
  try {
    child.kill(signal);
  } catch {
    // 已经退出
  }
}

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

function failed(error: DomainError): { ok: false; error: DomainError } {
  return { ok: false, error };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

export type { CodexSettings };
