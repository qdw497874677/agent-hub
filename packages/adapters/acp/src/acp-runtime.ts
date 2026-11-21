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
import { acpBranchAtTurn, acpDescriptor, type AcpAgentConfig, type AcpLaunch } from './config.ts';
import type { BranchSpec } from '@agent-hub/domain';
import { StderrTail, endedFromStopReason, mapAcpUpdate, mcpServersFor, readMcpCapabilities, readPromptCapabilities, toAcpPrompt } from './map-acp.ts';
import type { AcpPromptCapabilities } from './map-acp.ts';
import type { AcpChildUpdate, AcpSessionCodec } from './codec.ts';
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
/** 这些事件算「agent 有回应」。 */
const PRODUCING: ReadonlySet<SessionEvent['kind']> = new Set(['text', 'thinking', 'tool_call', 'tool_result', 'artifact', 'approval']);

/**
 * resync() 重放出来的一条**新**事件 + 跨重放稳定的去重指纹。
 * 重放会带整段历史，worker 还要再按 key 兜一层，避免断线重试时重复上报。
 */
export interface ResyncEntry {
  readonly key: string;
  readonly event: SessionEvent;
}

class AcpSession implements RuntimeSession {
  readonly sessionId: RuntimeSession['sessionId'];
  private readonly queue = new AsyncQueue<SessionEvent>();
  private readonly toolNames = new Map<string, string>();
  /** 传给 codec 的只读视图：codec 类型上拿不到 `set`，写入只发生在 map-acp 内部。 */
  private readonly toolNameView: ReadonlyMap<string, string> = this.toolNames;
  /** runtime 私有的 ACP 语义 codec；没有就走通用 mapper。 */
  private readonly codec: AcpSessionCodec | null;
  private codecWarned = false;
  private readonly connection: ClientConnection;
  private agentSessionId = '';
  /** open() 记下的工作目录：resync 重放时要原样带上（ACP 没有单独的 history 接口）。 */
  private cwd = '';
  /**
   * session/load 时 agent 会用 session/update 回放历史；平台已有这些事件，回放期间不进正常队列。
   * resync() 的回复进 `replayBuffer`，其余（open 的基线重放）只记去重指纹。
   */
  private replaying = false;
  private replayBuffer: ResyncEntry[] | null = null;
  /** 一次重放里同一 messageId 的 chunk 序号；每次重放从 0 起（见 seenChunks）。 */
  private replayChunks: Map<string, number> | null = null;
  /** 已经发出去（或基线里已知）的正文/思考 chunk 高水位：`kind|subagentId|messageId` → 条数。 */
  private readonly seenChunks = new Map<string, number>();
  /** 已经发出去（或基线里已知）的 tool_call / subagent / commands 指纹。 */
  private readonly seenKeys = new Set<string>();
  /** 同一时刻只允许一次 session/load：和 prompt 并发会打乱两边的 session/update。 */
  private resyncing: Promise<readonly ResyncEntry[]> | null = null;
  /** 上一次报给 hub 的命令表指纹：opencode 每次 session/load 都会重播一次，同名就别再发。 */
  private commandsKey: string | null = null;
  /** 主动 dispose 导致的进程退出记 stopped，不是 failed。 */
  private disposed = false;
  private current: readonly RuntimeOption[] = [];
  /** 这一轮 agent 有没有吐出过正文 / 思考 / 工具调用；一点没有就当失败报出来。 */
  private produced = false;
  /**
   * 正在飞的这一轮 session/prompt（没有就是 null）。ACP 一条会话同时只允许一轮；
   * 也用它把 ended 精确挂到这一条的 deliveryId 上，不按到达顺序猜。
   */
  private turn: { readonly deliveryId: string | null } | null = null;
  private readonly stderr = new StderrTail();
  /** 这一轮最后一条 assistant 消息的 id（ADR 0028）；一轮结束、推 ended 之前报给 hub。 */
  private lastMessageId: string | null = null;
  onTurnRef: ((turnRef: string) => void) | undefined = undefined;
  private init: Json = {};

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly config: AcpAgentConfig;
  private readonly onOptions: (options: readonly RuntimeOption[]) => void;
  /** true（默认）：一轮结束只推 ended 事件，进程与事件队列都留着，下一句 prompt 直接复用。 */
  private readonly keepAlive: boolean;

