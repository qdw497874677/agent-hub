import { createHash } from 'node:crypto';
import {
  asSessionId,
  authorizeSession,
  authorizeWorker,
  authorizeWorkspace,
  conflict,
  err,
  forbidden,
  invalid,
  isUsable,
  normalizePath,
  notFound,
  ok,
  requestFingerprint,
  requestReplayKey,
  sameRepoUrl,
  unavailable,
  type Deps,
  type DomainError,
  type GrantActor,
  type OperationReceiptPayload,
  type OperationReserveOutcome,
  type OperationReceiptStore,
  type Principal,
  type Project,
  type ProjectRepo,
  type Result,
  type Session,
  type SessionId,
  type Workspace,
  type WorkspaceDelegation,
  type WorkspaceDelegationStore,
  type WorkspaceGit
} from '@agent-hub/domain';
import type { ProjectSessionGrantService } from './project-session-grant.ts';

/**
 * 候选提交导入（docs/design/project-session-mcp.md §20-23、§27、§31）。
 *
 * 边界：
 * - 调用方是**接收会话**（授权记录里的会话），候选来源是一条已 `prepared` 的派工执行会话；
 *   来源、项目、人全部由授权记录和服务端记录推导，模型只提供来源会话 id、仓库 id、完整 SHA 和目标工作空间 id。
 * - 不信任模型给的路径 / 远端 / Git 参数；目标工作空间必须显式指定一个，且与来源同项目、同仓库、同 Worker。
 * - 导入只写目标仓库的专用 ref，不 checkout、不动分支、不推送；Worker 端的 `importCommit` 负责最后一道
 *   目录 / origin / 分支 / 可达性校验。
 * - 写操作先占持久回执再执行。RPC 发出前的确定性失败用 CAS 释放；发出后结果不明时保留 pending，
 *   不用时钟接管，也不盲目重试。
 */

export const CANDIDATE_IMPORT_OPERATION = 'project.candidate.import' as const;
export const CANDIDATE_IMPORT_FINGERPRINT_VERSION = 1 as const;
export const CANDIDATE_IMPORT_RECEIPT_VERSION = 1 as const;
export const CANDIDATE_IMPORT_SCOPE = 'candidate:import' as const;

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SESSION_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const MAX_ID_LENGTH = 200;
const MAX_REQUEST_KEY_LENGTH = 200;
const REQUEST_KEY_PATTERN = /^[^\u0000-\u001f\u007f]+$/;

const ACTOR_VIA: readonly GrantActor['via'][] = ['web', 'group', 'bot', 'connector', 'dispatch', 'tool'];

/** 工具 provider 解析出来的绑定；actor 由工具令牌冻结，模型不能改。 */
export interface ProjectCandidateImportBinding {
  readonly actorId: string;
  readonly actorVia: GrantActor['via'];
  /** 接收会话 = 项目授权记录里的会话。 */
  readonly sessionId: SessionId;
}

/** 模型可提供的参数；除这些之外不接受路径、远端、分支或 Git 参数。 */
export interface ProjectCandidateImportCommand extends ProjectCandidateImportBinding {
  readonly requestKey: string;
  /** 已登记派工记录里的执行会话。 */
  readonly sourceSessionId: string;
  /** 接收会话；必须与冻结绑定里的会话一致。 */
  readonly targetSessionId: SessionId;
  readonly repoId: string;
  /** 完整 40 位小写 SHA，不自动换成来源分支的最新提交。 */
  readonly sha: string;
}

/** 回执 / 工具返回值只保留重建结果所需的最小事实，不含路径、URL 或凭据。 */
export interface ProjectCandidateImportResult {
  readonly projectId: string;
  readonly repoId: string;
  readonly workerId: string;
  readonly sourceSessionId: string;
  readonly targetSessionId: SessionId;
  readonly targetWorkspaceId: string;
  readonly ref: string;
  readonly sha: string;
  readonly alreadyPresent: boolean;
}

export interface ProjectCandidateImportDeps {
  /** 项目授权入口；项目 / 人 / 会话都由它从服务端绑定推导。 */
  readonly grants: Pick<ProjectSessionGrantService, 'authorize'>;
  readonly access: Deps['access'];
  readonly projects: Deps['projects'];
  readonly workspaces: Deps['workspaces'];
  readonly sessions: Pick<Deps['sessions'], 'byId'>;
  readonly delegations: Pick<WorkspaceDelegationStore, 'byExecutionSession'>;
  readonly operationReceipts: OperationReceiptStore;
  /** 账号当前状态；返回 null 即拒绝。 */
  readonly loadActor: (accountId: string) => Promise<Principal | null>;
  /**
   * 已记下的 workerId → 真正执行 git 的那条路。由组合根注入（本机走 Server 自己的 git，
   * 远端走 gateway.git(workerId)），这里不猜、也不回落到本机。
   */
  readonly gitForWorker: (workerId: string) => Promise<WorkspaceGit>;
}

