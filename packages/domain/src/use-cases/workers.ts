import type { WorkerStatus } from '../worker.ts';
import type { Deps } from './deps.ts';

/** 节点列表只从网关端口来：谁连着、谁掉了，只有网关知道。 */
export function listWorkers(deps: Pick<Deps, 'gateway'>): Promise<WorkerStatus[]> {
  return deps.gateway.status();
}
