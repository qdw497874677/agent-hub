/**
 * 项目 / 任务上的「默认 Agent」界面侧纯逻辑（不含 React / DOM）。
 *
 * 真源在服务端：项目走 `PATCH /api/projects/:id` 的 `defaultAgent`，任务走
 * `PATCH /api/tasks/:id/default-agent`，形状都是 `{ runtime, model, options } | null`。
 * 新会话没点名 Agent 时的回落顺序：
 *   会话里显式选的 > 任务 > 项目 > 团队默认模型 > 运行时自己的默认
 *
 * 这里只做三件事：
 *   - 运行时候选（各台机器上报的 agentIds，机器离线也留着，标一下）；
 *   - 模型候选（在线机器上报的 agentModels + hub 提供商模型，`hub-<slug>/<model>`）；
 *   - 思考强度那一项的挑选（`category: 'thought_level'`，老数据按 id 兜底）与草稿互转。
 *
 * 界面上的「思考强度」只写 `options` 里的一个键，其它选项原样保留：保存时不能把
 * 用户从别处配好的选项（比如 agent 预设）悄悄抹掉。
 */
import { runtimeLabel } from './agent-defaults.ts';

/** 服务端 `defaultAgent` 的最小形状，和 `defaultAgentSchema` 对齐。 */
export interface DefaultAgentRef {
  readonly runtime: string;
  readonly model: string;
  readonly options: Readonly<Record<string, string | boolean>>;
}

/** `/api/workers` 里界面上要用到的那一块。 */
export interface DefaultAgentWorker {
  readonly state?: string;
  readonly agentIds?: readonly string[];
  readonly agentModels?: readonly {
    readonly agentId: string;
    readonly models?: readonly string[];
  }[];
}

/** 画布 agent 目录里界面上要用到的那一块（`AgentDto` 结构兼容）。 */
export interface DefaultAgentCatalogEntry {
  readonly id: string;
  readonly models?: readonly string[];
  readonly options?: readonly RuntimeOptionLike[];
}

export interface RuntimeChoice {
  readonly runtimeId: string;
  /** 这台 hub 上没有任何在线机器能跑它：仍然可以选，但标出来。 */
  readonly offline: boolean;
}

/**
 * 运行时候选：所有机器上报的 agentIds 去重（保持首次出现顺序）。
 * `extra` 给「正在用的运行时」兜底——那台机器当前离线时下拉里也还能显示它。
 * 机器离线不影响候选；没有任何在线机器认领的运行时标 `offline`。
 */
