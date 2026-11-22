import {
  asSessionId,
  authorizeSession,
  conflict,
  err,
  forbidden,
  invalid,
  notFound,
  ok,
  sameRepoUrl,
  unavailable,
  type Deps,
  type DomainError,
  type MessageBus,
  type Principal,
  type Project,
  type Result,
  type Session,
  type SessionId,
  type WorkspaceDelegation,
  type WorkspaceDelegationStore
} from '@agent-hub/domain';
import type { ProjectSessionGrantService } from './project-session-grant.ts';
import type {
  ProjectCandidateRef,
  ProjectSessionHandoffCommand,
  ProjectSessionHandoffSnapshot,
  ProjectSessionListQuery,
  ProjectSessionSummary,
  ProjectSessionToolDeps
} from './project-session-tools.ts';

/**
 * 项目内交接（docs/design/project-session-mcp.md §20-23、§27、§31）。
 *
 * 边界：
 * - 调用方身份（actor / 会话 / 项目）只从服务端项目授权推导；模型只能给目标会话、正文、
 *   请求键和一个可选的候选引用。
 * - 列表只返回调用方当前能 `session.read` 的同项目会话，且只回工具白名单字段。
 * - 交接走独立的 `messageBus.handoff`，不经过通用 `accept`；`wake` 默认 false（只进收件箱）。
 *   受限子会话没有收件箱工具，因此 `wake=false` 会明确拒绝，要求调用方显式 `wake=true`，
 *   绝不静默升级成唤醒。
 * - 候选引用只是 `project-candidate/v1` 的结构化提示，不触发导入、不授权导入。
 */

/** 候选引用 part 的 schema；接收方看到它也只当作提示。 */
export const PROJECT_CANDIDATE_PART_SCHEMA = 'project-candidate/v1';

/** 交接正文里候选 part 的人类可读说明。 */
const CANDIDATE_NOTICE =
  '候选提交引用，仅作提示；接收方如需使用，必须自行显式执行候选导入。';

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const MAX_ID_LENGTH = 200;
const MAX_STATUS_LENGTH = 40;

const HANDOFF_KEYS = new Set([
  'actorId',
  'actorVia',
  'sessionId',
  'requestKey',
  'targetSessionId',
  'body',
  'wake',
  'candidate'
]);
const LIST_KEYS = new Set(['actorId', 'actorVia', 'sessionId', 'limit']);

export interface ProjectSessionHandoffDeps {
  /** 项目授权入口；项目 / 人 / 会话都由它从服务端绑定推导。 */
  readonly grants: Pick<ProjectSessionGrantService, 'authorize'>;
  readonly access: Deps['access'];
  readonly projects: Pick<Deps['projects'], 'byId'>;
  readonly sessions: Pick<Deps['sessions'], 'byId' | 'listByProject'>;
  readonly tasks: Pick<Deps['tasks'], 'byId'>;
  /** 受限子会话识别；查询失败时按「可能是子会话」收紧。 */
  readonly delegations: Pick<WorkspaceDelegationStore, 'byExecutionSession'>;
  readonly messageBus: Pick<MessageBus, 'handoff'>;
  /** 账号当前状态；返回 null 即拒绝。 */
  readonly loadActor: (accountId: string) => Promise<Principal | null>;
  /**
   * 列 `origin_project_id = projectId` 的无任务会话：任务列表走 `task_id` 内连接，
   * 无任务会话永远查不到。未提供时列表只含任务会话；实现方仍需再按 canonical 规则复核。
   */
  readonly listTasklessByOriginProject?: (
    projectId: string
  ) => Promise<readonly Session[]>;
}

export interface ProjectSessionHandoffActions {
  readonly handoff: NonNullable<ProjectSessionToolDeps['handoff']>;
  readonly listSessions: NonNullable<ProjectSessionToolDeps['listSessions']>;
}

interface HandoffContext {
  readonly project: Project;
  readonly actor: Principal;
  readonly session: Session;
}

const grantError = (): DomainError => forbidden('项目授权与会话当前绑定不一致');

const hasControl = (value: string): boolean => CONTROL_CHARACTERS.test(value);

/**
 * 会话 → 项目：有任务时以任务项目为准，但不得与会话不可变来源冲突；
 * 无任务会话必须带不可变来源。返回 null 表示绑定不成立。
 */
async function canonicalProjectId(
  deps: ProjectSessionHandoffDeps,
  session: Session,
  taskCache?: Map<string, string | null>
): Promise<string | null> {
  if (session.taskId === null) return session.originProjectId ?? null;

  const key = session.taskId;
  let projectId = taskCache?.get(key);
  if (projectId === undefined) {
    const task = await deps.tasks.byId(session.taskId);
    projectId = task ? task.projectId : null;
    taskCache?.set(key, projectId);
  }
  if (projectId === null) return null;
  if (session.originProjectId != null && session.originProjectId !== projectId) return null;
  return projectId;
}

