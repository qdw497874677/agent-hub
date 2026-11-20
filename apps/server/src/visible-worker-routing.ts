import { can, workerReader, type AccessPolicy, type Subject } from '@agent-hub/domain';

/**
 * LOW6：机器维度的路由覆盖只给能看见这台机器的调用方（#261）。
 * Web /api/providers 与开放 API provider_list 共用这一份逻辑，避免两份实现漂移：
 * - 没有 worker.read 权限 → 整个字段省略（返回 undefined）；
 * - 有 → 按 workerReader 逐台过滤，只保留调用方 worker.read 得到的机器。
 */
export async function visibleWorkerRouting(
  access: AccessPolicy | undefined,
  actor: Subject | null,
  workerRouting: () => Promise<Record<string, unknown>>
): Promise<Record<string, unknown> | undefined> {
  if (!can(actor, 'worker.read')) return undefined;
  const readable = await workerReader(access, actor);
  const visible: Record<string, unknown> = {};
  for (const [workerId, routing] of Object.entries(await workerRouting())) {
    if (await readable(workerId)) visible[workerId] = routing;
  }
  return visible;
}
