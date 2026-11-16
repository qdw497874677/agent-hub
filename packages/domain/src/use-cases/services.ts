import type { Subject } from '../access.ts';
import type { DomainError } from '../errors.ts';
import { invalid, notFound, unavailable } from '../errors.ts';
import { asServiceId, asWorkspaceId, newId, type ServiceId, type TaskId, type WorkspaceId } from '../ids.ts';
import { err, ok, type Result } from '../result.ts';
import {
  SERVICE_ENV_MAX,
  SERVICE_LOG_MAX,
  appendServiceLog,
  serviceCommandProblem,
  serviceEnvProblem,
  serviceIdFrom,
  servicePortProblem,
  serviceStateOf,
  type ServiceRestart,
  type ServiceStateReport,
  type SessionService
} from '../service.ts';
import type { NodeGateway } from '../ports/node-gateway.ts';
import type { SessionServiceRepository } from '../ports/session-service-repository.ts';
import type { Deps } from './deps.ts';
import { authorizeProject, authorizeSession, projectOfRef } from './authorization.ts';
import { terminalAccess, terminalTarget } from './terminal.ts';
import { locationOf } from './workspaces.ts';

/**
 * 会话服务（docs/design/session-service.md）的用例。
 *
 * 权限：带 sessionId 时按 `session.prompt`（和终端一样：能起进程就等于能以会话身份执行命令）；
 * 只按任务建时按 `project.update`。`root` 是否落在 WORKER_ROOTS 内由 Worker realpath 后判定，
 * hub 只做非空 / 绝对路径校验。
 */
export type ServiceDeps = Pick<Deps, 'projects' | 'tasks' | 'sessions' | 'workspaces' | 'access' | 'now'> & {
  readonly sessionServices: SessionServiceRepository;
  readonly gateway: Pick<NodeGateway, 'services' | 'processes'>;
};

export interface CreateServiceInput {
  readonly taskId: string;
  /** 从哪条会话发起；给了就按会话授权并复用它的机器 / 工作空间。 */
  readonly sessionId?: string | null;
  /** 不跟会话绑定时用它定位机器与目录。 */
  readonly workspaceId?: string | null;
  readonly workerId?: string | null;
  /** 绝对路径；不给就用工作空间的根。 */
  readonly root?: string | null;
  readonly command: string;
  readonly port?: number | null;
  readonly env?: Readonly<Record<string, string>>;
  readonly restart?: ServiceRestart;
}

const RESTARTS: readonly ServiceRestart[] = ['always', 'on-demand', 'never'];

/** 服务列表：按任务或按会话挑一个入口，权限都只需要 `session.read` / `project.read`。 */
export type ServiceListQuery =
  | { readonly kind: 'task'; readonly taskId: string }
  | { readonly kind: 'session'; readonly sessionId: string };

async function freshServiceId(services: SessionServiceRepository): Promise<ServiceId> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const id = serviceIdFrom(newId().replaceAll('-', '').slice(0, 8));
    if ((await services.byId(id)) === null) return id;
  }
  // 8 位十六进制撞四次基本等于随机数坏了；宁可报错也不要覆盖别人的服务。
  throw new Error('生成服务 id 失败：连续撞号');
}

function portOf(value: number | null | undefined): number | null {
  return value === undefined || value === null ? null : value;
}

