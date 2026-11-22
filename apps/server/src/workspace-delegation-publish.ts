import type { Context, Hono } from 'hono';
import { z } from 'zod';
import {
  asProjectId,
  asSessionId,
  asWorkspaceId,
  authorizeProject,
  conflict,
  err,
  forbidden,
  githubRepoOf,
  invalid,
  isUsable,
  notFound,
  ok,
  principalOfSubject,
  publishWorkspaceDelegationUseCase,
  repoTokenKey,
  unavailable,
  type AccessPolicy,
  type DelegationFailureKind,
  type DelegationPublishStore,
  type DelegationPublishTarget,
  type DomainError,
  type GitAuth,
  type GitHostApi,
  type GitHostTokenStore,
  type NodeGateway,
  type Project,
  type ProjectRepository,
  type PublishAttempt,
  type PublishAttemptState,
  type PublishDelegationCommand,
  type PublishDelegationRun,
  type PublishedPullRequest,
  type PublishRemoteFacts,
  type Result,
  type SecretVault,
  type SessionRepository,
  type Subject,
  type TaskGate,
  type TaskRepository,
  type Workspace,
  type WorkspaceDelegation,
  type WorkspaceDelegationStore,
  type WorkspaceGit,
  type WorkspaceRepository
} from '@agent-hub/domain';
import { authHeaderFor } from './repo-auth.ts';
import { fail } from './http-error.ts';
import type { SubjectOf } from './auth.ts';

/**
 * 派工 step B 的服务端适配器（docs/design/workspace-delegation.md）。
 *
 * 这里只做三件事：
 * - 把持久化的派工记录 / 执行会话 / 工作空间翻译成 domain 用例要的 `DelegationPublishTarget`，
 *   全部只读，任何身份对不上就失败关闭（不猜机器、不猜路径、不猜分支）。
 * - 把项目仓库凭据 / 团队 GitHub 应用凭据接到 domain 的桥端口上：凭据只按记录里的 repoId
 *   精确解析，托管平台只认项目团队配置的 token，**不**退回环境变量或 Worker 的 gh 登录态。
 * - 暴露人对账用的 HTTP 接口；响应用例里没有任何 token / claim / 指纹 / 栈。
 */

/** 只读解析执行工作树身份所需的最小依赖；不含密钥 / 托管平台凭据。 */
export interface DelegationTargetDeps {
  readonly sessions: Pick<SessionRepository, 'byId'>;
  readonly workspaces: Pick<WorkspaceRepository, 'byId'>;
  readonly gateway: Pick<NodeGateway, 'status' | 'git'>;
  /** 本机 Worker 用的 git 实现；远端 Worker 走 `gateway.git(workerId)`。 */
  readonly git: WorkspaceGit;
}

export interface DelegationPublishDeps extends DelegationTargetDeps {
  readonly projects: ProjectRepository;
  readonly tasks: TaskRepository;
  readonly secrets: Pick<SecretVault, 'reveal'>;
  readonly access?: AccessPolicy;
  readonly now: () => number;
  readonly taskGate?: TaskGate;
  /** hub 直调 GitHub REST 的实现（`createGitHubApi()`）；不经过 Worker 的 gh。 */
  readonly gitHost: GitHostApi;
  readonly gitHostTokens: Pick<GitHostTokenStore, 'reveal'>;
}

export type DelegationPublisher = (
  command: PublishDelegationCommand
) => Promise<Result<PublishDelegationRun, DomainError>>;

interface ResolvedTarget {
  readonly target: DelegationPublishTarget;
  readonly git: WorkspaceGit;
}

/**
 * 把 domain 用例、持久化尝试和真实端口接起来。父车道在 main.ts 里调用一次，
 * 把返回的函数交给 `installDelegationPublishRoutes`。
 */
