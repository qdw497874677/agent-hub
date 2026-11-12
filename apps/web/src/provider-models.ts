/**
 * 提供商表单里「模型」一列的纯逻辑：拉取结果合并、额外参数 JSON 校验、行状态 → 保存载荷。
 *
 * 界面只负责渲染和收集输入，规则都在这里，方便单测盯住；后端还会用 domain 的
 * `providerModelExtraError` 再校验一遍，两边的约束保持一致（JSON 对象、≤4KB、不覆盖会话字段）。
 */
/**
 * 一个可保存的模型（`api.ts` 的 `ProviderModelDto` 就是它）。
 *
 * 形状写在这个不带 DOM / JSX 的模块里，`api.ts` 反向引用：根 tsconfig 只把 web 的
 * 单测文件拉进来编译，而它没有 DOM lib，编不动 `api.ts`。
 */
export interface ProviderModelSpec {
  readonly id: string;
  readonly name?: string;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  /** 合并进这个模型上游请求体顶层的额外参数（思考模式、采样参数之类）。 */
  readonly extra?: Readonly<Record<string, unknown>>;
}

/** 由会话 / agent 自己决定，额外参数不能覆盖（与 domain PROVIDER_MODEL_EXTRA_FORBIDDEN_KEYS 一致）。 */
export const FORBIDDEN_EXTRA_KEYS = ['model', 'messages', 'input', 'stream', 'stream_options', 'tools'] as const;
/** 额外参数序列化后的上限（与 domain PROVIDER_MODEL_EXTRA_MAX_BYTES 一致）。 */
export const EXTRA_MAX_BYTES = 4096;

/** 上游 /v1/models 这类接口报上来的一个模型。 */
export interface PulledModel {
  readonly id: string;
  readonly name?: string;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
}

/**
 * 一行模型的编辑状态。数字和 JSON 都按用户输入的原文存：空串 = 没填（保存时省略）。
 * `persisted` / `missing` 只影响提示文案，不用来拼请求。
 */
export interface ModelDraft {
  readonly id: string;
  readonly name: string;
  readonly contextWindow: string;
  readonly maxTokens: string;
  readonly extraText: string;
  /** 勾选 = 保存；取消勾选（或删行）= 保存时删除。 */
  readonly selected: boolean;
  /** 打开表单前就存在：取消勾选会被保存成删除。 */
  readonly persisted: boolean;
  /** 最近一次拉取里没有它：上游已不提供（仍可保留）。 */
  readonly missing: boolean;
}

export interface ModelDraftErrors {
  readonly extra?: string;
  readonly contextWindow?: string;
  readonly maxTokens?: string;
}

export interface BuiltModels {
  readonly models: ProviderModelSpec[];
  readonly errors: readonly { readonly id: string; readonly errors: ModelDraftErrors }[];
}

const blankDraft = (id: string, selected: boolean): ModelDraft => ({
  id,
  name: '',
  contextWindow: '',
  maxTokens: '',
  extraText: '',
  selected,
  persisted: false,
  missing: false
});

const numberText = (value: number | undefined): string => (value === undefined ? '' : String(value));

/** 把已存的 extra 渲染进输入框；没有就是空串。 */
export function formatExtra(extra: unknown): string {
  if (extra === undefined || extra === null) return '';
  try {
    return JSON.stringify(extra);
  } catch {
    return '';
  }
}

export function draftFromModel(model: ProviderModelSpec): ModelDraft {
  return {
    id: model.id,
    name: model.name ?? '',
    contextWindow: numberText(model.contextWindow),
    maxTokens: numberText(model.maxTokens),
    extraText: formatExtra(model.extra),
    selected: true,
    persisted: true,
    missing: false
  };
}

export function draftFromModels(models: readonly ProviderModelSpec[]): ModelDraft[] {
  return models.map(draftFromModel);
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export type ExtraResult = { readonly ok: true; readonly value?: Record<string, unknown> } | { readonly ok: false; readonly error: string };

/**
 * 校验额外参数：留空 = 没有额外参数；否则必须是 JSON 对象、不含会话字段、≤4KB。
 * 错误文案直接给用户看，所以写人话并带上怎么改。
 */
export function validateExtraJson(text: string): ExtraResult {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: '不是合法 JSON：检查引号、逗号和括号' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: '要写成一个 JSON 对象，例如 {"reasoning_effort":"high"}' };
  }
  const value = parsed as Record<string, unknown>;
  const forbidden = FORBIDDEN_EXTRA_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(value, key));
  if (forbidden.length > 0) {
    return { ok: false, error: `不能覆盖 ${forbidden.map((key) => `「${key}」`).join('、')}：这些字段由会话控制` };
  }
  const serialized = JSON.stringify(value);
  const bytes = serialized === undefined ? 0 : utf8Bytes(serialized);
  if (bytes > EXTRA_MAX_BYTES) {
    return { ok: false, error: `序列化后 ${bytes} 字节，超过 ${EXTRA_MAX_BYTES} 字节上限` };
  }
  return { ok: true, value };
}

export type CountResult = { readonly ok: true; readonly value?: number } | { readonly ok: false; readonly error: string };

