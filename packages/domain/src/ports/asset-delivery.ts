import type { AssetManifestEntry, WorkerAssetSync } from '../asset.ts';
import type { DomainError } from '../errors.ts';
import type { Result } from '../result.ts';

export interface DeliveryReport {
  /** Worker 上资产根目录。 */
  readonly root: string;
  /** assetId → 已落地 digest。 */
  readonly installed: Readonly<Record<string, string>>;
}

/** 把一台 Worker 该有的资产清单推下去；Worker 按哈希回来取缺的 blob，落地后回报。 */
export interface AssetDelivery {
  push(workerId: string, manifest: readonly AssetManifestEntry[]): Promise<Result<DeliveryReport, DomainError>>;
}

/** 每台 Worker 最近一次同步的情况。 */
export interface AssetSyncBoard {
  get(workerId: string): WorkerAssetSync | null;
  set(status: WorkerAssetSync): void;
  all(): WorkerAssetSync[];
}
