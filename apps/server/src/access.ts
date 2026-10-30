import type { Context, Hono } from 'hono';
import type { Deps, Permission, Principal, ResourceRef } from '@agent-hub/domain';
import { authorizeProject, authorizeWorker, projectOfRef } from '@agent-hub/domain';
import type { PrincipalOf } from './auth.ts';
import { fail } from './http-error.ts';

type AccessDeps = Pick<Deps, 'projects' | 'tasks' | 'sessions' | 'workspaces' | 'access'>;

/**
 * HTTP 这一层的授权（ADR 0011）：只把路由上的 id 映射到资源、交给领域里的 can()，不自己比角色。
 * - 路径里带 projectId / taskId / sessionId / workspaceId 的：所在项目必须看得见，写操作还要有对应权限；
 * - 请求体里点名的项目 / 任务 / 会话（建任务、开会话、分叉）同样查；
 * - 点名机器的（目录浏览、新建文件夹、重新检测）查 worker.use，本机查 worker.use_local；
 * - 对已有会话说话 / 改选项 / 换地方继续：会话所在的机器也要过 authorizeWorker（派发前最后一道）。
 * 删除 / 还原 / 彻底删除项目由各自的用例判断（回收站里的项目这里一律 404）。
 */
export function installAccess(app: Hono, deps: AccessDeps, principalOf: PrincipalOf): void {
  const policy = deps.access;
  if (!policy) return;

  const checkRef = async (c: Context, actor: Principal | null, ref: ResourceRef, permission: Permission): Promise<Response | null> => {
    const { project, session } = await projectOfRef(deps, ref);
    if (!project) return null; // 不存在的交给路由自己报 404（文案更准）
    const allowed = await authorizeProject(policy, actor, project, permission);
    if (!allowed.ok) return fail(c, allowed.error);
    if (session && DISPATCHING.test(c.req.path) && c.req.method === 'POST') {
      const worker = await authorizeWorker(policy, actor, session.workerId);
      if (!worker.ok) return fail(c, worker.error);
    }
    return null;
  };
  const writePermission = (kind: ResourceRef['kind']): Permission =>
    kind === 'project' ? 'project.update' : kind === 'session' ? 'session.control' : kind === 'workspace' ? 'project.update' : 'task.write';
  const readPermission = (kind: ResourceRef['kind']): Permission => (kind === 'session' ? 'session.read' : kind === 'task' ? 'task.read' : 'project.read');

  app.use('/api/*', async (c, next) => {
    const actor = principalOf(c);
    if (actor === null) return next();
    const path = c.req.path;
    const method = c.req.method;
    const read = method === 'GET' || method === 'HEAD';

    // 回收站的几个动作：用例自己判断
    if (/^\/api\/projects\/[^/]+$/.test(path) && method === 'DELETE') return next();
    if (/^\/api\/projects\/[^/]+\/(restore|purge)$/.test(path)) return next();

    const match = ROUTE.exec(path);
    if (match && !RESERVED.has(match[2] ?? '')) {
      const kind = KIND[match[1] ?? ''];
      if (kind) {
        const denied = await checkRef(c, actor, { kind, id: decodeURIComponent(match[2] ?? '') }, read ? readPermission(kind) : writePermission(kind));
        if (denied) return denied;
      }
    }

    if (!read && BODY_CHECKED.has(path)) {
      const body = (await c.req.raw.clone().json().catch(() => null)) as Record<string, unknown> | null;
      const text = (key: string): string | null => (body && typeof body[key] === 'string' && body[key] !== '' ? (body[key] as string) : null);
      if (path === '/api/tasks' && text('projectId')) {
        const denied = await checkRef(c, actor, { kind: 'project', id: text('projectId') ?? '' }, 'task.write');
        if (denied) return denied;
      }
      if (path === '/api/sessions/derive' && text('taskId')) {
        const denied = await checkRef(c, actor, { kind: 'task', id: text('taskId') ?? '' }, 'session.create');
        if (denied) return denied;
      }
      if (path === '/api/sessions/fork' && text('sessionId')) {
        const denied = await checkRef(c, actor, { kind: 'session', id: text('sessionId') ?? '' }, 'session.create');
        if (denied) return denied;
      }
      if (path === '/api/fs/directories') {
        const allowed = await authorizeWorker(policy, actor, text('workerId'));
        if (!allowed.ok) return fail(c, allowed.error);
      }
    } else if (read && path === '/api/fs/directories') {
      const workerId = c.req.query('workerId') ?? '';
      const allowed = await authorizeWorker(policy, actor, workerId === '' ? null : workerId);
      if (!allowed.ok) return fail(c, allowed.error);
    }
    if (path === '/api/search') {
      const denied = await checkRef(c, actor, { kind: 'project', id: c.req.query('projectId') ?? '' }, 'project.read');
      if (denied) return denied;
    }
    const probe = /^\/api\/workers\/([^/]+)\/probe$/.exec(path);
    if (probe && method === 'POST') {
      const allowed = await authorizeWorker(policy, actor, decodeURIComponent(probe[1] ?? ''));
      if (!allowed.ok) return fail(c, allowed.error);
    }
    return next();
  });
}

const ROUTE = /^\/api\/(projects|tasks|sessions|workspaces)\/([^/]+)/;
const KIND: Record<string, ResourceRef['kind']> = { projects: 'project', tasks: 'task', sessions: 'session', workspaces: 'workspace' };
/** 这些不是 id。 */
const RESERVED = new Set(['derive', 'fork', 'sweep']);
/** 会把活派到会话所在机器上的动作。 */
const DISPATCHING = /^\/api\/sessions\/[^/]+\/(prompt|options|continue)$/;
/** 要看请求体里点名了谁的几条路由（别的请求不多解析一遍 body，比如带附件的 prompt）。 */
const BODY_CHECKED = new Set(['/api/tasks', '/api/sessions/derive', '/api/sessions/fork', '/api/fs/directories']);
