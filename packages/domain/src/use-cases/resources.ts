import { authorizeWorker, workerReader, type AccessPolicy } from './authorization.ts';
import { newId } from '../ids.ts';
import type { AuditLog } from '../ports/audit-log.ts';
import type { SettingsRepository } from '../ports/settings-repository.ts';
import type { WorkerControl } from '../ports/worker-control.ts';
import type { WorkerMetrics } from '../ports/worker-metrics.ts';
import type { Principal } from '../account.ts';
import { forbidden, notFound, type DomainError } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import type { ResourceSample } from '../resources.ts';

/** 机器资源（ADR 0014）的读与策略。采样本身在网关里，这里只判权限、管开关。 */
export interface ResourceDeps {
  readonly metrics: WorkerMetrics;
  readonly settings: SettingsRepository;
  readonly workers: Pick<WorkerControl, 'list'>;
  readonly audit: AuditLog;
  readonly now: () => number;
  readonly access?: AccessPolicy;
}

/** 一台机器最近 1 小时的采样：能看见这台机器（worker.read）就能看，含每条会话的用量。 */
export async function workerMetricsHistory(
  deps: Pick<ResourceDeps, 'metrics' | 'access'>,
  actor: Principal | null,
  workerId: string
): Promise<Result<readonly ResourceSample[], DomainError>> {
  if (deps.access && actor === null) return err(forbidden('请先登录'));
  const readable = await workerReader(deps.access, actor);
  if (!(await readable(workerId))) return err(notFound('没有这台机器'));
  return ok(deps.metrics.history(workerId));
}

/** 「资源满了就拒绝新会话」：默认关，只有能管这台机器的人能开（worker.manage）。 */
export async function setRefuseWhenFull(
  deps: ResourceDeps,
  actor: Principal | null,
  workerId: string,
  on: boolean
): Promise<Result<{ refuseWhenFull: boolean }, DomainError>> {
  if (deps.access) {
    if (!actor) return err(forbidden('请先登录'));
    const worker = (await deps.workers.list()).find((candidate) => candidate.workerId === workerId);
    const allowed = await authorizeWorker(deps.access, actor, worker?.origin === 'local' ? null : workerId, 'worker.manage');
    if (!allowed.ok) return allowed;
  } else if (actor && actor.user.role !== 'owner') {
    return err(forbidden('只有管理员能改这个开关'));
  }
  const settings = await deps.settings.get();
  const current = new Set(settings.refuseWhenFull);
  if (on) current.add(workerId);
  else current.delete(workerId);
  const next = [...current].sort();
  await deps.settings.save({ ...settings, refuseWhenFull: next });
  deps.metrics.applyRefuseWhenFull(next);
  if (actor) {
    await deps.audit.append({
      id: newId(),
      actorId: actor.user.id,
      actorEmail: actor.user.email,
      action: 'worker.resource_policy',
      target: workerId,
      detail: on ? '资源满时拒绝新会话：开' : '资源满时拒绝新会话：关',
      at: deps.now()
    });
  }
  return ok({ refuseWhenFull: on });
}

/** 启动时把持久化的开关同步给网关。 */
export async function loadResourcePolicy(deps: Pick<ResourceDeps, 'metrics' | 'settings'>): Promise<void> {
  deps.metrics.applyRefuseWhenFull((await deps.settings.get()).refuseWhenFull);
}
