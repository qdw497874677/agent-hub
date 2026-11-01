import type { JournalEntry } from './event.ts';
import { estimateTokens } from './memory.ts';

/**
 * 会话上下文策略（ADR 0020 · P1）。
 *
 * - 每条会话恰好一个策略，选择顺序：会话 > 角色 > 项目 > hub 默认；会话级只能从项目已启用的里选。
 * - P1 只内置 `compaction`（摘要替换，运行时有原生压缩就用原生的）；`trim` / `tool-clear` /
 *   `summarize-window` / `paging` 是候选，`context-pruning`（主动上下文剪枝）先不做。
 * - 运行时选不了某个策略时退回 `compaction`，会话上标出来。
 * - hub 的原始记录（session_events）永远不动：策略只产出视图和旁路状态。
 */
export type ContextMode = 'hub-managed' | 'native' | 'runtime-plugin';
export const CONTEXT_MODES: readonly ContextMode[] = ['hub-managed', 'native', 'runtime-plugin'];

export type MsgId = string;
export interface MsgRange { readonly from: MsgId; readonly to: MsgId }

export interface ContextBudget {
  readonly windowTokens: number;
  readonly usedTokens: number;
  readonly reserveTokens: number;
  readonly softLimit: number;
  readonly hardLimit: number;
}

export interface ContextMessage {
  readonly id: MsgId;
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: unknown;
  readonly tokens: number;
  readonly tool?: string;
  /** assistant 消息里发起的工具调用 id；tool 消息对应的调用 id（协议要求成对，不能拆开）。 */
  readonly calls?: readonly string[];
  readonly callId?: string;
  /** 策略把这条工具结果清理掉了（运行时用占位文字替换内容）。 */
  readonly cleared?: boolean;
}
export interface ContextView {
  readonly messages: readonly ContextMessage[];
  /** 策略注入的引导文字：政策，不是记忆。只能来自策略包的静态模板 + 用量数字。 */
  readonly guidance: readonly string[];
}
export interface StrategyState { readonly schemaVersion: number; readonly data: unknown }

/** 策略产出的事件：写进会话事件流，提炼和 UI 都读它。 */
export type StrategyEvent =
  | { readonly kind: 'compressed'; readonly range: MsgRange; readonly tier: number; readonly summary: string; readonly blockId: string }
  | { readonly kind: 'decompressed'; readonly blockId: string }
  | { readonly kind: 'compacted'; readonly range: MsgRange; readonly summary: string; readonly native: boolean }
  | { readonly kind: 'truncated'; readonly range: MsgRange }
  | { readonly kind: 'nudge'; readonly level: 'soft' | 'hard'; readonly usedRatio: number }
  | { readonly kind: 'principle-candidate'; readonly text: string; readonly scope: 'role' | 'project'; readonly range?: MsgRange; readonly proposedBy: 'agent' | 'strategy' | 'distill' };

export interface StrategyTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
  call(args: unknown, ctx: { state: StrategyState; transcript: ContextView }): Promise<{ result: unknown; state: StrategyState; events: StrategyEvent[] }>;
}

/** 端口：和长期记忆（MemoryService）分开。 */
export interface ContextStrategy {
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly modes: readonly ContextMode[];
  transform?(input: { transcript: ContextView; state: StrategyState; budget: ContextBudget }): Promise<{ view: ContextView; state: StrategyState; events: StrategyEvent[] }>;
  onCompact?(input: { reason: 'threshold' | 'manual' | 'native'; transcript: ContextView; state: StrategyState; budget: ContextBudget }): Promise<{ state: StrategyState; events: StrategyEvent[] }>;
  tools?(): readonly StrategyTool[];
  initialState(): StrategyState;
  replay(transcript: ContextView): Promise<StrategyState>;
  pluginConfig?(target: { runtime: string; pluginVersion: string }): unknown;
}

export const DEFAULT_STRATEGY_ID = 'compaction';

/** 默认策略：native 优先（运行时自己压缩，hub 只观察记录）；hub 不改写上下文，不注入引导。 */
export const compactionStrategy: ContextStrategy = {
  id: 'compaction',
  version: '1',
  title: '自动压缩（默认）',
  modes: ['native', 'hub-managed'],
  initialState: () => ({ schemaVersion: 1, data: null }),
  replay: async () => ({ schemaVersion: 1, data: null }),
  onCompact: async ({ state }) => ({ state, events: [] })
};