/** 授权前置：项目授权、冻结绑定、账号当前状态、调用会话可读。 */
async function handoffContext(
  deps: ProjectSessionHandoffDeps,
  command: ProjectSessionHandoffCommand
): Promise<Result<HandoffContext, DomainError>> {
  const granted = await deps.grants.authorize({
    actor: { userId: command.actorId, via: command.actorVia },
    sessionId: command.sessionId,
    scope: 'message:send'
  });
  if (!granted.ok) return granted;
  const grant = granted.value;
  if (grant.accountId !== command.actorId || grant.sessionId !== command.sessionId) {
    return err(grantError());
  }

  const project = await deps.projects.byId(grant.projectId);
  if (!project || project.deletedAt != null) return err(notFound('项目不存在'));

  const session = await deps.sessions.byId(command.sessionId);
  if (!session) return err(notFound('会话不存在'));

  const actor = await deps.loadActor(command.actorId);
  if (!actor || actor.user.id !== command.actorId) return err(forbidden('当前账号不可用'));

  const canRead = await authorizeSession(deps.access, actor, project, session, 'session.read');
  if (!canRead.ok) return canRead;

  const projectId = await canonicalProjectId(deps, session);
  if (projectId !== project.id) return err(grantError());

  return ok({ project, actor, session });
}

function stateFailure(state: WorkspaceDelegation['state']): DomainError | null {
  switch (state) {
    case 'pending':
    case 'preparing':
      return conflict('候选来源派工仍在进行中');
    case 'failed':
      return unavailable('候选来源派工失败，无法引用候选');
    case 'uncertain':
      return unavailable('候选来源派工结果尚未确认，无法引用候选');
    case 'cancelled':
      return conflict('候选来源派工已取消');
    case 'prepared':
      return null;
  }
}

const invalidCandidate = (reason: string): DomainError => invalid(`候选引用不合法：${reason}`);

/** 候选引用必须指向当前项目、当前仓库里一条**已 prepared** 的来源派工。 */
async function candidatePart(
  deps: ProjectSessionHandoffDeps,
  command: ProjectSessionHandoffCommand,
  project: Project,
  actor: Principal
): Promise<Result<unknown[] | undefined, DomainError>> {
  const candidate: ProjectCandidateRef | null = command.candidate;
  if (!candidate) return ok(undefined);

  if (
    typeof candidate.sourceSessionId !== 'string' ||
    candidate.sourceSessionId === '' ||
    candidate.sourceSessionId !== candidate.sourceSessionId.trim() ||
    candidate.sourceSessionId.length > MAX_ID_LENGTH ||
    hasControl(candidate.sourceSessionId)
  ) {
    return err(invalidCandidate('来源会话 id 不合法'));
  }
  if (
    typeof candidate.repoId !== 'string' ||
    candidate.repoId === '' ||
    candidate.repoId !== candidate.repoId.trim() ||
    candidate.repoId.length > MAX_ID_LENGTH ||
    hasControl(candidate.repoId)
  ) {
    return err(invalidCandidate('仓库 id 不合法'));
  }
  if (typeof candidate.sha !== 'string' || !SHA_PATTERN.test(candidate.sha)) {
    return err(invalidCandidate('必须给完整 40 位小写 SHA'));
  }
  if (candidate.sourceSessionId === command.targetSessionId) {
    return err(invalidCandidate('来源会话不能是目标会话'));
  }

  const sourceSessionId = asSessionId(candidate.sourceSessionId);
  const delegation = await deps.delegations.byExecutionSession(sourceSessionId);
  if (!delegation) return err(notFound('候选来源会话没有已登记的派工'));
  const stateError = stateFailure(delegation.state);
  if (stateError) return err(stateError);
  if (delegation.executionSessionId !== sourceSessionId) {
    return err(forbidden('候选来源派工记录已漂移'));
  }
  if (delegation.accountId !== command.actorId) {
    return err(forbidden('候选来源派工不属于当前账号'));
  }
  if (delegation.projectId !== project.id) {
    return err(forbidden('候选来源不在当前项目'));
  }
  if (delegation.repoId !== candidate.repoId) {
    return err(forbidden('候选来源仓库与请求不一致'));
  }

  const repo = project.repos.find((entry) => entry.id === candidate.repoId);
  if (!repo) return err(forbidden('仓库不在项目当前清单里'));
  if (repo.url.trim() === '') return err(forbidden('项目仓库缺少地址'));
  if (!sameRepoUrl(delegation.repoUrl, repo.url)) {
    return err(forbidden('候选来源仓库地址与项目当前清单不一致'));
  }

  const workerId = delegation.workerId.trim();
  if (workerId === '') return err(forbidden('候选来源派工缺少 Worker'));
  if (delegation.branch.trim() === '') return err(forbidden('候选来源派工缺少分支'));

  const sourceSession = await deps.sessions.byId(sourceSessionId);
  if (!sourceSession) return err(unavailable('候选来源会话不存在'));
  const canReadSource = await authorizeSession(
    deps.access,
    actor,
    project,
    sourceSession,
    'session.read'
  );
  if (!canReadSource.ok) return canReadSource;
  if (sourceSession.taskId !== delegation.taskId) {
    return err(forbidden('候选来源会话任务与派工记录不一致'));
  }
  if (sourceSession.workspaceId === null) {
    return err(forbidden('候选来源会话没有工作空间'));
  }
  if (sourceSession.workerId !== null && sourceSession.workerId !== workerId) {
    return err(forbidden('候选来源会话 Worker 与派工记录不一致'));
  }

  return ok([
    {
      type: 'data',
      schema: PROJECT_CANDIDATE_PART_SCHEMA,
      data: {
        notice: CANDIDATE_NOTICE,
        projectId: project.id,
        sourceSessionId: candidate.sourceSessionId,
        repoId: candidate.repoId,
        sha: candidate.sha
      }
    }
  ]);
}

