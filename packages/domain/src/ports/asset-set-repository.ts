import type { AssetSet } from '../asset-set.ts';

/** 资产组合的持久化端口。 */
export interface AssetSetRepository {
  byId(id: string): Promise<AssetSet | null>;
  listByTeam(teamId: string): Promise<readonly AssetSet[]>;
  save(set: AssetSet): Promise<void>;
  remove(id: string): Promise<void>;
}