export function createDelegationPublisher(
  deps: DelegationPublishDeps,
  delegations: Pick<WorkspaceDelegationStore, 'byId'>,
  store: DelegationPublishStore
): DelegationPublisher {
  return async (command) => {
    // 每次调用单独记住 resolveTarget 选中的 git 实现：publishRef 必须落在同一台机器上，
    // 不能等后面再按 workerId 查一次（那会允许「解析用 A、写用 B」的竞态）。
    let resolved: ResolvedTarget | null = null;
    return publishWorkspaceDelegationUseCase(
      { projects: deps.projects, tasks: deps.tasks, access: deps.access, now: deps.now, taskGate: deps.taskGate },
      store,
      {
        loadRecord: (delegationId) => delegations.byId(delegationId),
        resolveTarget: async (record) => {
          const result = await resolveTarget(deps, record);
          if (!result.ok) return result;
          resolved = result.value;
          return ok(result.value.target);
        },
        git: (workerId) => {
          if (resolved === null || resolved.target.workerId !== workerId) {
            throw new Error('发布目标机器尚未解析');
          }
          return resolved.git;
        },
        repoAuth: (record) => resolveRepoAuth(deps, record),
        gitHost: (project) => resolveGitHost(deps, project)
      },
      command
    );
  };
}

/**
 * 只读地给出「执行工作树当前 HEAD」，和发布走同一个 `resolveTarget`：
 * 会话 / 工作空间 / 机器 / 路径 / 分支 / origin 任何一项对不上都不返回提交号。
 * 不读密钥、不写任何东西，供 GET 状态接口给 UI 展示「人该批准哪个 SHA」。
 */
export function createDelegationHeadResolver(
  deps: DelegationTargetDeps
): (record: WorkspaceDelegation) => Promise<Result<string, DomainError>> {
  return async (record) => {
    const result = await resolveTarget(deps, record);
    return result.ok ? ok(result.value.target.headSha) : err(result.error);
  };
}

/**
 * 执行会话 → 工作空间 → 机器 → 只读 HEAD。每一步都必须和派工记录逐项一致；
 * 记录里没有 workspaceId，所以工作空间只从执行会话的持久化绑定取得。
 */
async function resolveTarget(
  deps: DelegationTargetDeps,
  record: WorkspaceDelegation
): Promise<Result<ResolvedTarget, DomainError>> {
  const session = await deps.sessions.byId(asSessionId(record.executionSessionId));
  if (!session) return err(notFound('派工的执行会话不存在'));
  if (session.taskId !== record.taskId) return err(conflict('执行会话与派工记录的任务不一致'));
  if (session.parentSessionId || session.botId || session.kind === 'side') {
    return err(conflict('执行会话不是派工创建的独立会话'));
  }
  if (session.workspaceId === null) return err(conflict('执行会话没有绑定工作空间'));
  if (session.workerId !== record.workerId) return err(conflict('执行会话不在派工记录的机器上'));

  const workspace = await deps.workspaces.byId(asWorkspaceId(session.workspaceId));
  if (!workspace) return err(notFound('派工的工作空间不存在'));
  const workspaceProblem = workspaceMismatch(record, workspace);
  if (workspaceProblem) return err(conflict(workspaceProblem));

  const worker = (await deps.gateway.status()).find((candidate) => candidate.workerId === record.workerId);
  if (!worker) return err(unavailable('派工记录的机器当前不可用'));
  if (worker.origin === 'remote' && worker.state === 'offline') {
    return err(unavailable('派工记录的机器当前离线'));
  }
  const git = worker.origin === 'local' ? deps.git : deps.gateway.git(worker.workerId);

  // 只读预览：不落盘、不 commit、不 push；patch 也不要（0 字节），避免把改动内容带进 hub。
  const preview = await git.preview(workspace.path, 0, { redactSensitive: true });
  if (!preview.ok) return err(preview.error);
  const facts = preview.value;
  if (!facts.isGit) return err(conflict('派工的工作空间不是 Git 仓库'));
  if (facts.remoteUrl === null || facts.remoteUrl.trim() !== record.repoUrl.trim()) {
    return err(conflict('工作空间的 origin 与项目仓库不一致'));
  }
  if (facts.branch !== record.branch) return err(conflict('工作空间当前分支与派工记录不一致'));
  const headSha = facts.head;
  if (typeof headSha !== 'string' || !/^[0-9a-f]{40}$/.test(headSha)) {
    return err(unavailable('无法确认执行会话当前的提交'));
  }

  return ok({
    target: {
      executionSessionId: asSessionId(record.executionSessionId),
      taskId: record.taskId,
      workerId: record.workerId,
      path: record.worktreePath,
      repoUrl: record.repoUrl,
      branch: record.branch,
      headSha
    },
    git
  });
}

