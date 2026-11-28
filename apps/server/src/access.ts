import type { Context, Hono } from 'hono';
import type { Deps, Permission, ResourceRef, Subject } from '@agent-hub/domain';
import { asWorkspaceId, authorizeProject, authorizeSession, authorizeWorker, authorizeWorkspace, notFound, projectOfRef } from '@agent-hub/domain';
import type { SubjectOf } from './auth.ts';
import { fail } from './http-error.ts';

type AccessDeps = Pick<Deps, 'projects' | 'tasks' | 'sessions' | 'workspaces' | 'workspaceGroups' | 'access'>;

/**
 * HTTP 这一层的授权（ADR 0011）：只把路由上的 id 映射到资源、交给领域里的 can()，不自己比角色。
 * - 路径里带 projectId / taskId / sessionId / workspaceId 的：所在项目必须看得见，写操作还要有对应权限；
 * - 请求体里点名的项目 / 任务 / 会话（建任务、开会话、分叉）同样查；
 * - 点名机器的（目录浏览、新建文件夹、重新检测）查 worker.use，本机只给集群管理员；
 * - 已有会话上的说话 / 中断 / 换机继续：查会话本身（创建者 / owner·admin / 显式授权，ADR 0017 决定 4A）；
 * - 对已有会话说话 / 改选项 / 换地方继续：会话所在的机器也要过 authorizeWorker（派发前最后一道）。
 * 删除 / 还原 / 彻底删除项目由各自的用例判断（回收站里的项目这里一律 404）。
 */
