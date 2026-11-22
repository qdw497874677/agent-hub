import {
  asSessionId,
  asTaskId,
  authorizeProject,
  authorizeWorker,
  conflict,
  createTaskWithReplayUseCase,
  err,
  forbidden,
  invalid,
  notFound,
  ok,
  principalOfSubject,
  unavailable,
  type DelegationDirectAuthorizer,
  type DelegationDirectSource,
  type DelegationRun,
  type DirectDelegateWorkspaceCommand,
  type DomainError,
  type Principal,
  type Project,
  type ProjectRepo,
  type Result,
  type Session,
  type Task,
  type TaskCreationStore,
  type Workspace,
  type WorkspaceDelegation,
  type WorkspaceDelegationStore
} from '@agent-hub/domain';
import type { ProjectSessionGrantService } from './project-session-grant.ts';
import {
  runWorkspaceDelegationDirect,
  type DelegationDeps
} from './workspace-delegation.ts';
import type {
  ProjectTaskCreateCommand,
  ProjectTaskSnapshot,
  ProjectWorktreeSnapshot,
  ProjectWorktreeStartCommand
} from './project-session-tools.ts';

/**
 * `project.task.create` / `project.worktree.start` 的生产回调
 * （docs/design/project-session-mcp.md 实施顺序 1）。
 *
 * 身份与来源会话只来自工具 provider 冻结的 `ctx.grant`；项目只从授权服务
 * 重新读取的会话 / 任务绑定得出，绝不从命令参数、当前目录或资产文本推断。
 *
 * 两条路径都是独立写入：
 * - 建任务只写任务，不建会话、不派工；
 * - 开 worktree 先由授权服务确认 `worktree:open`，再由领域用例逐步调用这里注入的
 *   当前授权谓词。谓词每步都重新加载账号、授权、项目、任务、仓库与 Worker，
 *   拒绝发生在下一处副作用之前。
 */

/** 直接车道每步授权会重新读取的编译期接口；测试可替换实现以覆盖失败路径。 */
export type ProjectDirectRunner = (
  deps: DelegationDeps,
  delegations: WorkspaceDelegationStore,
  authorize: DelegationDirectAuthorizer,
  command: DirectDelegateWorkspaceCommand
) => Promise<Result<DelegationRun, DomainError>>;

export interface ProjectSessionActionDeps {
  /** 只暴露工具侧 `authorize`；grant / revoke 仍然只属于浏览器路由。 */
  readonly grants: Pick<ProjectSessionGrantService, 'authorize'>;
  readonly delegationDeps: DelegationDeps;
  readonly delegations: WorkspaceDelegationStore;
  readonly taskCreations: TaskCreationStore;
  /**
   * 按账号 id 重新加载当前登录人；绑定方应接 `loadActor(users, access, id, 'web')`。
   * 拒绝停用 / 删除的账号，并保留 no-via 的真人 provenance。
   */
  readonly loadActor: (accountId: string) => Promise<Principal | null>;
  /** 测试注入点；生产省略时使用 `runWorkspaceDelegationDirect`。 */
  readonly runDirect?: ProjectDirectRunner;
}

export interface ProjectSessionActions {
  readonly createTask: (
    command: ProjectTaskCreateCommand
  ) => Promise<Result<ProjectTaskSnapshot, DomainError>>;
  readonly startWorktree: (
    command: ProjectWorktreeStartCommand
  ) => Promise<Result<ProjectWorktreeSnapshot, DomainError>>;
}

const SHA_LENGTH = 40;
const SECTION_KEYS_MAX = 40;
const SECTION_KEYS_SHOWN = 5;

/** 非 prepared 的记录只回状态类别，不回失败详情 / 路径 / 请求内容。 */
function nonPrepared(state: WorkspaceDelegation['state']): DomainError {
  switch (state) {
    case 'pending':
    case 'preparing':
      return conflict('派工仍在进行中，请用相同请求键稍后重试');
    case 'failed':
      return unavailable('派工失败，请用相同请求键重试');
    case 'uncertain':
      return unavailable('派工结果尚未确认，请人工核对后再操作');
    case 'cancelled':
      return conflict('派工已取消');
    default:
      return unavailable('派工未完成，请人工核对后再操作');
  }
}

