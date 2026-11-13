/**
 * 模型清单有两套来源：agent 自己报的原生模型（`my-codex/zp-glm-5.3-flash`），
 * 和 hub 统一配置的提供商模型（`hub-<slug>/<modelId>`）。它们在同一个 `model` 选项里混着来。
 *
 * 后端的规矩（apps/server/src/providers.ts 的 optionAllowed）：换 hub 提供商 = 新开会话，
 * 同一提供商里换模型可以；原生模型之间随意换。所以候选项得按当前值的类别先收口，
 * 别让人先选一个、再收到「换模型提供商需新开会话」的报错。
 *
 * 拆分规则与 packages/domain/src/provider.ts 的 parseHubModel 一致；web 只允许依赖
 * @agent-hub/contract（scripts/check-import-boundaries.mjs），所以这里照抄一份最小实现。
 */

export const HUB_MODEL_PREFIX = 'hub-';
const SLUG = /^[a-z0-9][a-z0-9-]{0,30}$/;

export type ModelScope = { readonly kind: 'hub'; readonly slug: string } | { readonly kind: 'native' };

/** `hub-team-1/glm-5` → hub（slug `team-1`）；`my-codex/glm-5`、`local`、`hub-坏值` → 原生。 */
export function modelScope(value: string | null | undefined): ModelScope {
  if (value === null || value === undefined || !value.startsWith(HUB_MODEL_PREFIX)) return { kind: 'native' };
  const rest = value.slice(HUB_MODEL_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return { kind: 'native' };
  const slug = rest.slice(0, slash);
  return SLUG.test(slug) ? { kind: 'hub', slug } : { kind: 'native' };
}

/** 两个模型能不能在同一个会话里互换：hub 看提供商 slug，原生之间都算同类。 */
export function sameModelScope(left: string, right: string): boolean {
  const a = modelScope(left);
  const b = modelScope(right);
  if (a.kind === 'native' || b.kind === 'native') return a.kind === b.kind;
  return a.slug === b.slug;
}

/**
 * 只留当前值这一类的候选，其余收起来（返回藏起来的个数，用来决定要不要给说明）。
 * 当前值本身永远保留：它一定属于自己这一类，多一条 `value === current` 是兜底。
 */
export function filterModelsByScope<T extends { readonly value: string }>(
  items: readonly T[],
  current: string
): { items: T[]; hidden: number } {
  const kept = items.filter((item) => item.value === current || sameModelScope(item.value, current));
  return { items: kept, hidden: items.length - kept.length };
}

/** 被收起的那批为什么看不到：一句话，放在清单底部（或原生下拉的 title 里）。 */
export function scopeNote(current: string): string {
  return modelScope(current).kind === 'hub' ? '其他提供商的模型需要新开会话' : 'hub 提供商的模型需要新开会话';
}