/** 受限子会话没有 `agent.inbox`，`wake=false` 的投递永远读不到，必须显式唤醒。 */
async function requireExplicitWake(
  deps: ProjectSessionHandoffDeps,
  targetSessionId: SessionId,
  wake: boolean
): Promise<Result<void, DomainError>> {
  let restricted: boolean;
  try {
    restricted = (await deps.delegations.byExecutionSession(targetSessionId)) !== null;
  } catch {
    return err(unavailable('暂时无法确认目标会话的投递方式，请稍后重试'));
  }
  if (restricted && !wake) {
    return err(
      invalid('目标会话是受限子会话，没有收件箱工具；必须显式 wake=true 才能送达，不会自动升级')
    );
  }
  return ok(undefined);
}

/** 工具响应只保留投递事实；目标会话与 wake 必须与请求完全一致。 */
function snapshotOf(
  command: ProjectSessionHandoffCommand,
  accepted: { messageId: string; targetSessionId: SessionId | null; status: string }
): Result<ProjectSessionHandoffSnapshot, DomainError> {
  if (accepted.targetSessionId !== command.targetSessionId) {
    return err(unavailable('交接结果无法核实'));
  }
  if (
    typeof accepted.messageId !== 'string' ||
    accepted.messageId === '' ||
    accepted.messageId.length > MAX_ID_LENGTH ||
    hasControl(accepted.messageId)
  ) {
    return err(unavailable('交接结果无法核实'));
  }
  if (
    typeof accepted.status !== 'string' ||
    accepted.status === '' ||
    accepted.status.length > MAX_STATUS_LENGTH ||
    hasControl(accepted.status)
  ) {
    return err(unavailable('交接结果无法核实'));
  }
  return ok({
    messageId: accepted.messageId,
    targetSessionId: command.targetSessionId,
    status: accepted.status,
    wake: command.wake
  });
}

async function handoff(
  deps: ProjectSessionHandoffDeps,
  command: ProjectSessionHandoffCommand
): Promise<Result<ProjectSessionHandoffSnapshot, DomainError>> {
  const unknown = Object.keys(command).filter((key) => !HANDOFF_KEYS.has(key));
  if (unknown.length > 0) return err(invalid(`未知参数：${unknown.join(', ')}`));
  if (typeof command.requestKey !== 'string' || command.requestKey.trim() === '') {
    return err(invalid('请求键不合法'));
  }
  if (typeof command.body !== 'string' || command.body === '') {
    return err(invalid('交接正文不能为空'));
  }
  if (typeof command.wake !== 'boolean') return err(invalid('wake 必须是布尔值'));

  const context = await handoffContext(deps, command);
  if (!context.ok) return context;
  const { project, actor } = context.value;

  if (command.targetSessionId === command.sessionId) {
    return err(invalid('目标会话不能是当前会话'));
  }

  const target = await deps.sessions.byId(command.targetSessionId);
  if (!target) return err(notFound('目标会话不存在'));
  const targetProjectId = await canonicalProjectId(deps, target);
  if (targetProjectId !== project.id) return err(forbidden('目标会话不在当前项目'));

  const canReadTarget = await authorizeSession(deps.access, actor, project, target, 'session.read');
  if (!canReadTarget.ok) return canReadTarget;

  const delivery = await requireExplicitWake(deps, command.targetSessionId, command.wake);
  if (!delivery.ok) return delivery;

  const parts = await candidatePart(deps, command, project, actor);
  if (!parts.ok) return parts;

  let accepted;
  try {
    accepted = await deps.messageBus.handoff({
      fromSessionId: command.sessionId,
      actorId: command.actorId,
      targetSessionId: command.targetSessionId,
      body: command.body,
      requestKey: command.requestKey,
      ...(parts.value === undefined ? {} : { parts: parts.value }),
      wake: command.wake
    });
  } catch {
    return err(unavailable('交接消息未能送达，请稍后重试'));
  }
  if (!accepted.ok) return accepted;
  return snapshotOf(command, accepted.value);
}

