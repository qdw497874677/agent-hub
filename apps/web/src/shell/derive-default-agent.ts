import type { HubModelsDto, WorkerInfoDto } from './api.ts';

/** 自动选择只用明确的探测结果；旧 Worker 的「未报告」不等于已验证。 */
export function verifiedAgent(worker: WorkerInfoDto, agentId: string, hub: readonly HubModelsDto[]): boolean {
  if (worker.state !== 'online' || (worker.agentIds !== undefined && !worker.agentIds.includes(agentId))) return false;
  const entry = worker.agentModels?.find((item) => item.agentId === agentId);
  if (entry?.readiness?.state === 'ready') return entry.readiness.check?.ok !== false;
  if (entry?.readiness?.state !== 'unavailable' || entry.readiness.reason !== '未配置模型') return false;
  return hub.some((provider) => provider.models.length > 0 && (entry.providers ?? []).includes(provider.protocol));
}

/** 已选机器优先；绝不为自动选择 agent 换掉机器或工作目录。 */
export function defaultAgent(
  agents: readonly { readonly id: string }[], workers: readonly WorkerInfoDto[], machine: string | null,
  hub: readonly HubModelsDto[]
): string | null {
  const eligible = machine === null ? workers : workers.filter((worker) => worker.workerId === machine);
  return agents.find((agent) => eligible.some((worker) => verifiedAgent(worker, agent.id, hub)))?.id
    ?? agents.find((agent) => workers.some((worker) => verifiedAgent(worker, agent.id, hub)))?.id
    ?? null;
}
