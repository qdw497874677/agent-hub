import type { AssetManifestEntry, SessionAssetDelivery, WorkerAssetSync } from '../asset.ts';
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
  /** `retain`：这台机器上仍有会话在用的旧版本 digest，Worker 不能清（#225 M2）。 */
  push(
    workerId: string,
    manifest: readonly AssetManifestEntry[],
    retain?: readonly string[],
    /** #226 P4：这台机器上活跃会话各自的资产清单；传了 Worker 才会重建/回收会话视图。 */
    sessions?: readonly SessionAssetDelivery[]
  ): Promise<Result<DeliveryReport, DomainError>>;
}

/** 每台 Worker 最近一次同步的情况。 */
export interface AssetSyncBoard {
  get(workerId: string): WorkerAssetSync | null;
  set(status: WorkerAssetSync): void;
  all(): WorkerAssetSync[];
}