  pid(): number | null {
    return this.child.pid ?? null;
  }

  constructor(
    sessionId: RuntimeSession['sessionId'],
    child: ChildProcessWithoutNullStreams,
    config: AcpAgentConfig,
    onOptions: (options: readonly RuntimeOption[]) => void,
    keepAlive = true
  ) {
    this.sessionId = sessionId;
    this.child = child;
    this.config = config;
    this.onOptions = onOptions;
    this.keepAlive = keepAlive;
    this.codec = config.codec?.session() ?? null;
    // 一定要读 stderr：不读会写满管道把 agent 卡住；最后几行留着给空回合当线索（已脱敏）。
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => this.stderr.push(chunk));
    const app = client()
      .onNotification('session/update', ({ params }) => this.onUpdate(params.update as unknown as Json, params._meta))
      // OpenCode 的子会话更新是 ACP 扩展通知，不走 session/update。
      .onNotification<AcpChildUpdate>(
        'opencode/session/child_update',
        (raw) => raw as AcpChildUpdate,
        ({ params }) => this.onChildUpdate(params)
      )
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
    // 只有子进程真的退出才是会话终态。connection.closed 也会在 stdout 关掉而进程还活着时触发，
    // 单凭事件流断掉推 ended 等于替 agent 编造一个它没给的终态（更不能挂 deliveryId）。
    child.once('exit', () => this.finish());
    void this.connection.closed.catch((error: unknown) => {
      this.queue.push({ kind: 'diagnostic', level: 'error', text: `ACP 事件流中断：${(error as Error).message}` });
    });
  }

  private finish(): void {
    this.finishCodec(this.disposed ? 'cancelled' : 'failed');
    // 进程退出只有「这一轮真的在飞」时才算这一轮的终态；空闲退出 / 主动 dispose 是生命周期，不挂 deliveryId。
    const turn = this.disposed ? null : this.turn;
    this.turn = null;
    if (this.disposed) this.queue.push({ kind: 'ended', outcome: 'stopped' });
    else {
      const tail = this.stderr.tail();
      this.queue.push({
        kind: 'ended',
        outcome: 'failed',
        reason: `${this.config.label} 进程意外退出${tail.length > 0 ? `\n最近的 agent 日志：\n${tail.join('\n')}` : ''}`,
        ...(turn?.deliveryId ? { deliveryId: turn.deliveryId } : {})
      });
    }
    this.queue.close();
  }

  private onUpdate(update: Json, meta?: unknown): void {
    // agent 自己也会推全量配置（比如换模型后思考强度的可选值跟着变）。
    if (update['sessionUpdate'] === 'config_option_update') {
      this.setOptions(update['configOptions']);
      return;
    }
    if (this.replaying) {
      const fresh = this.replayEvents(this.decode(update, meta, false), update);
      // session/load 会回放历史，但也会重新上报当前命令表；命令不是历史，恢复会话时不能一起丢。
      if (this.replayBuffer === null && update['sessionUpdate'] === 'available_commands_update') {
        for (const entry of fresh) this.push(entry.event);
      }
      return;
    }

    const events = this.decode(update, meta, true);
    this.recordLive(events, update);
    for (const event of events) this.push(event);
  }

  /**
   * 进队列前去掉重复的命令表：session/load 之后 opencode 会再发一次 `available_commands_update`，
   * 内容没变就不该在每个 resync 周期往 journal 里加一行。
   */
  private push(event: SessionEvent): void {
    if (event.kind === 'commands') {
      const key = event.commands.map((command) => command.name).join(',');
      if (key === this.commandsKey) return;
      this.commandsKey = key;
    }
    if (PRODUCING.has(event.kind)) this.produced = true;
    this.queue.push(event);
  }

  /** 把一条 session/update 翻译成平台事件；codec 能处理就不走通用 mapper。 */
  private decode(update: Json, meta: unknown, reportErrors: boolean): readonly SessionEvent[] {
    if (this.codec) {
      try {
        const decoded = this.codec.decode({ update, meta, toolNames: this.toolNameView });
        if (decoded) return decoded.events;
      } catch (error) {
        if (reportErrors && !this.codecWarned) {
          this.codecWarned = true;
          this.queue.push({
            kind: 'diagnostic',
            level: 'error',
            text: `${this.config.label} 的 ACP codec 出错，已回退通用映射：${(error as Error).message}`
          });
        }
      }
    }
    // 重放里不更新 lastMessageId：那是「当前这一轮」的概念，历史不属于这一轮。
    if (reportErrors) this.noteMessageId(update);
    return mapAcpUpdate(update, this.toolNames);
  }

  private onChildUpdate(update: AcpChildUpdate): void {
    if (this.replaying) {
      this.replayEvents(this.decodeChild(update, false), update.update ?? {});
      return;
    }
    const events = this.decodeChild(update, true);
    this.recordLive(events, update.update ?? {});
    for (const event of events) {
      if (PRODUCING.has(event.kind)) this.produced = true;
      this.queue.push(event);
    }
  }

  private decodeChild(update: AcpChildUpdate, reportErrors: boolean): readonly SessionEvent[] {
    if (!this.codec?.childUpdate) return [];
    try {
      return this.codec.childUpdate(update, this.toolNameView);
    } catch (error) {
      if (reportErrors && !this.codecWarned) {
        this.codecWarned = true;
        this.queue.push({
          kind: 'diagnostic',
          level: 'error',
          text: `${this.config.label} 的 ACP codec 处理子会话更新失败：${(error as Error).message}`
        });
      }
      return [];
    }
  }

  /**
   * 重放里的事件算不算「新」：正文/思考按 `kind|subagentId|messageId` 的 chunk 高水位
   * （重放可能把多块合并成一块，所以按序号而不是按文本），tool / subagent / commands 按
   * 稳定指纹。open() 的基线重放也走这里——只记指纹、不进 `resync()` 的返回。
   */
  private replayEvents(events: readonly SessionEvent[], update: Json): readonly ResyncEntry[] {
    const chunks = this.replayChunks;
    if (!chunks) return [];
    const fresh: ResyncEntry[] = [];
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]!;
      if (event.kind === 'text' || event.kind === 'thinking') {
        const messageId = typeof update['messageId'] === 'string' && update['messageId'] ? update['messageId'] : null;
        // 没有稳定键就不重发：宁可漏，也不能把整段历史再灌一遍。
        if (messageId === null) continue;
        const base = `${event.kind}|${event.subagentId ?? ''}|${messageId}`;
        const nth = chunks.get(base) ?? 0;
        chunks.set(base, nth + 1);
        const seen = this.seenChunks.get(base) ?? 0;
        if (nth < seen) continue;
        this.seenChunks.set(base, nth + 1);
        fresh.push({ key: `${base}#${nth}`, event });
        continue;
      }
      const key = this.eventKey(event, update, index);
      if (key === null || this.seenKeys.has(key)) continue;
      this.seenKeys.add(key);
      fresh.push({ key, event });
    }
    for (const entry of fresh) this.replayBuffer?.push(entry);
    return fresh;
  }

  /** 实时事件也要记指纹，否则 resync 会把已发过的内容当成「重放里的新事件」再发一遍。 */
  private recordLive(events: readonly SessionEvent[], update: Json): void {
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]!;
      if (event.kind === 'text' || event.kind === 'thinking') {
        const messageId = typeof update['messageId'] === 'string' && update['messageId'] ? update['messageId'] : null;
        if (messageId === null) continue;
        const base = `${event.kind}|${event.subagentId ?? ''}|${messageId}`;
        this.seenChunks.set(base, (this.seenChunks.get(base) ?? 0) + 1);
        continue;
      }
      const key = this.eventKey(event, update, index);
      if (key !== null) this.seenKeys.add(key);
    }
  }

  private eventKey(event: SessionEvent, update: Json, index: number): string | null {
    switch (event.kind) {
      case 'subagent':
        return `subagent|${event.id}|${event.phase}`;
      case 'tool_call':
      case 'tool_result':
      case 'artifact': {
        const toolCallId = typeof update['toolCallId'] === 'string' ? update['toolCallId'] : '';
        if (!toolCallId) return null;
        return `tool|${event.subagentId ?? ''}|${toolCallId}|${String(update['status'] ?? '')}|${event.kind}|${index}`;
      }
      case 'commands':
        return `commands|${event.commands.map((command) => command.name).join(',')}`;
      default:
        // 诊断/用量/批准这类在重放里没有稳定身份，宁可不重发。
        return null;
    }
  }

  /** 最后一条 assistant 消息 id 只认父会话的正文/思考块；子会话不参与原生分叉。 */
  private noteMessageId(update: Json): void {
    const kind = update['sessionUpdate'];
    if ((kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') && typeof update['messageId'] === 'string' && update['messageId']) {
      this.lastMessageId = update['messageId'];
    }
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
    const base = mapAcpOptions(raw, this.config.optionOverrides);
    if (base.length === 0) return;
    let options = base;
    if (this.config.codec?.options) {
      try {
        options = this.config.codec.options(base, this.config);
      } catch (error) {
        if (!this.codecWarned) {
          this.codecWarned = true;
          this.queue.push({ kind: 'diagnostic', level: 'error', text: `${this.config.label} 的 ACP codec 选项映射出错，已忽略：${(error as Error).message}` });
        }
      }
    }
    this.publish(options);
  }

  /** 收尾 codec 维护的状态（比如所有子代理）。失败只报一次诊断，不打断会话。 */
  private finishCodec(status: 'completed' | 'failed' | 'cancelled'): void {
    if (!this.codec) return;
    try {
      for (const event of this.codec.finish(status)) this.queue.push(event);
    } catch (error) {
      if (!this.codecWarned) {
        this.codecWarned = true;
        this.queue.push({ kind: 'diagnostic', level: 'error', text: `${this.config.label} 的 ACP codec 收尾失败：${(error as Error).message}` });
      }
    }
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
    const clientCapabilities =
      this.config.codec?.id === 'opencode'
        ? { ...CLIENT_CAPABILITIES, _meta: { 'opencode/child-session-updates': true } }
        : CLIENT_CAPABILITIES;
    const init = await this.request('initialize', { protocolVersion: 1, clientCapabilities });
    this.init = init;
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

  async open(cwd: string, agentSessionRef: string | null, branch: BranchSpec | null = null): Promise<void> {
    await this.handshake();
    // resync 的 session/load 要原样带上同一个 cwd，这里记一次，调用方不用再传。
    this.cwd = cwd;
    if (branch) {
      const caps = (this.init['agentCapabilities'] as Json | undefined)?.['sessionCapabilities'] as Json | undefined;
      if (!caps?.['fork']) throw new Error(`${this.config.label} 没有声明 session/fork`);
      if (!branch.previousTurnRef) throw new Error('没有上一轮的 assistant 消息 id');
      const params = this.sessionParams(cwd);
      const meta = (params['_meta'] as Json | undefined) ?? {};
      const jetbrains = (meta['jetbrains'] as Json | undefined) ?? {};
      const air = (jetbrains['air'] as Json | undefined) ?? {};
      const session = await this.request('session/fork', {
        sessionId: branch.fromAgentSessionRef,
        ...params,
        _meta: { ...meta, jetbrains: { ...jetbrains, air: { ...air, fork: { version: 1, messageId: branch.previousTurnRef } } } }
      });
      if (typeof session['sessionId'] !== 'string' || !session['sessionId']) throw new Error('session/fork 没有返回新会话 id');
      this.agentSessionId = session['sessionId'];
      this.setReported(session);
      return;
    }
    if (agentSessionRef === null) {
      const session = await this.request('session/new', this.sessionParams(cwd));
      if (typeof session['sessionId'] === 'string') this.agentSessionId = session['sessionId'];
      this.setReported(session);
      return;
    }
    this.replaying = true;
    this.beginReplay(null);
    try {
      const session = await this.request('session/load', { sessionId: agentSessionRef, ...this.sessionParams(cwd) });
      this.setReported(session);
    } finally {
      this.finishReplay();
      this.replaying = false;
    }
    this.agentSessionId = agentSessionRef;
  }

  /**
   * 重放一遍当前 agent 会话历史，只返回平台还没有的**新**事件。
   *
   * 为什么需要：opencode 在后台子代理还在跑时也会给 `session/prompt` 回 end_turn，
   * 之后不再推任何 `session/update`；子代理完成时注入的总结只有再 `session/load`
   * 才会在重放里出现。ACP 没有 history 读取方法，load 是唯一补洞手段。
   */
  async resync(): Promise<readonly ResyncEntry[]> {
    if (this.disposed) return [];
    if (!this.agentSessionId) return [];
    // 同一时刻只允许一次：两次 load 的 session/update 会交错，chunk 顺序就乱了。
    if (this.resyncing) return this.resyncing;
    const run = (async (): Promise<readonly ResyncEntry[]> => {
      this.replaying = true;
      this.beginReplay([]);
      try {
        await this.request('session/load', { sessionId: this.agentSessionId, ...this.sessionParams(this.cwd) });
        return this.replayBuffer ? [...this.replayBuffer] : [];
      } finally {
        this.finishReplay();
        this.replaying = false;
      }
    })();
    this.resyncing = run;
    try {
      return await run;
    } finally {
      if (this.resyncing === run) this.resyncing = null;
    }
  }

  private beginReplay(buffer: ResyncEntry[] | null): void {
    this.replayBuffer = buffer;
    this.replayChunks = new Map();
  }

  private finishReplay(): void {
    this.replayBuffer = null;
    this.replayChunks = null;
  }

  /** 还没结束的子代理数量；>0 说明后台还有活，worker 该继续 resync。 */
  pendingSubagents(): number {
    try {
      return this.codec?.pendingSubagents?.() ?? 0;
    } catch {
      return 0;
    }
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
    // 一条 ACP 会话同时只允许一轮 session/prompt：并发会把两轮的 update 混在一起，
    // 也会让「这条 ended 属于谁」重新变成按顺序猜。
    if (this.turn !== null) return { ok: false, error: unavailable(`${this.config.label} 上一轮还没结束，不能并发发送`) };
    this.turn = { deliveryId: input.deliveryId && input.deliveryId.length > 0 ? input.deliveryId : null };
    this.produced = false;
    this.lastMessageId = null;
    try {
      const result = await this.request('session/prompt', {
        sessionId: this.agentSessionId,
        prompt: blocks.value
      });
      // 拿到这一条 session/prompt 的应答 = 这一轮的确切终态：现在才清 turn，并把它的 deliveryId 带下去。
      const turn = this.turn;
      this.turn = null;
      // 空回合时 agent 往往刚在 stderr 上写了原因：等一小会儿让管道里的那几行到齐
      if (!this.produced) await new Promise((resolve) => setTimeout(resolve, 200));
      if (this.lastMessageId) this.onTurnRef?.(this.lastMessageId);
      // 保活时不要在这一轮收尾 codec：子代理可能还在跑（后台 task），
      // 让它们的 end 由真实信号（child_update 终态 / 父工具终态内容）决定。
      if (!this.keepAlive) this.finishCodec('completed');
      // ended 是**回合**事件：提示这一轮完了，不是进程完了。
      this.queue.push(
        endedFromStopReason(result['stopReason'], {
          produced: this.produced,
          stderrTail: this.produced ? [] : this.stderr.tail(),
          ...(turn?.deliveryId ? { deliveryId: turn.deliveryId } : {})
        })
      );
      // 保活（默认）：队列不关，后续 session/update（比如后台子代理的进展）继续产出事件。
      // dispose() 仍是唯一真正关闭的路径；要回到「一轮一个进程」的老行为才传 keepAlive: false。
      if (!this.keepAlive) this.queue.close();
      return { ok: true, value: undefined };
    } catch (error) {
      this.turn = null;
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
  /**
   * 回合结束后保留进程（默认 true）：ended 只是回合事件，事件队列不关，
   * 后台子代理这类跨回合的 session/update 还能推上来；dispose() 仍是唯一真正关闭的路径。
   */
  readonly keepAlive?: boolean;
  readonly onAgentSessionRef?: (sessionId: string, agentSessionRef: string) => void;
  /** agent 报上来的可调项（含当前值），worker 用它告诉 server。 */
  readonly onOptions?: (sessionId: string, options: readonly RuntimeOption[]) => void;
  /** 每轮的原生标识（ADR 0028），只对能原生分叉的 agent 报。 */
  readonly onTurnRef?: (sessionId: string, turnRef: string) => void;
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
        // 没有资产也要调一次 launch：Hermes 靠它无条件设 HERMES_HOME，不能因为没装技能就去读 ~/.hermes。
        launch = config.launch ? await config.launch(spec.assets) : {};
        if (spec.provider && config.providerLaunch) launch = await config.providerLaunch(spec.sessionId, spec.provider, launch);
        child = spawn(config.command, [...(launch.args ?? config.args)], {
          cwd: spec.workspaceRoot,
          stdio: ['pipe', 'pipe', 'pipe'],
          ...(config.env || launch.env ? { env: { ...process.env, ...config.env, ...launch.env } } : {})
        });
      } catch (error) {
        return { ok: false, error: unavailable(`无法启动 ${config.label}：${(error as Error).message}`) };
      }
      // 命令不存在时 spawn 会异步抛 error；不接住就会崩掉整个 worker。
      child.on('error', () => {});

      const session = new AcpSession(spec.sessionId, child, config, (reported) => {
        options.onOptions?.(spec.sessionId, reported);
      }, options.keepAlive ?? true);
      session.tools = spec.tools;
      session.mcp = spec.mcp;
      session.toolShim = options.toolShim;
      session.launchMeta = launch.sessionMeta;
      const dialect = acpBranchAtTurn(config);
      if (dialect && options.onTurnRef) session.onTurnRef = (turnRef) => options.onTurnRef?.(spec.sessionId, turnRef);
      if (spec.branch && !dialect) {
        await session.dispose();
        return { ok: false, error: unavailable(`${config.label} 不能从某条消息原生分叉`) };
      }
      const ref = spec.resume?.agentSessionRef ?? null;
      try {
        await session.open(spec.workspaceRoot, ref, spec.resume ? null : (spec.branch ?? null));
      } catch (error) {
        await session.dispose();
        return { ok: false, error: unavailable(`${config.label} 握手失败：${(error as Error).message}`) };
      }

      // 开跑前用户已经选好的项（派生时选的模型、思考强度），交给 agent 去落实。
      // 模型也是一个配置项（ACP 的 category: model），与其余选项走同一条 set_config_option；
      // 但它必须先落——思考强度这类项只在选定模型之后才出现在清单里。
      const entries = Object.entries(spec.options).sort(([left], [right]) => Number(right === 'model') - Number(left === 'model'));
      for (const [id, raw] of entries) {
        const known = session.options().some((option) => option.id === id);
        const changed = await session.changeOption(id, raw);
        if (changed.ok) continue;
        // agent 没上报过这个键：多半是 bot / 配置里留下的多余默认值，跳过并记一笔，
        // 别为一个不生效的默认值把整条会话杀掉。值不合法（键认得）仍然失败。
        if (!known) {
          console.warn(`[${config.label}] 跳过未知配置项 ${id}：agent 没有上报它`);
          continue;
        }
        await session.dispose();
        return changed;
      }

      options.onAgentSessionRef?.(spec.sessionId, session.agentRef || ref || 'pending');
      return { ok: true, value: session };
    }
  } satisfies AgentRuntime;
}