/**
 * 失败信息可能来自 Git / 进程 / 目录探测，含远端地址、路径或底层异常文本。
 * 只有领域校验与授权谓词自己写的固定文案可以直接回给调用方。
 */
function safeFailure(error: DomainError): DomainError {
  if (error.code === 'unavailable') return unavailable('派工未能完成，请稍后重试');
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 工具参数里若出现额外字段，错误里只列字段名，不回显值。provider 已经严格拒绝，
 * 这里是第二道防线，保证这个模块单独被复用时也不会把 goal / instructions 带进审计。
 */
function extraKeyList(input: unknown, allowed: ReadonlySet<string>): string | null {
  if (!isRecord(input)) return null;
  const extra = Object.keys(input)
    .filter((key) => !allowed.has(key))
    .slice(0, SECTION_KEYS_SHOWN)
    .map((key) => key.slice(0, SECTION_KEYS_MAX));
  return extra.length === 0 ? null : extra.join(', ');
}

const TASK_KEYS = new Set(['requestKey', 'title', 'goal', 'parentTaskId', 'actorId', 'actorVia', 'sessionId']);
const WORKTREE_KEYS = new Set([
  'requestKey',
  'taskId',
  'repoId',
  'baseBranch',
  'instructions',
  'agentId',
  'model',
  'profileId',
  'actorId',
  'actorVia',
  'sessionId'
]);

/**
 * 建任务：项目从当前授权里取（授权服务已按会话绑定推导并复核），
 * 父任务只允许同一项目；请求键原样交给领域幂等回执。
 */
async function createTaskAction(
  deps: ProjectSessionActionDeps,
  command: ProjectTaskCreateCommand
): Promise<Result<ProjectTaskSnapshot, DomainError>> {
  const extra = extraKeyList(command, TASK_KEYS);
  if (extra !== null) return err(invalid(`未知参数：${extra}`));

  const granted = await deps.grants.authorize({
    actor: { userId: command.actorId, via: command.actorVia },
    sessionId: command.sessionId,
    scope: 'task:write'
  });
  if (!granted.ok) return granted;
  const grant = granted.value;

  // 授权服务已经按会话归属人复核；这里再钉住账号与会话，防止未来替换实现时松动。
  if (grant.accountId !== command.actorId || grant.sessionId !== command.sessionId) {
    return err(forbidden('项目授权与会话当前绑定不一致'));
  }

  const actor = await deps.loadActor(command.actorId);
  if (!actor || actor.user.id !== command.actorId) return err(forbidden('当前账号不可用'));

  // 父任务存在性与同项目都用同一句话回复，不向调用方区分「不存在」和「别的项目」。
  if (command.parentTaskId !== null) {
    let parent;
    try {
      parent = await deps.delegationDeps.tasks.byId(asTaskId(command.parentTaskId));
    } catch {
      return err(unavailable('任务未能创建，请稍后用相同请求键重试'));
    }
    if (!parent || parent.projectId !== grant.projectId) {
      return err(invalid('parent_task_id 无效'));
    }
  }

  let created;
  try {
    created = await createTaskWithReplayUseCase(
      {
        projects: deps.delegationDeps.projects,
        tasks: deps.delegationDeps.tasks,
        taskCreations: deps.taskCreations,
        now: deps.delegationDeps.now
      },
      {
        actorId: command.actorId,
        sourceSessionId: command.sessionId,
        projectId: grant.projectId,
        requestKey: command.requestKey,
        title: command.title,
        ...(command.goal === null ? {} : { goal: command.goal }),
        ownerId: command.actorId,
        parentTaskId: command.parentTaskId
      }
    );
  } catch {
    return err(unavailable('任务未能创建，请稍后用相同请求键重试'));
  }
  if (!created.ok) {
    // 预检与写入之间父任务被删除 / 移走：仍给中性错误，不暴露另一项目是否存在。
    if (command.parentTaskId !== null && created.error.message.includes('父任务')) {
      return err(invalid('parent_task_id 无效'));
    }
    return created;
  }

  const task = created.value;
  return ok({
    id: task.id,
    projectId: task.projectId,
    parentTaskId: task.parentTaskId ?? null,
    status: task.status
  });
}

interface AuthorizerContext {
  readonly deps: ProjectSessionActionDeps;
  readonly command: ProjectWorktreeStartCommand;
}

async function freshActor(context: AuthorizerContext, source: DelegationDirectSource): Promise<Result<Principal, DomainError>> {
  const { deps, command } = context;
  const actor = await deps.loadActor(command.actorId);
  if (!actor || actor.user.id !== command.actorId) return err(forbidden('当前账号不可用'));
  if (actor.via) return err(forbidden('派工必须由真人登录会话发起'));
  if (source.accountId !== command.actorId || source.sessionId !== command.sessionId) {
    return err(forbidden('来源会话已漂移'));
  }
  return ok(actor);
}

async function checkRegisteredRepo(
  project: Project,
  repo: ProjectRepo,
  repoId: string
): Promise<Result<void, DomainError>> {
  const registered = project.repos.find((candidate) => candidate.id === repoId);
  if (!registered || registered.id !== repo.id || registered.url.trim() === '') {
    return err(forbidden('仓库不在项目当前清单里'));
  }
  if (registered.url !== repo.url) return err(forbidden('项目仓库地址已变更'));
  return ok(undefined);
}

async function checkPrepared(
  deps: ProjectSessionActionDeps,
  project: Project,
  task: Task,
  plan: { readonly workerId: string; readonly worktreePath: string; readonly branch: string },
  prepared: { readonly workspaceId: string; readonly baseSha: string }
): Promise<Result<void, DomainError>> {
  if (prepared.workspaceId.trim() === '' || !new RegExp(`^[a-f0-9]{${SHA_LENGTH}}$`).test(prepared.baseSha)) {
    return err(forbidden('派工工作区快照不完整'));
  }
  const workspace = await deps.delegationDeps.workspaces.byId(prepared.workspaceId as Workspace['id']);
  if (!workspace) return err(forbidden('派工工作区不存在'));
  if (workspace.projectId !== project.id || workspace.ownerTaskId !== task.id) {
    return err(forbidden('派工工作区不属于当前项目任务'));
  }
  if (workspace.path !== plan.worktreePath || workspace.branch !== plan.branch) {
    return err(forbidden('派工工作区与计划不一致'));
  }
  if (workspace.workerId !== null && workspace.workerId !== plan.workerId) {
    return err(forbidden('派工工作区不在计划的 Worker 上'));
  }
  return ok(undefined);
}

/**
 * 每个尚未产生副作用的步骤前都会调用。这里不信任前一步的快照：
 * 账号、授权、来源会话、项目、目标任务、仓库、Worker 与已准备资源全部重新读取。
 */
function createDirectAuthorizer(context: AuthorizerContext): DelegationDirectAuthorizer {
  const { deps, command } = context;

  return async (input) => {
    const actorResult = await freshActor(context, input.source);
    if (!actorResult.ok) return actorResult;
    const actor = actorResult.value;

    const actorId = principalOfSubject(input.actor)?.user.id ?? null;
    if (actorId !== command.actorId) return err(forbidden('派工主体已漂移'));

    // grant 每次重读：撤销 / 过期 / 会话项目漂移都会在这里立即失效。
    const granted = await deps.grants.authorize({
      actor: { userId: command.actorId, via: command.actorVia },
      sessionId: command.sessionId,
      scope: 'worktree:open'
    });
    if (!granted.ok) return granted;
    const grant = granted.value;
    if (grant.accountId !== command.actorId || grant.sessionId !== command.sessionId) {
      return err(forbidden('项目授权与会话当前绑定不一致'));
    }

    if (input.project.id !== grant.projectId) return err(forbidden('项目已漂移'));
    if (input.source.projectId !== grant.projectId) return err(forbidden('来源会话项目已漂移'));
    if (input.task.id !== command.taskId) return err(forbidden('目标任务已漂移'));
    if (input.task.projectId !== grant.projectId) return err(forbidden('目标任务不在授权项目里'));
    if (input.project.deletedAt !== null) return err(notFound('项目不存在'));

    const repo = await checkRegisteredRepo(input.project, input.repo, command.repoId);
    if (!repo.ok) return repo;

    if (input.plan.baseBranch !== command.baseBranch) {
      return err(forbidden('派工基线分支与当前请求不一致'));
    }
    if (input.plan.workerId.trim() === '') return err(forbidden('派工缺少 Worker'));

    // 项目 / Worker 权限在每一步重新判定，不依赖创建请求时的快照。
    const canCreate = await authorizeProject(deps.delegationDeps.access, actor, input.project, 'session.create');
    if (!canCreate.ok) return canCreate;
    const canSpawn = await authorizeProject(deps.delegationDeps.access, actor, input.project, 'agent.spawn');
    if (!canSpawn.ok) return canSpawn;
    const canUseWorker = await authorizeWorker(deps.delegationDeps.access, actor, input.plan.workerId);
    if (!canUseWorker.ok) return canUseWorker;

    if (input.record) {
      const record = input.record;
      if (record.accountId !== command.actorId) return err(forbidden('派工记录归属人已漂移'));
      if (record.mode != null && record.mode !== 'direct') return err(forbidden('派工车道不一致'));
      if (record.projectId !== input.project.id) return err(forbidden('派工记录项目已漂移'));
      if (record.taskId !== input.task.id) return err(forbidden('派工记录任务已漂移'));
      if (record.repoId !== input.repo.id || record.repoUrl !== input.repo.url) {
        return err(forbidden('派工记录仓库已漂移'));
      }
      if (record.workerId !== input.plan.workerId) return err(forbidden('派工记录 Worker 已漂移'));
      if (record.baseBranch !== command.baseBranch) return err(forbidden('派工记录基线分支已漂移'));
      if (record.executionSessionId.trim() === '') return err(forbidden('派工记录缺少执行会话'));
    }

    if (input.prepared) {
      const prepared = await checkPrepared(deps, input.project, input.task, input.plan, input.prepared);
      if (!prepared.ok) return prepared;
    }

    if (input.started) {
      const record = input.record;
      if (!record) return err(forbidden('启动结果缺少派工记录'));
      if (input.started.sessionId !== record.executionSessionId) {
        return err(forbidden('执行会话与派工记录不一致'));
      }
      if (input.started.taskId !== input.task.id) return err(forbidden('执行会话任务已漂移'));
      if (!input.prepared || input.started.workspaceId !== input.prepared.workspaceId) {
        return err(forbidden('执行会话工作区与准备结果不一致'));
      }
      const session = await deps.delegationDeps.sessions.byId(input.started.sessionId);
      if (!session || session.taskId !== input.task.id || session.workspaceId !== input.started.workspaceId) {
        return err(forbidden('执行会话尚未绑定到准备的工作区'));
      }
    }

    return ok(undefined);
  };
}

/** 从精确的执行会话取 workspace id；记录本身不提供可伪造的 workspace id。 */
function checkPreparedRecord(
  record: WorkspaceDelegation,
  projectId: string,
  command: ProjectWorktreeStartCommand
): Result<void, DomainError> {
  if (
    record.accountId !== command.actorId ||
    (record.mode != null && record.mode !== 'direct') ||
    record.projectId !== projectId ||
    record.taskId !== command.taskId ||
    record.repoId !== command.repoId ||
    record.baseBranch !== command.baseBranch ||
    record.requestKey !== command.requestKey ||
    record.instructions !== command.instructions
  ) {
    return err(conflict('派工结果与当前请求不一致，请人工核对'));
  }
  return ok(undefined);
}

async function preparedSnapshot(
  deps: ProjectSessionActionDeps,
  record: WorkspaceDelegation
): Promise<Result<ProjectWorktreeSnapshot, DomainError>> {
  if (
    record.baseSha === null ||
    !new RegExp(`^[a-f0-9]{${SHA_LENGTH}}$`).test(record.baseSha) ||
    record.branch.trim() === '' ||
    record.executionSessionId.trim() === ''
  ) {
    return err(unavailable('派工结果缺少可核实的执行标识'));
  }
  const session: Session | null = await deps.delegationDeps.sessions.byId(record.executionSessionId);
  if (!session || session.id !== record.executionSessionId) {
    return err(unavailable('派工执行会话不存在'));
  }
  if (session.taskId !== record.taskId || session.workspaceId === null) {
    return err(unavailable('派工执行会话尚未绑定任务工作区'));
  }
  const workspace: Workspace | null = await deps.delegationDeps.workspaces.byId(session.workspaceId);
  if (
    !workspace ||
    workspace.id !== session.workspaceId ||
    workspace.projectId !== record.projectId ||
    workspace.ownerTaskId !== record.taskId ||
    workspace.path !== record.worktreePath ||
    workspace.branch !== record.branch ||
    (record.workerId.trim() !== '' && workspace.workerId !== record.workerId)
  ) {
    return err(unavailable('派工工作区无法核实'));
  }

  return ok({
    delegationId: record.id,
    executionSessionId: record.executionSessionId,
    workspaceId: session.workspaceId,
    taskId: record.taskId,
    repoId: record.repoId,
    branch: record.branch,
    baseSha: record.baseSha
  });
}

/**
 * 开 worktree：先过 `worktree:open`，再走直接车道。领域用例在 prepare / start /
 * instruction 之前调用谓词；任一拒绝都发生在下一处外部副作用之前。
 */
async function startWorktreeAction(
  deps: ProjectSessionActionDeps,
  command: ProjectWorktreeStartCommand
): Promise<Result<ProjectWorktreeSnapshot, DomainError>> {
  const extra = extraKeyList(command, WORKTREE_KEYS);
  if (extra !== null) return err(invalid(`未知参数：${extra}`));

  const granted = await deps.grants.authorize({
    actor: { userId: command.actorId, via: command.actorVia },
    sessionId: command.sessionId,
    scope: 'worktree:open'
  });
  if (!granted.ok) return granted;
  const grant = granted.value;
  if (grant.accountId !== command.actorId || grant.sessionId !== command.sessionId) {
    return err(forbidden('项目授权与会话当前绑定不一致'));
  }

  const actor = await deps.loadActor(command.actorId);
  if (!actor || actor.user.id !== command.actorId || actor.via) {
    return err(forbidden('当前账号不可用'));
  }

  const authorize = createDirectAuthorizer({ deps, command });
  const runDirect = deps.runDirect ?? runWorkspaceDelegationDirect;

  let result;
  try {
    result = await runDirect(
      deps.delegationDeps,
      deps.delegations,
      authorize,
      {
        actor,
        sourceSessionId: asSessionId(command.sessionId),
        requestKey: command.requestKey,
        taskId: asTaskId(command.taskId),
        repoId: command.repoId,
        baseBranch: command.baseBranch,
        instructions: command.instructions,
        agentId: command.agentId,
        model: command.model,
        profileId: command.profileId
      }
    );
  } catch {
    // 底层 bridge 的异常文本可能有远端地址 / 路径；只回固定文案。
    return err(unavailable('派工未能完成，请稍后重试'));
  }
  if (!result.ok) return err(safeFailure(result.error));

  const record = result.value.record;
  if (record.state !== 'prepared') return err(nonPrepared(record.state));
  // prepared 回放不会经过上面的逐步谓词；这里仍核对记录归属与本次请求参数。
  const replay = checkPreparedRecord(record, grant.projectId, command);
  if (!replay.ok) return replay;
  return preparedSnapshot(deps, record);
}

export function createProjectSessionActions(deps: ProjectSessionActionDeps): ProjectSessionActions {
  return {
    createTask: (command) => createTaskAction(deps, command),
    startWorktree: (command) => startWorktreeAction(deps, command)
  };
}
