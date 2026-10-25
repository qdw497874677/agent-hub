import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { jsonlRecords } from '@agent-hub/contract';
import type {
  AgentRuntime,
  DomainError,
  Result,
  RuntimeOption,
  RuntimeSession,
  SessionEvent,
  StartSpec
} from '@agent-hub/domain';
import { unavailable } from '@agent-hub/domain';
import { grokDescriptor, grokDescriptorFor } from './descriptor.ts';
import { endedFromStopReason, mapAcpUpdate } from './map-acp.ts';
import { mapAcpOptions } from './map-options.ts';

class EventQueue implements AsyncIterable<SessionEvent> {
  private readonly items: SessionEvent[] = [];
  private readonly waiters: ((result: IteratorResult<SessionEvent>) => void)[] = [];
  private closed = false;

  push(event: SessionEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.items.push(event);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SessionEvent> {
    return {
      next: (): Promise<IteratorResult<SessionEvent>> => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      }
    };
  }
}

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

class AcpSession implements RuntimeSession {
  readonly sessionId: RuntimeSession['sessionId'];
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly queue = new EventQueue();
  private readonly pending = new Map<string, Pending>();
  private readonly toolNames = new Map<string, string>();
  private counter = 0;
  private agentSessionId = '';
  /** session/load 时 Grok 会用 session/update 回放历史；平台已有这些事件，回放期间丢掉。 */
  private replaying = false;
  /** 与 Pi 适配器一致：主动 dispose 导致的进程退出记 stopped，不是 failed。 */
  private disposed = false;

  private current: readonly RuntimeOption[] = [];
  private readonly onOptions: (options: readonly RuntimeOption[]) => void;

  constructor(
    sessionId: RuntimeSession['sessionId'],
    child: ChildProcessWithoutNullStreams,
    onOptions: (options: readonly RuntimeOption[]) => void
  ) {
    this.sessionId = sessionId;
    this.child = child;
    this.onOptions = onOptions;
    void this.pump();
  }

  private setOptions(raw: unknown): void {
    const options = mapAcpOptions(raw);
    if (options.length === 0) return;
    this.current = options;
    this.onOptions(options);
  }

  setAgentSessionId(id: string): void {
    this.agentSessionId = id;
  }

  private async pump(): Promise<void> {
    try {
      for await (const line of jsonlRecords(this.child.stdout)) {
        let record: Record<string, unknown>;
        try {
          record = JSON.parse(line) as Record<string, unknown>;
        } catch {
          this.queue.push({ kind: 'diagnostic', level: 'warn', text: '无法解析的 ACP 记录' });
          continue;
        }

        const id = record['id'];
        if (record['method'] !== undefined && id !== undefined) {
          this.answerAcpRequest(record);
          continue;
        }
        if (id !== undefined && this.pending.has(String(id))) {
          const pending = this.pending.get(String(id));
          this.pending.delete(String(id));
          if (record['error']) {
            pending?.reject(new Error(String((record['error'] as Record<string, unknown>)['message'])));
          } else {
            pending?.resolve((record['result'] as Record<string, unknown>) ?? {});
          }
          continue;
        }
        const params = record['params'] as Record<string, unknown> | undefined;
        if (record['method'] === 'session/update' && params) {
          const update = params['update'] as Record<string, unknown> | undefined;
          // Grok 自己也会推全量配置（比如换模型后思考强度的可选值跟着变）。
          if (update?.['sessionUpdate'] === 'config_option_update') {
            this.setOptions(update['configOptions']);
            continue;
          }
        }
        if (record['method'] === 'session/update' && params && !this.replaying) {
          for (const event of mapAcpUpdate(params['update'], this.toolNames)) this.queue.push(event);
        }
      }
    } catch (error) {
      this.queue.push({
        kind: 'diagnostic',
        level: 'error',
        text: `ACP 事件流中断：${(error as Error).message}`
      });
    } finally {
      this.queue.push({ kind: 'ended', outcome: this.disposed ? 'stopped' : 'failed' });
      this.queue.close();
    }
  }

