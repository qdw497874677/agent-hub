import type { Hono } from 'hono';
import { z } from 'zod';
import {
  asProjectId,
  asSessionId,
  asWorkspaceId,
  authorizeProject,
  conflict,
  deriveSessionUseCase,
  err,
  forbidden,
  invalid,
  isUsable,
  newSessionId,
  notFound,
  ok,
  principalOfSubject,
  setupNotReady,
  usableByProject,
  type Deps,
  type DomainError,
  type Principal,
  type Project,
  type Result,
  type Session,
  type Subject,
  type Workspace,
  type WorkspaceCoordinatorRegistry
} from '@agent-hub/domain';
import { sessionSchema } from '@agent-hub/contract';
import type { SubjectOf } from './auth.ts';
import { fail } from './http-error.ts';

/**
 * 项目主会话（workspace delegation A 阶段，docs/design/workspace-delegation.md §A）。
 *
 * 这是「人手动在项目的长期工作空间开一条无任务主会话」的**独立**入口，不泛化 `agent.spawn`：
 * - 只接受当前登录的人（cookie 会话）发起；令牌（含 bot 令牌）、系统主体、角色冒充一律拒绝；
 * - 项目来源只认 `deriveSessionUseCase` 落下的不可变 `originProjectId`，不从工作空间反推；
 * - 机器跟着工作空间走，工作空间必须显式指定、长期、已关联到这个项目、当前可用；
 * - 不建任务、不动 `Task.branch`、不派生执行会话——派工记录属于 A1 的 delegation store。
 *
 * ## 身份标记（不新增共享 schema）
 *
 * 主会话身份**只**记在生产登记簿（`WorkspaceCoordinatorRegistry`，实现是 hub 的 SQLite 库）：
 * 项目 + 长期工作空间 → sessionId。不往 `Session` 上加字段、不借 `options` / `title` / `pinned` 当暗号：
 * - 已有无任务会话里有 bot / 群角色 / 连接器开的容器会话，靠字段嗅探一定会误判；
 * - 登记簿里的记录每次使用前还要对会话本身复核（见 `driftOf`），漂移的记录一律报冲突，不自动接管；
 * - 登记一旦存在就不按时间过期：宁可让人看到冲突，也不在另一个请求还可能派生时替换它。
 *
 * 路由刻意放在 `/api/coordinators`，不走 `/api/projects/:id/...`：
 * `installAccess` 对 `/api/projects/:id` 的写请求查 `project.update`，而开主会话要的是
 * `session.create`。本模块自己做授权，不依赖那层前缀预检。
 */
export type CoordinatorRecord = import('@agent-hub/domain').CoordinatorRecord;
export type CoordinatorReservation = import('@agent-hub/domain').CoordinatorReservation;
export type CoordinatorRegistry = WorkspaceCoordinatorRegistry;

/** 只有当前登录的人（cookie 会话，不经任何令牌）能开主会话。 */
export function humanOf(subject: Subject | null): Principal | null {
  const principal = principalOfSubject(subject);
  if (!principal || principal.via) return null;
  return principal;
}

/**
 * 注册表里的会话是否还是「这条工作空间的主会话」。
 * null = 对得上；否则返回漂移原因（当成不存在处理）。bot / 群 / 连接器开的无任务会话在这里被挡掉。
 */
function driftOf(session: Session | null, record: CoordinatorRecord): string | null {
  if (session === null) return '会话不在了';
  if (session.taskId !== null) return '会话已经归到任务上';
  if (session.originProjectId !== record.projectId) return '会话的来源项目对不上';
  if (session.workspaceId !== record.workspaceId) return '会话不在这个工作空间里';
  if ((session.botId ?? null) !== null) return '这条会话是 bot 开的';
  if ((session.groupId ?? null) !== null) return '这条会话属于组合工作空间';
  if ((session.parentSessionId ?? null) !== null) return '这条会话是侧聊';
  return null;
}

export type CoordinatorDeps = Pick<
  Deps,
  | 'agents'
  | 'agentDefaults'
  | 'agentProfiles'
  | 'gateway'
  | 'hosting'
  | 'now'
  | 'projects'
  | 'sessions'
  | 'tasks'
  | 'workLog'
  | 'workspaces'
  | 'workspaceGroups'
  | 'access'
>;

export interface StartCoordinatorCommand {
  readonly projectId: string;
  /** 必须显式点名；服务端不替人挑工作空间。 */
  readonly workspaceId: string;
  /** 必须显式点名 agent；模型可以留空（用 agent 自己的默认）。 */
  readonly agentId: string;
  readonly model?: string;
  readonly profileId?: string;
  readonly options?: Readonly<Record<string, string | boolean>>;
  readonly actor: Subject | null;
}

export interface CoordinatorStarted {
  readonly session: Session;
  readonly record: CoordinatorRecord;
  /** false = 这条工作空间早有主会话，原样复用（没有重复起进程）。 */
  readonly created: boolean;
}

export interface CoordinatorView {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly createdBy: string | null;
  readonly createdAt: number;
}

