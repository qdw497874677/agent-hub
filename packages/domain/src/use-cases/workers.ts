import { notFound, unavailable, type DomainError } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import type { WorkerStatus } from '../worker.ts';
import type { Deps } from './deps.ts';

/** 节点列表只从网关端口来：谁连着、谁掉了，只有网关知道。 */
export function listWorkers(deps: Pick<Deps, 'gateway'>): Promise<WorkerStatus[]> {
  return deps.gateway.status();
}

/** 「重新检测」某台 Worker 的 harness 就绪状态。结果异步回来，界面稍后再拉一次列表。 */
export async function probeWorker(deps: Pick<Deps, 'gateway'>, workerId: string): Promise<Result<void, DomainError>> {
  const worker = (await deps.gateway.status()).find((candidate) => candidate.workerId === workerId);
  if (!worker) return err(notFound('没有这台 Worker'));
  if (worker.state !== 'online') return err(unavailable(`「${worker.label}」不在线`));
  return (await deps.gateway.probe(workerId)) ? ok(undefined) : err(unavailable(`「${worker.label}」不在线`));
}