/**
 * 专用 ref 只由平台拼：`refs/agent-hub/imports/<接收会话>/<完整 SHA>`。
 * 会话 id 必须能安全地出现在 ref 里；不合法就拒绝，而不是转义成一个模型可猜的别名。
 */
export function candidateImportRef(targetSessionId: string, sha: string): Result<string, DomainError> {
  if (!SESSION_REF_PATTERN.test(targetSessionId)) {
    return err(invalid('会话 ID 不能用于候选导入 ref'));
  }
  if (!SHA_PATTERN.test(sha)) return err(invalid('候选提交必须给完整 40 位小写 SHA'));
  return ok(`refs/agent-hub/imports/${targetSessionId}/${sha}`);
}

const hasText = (value: unknown, max: number = MAX_ID_LENGTH): value is string =>
  typeof value === 'string' &&
  value !== '' &&
  value === value.trim() &&
  value.length <= max &&
  !CONTROL_CHARACTERS.test(value);

const exactId = (value: unknown, label: string, max: number = MAX_ID_LENGTH): Result<string, DomainError> =>
  hasText(value, max) ? ok(value) : err(invalid(`${label}不合法`));

const shaOf = (value: unknown): Result<string, DomainError> =>
  typeof value === 'string' && SHA_PATTERN.test(value)
    ? ok(value)
    : err(invalid('候选提交必须给完整 40 位小写 SHA'));

const releaseQuietly = async (
  deps: ProjectCandidateImportDeps,
  input: { key: string; fingerprint: string; reservationId: string }
): Promise<void> => {
  try {
    await deps.operationReceipts.release(input);
  } catch {
    // 释放失败不改变「RPC 前没有副作用」的事实；保留原错误，让调用方看到真正原因。
  }
};

interface AuthorizedContext {
  readonly project: Project;
  readonly actor: Principal;
  readonly session: Session;
}

interface ResolvedImport {
  readonly project: Project;
  readonly repo: ProjectRepo;
  readonly session: Session;
  readonly delegation: WorkspaceDelegation;
  readonly sourceWorkspace: Workspace;
  readonly targetWorkspace: Workspace;
  readonly workerId: string;
  readonly ref: string;
  readonly expectedUrl: string;
}

const grantError = (): DomainError => forbidden('项目授权与会话当前绑定不一致');

/** 授权前置：项目授权、账号当前状态、会话 prompt 权限。重放和真正执行前都会再走一次。 */
async function authorizedContext(
  deps: ProjectCandidateImportDeps,
  command: ProjectCandidateImportCommand
): Promise<Result<AuthorizedContext, DomainError>> {
  const granted = await deps.grants.authorize({
    actor: { userId: command.actorId, via: command.actorVia },
    sessionId: command.sessionId,
    scope: CANDIDATE_IMPORT_SCOPE
  });
  if (!granted.ok) return granted;
  const grant = granted.value;
  if (grant.accountId !== command.actorId || grant.sessionId !== command.sessionId) return err(grantError());

  const project = await deps.projects.byId(grant.projectId);
  if (!project || project.deletedAt != null) return err(notFound('项目不存在'));

  const session = await deps.sessions.byId(command.sessionId);
  if (!session) return err(notFound('会话不存在'));

  const actor = await deps.loadActor(command.actorId);
  if (!actor || actor.user.id !== command.actorId) return err(forbidden('当前账号不可用'));

  const canPrompt = await authorizeSession(deps.access, actor, project, session, 'session.prompt');
  if (!canPrompt.ok) return canPrompt;

  return ok({ project, actor, session });
}

const stateFailure = (state: WorkspaceDelegation['state']): DomainError | null => {
  switch (state) {
    case 'pending':
    case 'preparing':
      return conflict('候选来源派工仍在进行中');
    case 'failed':
      return unavailable('候选来源派工失败，无法导入候选');
    case 'uncertain':
      return unavailable('候选来源派工结果尚未确认，无法导入候选');
    case 'cancelled':
      return conflict('候选来源派工已取消');
    case 'prepared':
      return null;
  }
};

