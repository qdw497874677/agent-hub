import { can } from '../access.ts';
import { authorizeWorker, type AccessPolicy } from './authorization.ts';
import { newId } from '../ids.ts';
import type { AuditLog } from '../ports/audit-log.ts';
import type { ComponentCatalogRepository, ComponentPinStore } from '../ports/component-store.ts';
import type { SessionRepository } from '../ports/session-repository.ts';
import type { WorkerControl } from '../ports/worker-control.ts';
import type { Principal } from '../account.ts';
import { conflict, forbidden, invalid, notFound, type DomainError } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import type { RuntimeJob } from '../runtime-install.ts';
import type { ComponentProvides } from '../runtime-bundle.ts';
import { isBusy } from '../session.ts';
import {
  catalogKey,
  checkArtifact,
  planComponentJob,
  validateSubmission,
  type CatalogComponent,
  type ComponentAction,
  type NpmArtifactInfo
} from '../component-catalog.ts';

export interface ComponentDeps {
  readonly catalog: ComponentCatalogRepository;
  readonly pins: ComponentPinStore;
  readonly workers: Pick<WorkerControl, 'list' | 'runtimeJob'>;
  readonly sessions: Pick<SessionRepository, 'listAll'>;
  readonly audit: AuditLog;
  readonly access: AccessPolicy;
  /** hub 在审核前去 registry 查制品（下载地址、sha512、安装脚本）——借鉴 paseo 的「审的就是装的」。 */
  readonly resolveNpm: (packageName: string, version: string) => Promise<NpmArtifactInfo>;
  readonly now: () => number;
  readonly newJobId?: () => string;
}

const audit = (deps: ComponentDeps, by: Principal, action: Parameters<AuditLog['append']>[0]['action'], target: string, detail: string) =>
  deps.audit.append({ id: newId(), actorId: by.user.id, actorEmail: by.user.email, action, target, detail, at: deps.now() });

async function clusterAdmin(_deps: ComponentDeps, actor: Principal | null): Promise<Result<Principal, DomainError>> {
  if (!actor) return err(forbidden('请先登录'));
  if (!can(actor, 'asset.publish_global')) {
    return err(forbidden('只有集群管理员能管理组件目录'));
  }
  return ok(actor);
}

export async function listComponentCatalog(deps: ComponentDeps, actor: Principal | null): Promise<Result<CatalogComponent[], DomainError>> {
  if (!actor) return err(forbidden('请先登录'));
  const all = await deps.catalog.list();
  // 集群管理员看全部（含待审、已拒）；其他人只看已批准的——装组件时要从里面选
  return ok(can(actor, 'asset.publish_global') ? all : all.filter((item) => item.status === 'approved'));
}

/** 提交一个第三方组件版本进目录：hub 查 registry 钉死制品，状态 pending，等 cluster_admin 审。 */
export async function submitComponent(
  deps: ComponentDeps,
  actor: Principal | null,
  input: { id: string; packageName: string; version: string; provides: readonly ComponentProvides[] }
): Promise<Result<CatalogComponent, DomainError>> {
  const admin = await clusterAdmin(deps, actor);
  if (!admin.ok) return admin;
  const valid = validateSubmission(input);
  if (!valid.ok) return valid;
  const existing = await deps.catalog.byId(catalogKey(input.id, input.version));
  if (existing && existing.status !== 'rejected') return err(conflict('这个版本已经在目录里'));
  const others = (await deps.catalog.list()).filter((c) => c.id === input.id);
  if (others.some((c) => c.packageName !== input.packageName)) return err(conflict('同一个组件 id 不能换 npm 包'));
  let info: NpmArtifactInfo;
  try {
    info = await deps.resolveNpm(input.packageName, input.version);
  } catch (failure) {
    return err(invalid(`查不到这个 npm 版本：${(failure as Error).message}`));
  }
  const checked = checkArtifact(info, input.packageName, input.version);
  if (!checked.ok) return checked;
  const item: CatalogComponent = {
    id: input.id,
    runtime: 'pi',
    packageName: input.packageName,
    version: input.version,
    resolved: info.resolved,
    integrity: info.integrity,
    provides: input.provides.map((p) => ({ capability: p.capability, ...(p.mode ? { mode: p.mode } : {}) })),
    scripts: info.scripts,
    dependencyCount: info.dependencyCount,
    status: 'pending',
    submittedBy: admin.value.user.email,
    submittedAt: deps.now(),
    reviewedBy: null,
    reviewedAt: null,
    reviewNote: null
  };
  await deps.catalog.save(item);
  const scriptNote = Object.keys(item.scripts).length ? `，带安装脚本：${Object.keys(item.scripts).join('、')}` : '';
  await audit(deps, admin.value, 'bundle.submit', catalogKey(item.id, item.version), `${item.packageName}@${item.version} ${item.integrity.slice(0, 20)}…${scriptNote}`);
  return ok(item);
}