  /** ACP 允许 agent 反向请求客户端。不答就会卡住，所以每个请求都要有回音。 */
  private answerAcpRequest(record: Record<string, unknown>): void {
    const id = record['id'] as string | number;
    const method = String(record['method']);

    if (method === 'session/request_permission') {
      const params = record['params'] as Record<string, unknown> | undefined;
      const options = (params?.['options'] as { optionId?: string; kind?: string }[] | undefined) ?? [];
      const allow = options.find((option) => option.kind?.startsWith('allow')) ?? options[0];
      this.write({
        jsonrpc: '2.0',
        id,
        result: allow?.optionId ? { outcome: { outcome: 'selected', optionId: allow.optionId } } : { outcome: { outcome: 'cancelled' } }
      });
      return;
    }

    this.write({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `agent-hub v1 未实现 ${method}` }
    });
  }

  private write(payload: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.counter += 1;
    const id = this.counter;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(String(id), { resolve, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** initialize；带了 XAI_API_KEY 且 agent 认这种方式时才 authenticate，否则用 `grok login` 缓存的凭据。 */
  private async handshake(): Promise<void> {
    const init = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
    });
    const methods = ((init['authMethods'] as { id?: unknown }[] | undefined) ?? []).map((m) => m.id);
    if (process.env['XAI_API_KEY'] && methods.includes('xai.api_key')) {
      await this.request('authenticate', { methodId: 'xai.api_key', _meta: { headless: true } });
    }
  }

  async initialize(cwd: string, model: string): Promise<void> {
    await this.handshake();
    // yoloMode：和 OpenCode 适配器一样由平台放行工具调用（Grok 的 deny 规则与 hooks 仍生效）。
    const session = await this.request('session/new', { cwd, mcpServers: [], _meta: { yoloMode: true } });
    const id = session['sessionId'];
    if (typeof id === 'string') this.agentSessionId = id;
    this.setOptions(session['configOptions']);
    if (model) await this.request('session/set_model', { sessionId: this.agentSessionId, modelId: model });
  }

  async load(cwd: string, agentSessionRef: string): Promise<void> {
    await this.handshake();
    this.replaying = true;
    try {
      const session = await this.request('session/load', {
        sessionId: agentSessionRef,
        cwd,
        mcpServers: [],
        _meta: { yoloMode: true }
      });
      this.setOptions(session['configOptions']);
    } finally {
      this.replaying = false;
    }
    this.agentSessionId = agentSessionRef;
  }

  options(): readonly RuntimeOption[] {
    return this.current;
  }

  async changeOption(id: string, value: string | boolean): Promise<Result<readonly RuntimeOption[], DomainError>> {
    try {
      const result = await this.request('session/set_config_option', {
        sessionId: this.agentSessionId,
        configId: id,
        type: typeof value === 'boolean' ? 'boolean' : 'id',
        value
      });
      // 响应是全量状态：Grok 换模型会连带改变 reasoning_effort 的可选值。
      this.setOptions(result['configOptions']);
      if (this.current.length === 0) return { ok: false, error: unavailable('Grok 没有回报配置项') };
      return { ok: true, value: this.current };
    } catch (error) {
      return { ok: false, error: unavailable((error as Error).message) };
    }
  }

  get agentRef(): string {
    return this.agentSessionId;
  }

  async prompt(text: string): Promise<Result<void, DomainError>> {
    try {
      const result = await this.request('session/prompt', {
        sessionId: this.agentSessionId,
        prompt: [{ type: 'text', text }]
      });
      this.queue.push(endedFromStopReason(result['stopReason']));
      return { ok: true, value: undefined };
    } catch (error) {
      return { ok: false, error: unavailable((error as Error).message) as DomainError };
    }
  }

  async interrupt(): Promise<void> {
    this.write({
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId: this.agentSessionId }
    });
  }

  events(): AsyncIterable<SessionEvent> {
    return this.queue;
  }

  async adopt(_cursor: number): Promise<void> {
    return;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 3000);
    this.child.once('exit', () => clearTimeout(timer));
  }
}

export interface GrokRuntimeOptions {
  readonly command?: string;
  readonly models?: readonly string[];
  readonly defaultModel?: string;
  readonly onAgentSessionRef?: (sessionId: string, agentSessionRef: string) => void;
  /** Grok 报上来的可调项（含当前值），worker 用它告诉 server。 */
  readonly onOptions?: (sessionId: string, options: readonly RuntimeOption[]) => void;
}

export function createGrokRuntime(options: GrokRuntimeOptions = {}): AgentRuntime {
  const command = options.command ?? 'grok';
  const descriptor =
    options.models !== undefined
      ? grokDescriptorFor(options.models, options.defaultModel ?? '')
      : grokDescriptor;

  return {
    descriptor,

    async start(spec: StartSpec): Promise<Result<RuntimeSession, DomainError>> {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(command, ['--no-auto-update', 'agent', 'stdio'], {
          cwd: spec.workspaceRoot,
          stdio: ['pipe', 'pipe', 'pipe']
        });
      } catch (error) {
        return { ok: false, error: unavailable(`无法启动 Grok：${(error as Error).message}`) };
      }
      child.on('error', () => {
        /* 见 Pi 适配器的同名处理：避免未处理的 error 事件崩进程 */
      });

      const session = new AcpSession(spec.sessionId, child, (reported) => {
        options.onOptions?.(spec.sessionId, reported);
      });
      const ref = spec.resume?.agentSessionRef ?? null;
      try {
        if (ref) await session.load(spec.workspaceRoot, ref);
        // 模型若已在 spec.options 里，交给下面统一落实，避免设两次。
        else await session.initialize(spec.workspaceRoot, 'model' in spec.options ? '' : spec.model);
      } catch (error) {
        await session.dispose();
        return { ok: false, error: unavailable(`Grok 握手失败：${(error as Error).message}`) };
      }

      // 开跑前用户已经选好的项（派生时选的模型、思考强度），交给 Grok 去落实。
      for (const [id, value] of Object.entries(spec.options)) {
        const changed = await session.changeOption(id, value);
        if (!changed.ok) {
          await session.dispose();
          return { ok: false, error: changed.error };
        }
      }

      // 和 OpenCode 不同，Grok 的 session/new 直接给出会话 id，可以立刻报真 ref。
      options.onAgentSessionRef?.(spec.sessionId, session.agentRef || 'pending');
      return { ok: true, value: session };
    }
  } satisfies AgentRuntime;
}
