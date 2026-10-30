import { authorizeWorker, type AccessPolicy } from './authorization.ts';
import { newId } from '../ids.ts';
import type { AuditLog } from '../ports/audit-log.ts';
import type { EnrollmentRepository } from '../ports/enrollment-repository.ts';
import type { SessionRepository } from '../ports/session-repository.ts';
import type { WorkerControl } from '../ports/worker-control.ts';
import type { Principal } from '../account.ts';
import { conflict, forbidden, type DomainError } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import { canManageRuntimes, planRuntimeJob, type RuntimeJob, type RuntimeRequest } from '../runtime-install.ts';
import { isBusy } from '../session.ts';

export interface RuntimeInstallDeps {
  readonly workers: Pick<WorkerControl, 'list' | 'runtimeJob'>;
  readonly enrollment: Pick<EnrollmentRepository, 'credentialFor'>;
  readonly sessions: Pick<SessionRepository, 'listAll'>;
  readonly audit: AuditLog;
  readonly now: () => number;
  readonly newJobId?: () => string;
  /** 装了账号体系就走 can()（ADR 0011）；不给就用老规则 canManageRuntimes。 */
  readonly access?: AccessPolicy;
}

/**
 * 在一台机器上装 / 升级 / 卸载 agent 运行时：判权限 → 判能不能做 → 下发任务 → 写审计。
 * 只发指令；进度经 Worker 的 runtime_job_status 帧异步回来，界面看 WorkerStatus.runtimeJob。
 */
export async function startRuntimeJob(
  deps: RuntimeInstallDeps,
  actor: Principal | null,
  workerId: string,
  request: RuntimeRequest
): Promise<Result<RuntimeJob, DomainError>> {
  const worker = (await deps.workers.list()).find((candidate) => candidate.workerId === workerId);
  const credential = worker ? await deps.enrollment.credentialFor(workerId) : null;
  const allowed = canManageRuntimes(actor, worker ?? { origin: 'remote' }, credential);
  if (deps.access) {
    if (!actor) return err(forbidden('请先登录'));
    const scoped = await authorizeWorker(deps.access, actor, worker?.origin === 'local' ? null : workerId, 'runtime.install');
    if (!scoped.ok) return scoped;
  } else if (!allowed.ok) return allowed;
  const by = actor ?? (allowed.ok ? allowed.value : null);
  if (!by) return err(forbidden('请先登录'));
  const busy = (await deps.sessions.listAll()).filter(
    (session) => session.workerId === workerId && session.agentId === request.agentId && isBusy(session)
  ).length;
  const plan = planRuntimeJob(worker, request, busy);
  if (!plan.ok) return plan;

  const job: RuntimeJob = {
    jobId: (deps.newJobId ?? newId)(),
    agentId: request.agentId,
    action: plan.value.action,
    version: plan.value.version,
    state: 'running',
    message: plan.value.action === 'install' ? `正在安装 ${plan.value.version}` : '正在卸载',
    log: '',
    startedAt: deps.now(),
    endedAt: null,
    actorEmail: by.user.email
  };
  if (!(await deps.workers.runtimeJob(workerId, job))) return err(conflict('这台机器已经不在线'));
  const label = worker ? `${worker.label}（${workerId}）` : workerId;
  const detail =
    job.action === 'uninstall'
      ? `${request.agentId} 卸载 ${plan.value.from ?? ''}`.trim()
      : `${request.agentId} ${plan.value.from ? `${plan.value.from} → ` : ''}${job.version}`;
  await deps.audit.append({
    id: newId(),
    actorId: by.user.id,
    actorEmail: by.user.email,
    action: job.action === 'install' ? 'runtime.install' : 'runtime.uninstall',
    target: label,
    detail,
    at: deps.now()
  });
  return ok(job);
}
