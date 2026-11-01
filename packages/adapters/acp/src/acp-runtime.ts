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
import { acpDescriptor, type AcpAgentConfig, type AcpLaunch } from './config.ts';
import { endedFromStopReason, mapAcpUpdate, mcpServersFor, readMcpCapabilities, readPromptCapabilities, toAcpPrompt } from './map-acp.ts';
import type { AcpPromptCapabilities } from './map-acp.ts';
import { legacyAcpOptions, mapAcpOptions } from './map-options.ts';

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

  pid(): number | null {
    return this.child.pid ?? null;
  }

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

  /** agent 没有 configOptions、只报老式 models/modes（Hermes）：改值走 set_model / set_mode。 */
  private legacy = false;

  /** session/new|load 的响应：优先 configOptions，没有就读老式 models/modes。 */
  private setReported(session: Json): void {
    if (Array.isArray(session['configOptions']) && (session['configOptions'] as unknown[]).length > 0) {
      this.setOptions(session['configOptions']);
      return;
    }
    const legacy = legacyAcpOptions(session);
    if (legacy.length === 0) return;
    this.legacy = true;
    this.publish(legacy);
  }

  private setOptions(raw: unknown): void {
    const options = mapAcpOptions(raw);
    if (options.length === 0) return;
    this.publish(options);
  }

  /**
   * agent 写法 → hub 写法（config.optionValue 的反向）。例如 Hermes 回报「custom:m-1」，
   * hub 这边要看到并落库的仍是「hub-<slug>/m-1」——否则 session.model 被改写，重开时就配不上提供商了。
   */
  private readonly aliases = new Map<string, string>();

  private publish(options: readonly RuntimeOption[]): void {
    const alias = (value: string): string => this.aliases.get(value) ?? value;
    const mapValue = <T extends { value: string }>(entry: T): T => ({ ...entry, value: alias(entry.value) });
    this.current = this.aliases.size === 0
      ? options
      : options.map((option) => ({
          ...option,
          current: typeof option.current === 'string' ? alias(option.current) : option.current,
          choices: option.choices.map((choice) =>
            choice.kind === 'value' ? { ...choice, value: mapValue(choice.value) } : { ...choice, values: choice.values.map(mapValue) }
          )
        }));
    this.onOptions(this.current);
  }

  /** 官方 SDK 按 schema 给出了强类型；平台扩展字段（_meta）和宽松读取走这个口子。 */
  private promptCaps: AcpPromptCapabilities = { image: false, embeddedContext: false };
  private mcpCaps = { http: false, sse: false };
  /** hub 能力层；握手后按 agent 声明的 mcpCapabilities 决定能不能注入。 */
  tools: StartSpec['tools'] = undefined;
  /** hub 下发的 MCP 资产（stdio 的 env 含密钥：只交给 agent，不打日志）。 */
  mcp: StartSpec['mcp'] = undefined;
  /** 本机的 stdio MCP 垫片命令（worker 给）；agent 不会 HTTP MCP 时靠它。 */
  toolShim: { command: string; args: readonly string[] } | undefined = undefined;

  private request(method: string, params: Json): Promise<Json> {
    return this.connection.agent.request<Json, Json>(method, params);
  }

  private async handshake(): Promise<void> {
    const init = await this.request('initialize', { protocolVersion: 1, clientCapabilities: CLIENT_CAPABILITIES });
    this.promptCaps = readPromptCapabilities(init);
    this.mcpCaps = readMcpCapabilities(init);
    const methods = ((init['authMethods'] as { id?: unknown }[] | undefined) ?? []).flatMap((method) =>
      typeof method.id === 'string' ? [method.id] : []
    );
    const auth = this.config.authenticate?.(methods);
    if (auth) await this.request('authenticate', { ...auth });
  }

  /** 这次启动额外的 `_meta`（例如 hub 资产给 Grok 的 rules）。 */
  launchMeta: Readonly<Record<string, unknown>> | undefined = undefined;

  private sessionParams(cwd: string): Json {
    const meta = this.config.sessionMeta || this.launchMeta ? { ...this.config.sessionMeta, ...this.launchMeta } : undefined;
    return { cwd, mcpServers: mcpServersFor(this.tools, this.mcpCaps, this.toolShim, this.mcp), ...(meta ? { _meta: meta } : {}) };
  }

  async open(cwd: string, agentSessionRef: string | null): Promise<void> {
    await this.handshake();
    if (agentSessionRef === null) {
      const session = await this.request('session/new', this.sessionParams(cwd));
      if (typeof session['sessionId'] === 'string') this.agentSessionId = session['sessionId'];
      this.setReported(session);
      return;
    }
    this.replaying = true;
    try {
      const session = await this.request('session/load', { sessionId: agentSessionRef, ...this.sessionParams(cwd) });
      this.setReported(session);
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
    const agentValue = this.config.optionValue ? this.config.optionValue(id, value) : value;
    if (typeof value === 'string' && typeof agentValue === 'string' && agentValue !== value) this.aliases.set(agentValue, value);
    if (this.legacy) return this.changeLegacy(id, agentValue);
    value = agentValue;
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

  private async changeLegacy(id: string, value: string | boolean): Promise<Result<readonly RuntimeOption[], DomainError>> {
    if ((id !== 'model' && id !== 'mode') || typeof value !== 'string') {
      return { ok: false, error: unavailable(`${this.config.label} 不认这个配置项：${id}`) };
    }
    try {
      if (id === 'model') await this.request('session/set_model', { sessionId: this.agentSessionId, modelId: value });
      else await this.request('session/set_mode', { sessionId: this.agentSessionId, modeId: value });
    } catch (error) {
      return { ok: false, error: unavailable((error as Error).message) };
    }
    // 老接口不回全量状态：本地把当前值改掉（新值不在候选里就补一条，比如 Hermes 的 custom 端点只列了当前模型）
    const shown = this.aliases.get(value) ?? value;
    this.publish(
      this.current.map((option) =>
        option.id !== id
          ? option
          : {
              ...option,
              current: value,
              choices: option.choices.some((choice) => choice.kind === 'value' && (choice.value.value === value || choice.value.value === shown))
                ? option.choices
                : [...option.choices, { kind: 'value' as const, value: { value, label: shown } }]
            }
      )
    );
    return { ok: true, value: this.current };
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
  /** stdio MCP 垫片（`node mcp-shim.ts`）：Pi 一直用；ACP agent 不会 HTTP MCP 时用。 */
  readonly toolShim?: { readonly command: string; readonly args: readonly string[] };
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
      let launch: AcpLaunch = {};
      try {
        launch = spec.assets && config.launch ? await config.launch(spec.assets) : {};
        if (spec.provider && config.providerLaunch) launch = await config.providerLaunch(spec.sessionId, spec.provider, launch);
        child = spawn(config.command, [...(launch.args ?? config.args)], {
          cwd: spec.workspaceRoot,
          stdio: ['pipe', 'pipe', 'pipe'],
          ...(launch.env ? { env: { ...process.env, ...launch.env } } : {})
        });
      } catch (error) {
        return { ok: false, error: unavailable(`无法启动 ${config.label}：${(error as Error).message}`) };
      }
      // 命令不存在时 spawn 会异步抛 error；不接住就会崩掉整个 worker。
      child.on('error', () => {});

      const session = new AcpSession(spec.sessionId, child, config, (reported) => {
        options.onOptions?.(spec.sessionId, reported);
      });
      session.tools = spec.tools;
      session.mcp = spec.mcp;
      session.toolShim = options.toolShim;
      session.launchMeta = launch.sessionMeta;
      const ref = spec.resume?.agentSessionRef ?? null;
      try {
        await session.open(spec.workspaceRoot, ref);
      } catch (error) {
        await session.dispose();
        return { ok: false, error: unavailable(`${config.label} 握手失败：${(error as Error).message}`) };
      }

      // 开跑前用户已经选好的项（派生时选的模型、思考强度），交给 agent 去落实。
      // 模型也是一个配置项（ACP 的 category: model），与其余选项走同一条 set_config_option。
      for (const [id, raw] of Object.entries(spec.options)) {
        const changed = await session.changeOption(id, raw);
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
