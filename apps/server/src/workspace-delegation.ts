import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import type { Hono } from 'hono';
import { z } from 'zod';
import {
  asProjectId,
  asSessionId,
  asTaskId,
  asWorkspaceId,
  authorizeProject,
  authorizeSession,
  authorizeWorker,
  conflict,
  delegateWorkspaceDirectUseCase,
  delegateWorkspaceUseCase,
  deriveSessionUseCase,
  forbidden,
  isHttpsRepoUrl,
  isUsable,
  linkSessionsUseCase,
  newWorkspace,
  notFound,
  principalOfSubject,
  promptSessionUseCase,
  repoTokenKey,
  sameRepoUrl,
  setupNotReady,
  usableByProject,
  type CoordinatorRecord,
  type DelegationCoordinator,
  type DelegationDirectAuthorizer,
  type DelegationDirectSource,
  type DelegationDirectSourceRejection,
  type DelegationEffectResult,
  type DelegationLinkInput,
  type DelegationLinked,
  type DelegationMode,
  type DelegationPlan,
  type DelegationPlanInput,
  type DelegationPrepared,
  type DelegationPrepareInput,
  type DelegationRun,
  type DelegationStartInput,
  type DelegationStarted,
  type DelegateWorkspaceCommand,
  type Deps,
  type DirectDelegateWorkspaceCommand,
  type DomainError,
  type GitAuth,
  type Principal,
  type Project,
  type Result,
  type Session,
  type Subject,
  type Workspace,
  type WorkspaceCoordinatorRegistry,
  type WorkspaceDelegation,
  type WorkspaceDelegationDirectBridges,
  type WorkspaceDelegationStore,
  type WorkspaceDelegationBridges,
  type WorkspaceGit
} from '@agent-hub/domain';
import type { SubjectOf } from './auth.ts';
import { fail } from './http-error.ts';
import { authHeaderFor } from './repo-auth.ts';

/**
 * 主会话派工（workspace delegation A / A3）。
 *
 * 这一层只做「HTTP ⇄ 领域用例」的桥：
 * - POST /api/coordinators/:sessionId/delegations：当前登录的人发起；幂等键由客户端给；
 * - GET  同路径：先按项目 `session.read` 授权，再要求查看者是主会话的创建者（与 confirm 同一
 *   归属检查），只列出归属本人的派工记录；
 * - 响应永远脱敏：不返回请求指纹、claim、仓库令牌 / 凭据。
 *
 * 真正的顺序与状态机在 `delegateWorkspaceUseCase`；Git 工作树创建、会话派生也只通过下面几个
 * bridge 注入。MVP 的基线是主会话自己的长期工作空间：同一台 Worker、同一个项目仓库（HTTPS
 * 地址按 canonical host/path 匹配），严格 Worker 还会再校验实际 origin。
 */

/** 严格 worker 的失败文案：只有「可能已产生目录 / 分支」才允许标 uncertain。 */
function prepareFailureKind(message: string): 'fatal' | 'uncertain' {
  return message.includes('无法确认') || message.includes('可能已') ? 'uncertain' : 'fatal';
}

function humanOf(subject: Subject | null): Principal | null {
  const principal = principalOfSubject(subject);
  if (!principal || principal.via) return null;
  return principal;
}

/**
 * SSH 传输的两种注册形式：`ssh://...` 与 scp 形式 `user@host:path`。
 *
 * 这里只做「这是不是 SSH 传输」的粗判，具体文法 / 规范化由严格 Worker 的解析器负责；
 * 缓存 origin 的比对则保守地要求原文一致，不做 scheme / 端口 / userinfo 改写。
 */
function isSshRepoUrl(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed === '' || /\s/.test(trimmed)) return false;
  if (/^ssh:\/\//i.test(trimmed)) return true;
  return /^[^@/\s]+@[^:/\s]+:/.test(trimmed);
}

/** 两条车道共享的来源上下文：源会话、它所在的长期工作空间、以及服务端绑定的项目。 */
interface DelegationSourceContext {
  readonly session: Session;
  readonly workspace: Workspace;
  readonly project: Project;
}

/** 只从已核实的主会话登记簿里取；任何漂移都当不存在。 */
interface CoordinatorContext extends DelegationSourceContext {
  readonly record: CoordinatorRecord;
}

function validSessionForCoordinator(session: Session | null, record: CoordinatorRecord): string | null {
  if (session === null) return '会话不在了';
  if (session.taskId !== null) return '会话已经归到任务上';
  if (session.originProjectId !== record.projectId) return '会话的来源项目对不上';
  if (session.workspaceId !== record.workspaceId) return '会话不在这个工作空间里';
  if ((session.botId ?? null) !== null) return '这条会话是 bot 开的';
  if ((session.groupId ?? null) !== null) return '这条会话属于组合工作空间';
  if ((session.parentSessionId ?? null) !== null) return '这条会话是侧聊';
  if ((session.createdBy ?? '').trim() === '') return '会话没有归属人';
  return null;
}

