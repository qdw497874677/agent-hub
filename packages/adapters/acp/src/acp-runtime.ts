import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { client, ndJsonStream } from '@agentclientprotocol/sdk';
import type { ClientConnection } from '@agentclientprotocol/sdk';
import { AsyncQueue } from '@agent-hub/contract';
import type {
  AgentDescriptor,
  AgentRuntime,
  DomainError,
  Result,
  PromptInput,
  RuntimeOption,
  RuntimeSession,
  SessionEvent,
  StartSpec
} from '@agent-hub/domain';
import { unavailable } from '@agent-hub/domain';
import { acpDescriptor, type AcpAgentConfig } from './config.ts';
import { endedFromStopReason, mapAcpUpdate, readPromptCapabilities, toAcpPrompt } from './map-acp.ts';
import type { AcpPromptCapabilities } from './map-acp.ts';
import { mapAcpOptions } from './map-options.ts';

type Json = Record<string, unknown>;

const CLIENT_CAPABILITIES = { fs: { readTextFile: false, writeTextFile: false }, terminal: false };

/**
 * 一条 ACP 会话 = 一个子进程 + 一条官方 SDK 的 JSON-RPC 连接。
 *
 * JSON-RPC 的编号、配对、反向请求的「方法不存在」应答都交给
 * `@agentclientprotocol/sdk`；这里只剩平台自己的规则：
 * 事件归一、回放去重、可调项全量上报、dispose 记 stopped。
 */
class AcpSession implements RuntimeSession {
  readonly sessionId: RuntimeSession['sessionId'];
  private readonly queue = new AsyncQueue<SessionEvent>();
  private readonly toolNames = new Map<string, string>();
  private readonly connection: ClientConnection;
  private agentSessionId = '';
  /** session/load 时 agent 会用 session/update 回放历史；平台已有这些事件，回放期间丢掉。 */
  private replaying = false;
  /** 主动 dispose 导致的进程退出记 stopped，不是 failed。 */
  private disposed = false;
  private current: readonly RuntimeOption[] = [];

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly config: AcpAgentConfig;
  private readonly onOptions: (options: readonly RuntimeOption[]) => void;

  constructor(
    sessionId: RuntimeSession['sessionId'],
    child: ChildProcessWithoutNullStreams,
    config: AcpAgentConfig,
    onOptions: (options: readonly RuntimeOption[]) => void
  ) {
    this.sessionId = sessionId;
    this.child = child;
    this.config = config;
    this.onOptions = onOptions;
    const app = client()
      .onNotification('session/update', ({ params }) => this.onUpdate(params.update as unknown as Json))
      // 平台替用户放行工具调用（与 yolo 模式一致）；agent 自己的 deny 规则仍生效。
      .onRequest('session/request_permission', ({ params }) => {
        const allow = params.options.find((option) => option.kind.startsWith('allow')) ?? params.options[0];
        return allow
          ? { outcome: { outcome: 'selected' as const, optionId: allow.optionId } }
          : { outcome: { outcome: 'cancelled' as const } };
      });
    this.connection = app.connect(
      ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
      )
    );
    child.once('exit', () => this.finish());
    void this.connection.closed.catch((error: unknown) => {
      this.queue.push({ kind: 'diagnostic', level: 'error', text: `ACP 事件流中断：${(error as Error).message}` });
    }).finally(() => this.finish());
  }

  private finish(): void {
    this.queue.push({ kind: 'ended', outcome: this.disposed ? 'stopped' : 'failed' });
    this.queue.close();
  }

  private onUpdate(update: Json): void {
    // agent 自己也会推全量配置（比如换模型后思考强度的可选值跟着变）。
    if (update['sessionUpdate'] === 'config_option_update') {
      this.setOptions(update['configOptions']);
      return;
    }
    if (this.replaying) return;
    for (const event of mapAcpUpdate(update, this.toolNames)) this.queue.push(event);
  }

  private setOptions(raw: unknown): void {
    const options = mapAcpOptions(raw);
    if (options.length === 0) return;
    this.current = options;
    this.onOptions(options);
  }

  /** 官方 SDK 按 schema 给出了强类型；平台扩展字段（_meta）和宽松读取走这个口子。 */
  private promptCaps: AcpPromptCapabilities = { image: false, embeddedContext: false };

  private request(method: string, params: Json): Promise<Json> {
    return this.connection.agent.request<Json, Json>(method, params);
  }

  private async handshake(): Promise<void> {
    const init = await this.request('initialize', { protocolVersion: 1, clientCapabilities: CLIENT_CAPABILITIES });
    this.promptCaps = readPromptCapabilities(init);
    const methods = ((init['authMethods'] as { id?: unknown }[] | undefined) ?? []).flatMap((method) =>
      typeof method.id === 'string' ? [method.id] : []
    );
    const auth = this.config.authenticate?.(methods);
    if (auth) await this.request('authenticate', { ...auth });
  }

  private sessionParams(cwd: string): Json {
    return { cwd, mcpServers: [], ...(this.config.sessionMeta ? { _meta: this.config.sessionMeta } : {}) };
  }

  async open(cwd: string, agentSessionRef: string | null): Promise<void> {
    await this.handshake();
    if (agentSessionRef === null) {
      const session = await this.request('session/new', this.sessionParams(cwd));
      if (typeof session['sessionId'] === 'string') this.agentSessionId = session['sessionId'];
      this.setOptions(session['configOptions']);
      return;
    }
    this.replaying = true;
    try {
      const session = await this.request('session/load', { sessionId: agentSessionRef, ...this.sessionParams(cwd) });
      this.setOptions(session['configOptions']);
    } finally {
      this.replaying = false;
    }
    this.agentSessionId = agentSessionRef;
  }

  get agentRef(): string {
    return this.agentSessionId;
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
      // 响应是全量状态：换模型会连带改变别的项的可选值，所以整份换掉。
      this.setOptions(result['configOptions']);
      if (this.current.length === 0) return { ok: false, error: unavailable(`${this.config.label} 没有回报配置项`) };
      return { ok: true, value: this.current };
    } catch (error) {
      return { ok: false, error: unavailable((error as Error).message) };
    }
  }

  async prompt(input: PromptInput): Promise<Result<void, DomainError>> {
    const blocks = toAcpPrompt(input, this.promptCaps, this.config.label);
    if (!blocks.ok) return blocks;
    try {
      const result = await this.request('session/prompt', {
        sessionId: this.agentSessionId,
        prompt: blocks.value
      });
      this.queue.push(endedFromStopReason(result['stopReason'] as string | undefined));
      return { ok: true, value: undefined };
    } catch (error) {
      return { ok: false, error: unavailable((error as Error).message) };
    }
  }

  async interrupt(): Promise<void> {
    await this.connection.agent.notify('session/cancel', { sessionId: this.agentSessionId });
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
    this.connection.close();
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 3000);
    this.child.once('exit', () => clearTimeout(timer));
  }
}

