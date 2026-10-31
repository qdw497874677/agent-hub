import type { ComponentAction, ComponentJobResult, ComponentJobSpec } from './component-catalog.ts';
import type { Principal } from './account.ts';
import type { WorkerCredential } from './enrollment.ts';
import { conflict, forbidden, invalid, notFound, type DomainError } from './errors.ts';
import { err, ok, type Result } from './result.ts';
import type { WorkerStatus } from './worker.ts';

/**
 * 在 Worker 上安装 agent 运行时（docs/design/runtime-install.md，ADR 0010）。
 *
 * 领域只管规则：谁能装、什么时候能装、装哪个版本。怎么装（npm / 官方脚本）是 Worker 侧的
 * HarnessInstaller 适配器；装到哪（~/.agent-hub/runtimes）是 node-gateway 的事。
 */

/** 这台机器上这个运行时从哪来。machine = 机器自己装的（PATH / 常见位置 / X_COMMAND），以它为准，hub 不碰。 */
export type RuntimeSource = 'machine' | 'hub' | 'missing';

export interface RuntimeProvision {
  readonly source: RuntimeSource;
  /** hub 装的那份的版本（source = hub 时才有）。 */
  readonly version?: string;
  /** 适配器里钉死的推荐版本；没有 = 这个 agent 不支持在线安装（如自定义 ACP agent）。 */
  readonly recommended?: string;
  /** 不能装的原因（平台不支持、缺 npm / curl……）；能装是 undefined。 */
  readonly blocker?: string;
}

export type RuntimeAction = 'install' | 'uninstall';
export type RuntimeJobState = 'running' | 'succeeded' | 'failed' | 'refused';

/** 一次安装 / 卸载任务：hub 内存里每台机器留最近一个，界面据此显示进度和日志。 */
export interface RuntimeJob {
  readonly jobId: string;
  readonly agentId: string;
  readonly action: RuntimeAction | ComponentAction;
  readonly version: string | null;
  /** 组件任务（ADR 0021 P2）才有：要装 / 卸的组件。 */
  readonly component?: ComponentJobSpec;
  /** 组件任务结束时 Worker 报的结构化结果。 */
  readonly result?: ComponentJobResult;
  readonly state: RuntimeJobState;
  readonly message: string;
  /** 安装日志的末尾（有上限）。 */
  readonly log: string;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly actorEmail: string;
}

/** 版本号只接受 X.Y.Z(-suffix)：它会作为参数传给 npm / 安装脚本，不能夹带别的东西。 */
export const RUNTIME_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(-[0-9A-Za-z.]{1,32})?$/;

/** 能在线安装的 agent id 的形状：同样会进路径，收紧。 */
export const RUNTIME_AGENT_ID = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * 谁能在这台机器上装 / 卸：主人能动任何一台；成员只能动自己接入的那台（凭据上的 enrolledBy）。
 * 本机 Worker 没有接入凭据，只有主人能动。
 */
export function canManageRuntimes(
  actor: Principal | null,
  worker: Pick<WorkerStatus, 'origin'>,
  credential: Pick<WorkerCredential, 'enrolledBy' | 'revokedAt'> | null
): Result<Principal, DomainError> {
  if (!actor || actor.user.disabledAt !== null) return err(forbidden('请先登录'));
  if (actor.user.role === 'owner') return ok(actor);
  if (worker.origin === 'remote' && credential && credential.revokedAt === null && credential.enrolledBy === actor.user.id) return ok(actor);
  return err(forbidden('只有主人或接入这台机器的人能在上面安装运行时'));
}

export interface RuntimeRequest {
  readonly agentId: string;
  readonly action: RuntimeAction;
  /** 不填就装推荐版本。 */
  readonly version?: string | undefined;
}

/**
 * 能不能发这个任务、发哪个版本。规则（顺序即优先级）：
 * 离线拒绝；同一台机器同时只跑一个任务；老 Worker（不报 provision）拒绝；
 * 机器自带的不装也不卸；卸载只针对 hub 装的那份；有会话正用着这个 agent 时不升级、不卸载。
 */
export function planRuntimeJob(
  worker: WorkerStatus | undefined,
  request: RuntimeRequest,
  busySessions: number
): Result<{ readonly action: RuntimeAction; readonly version: string | null; readonly from: string | null }, DomainError> {
  if (!worker) return err(notFound('没有这台机器'));
  if (worker.state !== 'online') return err(conflict('这台机器不在线，连上之后再装'));
  if (worker.runtimeJob?.state === 'running') return err(conflict('这台机器上已经有一个安装任务在跑'));
  const entry = worker.agentModels?.find((candidate) => candidate.agentId === request.agentId);
  if (!entry) return err(notFound('这台机器不认识这个 agent'));
  const provision = entry.provision;
  if (!provision) return err(conflict('这台 Worker 版本太旧，不支持在线安装：先更新它'));
  if (provision.source === 'machine') return err(conflict('这台机器自己装了它，以机器上的为准，hub 不安装也不卸载'));
  const from = provision.source === 'hub' ? (provision.version ?? null) : null;

  if (request.action === 'uninstall') {
    if (provision.source !== 'hub') return err(conflict('只能卸载 hub 装的那份，这台机器上没有'));
    if (busySessions > 0) return err(conflict('还有会话在用它，结束后再卸载'));
    return ok({ action: 'uninstall', version: null, from });
  }

  if (!provision.recommended) return err(conflict('这个 agent 不支持在线安装'));
  if (provision.blocker) return err(conflict(provision.blocker));
  const version = request.version ?? provision.recommended;
  if (!RUNTIME_VERSION.test(version)) return err(invalid('版本号格式不对（要 X.Y.Z）'));
  if (from === version) return err(conflict(`已经装的就是 ${version}`));
  if (from !== null && busySessions > 0) return err(conflict('还有会话在用它，结束后再升级'));
  return ok({ action: 'install', version, from });
}