/** hub-managed 策略的触发点和保留量（ADR 没定具体数字，取保守值：到软上限才动，动完留一半窗口）。 */
export const HUB_MANAGED_LIMITS = { softRatio: 0.7, keepRatio: 0.5, keepToolResults: 5 } as const;
export const TOOL_CLEARED_TEXT = '旧工具结果已清理，可以重新执行';
export const TRIM_GUIDANCE = '更早的对话已被截断（完整原文仍在 hub 会话记录里，需要时可以用 memory_search 查）。';

const stateless = { initialState: () => ({ schemaVersion: 1, data: null }), replay: async () => ({ schemaVersion: 1, data: null }) };

/** 最后一条用户消息的下标（底线：它和它之后的内容永远不动）。 */
const lastUserIndex = (messages: readonly ContextMessage[]): number => {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === 'user') return i;
  return -1;
};
const sumTokens = (messages: readonly ContextMessage[]): number => messages.reduce((n, m) => n + m.tokens, 0);

/**
 * 截断（P3）：超过软上限时，从后往前按「整轮」（以用户消息开头）保留，直到占满 keepRatio 个窗口。
 * 切点总在用户消息上，所以工具调用 / 结果对不会被拆开；system 消息总是保留；最后一轮总是保留。
 */
export const trimStrategy: ContextStrategy = {
  id: 'trim',
  version: '1',
  title: '截断（保留最近几轮）',
  modes: ['hub-managed'],
  ...stateless,
  async transform({ transcript, state, budget }) {
    const msgs = transcript.messages;
    const used = sumTokens(msgs);
    if (used <= budget.softLimit) return { view: transcript, state, events: [] };
    const keepBudget = Math.floor(budget.windowTokens * HUB_MANAGED_LIMITS.keepRatio);
    const floor = lastUserIndex(msgs);
    if (floor <= 0) return { view: transcript, state, events: [] };
    const system = msgs.filter((m) => m.role === 'system');
    let cut = floor;
    let kept = sumTokens(msgs.slice(floor).filter((m) => m.role !== 'system')) + sumTokens(system);
    for (let i = floor - 1; i >= 0; i--) {
      if (msgs[i]!.role !== 'user') continue;
      const turn = sumTokens(msgs.slice(i, cut).filter((m) => m.role !== 'system'));
      if (kept + turn > keepBudget) break;
      kept += turn;
      cut = i;
    }
    const dropped = msgs.slice(0, cut).filter((m) => m.role !== 'system');
    if (dropped.length === 0) return { view: transcript, state, events: [] };
    const messages = [...msgs.slice(0, cut).filter((m) => m.role === 'system'), ...msgs.slice(cut)];
    return {
      view: { messages, guidance: [...transcript.guidance, TRIM_GUIDANCE] },
      state,
      events: [{ kind: 'truncated', range: { from: dropped[0]!.id, to: dropped[dropped.length - 1]!.id } }]
    };
  }
};

/**
 * 清理旧工具结果（P3）：超过软上限时，最近 keepToolResults 条工具结果之外的都换成占位文字。
 * 只换内容不删消息，调用 / 结果对还在；最后一条用户消息之后（正在进行的这一轮）不动。
 */
export const toolClearStrategy: ContextStrategy = {
  id: 'tool-clear',
  version: '1',
  title: '清理旧工具结果',
  modes: ['hub-managed'],
  ...stateless,
  async transform({ transcript, state, budget }) {
    const msgs = transcript.messages;
    if (sumTokens(msgs) <= budget.softLimit) return { view: transcript, state, events: [] };
    const floor = lastUserIndex(msgs);
    const tools = msgs.map((m, i) => ({ m, i })).filter(({ m, i }) => m.role === 'tool' && !m.cleared && (floor < 0 || i < floor));
    const clear = new Set(tools.slice(0, Math.max(0, tools.length - HUB_MANAGED_LIMITS.keepToolResults)).map(({ m }) => m.id));
    if (clear.size === 0) return { view: transcript, state, events: [] };
    const messages = msgs.map((m) => (clear.has(m.id) ? { ...m, cleared: true, tokens: 12 } : m));
    const ids = [...clear];
    return { view: { messages, guidance: transcript.guidance }, state, events: [{ kind: 'compressed', range: { from: ids[0]!, to: ids[ids.length - 1]! }, tier: 1, summary: TOOL_CLEARED_TEXT, blockId: `tool-clear:${ids[0]}` }] };
  }
};

/** hub 已安装（锁定版本）的策略。只有 cluster_admin 能装新的。 */
export const BUILTIN_STRATEGIES: readonly ContextStrategy[] = [compactionStrategy, trimStrategy, toolClearStrategy];