function registeredRepo(project: Project, repoId: string): Result<ProjectRepo, DomainError> {
  const repo = project.repos.find((candidate) => candidate.id === repoId);
  if (!repo) return err(forbidden('仓库不在项目当前清单里'));
  if (repo.url.trim() === '') return err(forbidden('项目仓库缺少地址'));
  return ok(repo);
}

function workspaceDrift(label: string): DomainError {
  return forbidden(`${label}已漂移`);
}

/** 来源工作空间必须还是派工记录里的那个目录、分支、任务和 Worker。 */
function checkSourceWorkspace(
  workspace: Workspace,
  delegation: WorkspaceDelegation,
  project: Project,
  repo: ProjectRepo,
  workerId: string
): Result<void, DomainError> {
  if (!isUsable(workspace)) return err(unavailable('候选来源工作空间当前不可用'));
  if (workspace.projectId !== project.id) return err(workspaceDrift('候选来源工作空间项目'));
  if (workspace.ownerTaskId !== delegation.taskId) return err(workspaceDrift('候选来源工作空间任务'));
  if (normalizePath(workspace.path) !== normalizePath(delegation.worktreePath)) {
    return err(workspaceDrift('候选来源工作目录'));
  }
  if (workspace.branch !== delegation.branch) return err(workspaceDrift('候选来源分支'));
  if (workspace.workerId !== null && workspace.workerId !== workerId) {
    return err(workspaceDrift('候选来源 Worker'));
  }
  if (workspace.repoUrl !== null && !sameRepoUrl(workspace.repoUrl, repo.url)) {
    return err(workspaceDrift('候选来源仓库地址'));
  }
  if (workspace.isGit === false) return err(forbidden('候选来源工作空间不是 Git 仓库'));
  if (!workspace.path.startsWith('/')) return err(workspaceDrift('候选来源工作目录'));
  return ok(undefined);
}

/** 目标工作空间：显式一个、同项目、同仓库、同 Worker，且不能就是来源目录。 */
function checkTargetWorkspace(
  workspace: Workspace,
  source: Workspace,
  project: Project,
  repo: ProjectRepo,
  workerId: string
): Result<void, DomainError> {
  if (!isUsable(workspace)) return err(unavailable('目标工作空间当前不可用'));
  if (workspace.projectId !== project.id) return err(forbidden('目标工作空间不在当前项目'));
  if (workspace.workerId === null || workspace.workerId !== workerId) {
    return err(forbidden('目标工作空间与候选来源不在同一台 Worker'));
  }
  // 手动关联的 Git 目录不一定缓存仓库地址；Worker 在写引用前核对两端真实 origin。
  if (workspace.repoUrl !== null && !sameRepoUrl(workspace.repoUrl, repo.url)) {
    return err(forbidden('目标工作空间仓库与项目当前清单不一致'));
  }
  if (workspace.isGit === false) return err(forbidden('目标工作空间不是 Git 仓库'));
  if (!workspace.path.startsWith('/')) return err(forbidden('目标工作空间目录不合法'));
  if (workspace.id === source.id || normalizePath(workspace.path) === normalizePath(source.path)) {
    return err(invalid('不能把候选导入到来源工作目录本身'));
  }
  return ok(undefined);
}