export function coordinatorView(record: CoordinatorRecord, session: Session): CoordinatorView {
  return {
    projectId: record.projectId,
    workspaceId: record.workspaceId,
    sessionId: session.id,
    createdBy: session.createdBy ?? null,
    createdAt: record.createdAt
  };
}

/**
 * 人对项目 + 工作空间 + 机器的授权确认（开主会话前）：
 * - 人的身份（`humanOf`）先过；
 * - 项目上的 `session.create`；
 * - 工作空间必须是长期、已关联此项目、当前可用；
 * - 机器授权由 `deriveSessionUseCase` 的 `authorizeWorker` 兜底（本机和团队规则都在那里）。
 */
async function readyWorkspaceOf(
  deps: CoordinatorDeps,
  actor: Subject | null,
  project: Project,
  workspaceId: string
): Promise<Result<Workspace, DomainError>> {
  const workspace = await deps.workspaces.byId(asWorkspaceId(workspaceId));
  if (!workspace || !(await usableByProject(deps, workspace, project.id))) return err(notFound('工作空间不存在'));
  if (workspace.kind !== 'long_lived') return err(invalid('主会话只能开在项目的长期工作空间里'));
  if (!isUsable(workspace)) return err(conflict('这个工作空间现在用不了（准备中、失败或已删除）'));
  const blocked = setupNotReady(workspace, project.worktree?.setup?.waitForSetup ?? true);
  if (blocked) return err(conflict(blocked));
  const allowed = await authorizeProject(deps.access, actor, project, 'session.create');
  if (!allowed.ok) return allowed;
  return ok(workspace);
}

async function projectForStart(deps: CoordinatorDeps, actor: Subject | null, projectId: string): Promise<Result<Project, DomainError>> {
  const project = await deps.projects.byId(asProjectId(projectId));
  if (!project || project.deletedAt !== null) return err(notFound('项目不存在'));
  return authorizeProject(deps.access, actor, project, 'session.create');
}

/**
 * 人开 / 取这条项目工作空间的主会话。重复提交（双击、刷新后重试）复用同一条会话：
 * 先原子占位再真正派生；占位记录里预分配的 sessionId 也是崩溃恢复的凭据。
 */
export async function startCoordinatorUseCase(
  deps: CoordinatorDeps,
  registry: CoordinatorRegistry,
  command: StartCoordinatorCommand
): Promise<Result<CoordinatorStarted, DomainError>> {
  const human = humanOf(command.actor);
  if (!human) return err(forbidden('只有登录的人能开项目主会话'));

  const project = await projectForStart(deps, command.actor, command.projectId);
  if (!project.ok) return project;
  const ready = await readyWorkspaceOf(deps, command.actor, project.value, command.workspaceId);
  if (!ready.ok) return ready;
  const workspace = ready.value;

  const reservation = await registry.reserve({
    projectId: project.value.id,
    workspaceId: workspace.id,
    sessionId: newSessionId(),
    createdAt: deps.now()
  });
  const record = reservation.record;
  if (reservation.status === 'exists') {
    const existing = await deps.sessions.byId(asSessionId(record.sessionId));
    if (driftOf(existing, record) === null) return ok({ session: existing as Session, record, created: false });
    // 登记还在，但会话不在了 / 已经不是这条工作空间的主会话：
    // 可能是另一个请求正在启动（预分配了 sessionId 还没落库），也可能是上次崩在半路。
    // 两种都停在这里报冲突，让人自己判断；不按时间过期、不释放、不替换登记。
    return err(conflict(`这条工作空间的主会话登记与当前状态对不上（${driftOf(existing, record)}），先排查再重试`));
  }

  const derived = await deriveSessionUseCase(deps, {
    projectId: project.value.id,
    workspaceId: workspace.id,
    agentId: command.agentId,
    model: command.model ?? '',
    sessionId: record.sessionId,
    createdBy: human.user.id,
    actor: command.actor,
    ...(command.profileId ? { profileId: command.profileId } : {}),
    ...(command.options ? { options: command.options } : {})
  });
  if (!derived.ok) {
    // 会话行可能已经落下（启动进程那一步失败）：保留登记让下次复用，别在建过会话之后再开一条。
    const partial = await deps.sessions.byId(asSessionId(record.sessionId));
    if (partial === null) await registry.release(record);
    return derived;
  }
  return ok({ session: derived.value, record, created: true });
}

/** 读一条主会话；只有能看见这个项目的人才读得到。 */
export async function findCoordinatorUseCase(
  deps: Pick<CoordinatorDeps, 'access' | 'projects' | 'sessions'>,
  registry: CoordinatorRegistry,
  command: { readonly projectId: string; readonly workspaceId: string; readonly actor: Subject | null }
): Promise<Result<{ readonly record: CoordinatorRecord; readonly session: Session }, DomainError>> {
  const project = await deps.projects.byId(asProjectId(command.projectId));
  if (!project || project.deletedAt !== null) return err(notFound('项目不存在'));
  const visible = await authorizeProject(deps.access, command.actor, project, 'session.read');
  if (!visible.ok) return visible;
  const record = await registry.get(command.projectId, command.workspaceId);
  if (!record) return err(notFound('这个项目还没有主会话'));
  const session = await deps.sessions.byId(asSessionId(record.sessionId));
  if (driftOf(session, record) !== null) return err(notFound('这个项目还没有主会话'));
  return ok({ record, session: session as Session });
}

