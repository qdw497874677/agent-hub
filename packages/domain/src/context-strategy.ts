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

/** hub 已安装（锁定版本）的策略。只有 cluster_admin 能装新的（P1 只有内置的一个）。 */
export const BUILTIN_STRATEGIES: readonly ContextStrategy[] = [compactionStrategy];

/** 候选（不能选，只在界面上列出来说明）。 */
export const CANDIDATE_STRATEGIES: readonly { id: string; title: string; note: string }[] = [
  { id: 'trim', title: '截断', note: '候选（P3）' },
  { id: 'tool-clear', title: '清理旧工具结果', note: '候选（P3）' },
  { id: 'summarize-window', title: '滑动窗口摘要', note: '候选（P3）' },
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
  if (runtime === 'pi')
    return {
      runtime,
      modes: ['native'],
      l1: { ...common, usage: 'estimated', compactionEvents: 'missing', compact: 'missing' },
      gaps: ['用量是 hub 按事件估算的（pi RPC get_session_stats 还没接）', '原生压缩事件还没接（compaction_start / end）', '手动压缩退回为重启会话']
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

function pickMode(strategy: ContextStrategy, capability: ContextCapability): ContextMode | null {
  for (const mode of ['hub-managed', 'runtime-plugin', 'native'] as const) if (strategy.modes.includes(mode) && capability.modes.includes(mode)) return mode;
  return null;
}

export const DEFAULT_WINDOW_TOKENS = 128_000;

/**
 * L1 兜底：运行时报不出用量时，按 hub 事件流估算这一代的上下文用量。
 * 只算会进模型上下文的东西（提问、回复、工具调用和结果）；思考和诊断不算。
 */
export function estimateContextUsage(events: readonly JournalEntry[], windowTokens = DEFAULT_WINDOW_TOKENS): { usedTokens: number; windowTokens: number; estimated: true; usedRatio: number; level: 'ok' | 'soft' | 'hard' } {
  let used = 0;
  for (const { event } of events) {
    if (event.kind === 'prompt' || event.kind === 'text') used += estimateTokens(event.kind === 'prompt' ? event.text : event.delta);
    else if (event.kind === 'tool_call') used += estimateTokens(event.name + event.input);
    else if (event.kind === 'tool_result') used += estimateTokens(event.output ?? '');
  }
  const usedRatio = windowTokens > 0 ? used / windowTokens : 0;
  return { usedTokens: used, windowTokens, estimated: true, usedRatio, level: usedRatio >= 0.95 ? 'hard' : usedRatio >= 0.7 ? 'soft' : 'ok' };
}

/** 策略引导的硬上限（ADR 0020 决定 6）。P1 的 compaction 不注入，只有 ADR 0019 的那一行记忆引导。 */
export const GUIDANCE_LIMITS = { compactGuideTokens: 1500, nudgeTokens: 200 } as const;