/** 建一条服务：校验 → 落库（starting）→ 交给 Worker 真的拉起来。Worker 不在线时记 failed 并报错。 */
export async function createServiceUseCase(
  deps: ServiceDeps,
  subject: Subject | null,
  input: CreateServiceInput
): Promise<Result<SessionService, DomainError>> {
  let taskId: TaskId;
  let projectId: string;
  let workspaceId: WorkspaceId | null = null;
  let workerId: string;
  let baseRoot: string;
  let sessionId: SessionService['sessionId'] = null;

  if (input.sessionId != null && input.sessionId !== '') {
    const access = await terminalAccess(deps, subject, input.sessionId);
    if (!access.ok) return access;
    const target = await terminalTarget(deps, subject, input.sessionId);
    if (!target.ok) return target;
    const { project, session } = await projectOfRef(deps, { kind: 'session', id: input.sessionId });
    if (!project || !session) return err(notFound('会话不存在'));
    if (session.taskId === null) return err(invalid('容器会话不能起本地服务'));
    if (session.taskId !== input.taskId) return err(invalid('服务要挂在会话所属的任务下'));
    taskId = session.taskId;
    projectId = project.id;
    sessionId = session.id;
    workspaceId = session.workspaceId;
    workerId = target.value.workerId ?? 'local';
    baseRoot = target.value.root;
  } else {
    const ref = await projectOfRef(deps, { kind: 'task', id: input.taskId });
    if (!ref.project) return err(notFound('任务不存在'));
    const allowed = await authorizeProject(deps.access, subject, ref.project, 'project.update');
    if (!allowed.ok) return allowed;
    taskId = input.taskId as TaskId;
    projectId = allowed.value.id;

    if (input.workspaceId != null && input.workspaceId !== '') {
      const workspace = await deps.workspaces.byId(asWorkspaceId(input.workspaceId));
      if (!workspace || workspace.state === 'removed') return err(notFound('工作空间不存在'));
      const location = await locationOf(deps, allowed.value, { workerId: workspace.workerId, workspaceId: workspace.id });
      workspaceId = workspace.id;
      baseRoot = location.root;
      workerId = location.workerId ?? input.workerId ?? '';
    } else {
      workerId = input.workerId ?? '';
      baseRoot = '';
    }
    if (workerId === '') return err(invalid('要指定在哪台机器上起服务'));
  }

  const root = (input.root ?? baseRoot).trim();
  if (root === '') return err(invalid('服务目录不能为空'));
  if (!root.startsWith('/')) return err(invalid('服务目录要是绝对路径'));

  const command = input.command.trim();
  const commandProblem = serviceCommandProblem(command);
  if (commandProblem !== null) return err(invalid(commandProblem));

  const port = portOf(input.port);
  const portProblem = servicePortProblem(port);
  if (portProblem !== null) return err(invalid(portProblem));

  const env: Readonly<Record<string, string>> = input.env ?? {};
  if (Object.keys(env).length > SERVICE_ENV_MAX) return err(invalid(serviceEnvProblem(env) ?? '环境变量太多'));
  const envProblem = serviceEnvProblem(env);
  if (envProblem !== null) return err(invalid(envProblem));

  const restart = input.restart ?? 'on-demand';
  if (!RESTARTS.includes(restart)) return err(invalid('重启策略不合法'));

  const now = deps.now();
  const service: SessionService = {
    id: await freshServiceId(deps.sessionServices),
    projectId: projectId as SessionService['projectId'],
    taskId,
    workspaceId,
    sessionId,
    workerId,
    root,
    command,
    port,
    env: { ...env },
    restart,
    state: 'starting',
    pid: null,
    detail: null,
    logTail: '',
    startedAt: null,
    updatedAt: now
  };
  await deps.sessionServices.save(service);

  const bridge = deps.gateway.services?.(workerId);
  if (!bridge) {
    const detail = '这台机器的 Worker 太旧，不支持本地服务';
    await deps.sessionServices.save(serviceStateOf(service, { state: 'failed', detail, at: now }));
    return err(unavailable(detail));
  }

  const started = await bridge.start({ serviceId: service.id, root, command, port, env: service.env, restart });
  if (!started.ok) {
    await deps.sessionServices.save(serviceStateOf(service, { state: 'failed', detail: started.error.message, at: deps.now() }));
    return err(started.error);
  }
  // 不做乐观状态：pid / running 都等 Worker 的 `service_state` 回报。
  return ok(service);
}

/** 停一条服务：先过权限，再让 Worker 收进程树。状态同样等 Worker 回报。 */
export async function stopServiceUseCase(
  deps: ServiceDeps,
  subject: Subject | null,
  serviceId: string
): Promise<Result<SessionService, DomainError>> {
  const service = await deps.sessionServices.byId(asServiceId(serviceId));
  if (!service) return err(notFound('服务不存在'));

  const allowed = await authorizeService(deps, subject, service);
  if (!allowed.ok) return allowed;

  const bridge = deps.gateway.services?.(service.workerId);
  if (!bridge) return err(unavailable('这台机器的 Worker 太旧，不支持本地服务'));
  const stopped = await bridge.stop(service.id);
  if (!stopped.ok) return stopped;
  return ok(service);
}