/** 工作空间必须是 A 阶段为这条派工建的临时 worktree，且项目 / 任务 / 机器 / 路径 / 分支都没变。 */
function workspaceMismatch(record: WorkspaceDelegation, workspace: Workspace): string | null {
  if (!isUsable(workspace)) return '派工的工作空间当前不可用';
  if (workspace.kind !== 'temporary') return '派工的工作空间不是临时工作树';
  if (workspace.projectId !== record.projectId) return '工作空间不属于这次派工的项目';
  if (workspace.ownerTaskId !== record.taskId) return '工作空间不属于这次派工的任务';
  if (workspace.workerId !== record.workerId) return '工作空间不在派工记录的机器上';
  if (workspace.path !== record.worktreePath) return '工作空间路径与派工记录不一致';
  if (workspace.branch !== record.branch) return '工作空间分支与派工记录不一致';
  if (workspace.repoUrl !== record.repoUrl) return '工作空间的仓库地址与派工记录不一致';
  if (!workspace.isGit) return '派工的工作空间不是 Git 仓库';
  return null;
}

/**
 * 只认记录里的 `repoId` 对应的那一条项目仓库：
 * - 不按 URL 扫项目，也不挑「另一个同 URL 但带 token」的条目（那是另一种身份）；
 * - `tokenSecret` 必须是这个项目 / 这个仓库的规范键，旧键一律当没配（失败关闭）。
 * 返回 null 表示这条仓库没有可用凭据；HTTPS 的 publishRef 会因此拒绝，而不是改用别的凭据。
 */
async function resolveRepoAuth(
  deps: DelegationPublishDeps,
  record: WorkspaceDelegation
): Promise<GitAuth | null> {
  const project = await deps.projects.byId(asProjectId(record.projectId));
  if (!project) return null;
  const repo = project.repos.find((candidate) => candidate.id === record.repoId);
  if (!repo || repo.url !== record.repoUrl) return null;
  const key = repoTokenKey(project.id, repo.id);
  if (repo.tokenSecret !== key) return null;
  const revealed = await deps.secrets.reveal([key]);
  const token = typeof revealed[key] === 'string' ? revealed[key].trim() : '';
  return token === '' ? null : authHeaderFor(token, repo.url);
}

/**
 * 标准发布通道只有一条：项目团队的 GitHub 应用凭据。
 * 项目没有团队 / 团队没配 token = 不能建 PR；**不**回退到环境变量、全局 token 或 Worker 的 gh。
 */
async function resolveGitHost(
  deps: DelegationPublishDeps,
  project: Project
): Promise<{ api: GitHostApi; token: string } | null> {
  const teamId = project.teamId;
  if (teamId === null) return null;
  const token = await deps.gitHostTokens.reveal(teamId);
  if (token === null || token.trim() === '') return null;
  return { api: deps.gitHost, token: token.trim() };
}