async function resolveImport(
  deps: ProjectCandidateImportDeps,
  command: ProjectCandidateImportCommand,
  context: AuthorizedContext,
  ref: string
): Promise<Result<ResolvedImport, DomainError>> {
  const { project } = context;

  if (command.sourceSessionId === command.sessionId) {
    return err(forbidden('候选来源不能是接收会话本身'));
  }

  const delegation = await deps.delegations.byExecutionSession(asSessionId(command.sourceSessionId));
  if (!delegation) return err(notFound('候选来源会话没有已登记的派工'));
  const stateError = stateFailure(delegation.state);
  if (stateError) return err(stateError);
  if (delegation.executionSessionId !== command.sourceSessionId) {
    return err(forbidden('候选来源派工记录已漂移'));
  }
  if (delegation.accountId !== command.actorId) return err(forbidden('候选来源派工不属于当前账号'));
  if (delegation.projectId !== project.id) return err(forbidden('候选来源不在当前项目'));
  if (delegation.repoId !== command.repoId) return err(forbidden('候选来源仓库与请求不一致'));

  const repo = registeredRepo(project, command.repoId);
  if (!repo.ok) return repo;
  if (!sameRepoUrl(delegation.repoUrl, repo.value.url)) {
    return err(forbidden('候选来源仓库地址与项目当前清单不一致'));
  }

  const workerId = delegation.workerId.trim();
  if (workerId === '') return err(forbidden('候选来源派工缺少 Worker'));
  if (delegation.branch.trim() === '') return err(forbidden('候选来源派工缺少分支'));

  const sourceSession = await deps.sessions.byId(asSessionId(command.sourceSessionId));
  if (!sourceSession) return err(unavailable('候选来源会话不存在'));
  const canReadSourceSession = await authorizeSession(deps.access, context.actor, project, sourceSession, 'session.read');
  if (!canReadSourceSession.ok) return canReadSourceSession;
  if (sourceSession.taskId !== delegation.taskId) return err(workspaceDrift('候选来源会话任务'));
  if (sourceSession.workspaceId === null) return err(workspaceDrift('候选来源会话工作空间'));
  if (sourceSession.workerId !== null && sourceSession.workerId !== workerId) {
    return err(workspaceDrift('候选来源会话 Worker'));
  }

  const sourceWorkspace = await deps.workspaces.byId(sourceSession.workspaceId);
  if (!sourceWorkspace) return err(unavailable('候选来源工作空间不存在'));
  const sourceCheck = checkSourceWorkspace(sourceWorkspace, delegation, project, repo.value, workerId);
  if (!sourceCheck.ok) return sourceCheck;

  if (context.session.workerId === null || context.session.workerId !== workerId) {
    return err(forbidden('接收会话与候选来源不在同一台 Worker'));
  }
  if (context.session.workspaceId === null) return err(forbidden('接收会话没有绑定工作空间'));
  const targetWorkspace = await deps.workspaces.byId(context.session.workspaceId);
  if (!targetWorkspace) return err(notFound('目标工作空间不存在'));
  const targetCheck = checkTargetWorkspace(targetWorkspace, sourceWorkspace, project, repo.value, workerId);
  if (!targetCheck.ok) return targetCheck;
  if (targetWorkspace.workerId === null) return err(forbidden('目标工作空间缺少 Worker'));

  const canReadSource = await authorizeWorkspace(deps, context.actor, sourceWorkspace, 'workspace.files.read');
  if (!canReadSource.ok) return canReadSource;
  const canUseTarget = await authorizeWorkspace(deps, context.actor, targetWorkspace, 'project.read');
  if (!canUseTarget.ok) return canUseTarget;
  const canUseWorker = await authorizeWorker(deps.access, context.actor, workerId);
  if (!canUseWorker.ok) return canUseWorker;

  return ok({
    project,
    repo: repo.value,
    session: context.session,
    delegation,
    sourceWorkspace,
    targetWorkspace,
    workerId,
    ref,
    expectedUrl: repo.value.url
  });
}

const fingerprintOf = (command: ProjectCandidateImportCommand): string =>
  createHash('sha256')
    .update(
      requestFingerprint([
        CANDIDATE_IMPORT_FINGERPRINT_VERSION,
        command.actorVia,
        command.sourceSessionId,
        command.targetSessionId,
        command.repoId,
        command.sha
      ])
    )
    .digest('hex');

const receipt = (
  resolved: ResolvedImport,
  sha: string,
  alreadyPresent: boolean
): OperationReceiptPayload => ({
  version: CANDIDATE_IMPORT_RECEIPT_VERSION,
  projectId: resolved.project.id,
  repoId: resolved.repo.id,
  workerId: resolved.workerId,
  sourceSessionId: resolved.delegation.executionSessionId,
  targetSessionId: resolved.session.id,
  targetWorkspaceId: resolved.targetWorkspace.id,
  ref: resolved.ref,
  sha,
  alreadyPresent
});

const RECEIPT_KEYS = [
  'version',
  'projectId',
  'repoId',
  'workerId',
  'sourceSessionId',
  'targetSessionId',
  'targetWorkspaceId',
  'ref',
  'sha',
  'alreadyPresent'
] as const;