const summaryOf = (session: Session): ProjectSessionSummary => ({
  sessionId: session.id,
  taskId: session.taskId === null ? null : String(session.taskId),
  title: session.title ?? null,
  status: session.status,
  agentId: session.agentId
});

/** 稳定顺序：最近更新的在前，同时间按会话 id 升序，保证重放看到同样的列表。 */
const byRecency = (left: Session, right: Session): number =>
  right.updatedAt - left.updatedAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

async function listSessions(
  deps: ProjectSessionHandoffDeps,
  query: ProjectSessionListQuery
): Promise<Result<readonly ProjectSessionSummary[], DomainError>> {
  const unknown = Object.keys(query).filter((key) => !LIST_KEYS.has(key));
  if (unknown.length > 0) return err(invalid(`未知参数：${unknown.join(', ')}`));
  if (!Number.isInteger(query.limit) || query.limit < 1) return err(invalid('limit 不合法'));

  const granted = await deps.grants.authorize({
    actor: { userId: query.actorId, via: query.actorVia },
    sessionId: query.sessionId,
    scope: 'project:read'
  });
  if (!granted.ok) return granted;
  const grant = granted.value;
  if (grant.accountId !== query.actorId || grant.sessionId !== query.sessionId) {
    return err(grantError());
  }

  const project = await deps.projects.byId(grant.projectId);
  if (!project || project.deletedAt != null) return err(notFound('项目不存在'));

  const caller = await deps.sessions.byId(query.sessionId);
  if (!caller) return err(notFound('会话不存在'));

  const actor = await deps.loadActor(query.actorId);
  if (!actor || actor.user.id !== query.actorId) return err(forbidden('当前账号不可用'));

  const canReadCaller = await authorizeSession(deps.access, actor, project, caller, 'session.read');
  if (!canReadCaller.ok) return canReadCaller;

  const callerProjectId = await canonicalProjectId(deps, caller);
  if (callerProjectId !== project.id) return err(grantError());

  let rows: readonly Session[];
  try {
    rows = await deps.sessions.listByProject(grant.projectId);
  } catch {
    return err(unavailable('会话列表暂时不可用，请稍后重试'));
  }

  // 任务列表走 task_id 内连接，无任务会话要由调用方按不可变来源单独查，再在这里合并。
  let taskless: readonly Session[] = [];
  if (deps.listTasklessByOriginProject) {
    try {
      taskless = await deps.listTasklessByOriginProject(grant.projectId);
    } catch {
      return err(unavailable('会话列表暂时不可用，请稍后重试'));
    }
    if (!Array.isArray(taskless)) return err(unavailable('会话列表无法核实'));
  }

  const seen = new Set<string>();
  const union: Session[] = [];
  for (const session of [...rows, ...taskless]) {
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    union.push(session);
  }

  const taskCache = new Map<string, string | null>();
  const sessions: ProjectSessionSummary[] = [];
  for (const session of union.sort(byRecency)) {
    if (sessions.length > query.limit) break;
    const projectId = await canonicalProjectId(deps, session, taskCache);
    if (projectId !== project.id) continue;

    let visible: Result<Session, DomainError>;
    try {
      visible = await authorizeSession(deps.access, actor, project, session, 'session.read');
    } catch {
      continue;
    }
    if (!visible.ok) continue;

    sessions.push(summaryOf(session));
  }

  // 多查一条，让 provider 能区分「刚好 limit 条」与「还有更多」。
  return ok(sessions.slice(0, query.limit + 1));
}

export function createProjectSessionHandoffActions(
  deps: ProjectSessionHandoffDeps
): ProjectSessionHandoffActions {
  return {
    handoff: (command) => handoff(deps, command),
    listSessions: (query) => listSessions(deps, query)
  };
}