export function installAccess(app: Hono<any>, deps: AccessDeps, subjectOf: SubjectOf, prefix = '/api'): void {
  const policy = deps.access;
  if (!policy) return;
  // 同一套检查也守开放 API（/openapi/v1，ADR 0015）：只换前缀。
  const esc = prefix.replace(/[/]/g, '\\/');
  const ROUTE = new RegExp(`^${esc}\\/(projects|tasks|sessions|workspaces)\\/([^/]+)`);
  const DISPATCHING = new RegExp(`^${esc}\\/sessions\\/[^/]+\\/(prompt|options|continue)$`);
  const BODY_CHECKED = new Set(['/tasks', '/sessions', '/sessions/derive', '/sessions/fork', '/fs/directories'].map((path) => prefix + path));

  const checkRef = async (c: Context, actor: Subject | null, ref: ResourceRef, permission: Permission): Promise<Response | null> => {
    if (ref.kind === 'workspace') {
      // ADR 0026：长期工作空间可能关联多个项目——任一关联项目允许、或有团队 workspace.manage 就行
      const workspace = await deps.workspaces.byId(asWorkspaceId(ref.id));
      if (!workspace) return null;
      const allowed = await authorizeWorkspace(deps, actor, workspace, permission);
      return allowed.ok ? null : fail(c, allowed.error);
    }
    const { project, session } = await projectOfRef(deps, ref);
    if (!project) {
      // #243：已有会话但来源项目无法证明（容器会话只落在长期工作空间、或组合组已丢失）时必须失败关闭，
      // 不能把「查不到项目」当成「资源不存在」交给路由。真正不存在的资源仍由路由自己报 404。
      if (ref.kind === 'session' && session !== null) return fail(c, notFound('会话不存在'));
      return null; // 不存在的交给路由自己报 404（文案更准）
    }
    const onSession = session !== null && ref.kind === 'session' && SESSION_SCOPED.has(permission);
    const allowed = onSession
      ? await authorizeSession(policy, actor, project, session, permission)
      : await authorizeProject(policy, actor, project, permission);
    if (!allowed.ok) return fail(c, allowed.error);
    if (session && DISPATCHING.test(c.req.path) && c.req.method === 'POST') {
      // bot 令牌也走同一条：worker.use 已放进 BOT_PERMISSIONS，本机仍然只给集群管理员。
      const worker = await authorizeWorker(policy, actor, session.workerId);
      if (!worker.ok) return fail(c, worker.error);
    }
    return null;
  };
  const writePermission = (kind: ResourceRef['kind'], path: string, method: string): Permission => {
    if (kind === 'session') {
      if (path.endsWith('/project-tool-grant')) return 'session.read'; // 路由另验真人、归属人和当前项目权限。
      // 删会话本身：DELETE /sessions/:id；其余动作看路径末尾
      if (method === 'DELETE') return 'session.delete';
      const action = /\/sessions\/[^/]+\/([^/]+)$/.exec(path)?.[1] ?? '';
      if (action === 'interrupt') return 'session.interrupt';
      if (action === 'continue') return 'session.continue';
      if (action === 'settle') return 'session.settle';
      return 'session.prompt';
    }
    if (kind === 'task') return method === 'DELETE' ? 'task.delete' : 'task.update';
    return 'project.update';
  };
  const readPermission = (kind: ResourceRef['kind']): Permission => (kind === 'session' ? 'session.read' : kind === 'task' ? 'task.read' : 'project.read');

  app.use(`${prefix}/*`, async (c, next) => {
    // 没认证的请求守门中间件早拒了；到这里 null 只可能是开放路径（/api/auth/* 等），交给路由自己。
    const actor = subjectOf(c);
    if (actor === null) return next();
    const path = c.req.path;
    const method = c.req.method;
    const read = method === 'GET' || method === 'HEAD';

    // Handoff service checks its own source/target ACLs, including continue and
    // read for reserve; treating reserve as prompt incorrectly rejects callers.
    if (prefix === '/api' && /^\/api\/sessions\/[^/]+\/agent-handoff(?:\/first)?$/.test(path)) return next();

    // Review performs its own source file-access and target prompt/worker checks.
    if (prefix === '/api' && /^\/api\/sessions\/[^/]+\/git\/review(?:\/|$)/.test(path)) return next();

    // These routes authorize the actual task, Worker, source read and, only
    // for remote preparation or setup, the stronger project update permission.
    if (prefix === '/api' && /^\/api\/projects\/[^/]+\/tasks\/[^/]+\/worktree-plans(?:\/[^/]+(?:\/execute)?)?$/.test(path)) return next();
    // Session tabs authorize session.create on the project and exact task in the handler.
    if (prefix === '/api' && method === 'POST' && /^\/api\/projects\/[^/]+\/session-tabs$/.test(path)) return next();

    // 授权撤销只需仍是会话归属人；不能因项目权限变更而留下无法撤销的旧授权。
    if (prefix === '/api' && method === 'DELETE' && /^\/api\/sessions\/[^/]+\/project-tool-grant$/.test(path)) return next();

    // 回收站的几个动作：用例自己判断
    if (new RegExp(`^${esc}\\/projects\\/[^/]+$`).test(path) && method === 'DELETE') return next();
    if (new RegExp(`^${esc}\\/projects\\/[^/]+\\/(restore|purge)$`).test(path)) return next();

    const match = ROUTE.exec(path);
    if (match && !RESERVED.has(match[2] ?? '')) {
      const kind = KIND[match[1] ?? ''];
      if (kind) {
        const denied = await checkRef(c, actor, { kind, id: decodeURIComponent(match[2] ?? '') }, read ? readPermission(kind) : writePermission(kind, path, method));
        if (denied) return denied;
      }
    }

    if (!read && BODY_CHECKED.has(path)) {
      const body = (await c.req.raw.clone().json().catch(() => null)) as Record<string, unknown> | null;
      const text = (key: string): string | null => (body && typeof body[key] === 'string' && body[key] !== '' ? (body[key] as string) : null);
      if (path === `${prefix}/tasks` && text('projectId')) {
        const denied = await checkRef(c, actor, { kind: 'project', id: text('projectId') ?? '' }, 'task.create');
        if (denied) return denied;
      }
      if ((path === `${prefix}/sessions/derive` || path === `${prefix}/sessions`) && text('taskId')) {
        const denied = await checkRef(c, actor, { kind: 'task', id: text('taskId') ?? '' }, 'session.create');
        if (denied) return denied;
      }
      if (path === `${prefix}/sessions/fork` && text('sessionId')) {
        const denied = await checkRef(c, actor, { kind: 'session', id: text('sessionId') ?? '' }, 'session.fork');
        if (denied) return denied;
      }
      if (path === `${prefix}/fs/directories`) {
        const allowed = await authorizeWorker(policy, actor, text('workerId'));
        if (!allowed.ok) return fail(c, allowed.error);
      }
    } else if (read && path === `${prefix}/fs/directories`) {
      const workerId = c.req.query('workerId') ?? '';
      const allowed = await authorizeWorker(policy, actor, workerId === '' ? null : workerId);
      if (!allowed.ok) return fail(c, allowed.error);
    }
    if (path === `${prefix}/search`) {
      const denied = await checkRef(c, actor, { kind: 'project', id: c.req.query('projectId') ?? '' }, 'project.read');
      if (denied) return denied;
    }
    const probe = new RegExp(`^${esc}\\/workers\\/([^/]+)\\/probe$`).exec(path);
    if (probe && method === 'POST') {
      const allowed = await authorizeWorker(policy, actor, decodeURIComponent(probe[1] ?? ''));
      if (!allowed.ok) return fail(c, allowed.error);
    }
    return next();
  });
}

const KIND: Record<string, ResourceRef['kind']> = { projects: 'project', tasks: 'task', sessions: 'session', workspaces: 'workspace' };
/** 这些不是 id。 */
const RESERVED = new Set(['derive', 'fork', 'sweep']);

/** 这些权限按会话本身判断（不是按项目）。分叉会继承 agentSessionRef，所以和 prompt 同口径。 */
const SESSION_SCOPED: ReadonlySet<Permission> = new Set<Permission>([
  'session.prompt',
  'session.interrupt',
  'session.delete',
  'session.continue',
  'session.settle',
  'session.fork'
]);