export async function reviewComponent(
  deps: ComponentDeps,
  actor: Principal | null,
  id: string,
  version: string,
  decision: { approve: boolean; note?: string }
): Promise<Result<CatalogComponent, DomainError>> {
  const admin = await clusterAdmin(deps, actor);
  if (!admin.ok) return admin;
  const item = await deps.catalog.byId(catalogKey(id, version));
  if (!item) return err(notFound('组件目录里没有这一项'));
  if (item.status !== 'pending') return err(conflict('这一项已经审过了'));
  const next: CatalogComponent = {
    ...item,
    status: decision.approve ? 'approved' : 'rejected',
    reviewedBy: admin.value.user.email,
    reviewedAt: deps.now(),
    reviewNote: decision.note?.slice(0, 500) ?? null
  };
  await deps.catalog.save(next);
  await audit(deps, admin.value, 'bundle.review', catalogKey(id, version), `${decision.approve ? '批准' : '驳回'} ${item.packageName}@${version}${decision.note ? `：${decision.note.slice(0, 200)}` : ''}`);
  return ok(next);
}

/** 在一台机器上装 / 升级 / 修复 / 卸载一个目录组件。权限 runtime.component.install（NEVER_GRANTABLE：只有内置角色有）。 */
export async function startComponentJob(
  deps: ComponentDeps,
  actor: Principal | null,
  workerId: string,
  request: { componentId: string; version?: string; action: ComponentAction }
): Promise<Result<RuntimeJob, DomainError>> {
  if (!actor) return err(forbidden('请先登录'));
  const worker = (await deps.workers.list()).find((candidate) => candidate.workerId === workerId);
  const scoped = await authorizeWorker(deps.access, actor, worker?.origin === 'local' ? null : workerId, 'runtime.component.install');
  if (!scoped.ok) return scoped;
  const pins = deps.pins.pinsFor(workerId);
  const pin = pins.find((p) => p.componentId === request.componentId) ?? null;
  const versions = (await deps.catalog.list()).filter((c) => c.id === request.componentId);
  const item =
    request.action === 'uninstall_component'
      ? (versions.find((c) => c.version === pin?.version) ?? versions[0] ?? null)
      : (versions.find((c) => c.version === (request.version ?? pin?.version)) ?? null);
  const busy = item
    ? (await deps.sessions.listAll()).filter((s) => s.workerId === workerId && s.agentId === item.runtime && isBusy(s)).length
    : 0;
  const plan = planComponentJob(worker, item, request.action, pin, busy);
  if (!plan.ok || !item) return plan.ok ? err(notFound('组件目录里没有这一项')) : plan;
  const install = request.action === 'install_component';
  const job: RuntimeJob = {
    jobId: (deps.newJobId ?? newId)(),
    agentId: item.runtime,
    action: request.action,
    version: install ? item.version : null,
    component: {
      componentId: item.id,
      runtime: item.runtime,
      packageName: item.packageName,
      version: item.version,
      resolved: item.resolved,
      integrity: item.integrity,
      provides: item.provides,
      ignoreScripts: true,
      expectedCurrent: plan.value.from
    },
    state: 'running',
    message: install ? `正在${plan.value.repair ? '修复' : '安装'}组件 ${item.id} ${item.version}` : `正在卸载组件 ${item.id}`,
    log: '',
    startedAt: deps.now(),
    endedAt: null,
    actorEmail: actor.user.email
  };
  if (!(await deps.workers.runtimeJob(workerId, job))) return err(conflict('这台机器已经不在线'));
  const label = worker ? `${worker.label}（${workerId}）` : workerId;
  const detail = install
    ? `${item.id} ${plan.value.from ? `${plan.value.from} → ` : ''}${item.version}${plan.value.repair ? '（修复漂移）' : ''}`
    : `${item.id} 卸载 ${plan.value.from ?? ''}`.trim();
  await audit(deps, actor, install ? 'runtime.component.install' : 'runtime.component.uninstall', label, detail);
  return ok(job);
}

/** 组件任务结束（Worker 报了终态）：成功才改 component_pins；跑过的脚本、哈希不符都单独记审计。 */
export async function componentJobFinished(deps: Pick<ComponentDeps, 'pins' | 'audit' | 'now'>, workerId: string, job: RuntimeJob): Promise<void> {
  const spec = job.component;
  if (!spec || job.state === 'running') return;
  const system = { user: { id: 'system', email: job.actorEmail } } as Principal;
  const target = `${workerId}:${spec.componentId}@${spec.version}`;
  if (job.result?.integrityMismatch) {
    await audit(deps as ComponentDeps, system, 'bundle.integrity_mismatch', target, `期望 ${spec.integrity.slice(0, 24)}…，实际 ${(job.result.integrity ?? '未知').slice(0, 24)}…；已回滚，没有切换版本`);
  }
  for (const run of job.result?.scripts ?? []) {
    await audit(deps as ComponentDeps, system, 'bundle.script_skipped', target, `${run.package} ${run.script}（未执行）`);
  }
  if (job.state !== 'succeeded') return;
  if (job.action === 'uninstall_component') {
    deps.pins.remove(workerId, spec.componentId, spec.runtime);
    return;
  }
  if (job.action === 'install_component') {
    deps.pins.upsert({
      workerId,
      componentId: spec.componentId,
      runtime: spec.runtime,
      version: spec.version,
      integrity: spec.integrity,
      installedBy: job.actorEmail,
      installedAt: deps.now()
    });
  }
}
