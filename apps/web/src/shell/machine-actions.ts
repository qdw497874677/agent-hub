import type { WorkerInfoDto } from '@agent-hub/contract';

/**
 * 这台机器上「我现在能做什么」。服务端在 `GET /api/workers` 的每台机器上带一组 `actions` 布尔值，
 * 由它决定按钮出不出现（同一份判定也用在接口上，两边不会各说各话）。
 *
 * 缺字段、值不是 `true` 一律按「不能做」：宁可少一个按钮，也不要让人点了才吃到 403。
 * 不从凭据接口的 403/404 反推权限——那是另一个问题（有没有专属凭据），推出来的东西迟早走样。
 */
export type MachineVerb =
  | 'update'
  | 'updateLogs'
  | 'disconnect'
  | 'rotateCredential'
  | 'revokeCredential'
  | 'installRuntime'
  | 'installComponent'
  | 'configureResources';

export type MachineActions = Readonly<Record<MachineVerb, boolean>>;

const DENY_ALL: MachineActions = {
  update: false,
  updateLogs: false,
  disconnect: false,
  rotateCredential: false,
  revokeCredential: false,
  installRuntime: false,
  installComponent: false,
  configureResources: false
};

/** 老 hub 还没带 `actions` 时整组为 false（fail closed）。 */
export function machineActions(worker: WorkerInfoDto | undefined | null): MachineActions {
  const raw = (worker as unknown as { readonly actions?: unknown } | undefined | null)?.actions;
  if (!raw || typeof raw !== 'object') return DENY_ALL;
  const flags = raw as Record<string, unknown>;
  const out: Record<MachineVerb, boolean> = { ...DENY_ALL };
  for (const verb of Object.keys(DENY_ALL) as MachineVerb[]) out[verb] = flags[verb] === true;
  return out;
}

/** 这台机器和 hub 比是新的、旧的，还是没报上来。不知道就是不知道，不许当成「已是最新」。 */
export type MachineVersion = 'current' | 'outdated' | 'unknown';

/** 服务端算好的版本状态；老 hub 没有这个字段时一律 `unknown`。 */
export function machineVersion(worker: WorkerInfoDto | undefined | null): MachineVersion {
  const raw = (worker as unknown as { readonly versionStatus?: unknown } | undefined | null)?.versionStatus;
  return raw === 'current' || raw === 'outdated' ? raw : 'unknown';
}

/**
 * 更新那一块「说哪句话 + 给哪个动作」。放在纯函数里，好让测试把每种状态都摆一遍：
 * 不知道版本不写成「已是最新」，正在更新时不写「等主人」，失败时只给一个「重试」。
 */
export type UpdateAction = 'none' | 'busy' | 'retry' | 'update' | 'trial' | 'blocked-online' | 'blocked-owner' | 'blocked-version';

export interface UpdateView {
  readonly status: string;
  readonly action: UpdateAction;
}

export function machineUpdateView(worker: WorkerInfoDto | undefined | null, actions: MachineActions): UpdateView {
  const local = worker?.origin === 'local';
  const online = worker?.state === 'online';
  const noRemoteUpdate = Array.isArray(worker?.capabilities) && !worker.capabilities.includes('update');
  const state = worker?.update?.state;
  const busy = state === 'updating' || state === 'trial';
  const failed = state === 'failed' || state === 'rolled_back';
  const version = machineVersion(worker);
  const status = local
    ? '和 hub 同源，不用单独更新'
    : noRemoteUpdate
      ? '这台机器不接受远程更新'
      : busy
        ? '正在更新，等它跑完'
        : failed
          ? '上次更新没成功'
          : version === 'outdated'
            ? '落后于 hub 的版本'
            : version === 'current'
              ? '已是最新'
              : online
                ? '还没报上来版本'
                : '离线，回来之后再核对版本';
  if (local || noRemoteUpdate) return { status, action: 'none' };
  if (!online) return { status, action: 'blocked-online' };
  if (busy) return { status, action: 'busy' };
  if (failed) return { status, action: actions.update ? 'retry' : 'none' };
  if (version === 'outdated') return { status, action: actions.update ? 'update' : 'blocked-owner' };
  if (version === 'unknown') return { status, action: 'blocked-version' };
  return { status, action: actions.update ? 'trial' : 'none' };
}

/** 一台机器上有没有任何「管理」动作可做（用来决定要不要显示说明性的那一行）。 */
export function anyManageAction(actions: MachineActions): boolean {
  return actions.update || actions.disconnect || actions.rotateCredential || actions.revokeCredential || actions.installRuntime || actions.installComponent || actions.configureResources;
}
