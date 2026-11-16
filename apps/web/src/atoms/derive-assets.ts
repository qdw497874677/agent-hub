import type { ProjectAssetPlanDto } from '@agent-hub/contract';

/**
 * 派生对话框里的「资产」勾选（docs/design/asset-hub.md）。
 *
 * 规则只有一条：默认全选，取消哪一项就把它的 id 从这次会话里减掉。
 * 一项都没取消时**不要**传 `assetIds`（保持旧行为：用项目生效集全部），
 * 取消到一项不剩时要传空数组（空数组 = 一个都不带，和不传不是一回事）。
 * 纯逻辑放这里，组件只负责渲染和请求。
 */

export type DeriveAssetEntry = ProjectAssetPlanDto['entries'][number];

const KIND_TEXT: Record<DeriveAssetEntry['kind'], string> = { skill: '技能', instruction: '指令', mcp: 'MCP' };
const SCOPE_TEXT: Record<DeriveAssetEntry['scope'], string | null> = {
  personal: '个人',
  project: null, // 本项目里的资产不用再标作用域，省一行字
  team: '团队',
  global: '全局'
};

export const kindLabel = (kind: DeriveAssetEntry['kind']): string => KIND_TEXT[kind] ?? kind;
/** 项目级返回 null：不显示作用域。 */
export const scopeLabel = (scope: DeriveAssetEntry['scope']): string | null =>
  scope in SCOPE_TEXT ? SCOPE_TEXT[scope] : scope;

/** 一行说明：`技能 · 团队`，项目级只有 `技能`。 */
export function assetNote(entry: DeriveAssetEntry): string {
  const scope = scopeLabel(entry.scope);
  return scope === null ? kindLabel(entry.kind) : `${kindLabel(entry.kind)} · ${scope}`;
}

/**
 * 勾选状态。`key` = 项目 + 机器：任一变了就重新全选（不同机器下发的是不同的资产集）。
 * 未勾选的资产 id 记在 `excluded` 里。
 */
export interface AssetSelection {
  readonly key: string;
  readonly excluded: readonly string[];
}

export const assetSelectionKey = (projectId: string, workerId: string | null): string => `${projectId}\n${workerId ?? ''}`;

/** 换项目 / 换机器就丢掉旧的排除项，恢复全选；同一个 key 原样返回同一份引用。 */
export function selectionFor(previous: AssetSelection | null, key: string): AssetSelection {
  return previous !== null && previous.key === key ? previous : { key, excluded: [] };
}

/** 勾上就把 id 从排除里拿掉，取消就加进去。 */
export function toggleAsset(selection: AssetSelection, assetId: string, included: boolean): AssetSelection {
  const without = selection.excluded.filter((id) => id !== assetId);
  return { key: selection.key, excluded: included ? without : [...without, assetId] };
}

export function isIncluded(selection: AssetSelection, assetId: string): boolean {
  return !selection.excluded.includes(assetId);
}

/** 这次会话实际会带的 id。 */
export function includedAssetIds(entries: readonly DeriveAssetEntry[], selection: AssetSelection): string[] {
  return entries.filter((entry) => isIncluded(selection, entry.assetId)).map((entry) => entry.assetId);
}

/**
 * 发给 `POST /api/sessions/derive` 的 `assetIds`：
 * 一项都没取消时返回 undefined（不传 = 用项目生效集全部），否则返回勾选后的 id（可能是空数组）。
 */
export function submitAssetIds(
  entries: readonly DeriveAssetEntry[],
  selection: AssetSelection
): string[] | undefined {
  if (selection.excluded.length === 0) return undefined;
  return includedAssetIds(entries, selection);
}
