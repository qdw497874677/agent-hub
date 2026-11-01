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
import { isBusy } from '../session.ts';
import {
  catalogKey,
  checkArtifact,
  planComponentJob,
  validateSubmission,
  type CatalogComponent,
  type ComponentAction,
  type ComponentJobSpec,
  type ComponentSubmission,
  type NpmArtifactInfo,
  gitIntegrity,
  gitSpec
} from '../component-catalog.ts';
import type { WorkerComponentPin } from '../component-catalog.ts';

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
  /** 每个目录项需要几个不同的 cluster_admin 批准（P3 双人审核；默认 1）。≥2 时提交人自己那票不算。 */
  readonly requiredApprovals?: number;
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
  input: ComponentSubmission
): Promise<Result<CatalogComponent, DomainError>> {
  const admin = await clusterAdmin(deps, actor);
  if (!admin.ok) return admin;
  const valid = validateSubmission(input);
  if (!valid.ok) return valid;
  const existing = await deps.catalog.byId(catalogKey(input.id, input.version));
  if (existing && existing.status !== 'rejected') return err(conflict('这个版本已经在目录里'));
  const others = (await deps.catalog.list()).filter((c) => c.id === input.id);
  if (others.some((c) => c.packageName !== input.packageName)) return err(conflict('同一个组件 id 不能换 npm 包'));
  if (others.some((c) => (c.runtime ?? 'pi') !== (input.runtime ?? 'pi'))) return err(conflict('同一个组件 id 不能换运行时'));
  let info: NpmArtifactInfo;
  if (input.git) {
    // git 来源（P4）：钉死提交号，制品就是那个提交；hub 不去拉仓库，安装脚本审核时看不到（装的时候一律不执行）
    info = { name: input.packageName, version: input.version, resolved: gitSpec(input.git.url, input.git.commit), integrity: gitIntegrity(input.git.commit), scripts: {}, dependencyCount: 0 };
  } else {
    try {
      info = await deps.resolveNpm(input.packageName, input.version);
    } catch (failure) {
      return err(invalid(`查不到这个 npm 版本：${(failure as Error).message}`));
    }
    const checked = checkArtifact(info, input.packageName, input.version);
    if (!checked.ok) return checked;
  }
  const required = Math.max(1, Math.min(3, Math.floor(deps.requiredApprovals ?? 1)));
  const item: CatalogComponent = {
    id: input.id,
    runtime: input.runtime ?? 'pi',
    ...(input.git ? { source: 'git' as const, gitUrl: input.git.url, commit: input.git.commit } : {}),
    approvals: [],
    requiredApprovals: required,
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
  const required = item.requiredApprovals ?? 1;
  const approvals = item.approvals ?? [];
  const me = admin.value.user.email;
  if (decision.approve && required >= 2 && me === item.submittedBy) return err(forbidden('需要另外的集群管理员审核：提交人自己不能批准'));
  if (decision.approve && approvals.some((a) => a.by === me)) return err(conflict('你已经批准过了，还要等别的集群管理员'));
  const nextApprovals = decision.approve ? [...approvals, { by: me, at: deps.now(), note: decision.note?.slice(0, 500) ?? null }] : approvals;
  if (decision.approve && nextApprovals.length < required) {
    const partial: CatalogComponent = { ...item, approvals: nextApprovals };
    await deps.catalog.save(partial);
    await audit(deps, admin.value, 'bundle.review', catalogKey(id, version), `批准 ${item.packageName}@${version}（${nextApprovals.length}/${required}，还差 ${required - nextApprovals.length} 人）`);
    return ok(partial);
  }
  const next: CatalogComponent = {
    ...item,
    approvals: nextApprovals,
    status: decision.approve ? 'approved' : 'rejected',
    reviewedBy: admin.value.user.email,
    reviewedAt: deps.now(),
    reviewNote: decision.note?.slice(0, 500) ?? null
  };
  await deps.catalog.save(next);
  await audit(deps, admin.value, 'bundle.review', catalogKey(id, version), `${decision.approve ? '批准' : '驳回'} ${item.packageName}@${version}${decision.note ? `：${decision.note.slice(0, 200)}` : ''}`);
  return ok(next);
}

function specOf(item: CatalogComponent, from: string | null): ComponentJobSpec {
  return {
    componentId: item.id,
    runtime: item.runtime,
    ...(item.source === 'git' && item.gitUrl && item.commit ? { git: { url: item.gitUrl, commit: item.commit } } : {}),
    packageName: item.packageName,
    version: item.version,
    resolved: item.resolved,
    integrity: item.integrity,
    provides: item.provides,
    ignoreScripts: true,
    expectedCurrent: from
  };
}

/**
 * 一次装一组组件（P3「装套件」）：全有或全无——Worker 先把每一个都装进暂存目录并核对，
 * 全部通过才一起切换 current；任何一个失败都不切换。只管组件，不装运行时本身。
 * 每一项按单个安装同样的规则检查（已审核、运行时在机器上、CAS 期望版本）；已经是这个版本且没漂移的跳过。
 */
export async function startBundleJob(
  deps: ComponentDeps,
  actor: Principal | null,
  workerId: string,
  request: { components: readonly { componentId: string; version: string }[] }
): Promise<Result<RuntimeJob, DomainError>> {
  if (!actor) return err(forbidden('请先登录'));
  const worker = (await deps.workers.list()).find((candidate) => candidate.workerId === workerId);
  const scoped = await authorizeWorker(deps.access, actor, worker?.origin === 'local' ? null : workerId, 'runtime.component.install');
  if (!scoped.ok) return scoped;
  if (request.components.length === 0) return err(invalid('至少选一个组件'));
  if (request.components.length > 16) return err(invalid('一次最多装 16 个组件'));
  if (new Set(request.components.map((c) => c.componentId)).size !== request.components.length) return err(invalid('同一个组件只能选一个版本'));
  if (worker?.inventory && !worker.inventory.bundleInstall) return err(conflict('这台 Worker 版本太旧，不支持整套安装：先更新它'));
  const pins = deps.pins.pinsFor(workerId);
  const catalog = await deps.catalog.list();
  const specs: ComponentJobSpec[] = [];
  const skipped: string[] = [];
  for (const wanted of request.components) {
    const item = catalog.find((c) => c.id === wanted.componentId && c.version === wanted.version) ?? null;
    const pin: WorkerComponentPin | null = pins.find((p) => p.componentId === wanted.componentId) ?? null;
    const plan = planComponentJob(worker, item, 'install_component', pin, 0);
    if (!plan.ok) {
      if (plan.error.message.startsWith('已经装的就是')) {
        skipped.push(wanted.componentId);
        continue;
      }
      return err({ ...plan.error, message: `${wanted.componentId}：${plan.error.message}` });
    }
    if (item) specs.push(specOf(item, plan.value.from));
  }
  if (specs.length === 0) return err(conflict('选的组件都已经装好了'));
  const job: RuntimeJob = {
    jobId: (deps.newJobId ?? newId)(),
    agentId: specs[0]!.runtime,
    action: 'install_component',
    version: null,
    components: specs,
    state: 'running',
    message: `正在整套安装 ${specs.length} 个组件（全部通过才切换）`,
    log: '',
    startedAt: deps.now(),
    endedAt: null,
    actorEmail: actor.user.email
  };
  if (!(await deps.workers.runtimeJob(workerId, job))) return err(conflict('这台机器已经不在线'));
  const label = worker ? `${worker.label}（${workerId}）` : workerId;
  await audit(deps, actor, 'runtime.component.install', label, `整套：${specs.map((s) => `${s.componentId} ${s.expectedCurrent ? `${s.expectedCurrent} → ` : ''}${s.version}`).join('、')}${skipped.length ? `（已装好跳过：${skipped.join('、')}）` : ''}`);
  return ok(job);
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
    component: specOf(item, plan.value.from),
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
  if (job.state === 'running') return;
  if (job.components?.length) {
    // 整套任务：结果只有一份（全有或全无），成功才把每一项都钉上
    for (const spec of job.components) await finishOne(deps, workerId, { ...job, component: spec, components: undefined });
    return;
  }
  await finishOne(deps, workerId, job);
}

async function finishOne(deps: Pick<ComponentDeps, 'pins' | 'audit' | 'now'>, workerId: string, job: RuntimeJob): Promise<void> {
  const spec = job.component;
  if (!spec) return;
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