/** 对账 / 发布响应：只给 UI 需要的事实，不包含 repoUrl、claim、指纹、批准键、token。 */
export interface DelegationPublishAttemptView {
  readonly state: PublishAttemptState;
  readonly headSha: string;
  readonly remote: PublishRemoteFacts | null;
  readonly pullRequest: PublishedPullRequest | null;
  readonly failure: { readonly kind: DelegationFailureKind; readonly message: string; readonly at: number } | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface DelegationPublishView {
  readonly delegationId: string;
  readonly state: WorkspaceDelegation['state'];
  readonly projectId: string;
  readonly taskId: string;
  readonly executionSessionId: string;
  readonly workerId: string;
  /** `owner/name`；记录里的 URL 解析不出来时是 null（此时也发布不了）。 */
  readonly repo: string | null;
  readonly branch: string;
  readonly baseBranch: string;
  readonly baseSha: string | null;
  readonly failure: { readonly kind: DelegationFailureKind; readonly message: string; readonly at: number } | null;
  readonly attempt: DelegationPublishAttemptView | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export function delegationPublishView(
  record: WorkspaceDelegation,
  attempt: PublishAttempt | null
): DelegationPublishView {
  return {
    delegationId: record.id,
    state: record.state,
    projectId: record.projectId,
    taskId: record.taskId,
    executionSessionId: record.executionSessionId,
    workerId: record.workerId,
    repo: githubRepoOf(record.repoUrl),
    branch: record.branch,
    baseBranch: record.baseBranch,
    baseSha: record.baseSha,
    failure: record.failure
      ? { kind: record.failure.kind, message: safeMessage(record.failure.message), at: record.failure.at }
      : null,
    attempt: attempt
      ? {
          state: attempt.state,
          headSha: attempt.headSha,
          remote: attempt.remote,
          pullRequest: attempt.pullRequest,
          failure: attempt.failure
            ? { kind: attempt.failure.kind, message: safeMessage(attempt.failure.message), at: attempt.failure.at }
            : null,
          createdAt: attempt.createdAt,
          updatedAt: attempt.updatedAt
        }
      : null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

/**
 * 适配器边界最后一道清洗：远端 / git 的报错可能带 `user:token@host`、Authorization 头或栈。
 * 这些文本要给人看，但不能把凭据带进浏览器；也不在这里写日志。
 */
function safeMessage(message: string): string {
  const lines = message
    .split('\n')
    .filter((line) => !/^\s*at\s/.test(line))
    .map((line) =>
      line
        // https://user:token@host/... → https://***@host/...
        .replace(/(https?:\/\/)[^\s/@]+@/gi, '$1***@')
        // Authorization: Basic xxx / Bearer xxx / token xxx
        .replace(/(authorization\s*[:=]\s*)(?:basic|bearer|token)\s+\S+/gi, '$1***')
        // token=... / password: ... / secret = ...
        .replace(/((?:access[_-]?token|token|password|secret)\s*[:=]\s*)\S+/gi, '$1***')
        // GitHub token 形态
        .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '***')
        // 64 位指纹 / 哈希（提交号是 40 位，保留可读性）
        .replace(/\b[0-9a-f]{64}\b/gi, '***')
        // 控制字符（保留换行 / tab）
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    );
  const text = lines.join('\n').trim();
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

export interface DelegationPublishRouteOptions {
  readonly publisher: DelegationPublisher;
  readonly delegations: Pick<WorkspaceDelegationStore, 'byId'>;
  readonly attempts: Pick<DelegationPublishStore, 'latest'>;
  readonly projects: Pick<ProjectRepository, 'byId'>;
  readonly access?: AccessPolicy;
  /**
   * 只读 HEAD 解析（`createDelegationHeadResolver`）。GET 状态用它给 UI 一个可批准的 SHA；
   * 不传 / 解析失败时 `headSha` 为 null，并用中性文案填 `headUnavailable`。
   */
  readonly resolveHead?: (record: WorkspaceDelegation) => Promise<Result<string, DomainError>>;
}

const APPROVAL_KEY = z
  .string()
  .refine((value) => {
    const trimmed = value.trim();
    return trimmed.length > 0 && trimmed.length <= 200 && !/[\u0000-\u001f\u007f]/.test(trimmed);
  }, 'approvalKey 必须是 trim 后非空、不超过 200 字符、且不含控制字符的字符串');

const PUBLISH_BODY = z
  .object({
    approvalKey: APPROVAL_KEY,
    expectedHeadSha: z.string().regex(/^[0-9a-f]{40}$/, 'expectedHeadSha 必须是 40 位小写十六进制提交')
  })
  .strict();

const RECONCILE_BODY = z.object({ approvalKey: APPROVAL_KEY }).strict();

const NO_STORE = { 'cache-control': 'no-store' };

function humanOf(subject: Subject | null) {
  const principal = principalOfSubject(subject);
  return principal !== null && principal.via === undefined ? principal : null;
}

async function readJson(c: Context): Promise<unknown> {
  return c.req.json().catch(() => null);
}

/**
 * 挂载：
 * - `POST /api/workspace-delegations/:delegationId/publish`（publish）
 * - `POST /api/workspace-delegations/:delegationId/reconcile`（只读对账）
 * - `GET  /api/workspace-delegations/:delegationId/publish`（人看状态）
 *
 * POST 只接受真人 cookie 登录（domain 也会再查一次）；GET 允许普通 API 令牌按项目读权限查看。
 */
export function installDelegationPublishRoutes(
  app: Hono<any>,
  options: DelegationPublishRouteOptions,
  subjectOf: SubjectOf
): void {
  app.post('/api/workspace-delegations/:delegationId/publish', async (c) => {
    const actor = subjectOf(c);
    if (!humanOf(actor)) return fail(c, forbidden('发布 PR 必须由真人登录会话发起'));
    const body = PUBLISH_BODY.safeParse(await readJson(c));
    if (!body.success) return fail(c, invalid('请求内容不合法'));

    return runPublish(c, options, {
      actor,
      delegationId: c.req.param('delegationId'),
      approvalKey: body.data.approvalKey,
      mode: 'publish',
      expectedHeadSha: body.data.expectedHeadSha
    });
  });

  app.post('/api/workspace-delegations/:delegationId/reconcile', async (c) => {
    const actor = subjectOf(c);
    if (!humanOf(actor)) return fail(c, forbidden('发布 PR 必须由真人登录会话发起'));
    const body = RECONCILE_BODY.safeParse(await readJson(c));
    if (!body.success) return fail(c, invalid('请求内容不合法'));

    return runPublish(c, options, {
      actor,
      delegationId: c.req.param('delegationId'),
      approvalKey: body.data.approvalKey,
      mode: 'reconcile'
    });
  });

  app.get('/api/workspace-delegations/:delegationId/publish', async (c) => {
    const actor = subjectOf(c);
    if (!actor) return fail(c, forbidden('需要登录'));
    const record = await options.delegations.byId(c.req.param('delegationId'));
    if (!record) return fail(c, notFound('派工记录不存在'));
    const project = await options.projects.byId(asProjectId(record.projectId));
    const allowed = await authorizeProject(options.access, actor, project, 'project.read');
    if (!allowed.ok) return fail(c, allowed.error);

    const attempt = await options.attempts.latest(record.id);
    const head = await currentHead(record, attempt, options.resolveHead);
    return c.json(
      {
        ...delegationPublishView(record, attempt),
        headSha: head.sha,
        headUnavailable: head.unavailable
      },
      200,
      NO_STORE
    );
  });
}

/**
 * GET 状态里的「当前 HEAD」：
 * - 记录不是 prepared = 还没有可批准的执行树，null（不报错）；
 * - 已有 publishing / published / uncertain 尝试 = 不再读工作树（避免把已经发生 / 正在发生的
 *   发布状态和「现在本地 HEAD 是什么」混在一起），null；
 * - 没有尝试或上次是明确 failed = 允许重新读取当前 SHA（人重试前要看到新提交）。
 * 解析失败只给中性文案，不回显 session / path / worker 这些内部身份。
 */
async function currentHead(
  record: WorkspaceDelegation,
  attempt: PublishAttempt | null,
  resolveHead: ((record: WorkspaceDelegation) => Promise<Result<string, DomainError>>) | undefined
): Promise<{ readonly sha: string | null; readonly unavailable: string | null }> {
  if (record.state !== 'prepared') return { sha: null, unavailable: null };
  if (attempt !== null && attempt.state !== 'failed') return { sha: null, unavailable: null };
  if (resolveHead === undefined) {
    return { sha: null, unavailable: '暂时无法读取执行工作树的当前提交' };
  }
  try {
    const result = await resolveHead(record);
    return result.ok
      ? { sha: result.value, unavailable: null }
      : { sha: null, unavailable: '暂时无法读取执行工作树的当前提交' };
  } catch {
    return { sha: null, unavailable: '暂时无法读取执行工作树的当前提交' };
  }
}

async function runPublish(
  c: Context,
  options: DelegationPublishRouteOptions,
  command: PublishDelegationCommand
): Promise<Response> {
  let result: Result<PublishDelegationRun, DomainError>;
  try {
    result = await options.publisher(command);
  } catch {
    // 不把异常栈 / 原始 message 回给浏览器；外部是否已经发生写由人用 reconcile 判定。
    return fail(c, unavailable('发布过程中断，结果无法确认；请刷新后对账'));
  }
  if (!result.ok) return fail(c, { code: result.error.code, message: safeMessage(result.error.message) });
  return c.json(
    {
      ...delegationPublishView(result.value.record, result.value.attempt),
      attempted: result.value.attempted,
      replayed: result.value.replayed,
      reconciled: result.value.reconciled
    },
    200,
    NO_STORE
  );
}