async function coordinatorContext(
  deps: DelegationDeps,
  registry: WorkspaceCoordinatorRegistry,
  sessionId: string
): Promise<CoordinatorContext | null> {
  const session = await deps.sessions.byId(asSessionId(sessionId));
  const projectId = session?.originProjectId ?? null;
  const workspaceId = session?.workspaceId ?? null;
  if (!session || projectId === null || workspaceId === null) return null;
  const record = await registry.get(asProjectId(projectId), asWorkspaceId(workspaceId));
  if (!record || record.sessionId !== sessionId) return null;
  if (validSessionForCoordinator(session, record) !== null) return null;

  const project = await deps.projects.byId(asProjectId(record.projectId));
  if (!project || project.deletedAt !== null) return null;
  const workspace = await deps.workspaces.byId(asWorkspaceId(record.workspaceId));
  if (!workspace || workspace.kind !== 'long_lived' || !isUsable(workspace)) return null;
  if (!(await usableByProject(deps, workspace, project.id))) return null;
  if (setupNotReady(workspace, project.worktree?.setup?.waitForSetup ?? true) !== null) return null;
  if (
    workspace.workerId !== null &&
    session.workerId !== null &&
    workspace.workerId !== session.workerId
  ) {
    return null;
  }
  return { session, record, workspace, project };
}

/**
 * 直接执行车道的来源：普通任务 / 无任务会话，项目只能来自服务端不可变绑定。
 *
 * - 有任务：项目 = 任务项目；若同时存在 `originProjectId` 且与之不同，说明绑定冲突，拒绝。
 * - 无任务：项目 = `originProjectId`；没有则拒绝，绝不从 cwd / 默认项目猜。
 *
 * 仍然要求来源会话的长期工作空间可用、属于同一项目、Worker 一致；但不要求登记为主会话。
 */
interface DirectContextResult {
  readonly context: DelegationSourceContext | null;
  /** 只有明确按「当前主人」询问、且会话归属确实匹配时才有值。 */
  readonly rejection: DelegationDirectSourceRejection | null;
}

const NEUTRAL_DIRECT_CONTEXT: DirectContextResult = { context: null, rejection: null };

async function directContext(
  deps: DelegationDeps,
  sessionId: string,
  explainToAccountId: string | null = null
): Promise<DirectContextResult> {
  const session = await deps.sessions.byId(asSessionId(sessionId));
  if (!session) return NEUTRAL_DIRECT_CONTEXT;
  const owner = (session.createdBy ?? '').trim();
  if (owner === '') return NEUTRAL_DIRECT_CONTEXT;

  // 归类只对「这条会话现在的主人」开放；其他调用方看到的仍是中性 notFound。
  const reject = (reason: DelegationDirectSourceRejection): DirectContextResult =>
    explainToAccountId !== null && owner === explainToAccountId
      ? { context: null, rejection: reason }
      : NEUTRAL_DIRECT_CONTEXT;

  if ((session.botId ?? null) !== null) return NEUTRAL_DIRECT_CONTEXT;
  if ((session.parentSessionId ?? null) !== null || session.kind === 'side') return NEUTRAL_DIRECT_CONTEXT;

  let projectId = session.originProjectId ?? null;
  if (session.taskId !== null) {
    const task = await deps.tasks.byId(session.taskId);
    if (!task) return NEUTRAL_DIRECT_CONTEXT;
    if (projectId !== null && projectId !== task.projectId) return NEUTRAL_DIRECT_CONTEXT;
    projectId = task.projectId;
  }
  // 聊天 / 无项目 / 没有持久工作空间的会话：属于「不可直接复用」而不是「不存在」。
  if (projectId === null || session.workspaceId === null) return reject('chat_only');

  const project = await deps.projects.byId(projectId);
  if (!project || project.deletedAt !== null) return NEUTRAL_DIRECT_CONTEXT;
  const workspace = await deps.workspaces.byId(session.workspaceId);
  if (!workspace) return reject('workspace_missing');
  // 临时 / 非长期工作空间不能作为直接来源。
  if (workspace.kind !== 'long_lived') return reject('chat_only');
  if (!isUsable(workspace)) {
    return reject(workspace.state === 'removed' ? 'workspace_missing' : 'workspace_not_ready');
  }
  if (setupNotReady(workspace, project.worktree?.setup?.waitForSetup ?? true) !== null) {
    return reject('workspace_not_ready');
  }
  if (!(await usableByProject(deps, workspace, project.id))) return reject('workspace_unlinked');
  if (
    workspace.workerId !== null &&
    session.workerId !== null &&
    workspace.workerId !== session.workerId
  ) {
    return reject('worker_mismatch');
  }
  return { context: { session, workspace, project }, rejection: null };
}

/**
 * 按车道解析来源：提案只走登记簿；直接只走普通会话的不可变项目绑定。
 * `registry === null` 表示当前桥不提供提案车道（直接桥）。
 */
async function sourceContext(
  deps: DelegationDeps,
  registry: WorkspaceCoordinatorRegistry | null,
  sessionId: string,
  mode: DelegationMode
): Promise<DelegationSourceContext | null> {
  if (mode === 'direct') return (await directContext(deps, sessionId)).context;
  if (!registry) return null;
  const context = await coordinatorContext(deps, registry, sessionId);
  return context;
}