/** 列出一个项目的主会话（按工作空间）；看不见的项目一律 404，漂移的记录不返回。 */
export async function listCoordinatorsUseCase(
  deps: Pick<CoordinatorDeps, 'access' | 'projects' | 'sessions'>,
  registry: CoordinatorRegistry,
  command: { readonly projectId: string; readonly actor: Subject | null }
): Promise<Result<readonly { readonly record: CoordinatorRecord; readonly session: Session }[], DomainError>> {
  const project = await deps.projects.byId(asProjectId(command.projectId));
  if (!project || project.deletedAt !== null) return err(notFound('项目不存在'));
  const visible = await authorizeProject(deps.access, command.actor, project, 'session.read');
  if (!visible.ok) return visible;
  const found: { record: CoordinatorRecord; session: Session }[] = [];
  for (const record of await registry.list(command.projectId)) {
    const session = await deps.sessions.byId(asSessionId(record.sessionId));
    if (driftOf(session, record) !== null) continue;
    found.push({ record, session: session as Session });
  }
  return ok(found);
}

/**
 * 给 Home 用的只读视图：某个项目里所有仍然对得上的主会话。
 * 只返回 `taskId === null` 且通过 `driftOf` 复核的会话——普通无任务容器会话不会混进来。
 */
export async function coordinatorSessionsUseCase(
  deps: Pick<CoordinatorDeps, 'access' | 'projects' | 'sessions'>,
  registry: CoordinatorRegistry,
  command: { readonly projectId: string; readonly actor: Subject | null }
): Promise<Result<readonly Session[], DomainError>> {
  const listed = await listCoordinatorsUseCase(deps, registry, command);
  if (!listed.ok) return listed;
  return ok(listed.value.map((row) => row.session));
}

const startBody = z.object({
  projectId: z.string().min(1).max(80),
  workspaceId: z.string().min(1).max(120),
  agentId: z.string().min(1).max(120),
  model: z.string().max(200).optional(),
  profileId: z.string().min(1).max(120).optional(),
  options: z.record(z.string(), z.union([z.string(), z.boolean()])).optional()
});

export interface CoordinatorRouteDeps {
  readonly deps: CoordinatorDeps;
  readonly coordinators: CoordinatorRegistry;
  readonly onCreated?: (c: import('hono').Context, actor: Principal, session: Session) => Promise<void>;
}

/**
 * HTTP 外壳（安装位置由组合根决定，本模块不改 `http.ts`）：
 * - POST /api/coordinators                       开 / 取主会话（人，201 / 200）
 * - GET  /api/coordinators?projectId=…&workspaceId=…  读一条（缺 workspaceId 时列出项目全部）
 */
export function installCoordinatorRoutes(app: Hono<any>, options: CoordinatorRouteDeps, subjectOf: SubjectOf): void {
  const { deps, coordinators } = options;

  app.post('/api/coordinators', async (c) => {
    const subject = subjectOf(c);
    const actor = humanOf(subject);
    if (!actor) return fail(c, forbidden('只有登录的人能开项目主会话'));
    const parsed = startBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return fail(c, invalid(issue ? `${issue.path.join('.')}: ${issue.message}` : '开主会话的参数不对'));
    }
    const started = await startCoordinatorUseCase(deps, coordinators, { ...parsed.data, actor: subject });
    if (!started.ok) return fail(c, started.error);
    if (started.value.created) await options.onCreated?.(c, actor, started.value.session);
    return c.json(
      {
        coordinator: coordinatorView(started.value.record, started.value.session),
        session: sessionSchema.parse(started.value.session),
        created: started.value.created
      },
      started.value.created ? 201 : 200
    );
  });

  app.get('/api/coordinators', async (c) => {
    const subject = subjectOf(c);
    if (!subject) return fail(c, forbidden('请先登录'));
    const projectId = c.req.query('projectId') ?? '';
    if (projectId === '') return fail(c, invalid('要给 projectId'));
    const workspaceId = c.req.query('workspaceId') ?? '';
    if (workspaceId !== '') {
      const found = await findCoordinatorUseCase(deps, coordinators, { projectId, workspaceId, actor: subject });
      if (!found.ok) return fail(c, found.error);
      return c.json({ coordinator: coordinatorView(found.value.record, found.value.session), session: sessionSchema.parse(found.value.session) });
    }
    const listed = await listCoordinatorsUseCase(deps, coordinators, { projectId, actor: subject });
    if (!listed.ok) return fail(c, listed.error);
    return c.json({
      coordinators: listed.value.map((entry) => coordinatorView(entry.record, entry.session))
    });
  });
}