/** 数字输入允许留空；填了就必须是正整数。 */
export function parseTokenCount(text: string, label: string): CountResult {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true };
  if (!/^\d+$/.test(trimmed)) return { ok: false, error: `${label}只能填正整数` };
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value <= 0) return { ok: false, error: `${label}要大于 0` };
  return { ok: true, value };
}

export function draftErrors(draft: ModelDraft): ModelDraftErrors {
  const errors: { extra?: string; contextWindow?: string; maxTokens?: string } = {};
  const extra = validateExtraJson(draft.extraText);
  if (!extra.ok) errors.extra = extra.error;
  const contextWindow = parseTokenCount(draft.contextWindow, '上下文长度');
  if (!contextWindow.ok) errors.contextWindow = contextWindow.error;
  const maxTokens = parseTokenCount(draft.maxTokens, '最大输出');
  if (!maxTokens.ok) errors.maxTokens = maxTokens.error;
  return errors;
}

export function hasDraftErrors(errors: ModelDraftErrors): boolean {
  return errors.extra !== undefined || errors.contextWindow !== undefined || errors.maxTokens !== undefined;
}

/**
 * 拉取结果与当前列表按 id 合并：
 * - 已有的行保留用户填的 name / 各数字 / 额外参数，只有空字段用上游元数据补齐；
 * - 上游新出现的默认勾选、追加到前面；
 * - 上游这次没给的、之前存过的行标成「上游已不提供」，但内容和勾选状态都不动。
 */
export function mergePulledModels(drafts: readonly ModelDraft[], pulled: readonly PulledModel[]): ModelDraft[] {
  const byId = new Map(drafts.map((draft) => [draft.id, draft]));
  const seen = new Set<string>();
  const merged: ModelDraft[] = [];
  for (const model of pulled) {
    const id = model.id.trim();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    const existing = byId.get(id);
    if (existing === undefined) {
      merged.push({
        ...blankDraft(id, true),
        name: model.name ?? '',
        contextWindow: numberText(model.contextWindow),
        maxTokens: numberText(model.maxTokens)
      });
      continue;
    }
    merged.push({
      ...existing,
      name: existing.name.trim() === '' ? (model.name ?? '') : existing.name,
      contextWindow: existing.contextWindow.trim() === '' ? numberText(model.contextWindow) : existing.contextWindow,
      maxTokens: existing.maxTokens.trim() === '' ? numberText(model.maxTokens) : existing.maxTokens,
      missing: false
    });
  }
  const kept = drafts
    .filter((draft) => !seen.has(draft.id))
    .map((draft) => (draft.persisted ? { ...draft, missing: true } : draft));
  return [...merged, ...kept];
}

/** 手动加一个 id：重复就把它勾上，不重复就追加到最后。 */
export function addManualModel(drafts: readonly ModelDraft[], rawId: string): ModelDraft[] {
  const id = rawId.trim();
  if (id === '') return [...drafts];
  if (drafts.some((draft) => draft.id === id)) {
    return drafts.map((draft) => (draft.id === id ? { ...draft, selected: true } : draft));
  }
  return [...drafts, blankDraft(id, true)];
}

export function updateDraft(drafts: readonly ModelDraft[], id: string, patch: Partial<Omit<ModelDraft, 'id' | 'persisted'>>): ModelDraft[] {
  return drafts.map((draft) => (draft.id === id ? { ...draft, ...patch } : draft));
}

export function removeDraft(drafts: readonly ModelDraft[], id: string): ModelDraft[] {
  return drafts.filter((draft) => draft.id !== id);
}

/** 全选 / 全不选只作用于传进来的 id（界面传当前筛选出来的行）。 */
export function setSelectedFor(drafts: readonly ModelDraft[], ids: readonly string[], selected: boolean): ModelDraft[] {
  const target = new Set(ids);
  return drafts.map((draft) => (target.has(draft.id) ? { ...draft, selected } : draft));
}

/**
 * 行状态 → 保存载荷：只保留勾选的行；有问题的行不进载荷、单独报出来（调用方拦住保存）。
 * 空白的数字 / 额外参数按「没填」处理，不往请求里塞空对象。
 */
export function buildProviderModels(drafts: readonly ModelDraft[]): BuiltModels {
  const models: ProviderModelSpec[] = [];
  const errors: { id: string; errors: ModelDraftErrors }[] = [];
  for (const draft of drafts) {
    if (!draft.selected) continue;
    const found = draftErrors(draft);
    if (hasDraftErrors(found)) {
      errors.push({ id: draft.id, errors: found });
      continue;
    }
    const extra = validateExtraJson(draft.extraText);
    const contextWindow = parseTokenCount(draft.contextWindow, '上下文长度');
    const maxTokens = parseTokenCount(draft.maxTokens, '最大输出');
    if (!extra.ok || !contextWindow.ok || !maxTokens.ok) continue;
    const name = draft.name.trim();
    models.push({
      id: draft.id,
      ...(name === '' ? {} : { name }),
      ...(contextWindow.value === undefined ? {} : { contextWindow: contextWindow.value }),
      ...(maxTokens.value === undefined ? {} : { maxTokens: maxTokens.value }),
      ...(extra.value === undefined || Object.keys(extra.value).length === 0 ? {} : { extra: extra.value })
    });
  }
  return { models, errors };
}