/** 回执读回后逐字段校验；`unknown` 不能直接当业务对象用。 */
function readReceipt(
  payload: OperationReceiptPayload,
  command: ProjectCandidateImportCommand,
  projectId: string,
  ref: string,
  bound: Pick<Session, 'workspaceId' | 'workerId'>
): Result<ProjectCandidateImportResult, DomainError> {
  const keys = Object.keys(payload);
  if (keys.length !== RECEIPT_KEYS.length || !RECEIPT_KEYS.every((key) => keys.includes(key))) {
    return err(unavailable('候选导入回执形状不正确，请核对'));
  }
  if (payload.version !== CANDIDATE_IMPORT_RECEIPT_VERSION) {
    return err(unavailable('候选导入回执版本不支持，请核对'));
  }
  const fields = {
    projectId: payload.projectId,
    repoId: payload.repoId,
    workerId: payload.workerId,
    sourceSessionId: payload.sourceSessionId,
    targetSessionId: payload.targetSessionId,
    targetWorkspaceId: payload.targetWorkspaceId,
    ref: payload.ref,
    sha: payload.sha
  };
  for (const [label, value] of Object.entries(fields)) {
    if (!hasText(value)) return err(unavailable(`候选导入回执的 ${label} 不合法，请核对`));
  }
  if (typeof payload.alreadyPresent !== 'boolean') {
    return err(unavailable('候选导入回执缺少 alreadyPresent，请核对'));
  }
  const receiptFields = fields as {
    projectId: string;
    repoId: string;
    workerId: string;
    sourceSessionId: string;
    targetSessionId: string;
    targetWorkspaceId: string;
    ref: string;
    sha: string;
  };
  if (
    receiptFields.projectId !== projectId ||
    receiptFields.repoId !== command.repoId ||
    receiptFields.sourceSessionId !== command.sourceSessionId ||
    receiptFields.targetSessionId !== command.targetSessionId ||
    receiptFields.ref !== ref ||
    receiptFields.sha !== command.sha
  ) {
    return err(unavailable('候选导入回执与当前请求不一致，请核对'));
  }
  if (bound.workspaceId === null || receiptFields.targetWorkspaceId !== bound.workspaceId) {
    return err(unavailable('接收会话的工作空间已变化，请核对'));
  }
  if (bound.workerId === null || receiptFields.workerId !== bound.workerId) {
    return err(unavailable('接收会话的 Worker 已变化，请核对'));
  }
  return ok({
    projectId: receiptFields.projectId,
    repoId: receiptFields.repoId,
    workerId: receiptFields.workerId,
    sourceSessionId: receiptFields.sourceSessionId,
    targetSessionId: command.targetSessionId,
    targetWorkspaceId: receiptFields.targetWorkspaceId,
    ref: receiptFields.ref,
    sha: receiptFields.sha,
    alreadyPresent: payload.alreadyPresent
  });
}

/** 参数形状校验；项目 id 不在入参里，键要等授权拿到项目之后再拼。 */
function validateCommand(command: ProjectCandidateImportCommand): Result<{ ref: string }, DomainError> {
  if (!hasText(command.actorId)) return err(invalid('缺少调用人'));
  if (!ACTOR_VIA.includes(command.actorVia)) return err(invalid('调用来源不合法'));
  if (!hasText(command.sessionId) || !SESSION_REF_PATTERN.test(command.sessionId)) {
    return err(invalid('会话 ID 不合法'));
  }
  if (!hasText(command.targetSessionId) || command.targetSessionId !== command.sessionId) {
    return err(forbidden('目标会话与当前绑定会话不一致'));
  }
  if (!hasText(command.requestKey, MAX_REQUEST_KEY_LENGTH) || !REQUEST_KEY_PATTERN.test(command.requestKey)) {
    return err(invalid('请求键不合法'));
  }
  const source = exactId(command.sourceSessionId, '候选来源会话');
  if (!source.ok) return source;
  const repo = exactId(command.repoId, '仓库 ID');
  if (!repo.ok) return repo;
  const sha = shaOf(command.sha);
  if (!sha.ok) return sha;
  const ref = candidateImportRef(command.sessionId, sha.value);
  if (!ref.ok) return ref;
  return ok({ ref: ref.value });
}

