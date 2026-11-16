import { invalid, type DomainError } from './errors.ts';
import { newId } from './ids.ts';
import { err, ok, type Result } from './result.ts';

/** 资产组合里的一项：只记资产 id，资产本身（版本、可见性）在解析时再查。 */
export interface AssetSetItem {
  readonly assetId: string;
}

/**
 * 团队级的资产组合：给项目配默认组合，会话也可以显式换一组。
 * 组合只存引用，不复制资产；解析时仍要过可见性和「已装到这台机器」两道关。
 */
export interface AssetSet {
  readonly id: string;
  readonly teamId: string;
  readonly name: string;
  readonly description: string | null;
  readonly items: readonly AssetSetItem[];
  readonly createdBy: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export const ASSET_SET_NAME_MAX = 60;
export const ASSET_SET_DESCRIPTION_MAX = 300;
export const ASSET_SET_ITEMS_MAX = 50;
/** 项目 / 会话最多引用几个组合（和契约里的 max(8) 对齐）。 */
export const ASSET_SET_IDS_MAX = 8;

/** `aset_` + 8 位十六进制。 */
export const newAssetSetId = (): string => `aset_${newId().replace(/-/g, '').slice(0, 8)}`;

/** 去重保序、空 id 丢弃；超过上限报 invalid。 */
export function normalizeAssetSetItems(
  items: readonly { readonly assetId: string }[]
): Result<readonly AssetSetItem[], DomainError> {
  const seen = new Set<string>();
  const normalized: AssetSetItem[] = [];
  for (const item of items) {
    const assetId = typeof item?.assetId === 'string' ? item.assetId.trim() : '';
    if (assetId === '' || seen.has(assetId)) continue;
    seen.add(assetId);
    normalized.push({ assetId });
  }
  if (normalized.length > ASSET_SET_ITEMS_MAX) return err(invalid(`一个资产组合最多 ${ASSET_SET_ITEMS_MAX} 个资产`));
  return ok(normalized);
}

/** 项目 / 会话引用的组合 id：去重保序、空串丢弃、最多 8 个；null / undefined = 空。 */
export function normalizeAssetSetIds(value: readonly string[] | null | undefined): Result<readonly string[], DomainError> {
  if (value === null || value === undefined) return ok([]);
  if (!Array.isArray(value)) return err(invalid('资产组合 id 要是字符串数组'));
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') return err(invalid('资产组合 id 要是字符串数组'));
    const id = raw.trim();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
  }
  if (normalized.length > ASSET_SET_IDS_MAX) return err(invalid(`最多引用 ${ASSET_SET_IDS_MAX} 个资产组合`));
  return ok(normalized);
}