export function runtimeChoices(
  workers: readonly DefaultAgentWorker[],
  extra: readonly string[] = []
): RuntimeChoice[] {
  const order: string[] = [];
  const online = new Set<string>();
  const seen = new Set<string>();
  const add = (raw: string, isOnline: boolean): void => {
    const id = raw.trim();
    if (id === '') return;
    if (!seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
    if (isOnline) online.add(id);
  };
  for (const worker of workers) {
    const isOnline = worker.state !== 'offline';
    for (const id of worker.agentIds ?? []) add(id, isOnline);
    // 老 Worker 只报 agentModels，没有 agentIds。
    for (const entry of worker.agentModels ?? []) add(entry.agentId, isOnline);
  }
  for (const id of extra) add(id, false);
  return order.map((runtimeId) => ({ runtimeId, offline: !online.has(runtimeId) }));
}

export interface HubModelSource {
  readonly models: readonly { readonly id: string }[];
}

/**
 * 模型候选：在线机器上报的 agentModels → 画布 agent 目录 → hub 提供商（id 已是 `hub-<slug>/<model>`）。
 * 顺序即「先试哪台机器上报的名字」，去重后原样塞进 datalist；取不到就是空数组（纯手填）。
 */
export function modelChoices(
  workers: readonly DefaultAgentWorker[],
  runtime: string,
  agents: readonly DefaultAgentCatalogEntry[],
  hub: readonly HubModelSource[]
): string[] {
  const id = runtime.trim();
  const out: string[] = [];
  if (id === '') return out;
  const push = (raw: string): void => {
    const model = raw.trim();
    if (model !== '' && !out.includes(model)) out.push(model);
  };
  for (const worker of workers) {
    if (worker.state === 'offline') continue;
    for (const entry of worker.agentModels ?? []) {
      if (entry.agentId.trim() !== id) continue;
      for (const model of entry.models ?? []) push(model);
    }
  }
  for (const agent of agents) {
    if (agent.id !== id) continue;
    for (const model of agent.models ?? []) push(model);
  }
  for (const provider of hub) for (const model of provider.models) push(model.id);
  return out;
}

/** 思考/推理类选项的 category；`runtimeOptionSchema` 的枚举里有它。 */
export const THINKING_CATEGORY = 'thought_level';

/** 老数据没有 category 时的 id 兜底（各运行时的历史叫法）。 */
const THINKING_IDS = ['effort', 'thinking', 'thought_level'] as const;

export interface OptionValueLike {
  readonly value: string;
  readonly label: string;
}

export type OptionChoiceLike =
  | { readonly kind: 'value'; readonly value: OptionValueLike }
  | { readonly kind: 'group'; readonly label?: string; readonly values: readonly OptionValueLike[] };

export interface RuntimeOptionLike {
  readonly id: string;
  readonly label?: string;
  readonly category?: string;
  readonly kind?: string;
  readonly choices?: readonly OptionChoiceLike[];
}

/**
 * 这个运行时的「思考强度」选项，没有就返回 null（整行不显示）。
 * 先按 category 认；老数据没有 category 时按 id 认。boolean 类的开关不算档位。
 */
export function thinkingOption(
  options: readonly RuntimeOptionLike[] | null | undefined
): RuntimeOptionLike | null {
  const list = (options ?? []).filter((option) => option.kind !== 'boolean');
  const byCategory = list.find((option) => option.category === THINKING_CATEGORY);
  if (byCategory) return byCategory;
  for (const id of THINKING_IDS) {
    const found = list.find((option) => option.id === id);
    if (found) return found;
  }
  return null;
}

/** 选项的候选档位摊平（group 拆开），空值丢弃。 */
export function optionChoices(option: RuntimeOptionLike | null | undefined): OptionValueLike[] {
  const out: OptionValueLike[] = [];
  const seen = new Set<string>();
  for (const choice of option?.choices ?? []) {
    const values = choice.kind === 'group' ? choice.values : [choice.value];
    for (const value of values) {
      if (value.value === '' || seen.has(value.value)) continue;
      seen.add(value.value);
      out.push(value);
    }
  }
  return out;
}

/** 表单草稿：思考强度单独放一个字段，`effortKey` 记录它写回 options 的哪个键。 */
export interface AgentDraft {
  readonly runtime: string;
  readonly model: string;
  readonly effort: string;
  /** 空串 = 这个运行时不支持思考强度（不写 options）。 */
  readonly effortKey: string;
}

export const EMPTY_AGENT_DRAFT: AgentDraft = {
  runtime: '',
  model: '',
  effort: '',
  effortKey: ''
};

const legacyEffortKey = (options: Readonly<Record<string, string | boolean>>): string => {
  for (const id of THINKING_IDS) {
    if (typeof options[id] === 'string') return id;
  }
  return '';
};

/** 服务端值 → 草稿。`thinkingId` 来自 agent 目录，拿不到时按老数据里的键兜底。 */
export function agentDraft(
  value: DefaultAgentRef | null | undefined,
  thinkingId?: string | null
): AgentDraft {
  if (value === null || value === undefined || value.runtime.trim() === '') return EMPTY_AGENT_DRAFT;
  const key = thinkingId ?? legacyEffortKey(value.options);
  const raw = key === '' ? undefined : value.options[key];
  return {
    runtime: value.runtime,
    model: value.model,
    effort: typeof raw === 'string' ? raw : '',
    effortKey: key
  };
}

/**
 * 草稿 → 请求体。空运行时 = 清掉（null）。
 * options 以服务端原值为底：同一个运行时只改思考强度那一键，其它键原样带回去。
 */
export function draftAgent(
  base: DefaultAgentRef | null | undefined,
  draft: AgentDraft
): DefaultAgentRef | null {
  const runtime = draft.runtime.trim();
  if (runtime === '') return null;
  const options: Record<string, string | boolean> = {};
  if (base !== null && base !== undefined && base.runtime === runtime) {
    Object.assign(options, base.options);
  }
  if (draft.effortKey !== '') {
    const effort = draft.effort.trim();
    if (effort === '') delete options[draft.effortKey];
    else options[draft.effortKey] = effort;
  }
  return { runtime, model: draft.model.trim(), options };
}

export function sameDraft(left: AgentDraft, right: AgentDraft): boolean {
  return left.runtime === right.runtime && left.model === right.model && left.effort === right.effort;
}

const normalize = (value: DefaultAgentRef | null | undefined): DefaultAgentRef | null => {
  if (value === null || value === undefined || value.runtime.trim() === '') return null;
  return { runtime: value.runtime, model: value.model, options: value.options };
};

export function hasDefaultAgent(value: DefaultAgentRef | null | undefined): boolean {
  return normalize(value) !== null;
}

export function sameDefaultAgent(
  left: DefaultAgentRef | null | undefined,
  right: DefaultAgentRef | null | undefined
): boolean {
  const a = normalize(left);
  const b = normalize(right);
  if (a === null || b === null) return a === b;
  if (a.runtime !== b.runtime || a.model !== b.model) return false;
  const keys = new Set([...Object.keys(a.options), ...Object.keys(b.options)]);
  for (const key of keys) {
    if (a.options[key] !== b.options[key]) return false;
  }
  return true;
}

/**
 * 任务详情里那一行的摘要：没配 → 「跟随项目」；
 * 配了 → 「OpenCode · gpt-5.1-codex · 思考：高」（模型空 = 运行时默认模型，档位找不到标签就显示原值）。
 */
export function defaultAgentSummary(
  value: DefaultAgentRef | null | undefined,
  options?: readonly RuntimeOptionLike[] | null
): string {
  const agent = normalize(value);
  if (agent === null) return '跟随项目';
  const parts: string[] = [runtimeLabel(agent.runtime)];
  const model = agent.model.trim();
  parts.push(model === '' ? '运行时默认模型' : model);
  const key = legacyEffortKey(agent.options);
  const effort = key === '' ? undefined : agent.options[key];
  if (typeof effort === 'string' && effort !== '') {
    const label = optionChoices(thinkingOption(options)).find((choice) => choice.value === effort);
    parts.push(`思考：${label?.label ?? effort}`);
  }
  return parts.join(' · ');
}