/** 候选导入动作。 */
export async function importProjectCandidate(
  deps: ProjectCandidateImportDeps,
  command: ProjectCandidateImportCommand
): Promise<Result<ProjectCandidateImportResult, DomainError>> {
  const shape = validateCommand(command);
  if (!shape.ok) return shape;
  const expectedRef = shape.value.ref;

  const first = await authorizedContext(deps, command);
  if (!first.ok) return first;

  const fingerprint = fingerprintOf(command);
  // 项目 id 只在授权之后才可信；键里的项目来自授权记录，不来自入参。
  const key = requestReplayKey(
    {
      actorId: command.actorId,
      sourceSessionId: command.sessionId,
      projectId: first.value.project.id,
      operation: CANDIDATE_IMPORT_OPERATION
    },
    command.requestKey
  );

  let reserved: OperationReserveOutcome;
  try {
    reserved = await deps.operationReceipts.reserve({
      key,
      fingerprint,
      actorId: command.actorId,
      sourceSessionId: command.sessionId,
      projectId: first.value.project.id,
      operation: CANDIDATE_IMPORT_OPERATION
    });
  } catch {
    return err(unavailable('无法建立候选导入回执，请稍后重试'));
  }

  if (reserved.status === 'conflict') return err(conflict('同一请求键对应不同参数'));
  if (reserved.status === 'pending') return err(conflict('相同候选导入请求正在处理中，请稍后再试'));
  if (reserved.status === 'completed') {
    return readReceipt(reserved.payload, command, first.value.project.id, expectedRef, first.value.session);
  }

  const reservation = { key, fingerprint, reservationId: reserved.reservationId };
  const beforeRpc = async (error: DomainError): Promise<Result<ProjectCandidateImportResult, DomainError>> => {
    await releaseQuietly(deps, reservation);
    return err(error);
  };

  // 第一次解析用于取得 Worker / 工作空间，再做一次完整授权，最后再解析一次确认没有漂移。
  const resolved = await resolveImport(deps, command, first.value, expectedRef);
  if (!resolved.ok) return beforeRpc(resolved.error);

  const second = await authorizedContext(deps, command);
  if (!second.ok) return beforeRpc(second.error);
  if (second.value.project.id !== first.value.project.id) {
    return beforeRpc(forbidden('会话的项目绑定在确认前发生变化'));
  }

  const confirmed = await resolveImport(deps, command, second.value, expectedRef);
  if (!confirmed.ok) return beforeRpc(confirmed.error);
  if (
    confirmed.value.workerId !== resolved.value.workerId ||
    confirmed.value.session.workerId !== resolved.value.session.workerId ||
    confirmed.value.session.workspaceId !== resolved.value.session.workspaceId ||
    confirmed.value.sourceWorkspace.id !== resolved.value.sourceWorkspace.id ||
    confirmed.value.targetWorkspace.id !== resolved.value.targetWorkspace.id ||
    confirmed.value.ref !== expectedRef
  ) {
    return beforeRpc(forbidden('候选导入目标在确认前发生变化'));
  }

  let git: WorkspaceGit;
  try {
    git = await deps.gitForWorker(confirmed.value.workerId);
  } catch {
    return beforeRpc(unavailable('候选来源所在的 Worker 当前不可用'));
  }
  if (!git.importCommit) return beforeRpc(unavailable('当前 Worker 不支持候选导入'));

  try {
    const imported = await git.importCommit({
      sourcePath: confirmed.value.sourceWorkspace.path,
      targetPath: confirmed.value.targetWorkspace.path,
      sourceBranch: confirmed.value.delegation.branch,
      sha: command.sha,
      ref: expectedRef,
      expectedUrl: confirmed.value.expectedUrl
    });
    if (!imported.ok) {
      // 已经发出 RPC：不能假装没有副作用。保留 pending，让同一请求键再次观察结果。
      return err(unavailable('候选导入结果尚未确认，请用同一请求键重试核对'));
    }
    if (
      imported.value.ref !== expectedRef ||
      imported.value.sha !== command.sha ||
      typeof imported.value.alreadyPresent !== 'boolean'
    ) {
      return err(unavailable('候选导入返回的结果与请求不一致，请核对'));
    }

    const payload = receipt(confirmed.value, command.sha, imported.value.alreadyPresent);
    let completed: Awaited<ReturnType<OperationReceiptStore['complete']>>;
    try {
      completed = await deps.operationReceipts.complete({
        key,
        fingerprint,
        reservationId: reservation.reservationId,
        payload
      });
    } catch {
      return err(unavailable('候选导入已完成，但回执未能确认，请用同一请求键重试核对'));
    }
    if (completed.status === 'conflict') {
      return err(unavailable('候选导入回执状态冲突，请用同一请求键重试核对'));
    }
    if (completed.status === 'replayed') {
      return readReceipt(completed.payload, command, first.value.project.id, expectedRef, second.value.session);
    }
    return readReceipt(payload, command, first.value.project.id, expectedRef, second.value.session);
  } catch {
    // 发出后异常：具体原因可能含 Worker 路径，不原样回传；保留 pending。
    return err(unavailable('候选导入结果尚未确认，请用同一请求键重试核对'));
  }
}