/** 候选（不能选，只在界面上列出来说明）。 */
export const CANDIDATE_STRATEGIES: readonly { id: string; title: string; note: string }[] = [
  { id: 'summarize-window', title: '滑动窗口摘要', note: '候选（要模型生成摘要，和模型提炼一起做）' },
  { id: 'paging', title: '分页换入换出', note: '候选（P4）' },
  { id: 'context-pruning', title: '主动上下文剪枝', note: '先不做' }
];

/** L1 每一项现在是怎么做到的：runtime = 运行时给的准确值；estimated = hub 估算 / 兜底；missing = 做不到。 */
export type L1Level = 'runtime' | 'estimated' | 'missing';
export interface ContextCapability {
  readonly runtime: 'pi' | 'grok' | 'acp';
  readonly modes: readonly ContextMode[];
  readonly l1: {
    readonly usage: L1Level;
    readonly compactionEvents: L1Level;
    readonly transcript: L1Level;
    /** missing 时「触发压缩」退回「重启会话」。 */
    readonly compact: L1Level;
    readonly restart: L1Level;
    readonly memoryTools: L1Level;
  };
  /** 给界面看的缺口说明。 */
  readonly gaps: readonly string[];
}

/**
 * 运行时的上下文能力（ADR 0020 §5.3 矩阵，按 hub 现在真正接上了什么来声明，不按运行时理论上能做什么）。
 * 记录导出由 hub 的事件流完成；记忆工具走 hub MCP（ADR 0019）。
 */
export function contextCapabilityOf(agentId: string): ContextCapability {
  const runtime: ContextCapability['runtime'] = agentId === 'pi' || agentId.startsWith('pi-') ? 'pi' : agentId === 'grok' || agentId.startsWith('grok-') ? 'grok' : 'acp';
  const common = { transcript: 'runtime', restart: 'runtime', memoryTools: 'runtime' } as const;
  // pi：hub 自带的扩展把 `context` 事件转给 hub（hub-managed，P3）；旧 worker 没这个扩展时 hub-managed 策略不生效。
  if (runtime === 'pi')
    return {
      runtime,
      modes: ['native', 'hub-managed'],
      l1: { ...common, usage: 'runtime', compactionEvents: 'runtime', compact: 'runtime' },
      gaps: []
    };
  if (runtime === 'grok')
    return {
      runtime,
      modes: ['native'],
      l1: { ...common, usage: 'estimated', compactionEvents: 'missing', compact: 'missing' },
      gaps: ['grok 的协议还没查清：用量是 hub 估算的', '看不到原生压缩事件', '手动压缩退回为重启会话']
    };
  return {
    runtime,
    modes: ['native'],
    l1: { ...common, usage: 'estimated', compactionEvents: 'missing', compact: 'missing' },
    gaps: ['ACP 的 usage_update 还在 RFD：用量是 hub 估算的', 'ACP 没有压缩事件（要 opencode 插件补）', '手动压缩退回为重启会话']
  };
}

export interface StrategyChoice { readonly strategy: string; readonly params?: Readonly<Record<string, unknown>> }
export interface ContextLayers {
  readonly session?: StrategyChoice | null;
  readonly role?: StrategyChoice | null;
  readonly project?: StrategyChoice | null;
  readonly hub?: StrategyChoice | null;
}
export interface ResolvedStrategy {
  readonly strategy: ContextStrategy;
  readonly mode: ContextMode;
  readonly source: 'session' | 'role' | 'project' | 'hub' | 'default';
  /** 选的策略运行时不支持（或没安装 / 项目没启用），退回了默认。 */
  readonly fallback: { readonly wanted: string; readonly reason: string } | null;
}