export interface AcpRuntimeOptions {
  /** 覆盖默认能力矩阵（例如 Grok 的模型清单在启动前就问得出来）。 */
  readonly descriptor?: AgentDescriptor;
  readonly onAgentSessionRef?: (sessionId: string, agentSessionRef: string) => void;
  /** agent 报上来的可调项（含当前值），worker 用它告诉 server。 */
  readonly onOptions?: (sessionId: string, options: readonly RuntimeOption[]) => void;
}

/**
 * 一个 ACP agent = 一条命令 + 一套协议 + 少量握手钩子。
 * 换 agent 只换 `config`，不改这里——这就是「通用」在这一层的全部含义。
 */
export function createAcpRuntime(config: AcpAgentConfig, options: AcpRuntimeOptions = {}): AgentRuntime {
  return {
    descriptor: options.descriptor ?? acpDescriptor(config),

    async start(spec: StartSpec): Promise<Result<RuntimeSession, DomainError>> {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(config.command, [...config.args], { cwd: spec.workspaceRoot, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (error) {
        return { ok: false, error: unavailable(`无法启动 ${config.label}：${(error as Error).message}`) };
      }
      // 命令不存在时 spawn 会异步抛 error；不接住就会崩掉整个 worker。
      child.on('error', () => {});

      const session = new AcpSession(spec.sessionId, child, config, (reported) => {
        options.onOptions?.(spec.sessionId, reported);
      });
      const ref = spec.resume?.agentSessionRef ?? null;
      try {
        await session.open(spec.workspaceRoot, ref);
      } catch (error) {
        await session.dispose();
        return { ok: false, error: unavailable(`${config.label} 握手失败：${(error as Error).message}`) };
      }

      // 开跑前用户已经选好的项（派生时选的模型、思考强度），交给 agent 去落实。
      // 模型也是一个配置项（ACP 的 category: model），与其余选项走同一条 set_config_option。
      for (const [id, value] of Object.entries(spec.options)) {
        const changed = await session.changeOption(id, value);
        if (!changed.ok) {
          await session.dispose();
          return changed;
        }
      }

      options.onAgentSessionRef?.(spec.sessionId, session.agentRef || ref || 'pending');
      return { ok: true, value: session };
    }
  } satisfies AgentRuntime;
}
