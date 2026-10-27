import { assetsFetch, RpcFailure, type RpcPort } from '@agent-hub/contract';
import { assetBlobsForWorker, type AssetDeps } from '@agent-hub/domain';

/** 一次回复的内容上限（base64 前）：大资产分几批取，单帧远低于网关的 32 MB。 */
const MAX_BATCH_BYTES = 8 * 1024 * 1024;

/**
 * hub 侧 assets.fetch：Worker 按 sha256 来取内容。只给这台机器清单里有的（领域用例核对），
 * 超过一批的上限就截断，Worker 再要剩下的。
 */
export function serveAssetFetch(port: RpcPort, workerId: string, deps: Pick<AssetDeps, 'assets'>): void {
  port.handle(assetsFetch, async ({ hashes }) => {
    const found = await assetBlobsForWorker(deps, workerId, hashes);
    if (!found.ok) throw new RpcFailure(found.error.code === 'not_found' ? 'not_found' : 'invalid', found.error.message);
    const blobs: { sha256: string; data: string }[] = [];
    let total = 0;
    for (const blob of found.value) {
      if (blobs.length > 0 && total + blob.data.byteLength > MAX_BATCH_BYTES) break;
      total += blob.data.byteLength;
      blobs.push({ sha256: blob.sha256, data: Buffer.from(blob.data).toString('base64') });
    }
    return { blobs };
  });
}