/** 选策略：会话 > 角色 > 项目 > hub；按 hub-managed > runtime-plugin > native 挑模式；不支持就退回 compaction。 */
export function resolveContextStrategy(input: {
  layers: ContextLayers;
  capability: ContextCapability;
  installed?: readonly ContextStrategy[];
  /** 项目启用的策略；会话 / 角色只能从这里选。 */
  enabled?: readonly string[];
}): ResolvedStrategy {
  const installed = input.installed ?? BUILTIN_STRATEGIES;
  const order = ['session', 'role', 'project', 'hub'] as const;
  const picked = order.map((source) => ({ source, choice: input.layers[source] })).find((x) => x.choice);
  const byId = (id: string) => installed.find((s) => s.id === id) ?? null;
  const fallbackTo = (wanted: string, reason: string): ResolvedStrategy => ({ strategy: byId(DEFAULT_STRATEGY_ID) ?? compactionStrategy, mode: 'native', source: picked?.source ?? 'default', fallback: { wanted, reason } });
  if (!picked) return { strategy: byId(DEFAULT_STRATEGY_ID) ?? compactionStrategy, mode: pickMode(compactionStrategy, input.capability) ?? 'native', source: 'default', fallback: null };
  const wanted = picked.choice!.strategy;
  const strategy = byId(wanted);
  if (!strategy) return fallbackTo(wanted, '这个策略没安装');
  if ((picked.source === 'session' || picked.source === 'role') && input.enabled && !input.enabled.includes(wanted)) return fallbackTo(wanted, '项目没启用这个策略');
  const mode = pickMode(strategy, input.capability);
  if (!mode) return fallbackTo(wanted, '运行时不支持这个策略');
  return { strategy, mode, source: picked.source, fallback: null };
}

/** 按策略自己列的先后挑（compaction 先 native：运行时自己压缩，hub 不介入）。 */
function pickMode(strategy: ContextStrategy, capability: ContextCapability): ContextMode | null {
  for (const mode of strategy.modes) if (capability.modes.includes(mode)) return mode;
  return null;
}

export const DEFAULT_WINDOW_TOKENS = 128_000;

export interface ContextUsage {
  readonly usedTokens: number;
  readonly windowTokens: number;
  /** true = hub 按事件估算；false = 运行时报的（context_usage 事件）。 */
  readonly estimated: boolean;
  readonly usedRatio: number;
  readonly level: 'ok' | 'soft' | 'hard';
  /** 最近一次压缩（运行时原生）；没有就是 null。 */
  readonly lastCompaction: { readonly seq: number; readonly ok: boolean; readonly tokensBefore: number | null; readonly tokensAfter: number | null } | null;
}

const levelOf = (ratio: number): ContextUsage['level'] => (ratio >= 0.95 ? 'hard' : ratio >= 0.7 ? 'soft' : 'ok');

/**
 * L1 用量：运行时报过 context_usage 就用最后一条（刚压缩完还没新数时用压缩后的估计值）；
 * 否则按 hub 事件流估算——只算会进模型上下文的东西（提问、回复、工具调用和结果）；思考和诊断不算；
 * 估算只算最近一次成功压缩之后的事件。
 */
export function estimateContextUsage(events: readonly JournalEntry[], windowTokens = DEFAULT_WINDOW_TOKENS): ContextUsage {
  let used = 0;
  let runtime: { used: number | null; window: number } | null = null;
  let lastCompaction: ContextUsage['lastCompaction'] = null;
  for (const { seq, event } of events) {
    if (event.kind === 'prompt' || event.kind === 'text') used += estimateTokens(event.kind === 'prompt' ? event.text : event.delta);
    else if (event.kind === 'tool_call') used += estimateTokens(event.name + event.input);
    else if (event.kind === 'tool_result') used += estimateTokens(event.output ?? '');
    else if (event.kind === 'context_usage') runtime = { used: event.usedTokens, window: event.windowTokens };
    else if (event.kind === 'compaction' && event.phase === 'end') {
      lastCompaction = { seq: Number(seq), ok: event.ok === true, tokensBefore: event.tokensBefore ?? null, tokensAfter: event.tokensAfter ?? null };
      if (event.ok) {
        used = event.tokensAfter ?? 0;
        if (runtime) runtime = { used: event.tokensAfter ?? null, window: runtime.window };
      }
    }
  }
  if (runtime && runtime.used !== null) {
    const ratio = runtime.window > 0 ? runtime.used / runtime.window : 0;
    return { usedTokens: runtime.used, windowTokens: runtime.window, estimated: false, usedRatio: ratio, level: levelOf(ratio), lastCompaction };
  }
  const win = runtime?.window ?? windowTokens;
  const usedRatio = win > 0 ? used / win : 0;
  return { usedTokens: used, windowTokens: win, estimated: true, usedRatio, level: levelOf(usedRatio), lastCompaction };
}

/** 预算：窗口来自会话记录（运行时报的或默认值），软 / 硬上限按比例。 */
export function hubManagedBudget(windowTokens: number, usedTokens: number): ContextBudget {
  return { windowTokens, usedTokens, reserveTokens: 0, softLimit: Math.floor(windowTokens * HUB_MANAGED_LIMITS.softRatio), hardLimit: Math.floor(windowTokens * 0.95) };
}