/** 已记下的 workerId → 真正执行 git 的那条路（本机 Worker 走 Server 自己的 git）。 */
export async function gitForWorker(deps: Pick<DelegationDeps, 'gateway' | 'git'>, workerId: string): Promise<WorkspaceGit> {
  const worker = (await deps.gateway.status()).find((candidate) => candidate.workerId === workerId);
  if (worker?.origin === 'local') return deps.git;
  // 不认识的 worker 也交给网关报错，绝不能退回到 Server 本机的 git 上动错目录。
  return deps.gateway.git(workerId);
}

async function workerIdOf(deps: DelegationDeps, context: DelegationSourceContext): Promise<string | null> {
  if (context.workspace.workerId !== null) return context.workspace.workerId;
  if (context.session.workerId !== null) return context.session.workerId;
  const local = (await deps.gateway.status()).find((candidate) => candidate.origin === 'local');
  return local?.workerId ?? null;
}

/** 同 key 同计划：只由来源会话 id + 请求键 + 车道推导，不含随机数 / 时间 / 预分配会话 id。 */
function planOf(
  sessionId: string,
  requestKey: string,
  workerId: string,
  baseBranch: string,
  mode: DelegationMode,
  workspacePath: string
): DelegationPlan {
  const prefix = mode === 'direct' ? 'workspace-delegation/direct/v1' : 'workspace-delegation/v1';
  const digest = createHash('sha256')
    .update(`${prefix}\n${sessionId}\n${requestKey}`, 'utf8')
    .digest('hex')
    .slice(0, 24);
  const name = basename(workspacePath);
  return {
    workerId,
    baseBranch,
    worktreePath: join(dirname(workspacePath), `${name}.delegation-${digest}`),
    branch: `delegation/${digest}`
  };
}

/**
 * 让主会话的工作空间必须真的是选中项目的那个仓库（HTTPS 或 SSH）。
 * `workspace.repoUrl === null` 只是「没有缓存 origin 元数据」，不是通过：后续严格 Worker 仍会用
 * `expectedUrl` 对实际 origin 做决定性校验（在创建目录 / 分支和联网之前）。非 null 的缓存必须一致。
 *
 * HTTPS 按既有 canonical host/path 匹配；SSH 的语法由 Worker 统一解析，这里只接受同一条原始地址，
 * 避免在 server 里做 port / userinfo / scp 形式的危险改写。
 */
function requireSameRepo(workspace: Workspace, repo: { readonly url: string }): void {
  const ssh = isSshRepoUrl(repo.url);
  if (!isHttpsRepoUrl(repo.url) && !ssh) throw new Error('委派只支持 HTTPS 或 SSH 仓库地址');
  const origin = workspace.repoUrl;
  if (origin !== null) {
    if (ssh) {
      if (origin.trim() !== repo.url.trim()) {
        throw new Error('主会话的工作空间不是这个项目仓库（SSH origin 不一致）');
      }
    } else if (!isHttpsRepoUrl(origin) || !sameRepoUrl(origin, repo.url)) {
      throw new Error('主会话的工作空间不是这个项目仓库（HTTPS origin 不一致）');
    }
  }
  if (workspace.isGit === false) throw new Error('主会话的工作空间不是 Git 仓库');
}

/**
 * 只按这次派工记录里的 `repoId` 解凭据，不按 URL 扫项目：
 * 同一个 canonical URL 可能在项目里登记成两条（例如一条带 token、一条走机器 key），
 * URL 命中会拿到另一条仓库的凭据。这里与发布通道 `workspace-delegation-publish.ts` 同一套设计：
 * 必须是该项目里的这一条，`tokenSecret` 必须是 `repo-git:<projectId>:<repoId>` 规范键；
 * 旧键 / 没配 = 不带凭据（失败关闭，不改用环境变量、全局 token 或机器上的 gh）。
 */
async function configuredRepoAuth(
  deps: DelegationDeps,
  project: Project,
  repo: { readonly id: string; readonly url: string }
): Promise<DelegationEffectResult<GitAuth | null>> {
  const exact = project.repos.find((candidate) => candidate.id === repo.id);
  const ssh = exact !== undefined && isSshRepoUrl(exact.url);
  if (!exact || exact.url !== repo.url || (!isHttpsRepoUrl(exact.url) && !ssh)) {
    return { ok: false, kind: 'fatal', message: '派工仓库与项目里的仓库登记不一致' };
  }
  // SSH 只使用这台 Worker 已有的信任身份；即使登记了 tokenSecret 也绝不读取 / 转发 HTTPS 凭据。
  if (ssh) return { ok: true, value: null };
  const key = repoTokenKey(project.id, exact.id);
  if (exact.tokenSecret !== key) return { ok: true, value: null };
  try {
    const revealed = await deps.secrets.reveal([key]);
    const token = typeof revealed[key] === 'string' ? revealed[key].trim() : '';
    return { ok: true, value: token === '' ? null : authHeaderFor(token, exact.url) };
  } catch (error) {
    return { ok: false, kind: 'fatal', message: `读取仓库凭据失败：${messageOf(error)}` };
  }
}