/** 删一条服务：在跑就先停（停失败也给删——记录不该永远卡着），然后删行。 */
export async function removeServiceUseCase(
  deps: ServiceDeps,
  subject: Subject | null,
  serviceId: string
): Promise<Result<void, DomainError>> {
  const service = await deps.sessionServices.byId(asServiceId(serviceId));
  if (!service) return err(notFound('服务不存在'));
  const allowed = await authorizeService(deps, subject, service);
  if (!allowed.ok) return allowed;
  if (service.state === 'running' || service.state === 'starting') {
    await deps.gateway.services?.(service.workerId)?.stop(service.id);
  }
  await deps.sessionServices.remove(service.id);
  return ok(undefined);
}

/** 列任务 / 会话下的服务。会话入口用 `session.read`（和看预览一样），任务入口用 `project.read`。 */
export async function listServicesUseCase(
  deps: ServiceDeps,
  subject: Subject | null,
  query: ServiceListQuery
): Promise<Result<readonly SessionService[], DomainError>> {
  if (query.kind === 'session') {
    const { project, session } = await projectOfRef(deps, { kind: 'session', id: query.sessionId });
    if (!project || !session) return err(notFound('会话不存在'));
    const allowed = await authorizeSession(deps.access, subject, project, session, 'session.read');
    if (!allowed.ok) return allowed;
    return ok(await deps.sessionServices.listBySession(session.id));
  }
  const ref = await projectOfRef(deps, { kind: 'task', id: query.taskId });
  if (!ref.project) return err(notFound('任务不存在'));
  const allowed = await authorizeProject(deps.access, subject, ref.project, 'project.read');
  if (!allowed.ok) return allowed;
  return ok(await deps.sessionServices.listByTask(query.taskId as TaskId));
}

/**
 * 读一条服务的日志尾部。
 * 日志由 `service_log` 帧持续写进 `log_tail`（只留最后 8 KiB），这里不再向 Worker 要——
 * 机器断线 / 服务已停时也能看到最后那一屏。`maxBytes` 只做上限截断。
 */
export async function readServiceLogsUseCase(
  deps: ServiceDeps,
  subject: Subject | null,
  serviceId: string,
  maxBytes?: number
): Promise<Result<string, DomainError>> {
  const service = await deps.sessionServices.byId(asServiceId(serviceId));
  if (!service) return err(notFound('服务不存在'));
  const allowed = await authorizeService(deps, subject, service);
  if (!allowed.ok) return allowed;
  const limit = maxBytes === undefined ? SERVICE_LOG_MAX : Math.min(Math.max(1, maxBytes), SERVICE_LOG_MAX);
  return ok(service.logTail.slice(-limit));
}

/** Worker 的 `service_state` 帧 → 落库。hub 唯一推进状态的地方。 */
export async function recordServiceStateUseCase(
  deps: Pick<ServiceDeps, 'sessionServices' | 'now'>,
  serviceId: string,
  report: Omit<ServiceStateReport, 'at'>
): Promise<SessionService | null> {
  const service = await deps.sessionServices.byId(asServiceId(serviceId));
  if (!service) return null;
  const next = serviceStateOf(service, { ...report, at: deps.now() });
  await deps.sessionServices.save(next);
  return next;
}

/** Worker 的 `service_log` 帧 → 追加到 log_tail（只留尾部 8 KiB）。 */
export async function recordServiceLogUseCase(
  deps: Pick<ServiceDeps, 'sessionServices'>,
  serviceId: string,
  chunk: string
): Promise<void> {
  const service = await deps.sessionServices.byId(asServiceId(serviceId));
  if (!service) return;
  await deps.sessionServices.save({ ...service, logTail: appendServiceLog(service.logTail, chunk) });
}

/** 有会话就按会话（session.prompt），否则按服务所属任务（project.update）。 */
async function authorizeService(deps: ServiceDeps, subject: Subject | null, service: SessionService): Promise<Result<void, DomainError>> {
  if (service.sessionId !== null) return terminalAccess(deps, subject, service.sessionId);
  const project = await deps.projects.byId(service.projectId);
  const allowed = await authorizeProject(deps.access, subject, project, 'project.update');
  return allowed.ok ? ok(undefined) : allowed;
}
