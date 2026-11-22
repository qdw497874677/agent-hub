import { authorizeWorker, canInvoke } from '@agent-hub/domain';
import type { AccessPolicy, Permission, Principal, Subject, WorkerCredential, WorkerStatus } from '@agent-hub/domain';
import { requireOwner, workerUpdateApplicable } from '@agent-hub/domain';
import type { WorkerActionsDto } from '@agent-hub/contract';

export interface WorkerActionContext {
  /** 没装账号体系时没有 access：与各用例一致，不额外限制。 */
  readonly access?: AccessPolicy;
  readonly subject: Subject | null;
  readonly principal: Principal | null;
  readonly credential: WorkerCredential | null;
  readonly now: number;
  /** hub 当前的提交；null 时更新接口自己也会拒绝。 */
  readonly hubCommit: string | null;
  /** 网关实现是否支持轮换（老实现没有）。 */
  readonly canRotate: boolean;
}

/**
 * 把 `/api/workers` 每台机器的动作权限算成布尔值。
 *
 * 这里不重新发明规则：管理员动作照 `requireOwner` / `updateWorker` /
 * `disconnectWorker` 的现有条件，机器动作照 `authorizeWorker(worker.manage /
 * runtime.install)` 和运行时安装的现有条件。凭据只用来表示「这台机器有没有
 * 可轮换 / 可吊销的凭据」，绝不因为查不到凭据就放大权限：没有凭据的远端机器
 * 在 domain 里属于 hub 团队（共享 HUB_TOKEN），普通成员仍然不能管理它。
 */
export async function workerActionsFor(worker: WorkerStatus, ctx: WorkerActionContext): Promise<WorkerActionsDto> {
  const owner = requireOwner(ctx.principal).ok;
  const remote = worker.origin === 'remote';
  const online = worker.state === 'online';

  const permissions = new Map<Permission, Promise<boolean>>();
  const allowed = (permission: Permission): Promise<boolean> => {
    const cached = permissions.get(permission);
    if (cached) return cached;
    const value = authorizeWorker(ctx.access, ctx.subject, remote ? worker.workerId : null, permission).then((result) => result.ok);
    permissions.set(permission, value);
    return value;
  };

  const [manage, install, componentInstall] = await Promise.all([
    allowed('worker.manage'),
    allowed('runtime.install'),
    allowed('runtime.component.install')
  ]);

  const credential = ctx.credential;
  const credentialLive = credential !== null && credential.revokedAt === null;
  const rotating = credentialLive && credential.pendingHash != null && (credential.pendingUntil ?? 0) > ctx.now;
  const installable = (worker.agentModels ?? []).some((agent) => agent.provision);
  const jobIdle = worker.runtimeJob?.state !== 'running' && canInvoke(worker.capabilities, 'runtimes');
  // 运行时和组件是两个独立入口、两个独立权限，不能因为「有其中一个」就把另一个也放出来。
  const runtimeInstallable = install && installable;
  const componentInstallable = componentInstall && worker.inventory?.componentInstall === true;

  return {
    // updateWorker：管理员 + 单台更新按钮的适用条件（本机 / 无自更新能力不给）。
    update: owner && workerUpdateApplicable(worker, ctx.hubCommit),
    // 更新日志只经 /api/admin/workers 发给管理员；没有日志就没有可看的。
    updateLogs: owner && Boolean(worker.update?.logTail),
    // disconnectWorker：管理员、远端、在线（本机跟 hub 同生共死）。
    disconnect: owner && remote && online,
    // rotateWorkerCredential：有有效凭据、在线、不在轮换宽限期，且网关支持。
    rotateCredential: manage && remote && credentialLive && online && !rotating && ctx.canRotate,
    // revokeWorker：有凭据可吊销；共享 HUB_TOKEN 的老机器只能靠「在线」让它断开。
    revokeCredential: manage && remote && (credential !== null ? credential.revokedAt === null : online),
    // startRuntimeJob：runtime.install + 在线 + Worker 允许装卸运行时 + 没有正在跑的任务 + 至少报了一个可安装的 agent。
    installRuntime: online && jobIdle && runtimeInstallable,
    // startComponentJob：runtime.component.install + 清单声明能装组件；和运行时权限互不代替。
    installComponent: online && jobIdle && componentInstallable,
    // setRefuseWhenFull：只认 worker.manage，不看在线状态。
    configureResources: manage
  };
}