/** bridge 需要知道这次请求的启动参数；领域契约没有把它们传进 prepare/start。 */
export interface DelegationBridgeContext {
  /** POST body 里的基线分支；`plan` 用它，保证与领域记录的冻结计划一致。 */
  readonly baseBranch: string;
  readonly agentId: string;
  readonly model?: string | null;
  readonly profileId?: string | null;
  readonly options?: Readonly<Record<string, string | boolean>>;
}

/**
 * 生产 bridge 的共享实现。`command` 只影响本次首次请求；已存在记录的重试由用例自己复用冻结计划，
 * 不会再调用 `plan` / 不会重新读取这里的启动参数。
 *
 * `registry === null` 表示直接车道桥：不提供提案来源，只按 `input.mode` 解析直接来源。
 */
function createBridges(
  deps: DelegationDeps,
  registry: WorkspaceCoordinatorRegistry | null,
  command: DelegationBridgeContext
): WorkspaceDelegationBridges {
  return {
    async resolveCoordinator(sessionId): Promise<DelegationCoordinator | null> {
      if (!registry) return null;
      const context = await coordinatorContext(deps, registry, sessionId);
      if (!context) return null;
      return {
        sessionId: asSessionId(context.record.sessionId),
        projectId: asProjectId(context.record.projectId),
        accountId: context.session.createdBy as string
      };
    },

    async plan(input: DelegationPlanInput): Promise<DelegationPlan> {
      const context = await sourceContext(deps, registry, input.coordinator.sessionId, input.mode);
      if (!context) throw new Error('派工来源会话已不存在或已漂移');
      if (context.project.id !== input.project.id) throw new Error('来源会话的项目与请求不一致');
      requireSameRepo(context.workspace, input.repo);
      const workerId = await workerIdOf(deps, context);
      if (workerId === null) throw new Error('找不到来源会话所在的 Worker');
      return planOf(
        input.coordinator.sessionId,
        input.requestKey,
        workerId,
        command.baseBranch,
        input.mode,
        context.workspace.path
      );
    },

    async prepare(input: DelegationPrepareInput): Promise<DelegationEffectResult<DelegationPrepared>> {
      const context = await sourceContext(deps, registry, input.coordinator.sessionId, input.mode);
      if (!context) return { ok: false, kind: 'fatal', message: '派工来源会话已不存在或已漂移' };
      try {
        requireSameRepo(context.workspace, input.repo);
      } catch (error) {
        return { ok: false, kind: 'fatal', message: messageOf(error) };
      }
      if (input.plan.workerId !== (await workerIdOf(deps, context))) {
        return { ok: false, kind: 'fatal', message: '计划里的 Worker 与来源会话不一致' };
      }

      const resolved = await configuredRepoAuth(deps, input.project, input.repo);
      if (!resolved.ok) return resolved;
      const auth = resolved.value;

      const git = await gitForWorker(deps, input.plan.workerId);
      if (typeof git.prepareDelegationWorktree !== 'function') {
        return { ok: false, kind: 'fatal', message: '这台 Worker 不支持严格准备委派工作区' };
      }
      let prepared;
      try {
        prepared = await git.prepareDelegationWorktree({
          repoPath: context.workspace.path,
          path: input.plan.worktreePath,
          branch: input.plan.branch,
          baseBranch: input.plan.baseBranch,
          expectedUrl: input.repo.url,
          ...(auth ? { auth } : {})
        });
      } catch (error) {
        return { ok: false, kind: 'uncertain', message: `准备委派工作区时发生异常，结果无法确认：${messageOf(error)}` };
      }
      if (!prepared.ok) {
        return { ok: false, kind: prepareFailureKind(prepared.error.message), message: prepared.error.message };
      }
      const outcome = prepared.value;
      if (
        outcome.path !== input.plan.worktreePath ||
        outcome.branch !== input.plan.branch ||
        !/^[0-9a-f]{40}$/.test(outcome.baseSha)
      ) {
        return { ok: false, kind: 'uncertain', message: 'Worker 返回的工作区路径 / 分支 / 提交与计划不一致' };
      }

      const created = newWorkspace({
        projectId: input.project.id,
        teamId: input.project.teamId,
        repoUrl: input.repo.url,
        workerId: input.plan.workerId,
        path: outcome.path,
        kind: 'temporary',
        source: 'worktree',
        ownerTaskId: input.record.taskId,
        baseWorkspaceId: context.workspace.id,
        branch: outcome.branch,
        label: `委派 ${input.record.requestKey}`,
        isGit: true,
        now: deps.now()
      });
      if (!created.ok) {
        return { ok: false, kind: 'uncertain', message: `工作区已创建，但登记失败：${created.error.message}` };
      }
      let saved;
      try {
        saved = await deps.workspaces.save(created.value);
      } catch (error) {
        return { ok: false, kind: 'uncertain', message: `工作区已创建，但登记异常：${messageOf(error)}` };
      }
      if (saved.status !== 'saved') {
        return { ok: false, kind: 'uncertain', message: '工作区已创建，但登记没有落库' };
      }
      return { ok: true, value: { workspaceId: saved.workspace.id, baseSha: outcome.baseSha } };
    },

    async start(input: DelegationStartInput): Promise<DelegationEffectResult<DelegationStarted>> {
      const context = await sourceContext(deps, registry, input.coordinator.sessionId, input.mode);
      if (!context) return { ok: false, kind: 'uncertain', message: '派工来源会话已漂移，执行会话未启动' };
      const workspace = await deps.workspaces.byId(input.prepared.workspaceId);
      if (
        !workspace ||
        workspace.kind !== 'temporary' ||
        workspace.ownerTaskId !== input.record.taskId ||
        workspace.projectId !== input.project.id ||
        workspace.baseWorkspaceId !== context.workspace.id ||
        workspace.workerId !== input.plan.workerId ||
        workspace.path !== input.plan.worktreePath ||
        workspace.branch !== input.plan.branch ||
        !isUsable(workspace)
      ) {
        return { ok: false, kind: 'uncertain', message: '预分配的工作区登记与计划不一致，执行会话未启动' };
      }

      // 权限在副作用之后可能已经变化：启动前重新过项目 / agent / Worker 三道授权。
      const allowed = await authorizeProject(deps.access, input.actor, context.project, 'session.create');
      if (!allowed.ok) {
        return { ok: false, kind: 'uncertain', message: `启动前项目权限已失效：${allowed.error.message}` };
      }
      const allowedSpawn = await authorizeProject(deps.access, input.actor, context.project, 'agent.spawn');
      if (!allowedSpawn.ok) {
        return { ok: false, kind: 'uncertain', message: `启动前 agent 权限已失效：${allowedSpawn.error.message}` };
      }
      const allowedWorker = await authorizeWorker(deps.access, input.actor, input.plan.workerId);
      if (!allowedWorker.ok) {
        return { ok: false, kind: 'uncertain', message: `启动前 Worker 权限已失效：${allowedWorker.error.message}` };
      }

      const derived = await deriveSessionUseCase(deps, {
        taskId: input.record.taskId,
        projectId: input.project.id,
        workspaceId: input.prepared.workspaceId,
        sessionId: input.record.executionSessionId,
        agentId: command.agentId,
        model: command.model ?? '',
        ...(command.profileId ? { profileId: command.profileId } : {}),
        ...(command.options ? { options: command.options } : {}),
        createdBy: context.session.createdBy,
        actor: input.actor
      });
      if (!derived.ok) {
        // 工作树已经在 prepare 阶段落盘；这里无论会话行有没有写进去，都不能自动重放。
        return { ok: false, kind: 'uncertain', message: `启动执行会话失败，工作区可能已存在：${derived.error.message}` };
      }
      const session = derived.value;
      if (
        session.id !== input.record.executionSessionId ||
        session.taskId !== input.record.taskId ||
        session.workspaceId !== input.prepared.workspaceId
      ) {
        return { ok: false, kind: 'uncertain', message: '执行会话的身份与预分配不一致' };
      }
      return {
        ok: true,
        value: { sessionId: session.id, taskId: session.taskId, workspaceId: session.workspaceId }
      };
    },

    async link(input: DelegationLinkInput): Promise<DelegationEffectResult<DelegationLinked>> {
      const context = await sourceContext(deps, registry, input.coordinator.sessionId, input.mode);
      if (!context || context.project.id !== input.project.id) {
        return { ok: false, kind: 'uncertain', message: '派工来源会话 / 工作空间已漂移，无法建立执行会话链路' };
      }
      const session = await deps.sessions.byId(input.record.executionSessionId);
      if (
        !session ||
        session.taskId !== input.record.taskId ||
        session.workspaceId !== input.prepared.workspaceId ||
        (session.parentSessionId ?? null) !== null ||
        (session.botId ?? null) !== null ||
        session.kind === 'side'
      ) {
        return { ok: false, kind: 'uncertain', message: '执行会话的关联状态无法确认' };
      }
      // 会话权限也要在真正发消息前重新判定：期间可能被移出项目 / 收回会话权限。
      const allowed = await authorizeSession(deps.access, input.actor, context.project, session, 'session.prompt');
      if (!allowed.ok) {
        return { ok: false, kind: 'uncertain', message: `执行会话权限已失效：${allowed.error.message}` };
      }
      if (!deps.links) {
        return { ok: false, kind: 'uncertain', message: '会话连线存储不可用，无法建立双向消息链路' };
      }
      const principal = principalOfSubject(input.actor);
      const linked = await linkSessionsUseCase(
        deps,
        input.project.id,
        input.coordinator.sessionId,
        session.id,
        principal?.user.id ?? null
      );
      if (!linked.ok) {
        return { ok: false, kind: 'uncertain', message: `建立主会话 / 执行会话连线失败：${linked.error.message}` };
      }

      // 说明只通过现有 durable 送达队列送一次。幂等键固定在派工记录上：同一条记录重试不会多写一条 prompt。
      if (input.record.instructions.trim() !== '') {
        try {
          const prompted = await promptSessionUseCase(deps, {
            sessionId: session.id,
            text: input.record.instructions,
            clientMessageId: `delegation:${input.record.id}`,
            ...(principal ? { author: { id: principal.user.id, name: principal.user.displayName } } : {})
          });
          if (!prompted.ok) {
            return { ok: false, kind: 'uncertain', message: `委派说明没能进入送达队列：${prompted.error.message}` };
          }
        } catch (error) {
          return { ok: false, kind: 'uncertain', message: `委派说明送达结果无法确认：${messageOf(error)}` };
        }
      }
      return { ok: true, value: { sessionId: session.id } };
    }
  };
}

