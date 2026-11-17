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
 * 以前这里按「当前值属于哪一类」收起来，因为换提供商必须新开会话。
 * 现在换提供商会重启这条会话的进程并 `session/load` 接回历史（hub 侧
 * `switchSessionModel`），所以全部候选都放出来——不再收。
 *
 * 保留这个函数是为了调用方与测试的兼容：hidden 恒为 0，说明也不再显示。
 */
export function filterModelsByScope<T extends { readonly value: string }>(
  items: readonly T[],
  _current: string
): { items: T[]; hidden: number } {
  return { items: [...items], hidden: 0 };
}

/** 换提供商会重启进程：在需要提醒的地方用它，而不是把模型藏起来。 */
export function scopeNote(_current: string): string {
  return '换提供商会重启这条会话的进程（对话历史保留，正在跑的回合会中断）';
}