/** 提案车道的生产 bridge；工具 / HTTP 的既有导入保持不变。 */
export function createWorkspaceDelegationBridges(
  deps: DelegationDeps,
  registry: WorkspaceCoordinatorRegistry,
  command: DelegationBridgeContext
): WorkspaceDelegationBridges {
  return createBridges(deps, registry, command);
}

/**
 * 直接车道的生产 bridge：来源只来自普通会话的不可变项目绑定，不查主会话登记簿。
 *
 * `actorAccountId` 是本次调用的人类主人；只有它与会话归属一致时，才允许把具体拒绝原因带回。
 * 默认 null = 只做来源解析，不提供诊断（保持旧调用方行为）。
 */
export function createWorkspaceDelegationDirectBridges(
  deps: DelegationDeps,
  command: DelegationBridgeContext,
  actorAccountId: string | null = null
): WorkspaceDelegationDirectBridges {
  return {
    ...createBridges(deps, null, command),
    async resolveDirectSource(sessionId): Promise<DelegationDirectSource | null> {
      const { context } = await directContext(deps, sessionId);
      if (!context) return null;
      return {
        sessionId: asSessionId(sessionId),
        projectId: context.project.id,
        taskId: context.session.taskId,
        accountId: context.session.createdBy as string
      };
    },
    async explainDirectSourceRejection(sessionId, accountId) {
      if (accountId === null || accountId !== actorAccountId) return null;
      return (await directContext(deps, sessionId, accountId)).rejection;
    }
  };
}

/**
 * 直接车道的服务端入口。调用方必须注入当前授权判定（重新读取来源 / 目标 / 仓库 / 授权，
 * 而不是依赖入参或旧快照）；领域层会在每个尚未发出的副作用步骤前再次调用它。
 */
export async function runWorkspaceDelegationDirect(
  deps: DelegationDeps,
  delegations: WorkspaceDelegationStore,
  authorize: DelegationDirectAuthorizer,
  command: DirectDelegateWorkspaceCommand
): Promise<Result<DelegationRun, DomainError>> {
  const bridges = createWorkspaceDelegationDirectBridges(
    deps,
    {
      baseBranch: command.baseBranch,
      agentId: command.agentId,
      model: command.model ?? null,
      profileId: command.profileId ?? null,
      options: command.options
    },
    humanOf(command.actor)?.user.id ?? null
  );
  return delegateWorkspaceDirectUseCase(deps, delegations, bridges, authorize, command);
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  return String(error);
}

/** 给浏览器的已脱敏启动配置：参数本身不外露，避免 options 带出运行环境细节。 */
export interface DelegationStartupView {
  readonly agentId: string;
  readonly model: string | null;
  readonly profileId: string | null;
}

/** 给浏览器的派工视图：刻意没有 requestFingerprint / claim / accountId / repoUrl / options。 */
export interface DelegationView {
  readonly id: string;
  readonly coordinatorSessionId: string;
  readonly requestKey: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly repoId: string;
  readonly workerId: string;
  readonly baseBranch: string;
  readonly baseSha: string | null;
  readonly instructions: string;
  readonly executionSessionId: string;
  readonly worktreePath: string;
  readonly branch: string;
  /** 只有仍处于「待确认提案」时才是 true；不是请求方可以指定的布尔值。 */
  readonly canConfirm: boolean;
  /**
   * 读取时按会话存储核实「执行会话现在真的存在，并且当前查看者能读」。
   *
   * 这不是按 `state` 推出来的：prepared 之后会话可能被删，pending 预留的 id 也还没有会话。
   * 只有同时满足以下条件才是 true；其余（不存在 / 已删除 / 读取异常 / 归属漂移 / 没有
   * `session.read`）一律 false，并且**不区分原因**——不要用这个布尔值反推「别人的会话是否存在」。
   */
  readonly executionSessionExists: boolean;
  readonly startup: DelegationStartupView | null;
  readonly state: WorkspaceDelegation['state'];
  readonly failure: WorkspaceDelegation['failure'];
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** 旧调用点（例如 Runtime 工具）没有查看者上下文：默认 false = 不声称会话存在。 */
export function delegationView(record: WorkspaceDelegation, executionSessionExists = false): DelegationView {
  return {
    id: record.id,
    coordinatorSessionId: record.coordinatorSessionId,
    requestKey: record.requestKey,
    projectId: record.projectId,
    taskId: record.taskId,
    repoId: record.repoId,
    workerId: record.workerId,
    baseBranch: record.baseBranch,
    baseSha: record.baseSha,
    instructions: record.instructions,
    executionSessionId: record.executionSessionId,
    worktreePath: record.worktreePath,
    branch: record.branch,
    canConfirm: record.state === 'pending' && record.claim === null && record.startup !== null,
    executionSessionExists,
    startup: record.startup
      ? {
          agentId: record.startup.agentId,
          model: record.startup.model,
          profileId: record.startup.profileId
        }
      : null,
    state: record.state,
    failure: record.failure,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

/**
 * 读取时的执行会话存在性判定（`executionSessionExists` 的唯一来源）。
 *
 * 纯读、无副作用；任何一步不成立都返回 false，绝不把原因（无权 / 已删 / 读失败）传给浏览器：
 * - 精确归属：查看者必须就是这条派工的归属账号（与 GET / confirm 同一份 ownership 检查）；
 * - 项目一致：只能用服务端核实过的项目做 `session.read`，不能让查询参数改判；
 * - 真实存在：按预留 `executionSessionId` 从会话存储读取，读不到 / 抛错都当不存在；
 * - 身份一致：会话的任务与创建者必须跟派工记录完全一致，bot / 侧聊 / 容器会话不算；
 * - 当前可读：查看者现在仍对这条会话有 `session.read`（权限可能在发起后被收回）。
 */
async function executionSessionExistsFor(
  deps: Pick<DelegationDeps, 'access' | 'sessions'>,
  viewer: Subject | null,
  project: Project | null,
  record: WorkspaceDelegation
): Promise<boolean> {
  const principal = humanOf(viewer);
  if (!principal || principal.user.id !== record.accountId) return false;
  if (!project || project.id !== record.projectId) return false;
  let session: Session | null;
  try {
    session = await deps.sessions.byId(asSessionId(record.executionSessionId));
  } catch {
    return false;
  }
  if (!session) return false;
  if (session.taskId !== record.taskId) return false;
  if ((session.createdBy ?? '') !== record.accountId) return false;
  if ((session.botId ?? null) !== null) return false;
  if ((session.parentSessionId ?? null) !== null || session.kind === 'side') return false;
  try {
    const allowed = await authorizeSession(deps.access, viewer, project, session, 'session.read');
    return allowed.ok;
  } catch {
    return false;
  }
}

export type DelegationDeps = Pick<
  Deps,
  | 'access'
  | 'agentDefaults'
  | 'agentProfiles'
  | 'agents'
  | 'artifacts'
  | 'bots'
  | 'deliveries'
  | 'fs'
  | 'gateway'
  | 'git'
  | 'hosting'
  | 'links'
  | 'memoryGuidance'
  | 'now'
  | 'peerBriefing'
  | 'projects'
  | 'queue'
  | 'secrets'
  | 'sessionInstructions'
  | 'sessions'
  | 'stream'
  | 'tasks'
  | 'taskGate'
  | 'workerPresence'
  | 'workspaces'
  | 'workspaceGroups'
  | 'workLog'
>;

export interface DelegationRouteDeps {
  readonly deps: DelegationDeps;
  readonly delegations: WorkspaceDelegationStore;
  readonly coordinators: WorkspaceCoordinatorRegistry;
}

const createBody = z.object({
  requestKey: z.string().min(1).max(200),
  taskId: z.string().min(1),
  repoId: z.string().min(1),
  baseBranch: z.string().min(1).max(200),
  instructions: z.string().min(1, 'instructions 不能为空').max(20_000),
  agentId: z.string().min(1),
  model: z.string().max(200).optional().nullable(),
  profileId: z.string().min(1).max(200).optional().nullable(),
  options: z.record(z.string(), z.union([z.string(), z.boolean()])).optional()
});

const noStore = { 'cache-control': 'no-store' } as const;

/** 确认接口不接受浏览器重放整份配置：只允许空 body 或 `{}`。 */
function emptyConfirmBody(raw: string): boolean {
  if (raw.trim() === '') return true;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length === 0;
  } catch {
    return false;
  }
}

export function installDelegationRoutes(
  app: Hono<any>,
  options: DelegationRouteDeps,
  subjectOf: SubjectOf
): void {
  const { deps, delegations, coordinators } = options;

  app.post('/api/coordinators/:sessionId/delegations', async (c) => {
    const actor = subjectOf(c);
    if (!humanOf(actor)) return c.json({ error: { code: 'forbidden', message: '只有当前登录的人能发起委派' } }, 403);
    const parsed = createBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: 'invalid', message: parsed.error.issues[0]?.message ?? '请求格式不对' } }, 400);
    }
    const body = parsed.data;
    const coordinatorSessionId = asSessionId(c.req.param('sessionId'));
    const command: DelegateWorkspaceCommand = {
      actor,
      requestKey: body.requestKey,
      coordinatorSessionId,
      taskId: asTaskId(body.taskId),
      repoId: body.repoId,
      baseBranch: body.baseBranch,
      instructions: body.instructions,
      agentId: body.agentId,
      model: body.model ?? null,
      profileId: body.profileId ?? null,
      options: body.options
    };
    const result = await delegateWorkspaceUseCase(
      deps,
      delegations,
      createWorkspaceDelegationBridges(deps, coordinators, {
        baseBranch: body.baseBranch,
        agentId: body.agentId,
        model: body.model ?? null,
        profileId: body.profileId ?? null,
        options: body.options
      }),
      command
    );
    if (!result.ok) return fail(c, result.error);
    const project = await deps.projects.byId(result.value.record.projectId);
    const executionSessionExists = await executionSessionExistsFor(deps, actor, project, result.value.record);
    return c.json(
      {
        created: result.value.allocation === 'created',
        claimed: result.value.claimed,
        delegation: delegationView(result.value.record, executionSessionExists)
      },
      result.value.allocation === 'created' ? 201 : 200,
      noStore
    );
  });

  app.post('/api/coordinators/:sessionId/delegations/:delegationId/confirm', async (c) => {
    const actor = subjectOf(c);
    const principal = humanOf(actor);
    if (!actor || !principal) {
      return c.json({ error: { code: 'forbidden', message: '只有当前登录的人能确认派工' } }, 403);
    }
    const body = await c.req.text().catch(() => null);
    if (body === null || !emptyConfirmBody(body)) {
      return c.json({ error: { code: 'invalid', message: '确认派工不接受请求体；启动配置只从服务端记录读取' } }, 400);
    }

    const coordinatorSessionId = asSessionId(c.req.param('sessionId'));
    const context = await coordinatorContext(deps, coordinators, coordinatorSessionId);
    if (!context) return fail(c, notFound('主会话不存在'));
    const record = await delegations.byId(c.req.param('delegationId'));
    if (!record || record.coordinatorSessionId !== coordinatorSessionId || record.projectId !== context.project.id) {
      return fail(c, notFound('派工记录不存在'));
    }
    if (record.accountId !== principal.user.id || context.session.createdBy !== principal.user.id) {
      return fail(c, forbidden('不能确认别人的派工'));
    }
    const allowed = await authorizeProject(deps.access, actor, context.project, 'session.read');
    if (!allowed.ok) return fail(c, allowed.error);

    // 已完成的确认是幂等的：重复点击只回同一条 prepared 记录，不再碰 Git / 会话。
    if (record.state === 'prepared') {
      const executionSessionExists = await executionSessionExistsFor(deps, actor, context.project, record);
      return c.json(
        { created: false, claimed: false, delegation: delegationView(record, executionSessionExists) },
        200,
        noStore
      );
    }
    if (record.state !== 'pending' || record.claim !== null) {
      return fail(c, conflict(`派工当前是 ${record.state}，不能确认`));
    }
    if (record.startup === null) {
      return fail(c, conflict('这条派工没有服务端冻结的启动配置，不能确认'));
    }

    // 原请求的配置只从持久记录恢复；请求体不参与，原始指纹由领域用例按同一条记录复算并校验。
    const startup = record.startup;
    const command: DelegateWorkspaceCommand = {
      actor,
      requestKey: record.requestKey,
      coordinatorSessionId,
      taskId: record.taskId,
      repoId: record.repoId,
      baseBranch: record.baseBranch,
      instructions: record.instructions,
      agentId: startup.agentId,
      model: startup.model,
      profileId: startup.profileId,
      options: startup.options
    };
    const result = await delegateWorkspaceUseCase(
      deps,
      delegations,
      createWorkspaceDelegationBridges(deps, coordinators, {
        baseBranch: record.baseBranch,
        agentId: startup.agentId,
        model: startup.model,
        profileId: startup.profileId,
        options: startup.options
      }),
      command
    );
    if (!result.ok) return fail(c, result.error);
    if (result.value.record.state !== 'prepared') {
      return fail(c, conflict(`派工当前是 ${result.value.record.state}，还没有完成确认`));
    }
    return c.json(
      {
        created: false,
        claimed: result.value.claimed,
        delegation: delegationView(
          result.value.record,
          await executionSessionExistsFor(deps, actor, context.project, result.value.record)
        )
      },
      200,
      noStore
    );
  });

  app.get('/api/coordinators/:sessionId/delegations', async (c) => {
    const actor = subjectOf(c);
    const principal = humanOf(actor);
    if (!actor || !principal) {
      return c.json({ error: { code: 'forbidden', message: '只有当前登录的人能查看派工' } }, 403);
    }
    const sessionId = asSessionId(c.req.param('sessionId'));
    const session = await deps.sessions.byId(sessionId);
    if (!session) return fail(c, notFound('主会话不存在'));
    const project = session.originProjectId ? await deps.projects.byId(session.originProjectId) : null;
    const allowed = await authorizeProject(deps.access, actor, project, 'session.read');
    if (!allowed.ok) return fail(c, allowed.error);
    const context = await coordinatorContext(deps, coordinators, sessionId);
    if (!context) return fail(c, notFound('主会话不存在'));
    // 与 confirm 一致：派工说明、工作树路径和失败细节只给派工归属的人，项目内其他成员不共享。
    if (context.session.createdBy !== principal.user.id) return fail(c, forbidden('只有主会话的创建者能查看派工'));
    const records = await delegations.byCoordinator(sessionId);
    const own = records.filter((record) => record.accountId === principal.user.id);
    const views = await Promise.all(
      own.map(async (record) =>
        delegationView(record, await executionSessionExistsFor(deps, actor, context.project, record))
      )
    );
    return c.json({ delegations: views }, 200, noStore);
  });
}
