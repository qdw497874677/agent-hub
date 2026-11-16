import type { Context, Hono } from 'hono';
import { createServiceRequest, serviceSchema } from '@agent-hub/contract';
import {
  asSessionId,
  asWorkspaceId,
  authorizeSession,
  createServiceUseCase,
  listServicesUseCase,
  notFound,
  projectOfRef,
  readServiceLogsUseCase,
  removeServiceUseCase,
  servicePublic,
  stopServiceUseCase,
  unavailable,
  workerReader,
  type ServiceDeps,
  type Subject,
} from '@agent-hub/domain';
import type { SubjectOf } from './auth.ts';
import { fail } from './http-error.ts';

/** 会话服务的审计动作（`AuditAction` 里已有同名成员，这里只收窄本文件用到的两项）。 */
export type ServiceAuditAction = 'service.start' | 'service.stop';

export interface ServiceApiOptions {
  /**
   * 数据面依赖：`projects`、`tasks`、`sessions`、`workspaces`、`access`、`now`、
   * `sessionServices`（`store.sessionServices`）和 `gateway`。
   */
  readonly deps: ServiceDeps;
}

export interface ServiceRouteOptions extends ServiceApiOptions {
  readonly audit?: (
    c: Context,
    subject: Subject | null,
    action: ServiceAuditAction,
    target: string,
    detail: string,
  ) => Promise<void>;
}

/** 审计里记录的命令摘要：命令可能很长，只留第一行前 200 个字符。 */
function commandDigest(command: string): string {
  const firstLine = command.split('\n')[0] ?? '';
  return firstLine.length <= 200 ? firstLine : `${firstLine.slice(0, 200)}…`;
}

/**
 * 会话服务的 HTTP 面（docs/design/session-service.md §4）：
 *
 * - `POST   /api/tasks/:taskId/services`        → 201 `{ service }`（body `createServiceRequest`）
 * - `GET    /api/tasks/:taskId/services`        → `{ services: ServiceDto[] }`
 * - `GET    /api/sessions/:sessionId/services`  → `{ services: ServiceDto[] }`
 * - `POST   /api/services/:serviceId/stop`      → `{ service }`
 * - `DELETE /api/services/:serviceId`           → `{ ok: true }`
 * - `GET    /api/services/:serviceId/logs`      → `{ tail }`
 *
 * 权限在用例里：建 / 停有会话走 `session.prompt`，否则走 `project.update`；
 * 列表走 `session.read` / `project.read`。不在权限范围内一律 404 / 403。
 */
export function installServiceRoutes(app: Hono<any>, options: ServiceRouteOptions, subjectOf: SubjectOf): void {
  const deps = options.deps;
  const dtoOf = (service: Parameters<typeof servicePublic>[0]) => serviceSchema.parse(servicePublic(service));
  /** 列表里跳过坏行：一条不合约的数据不该让整个服务列表 500。 */
  const dtosOf = (services: readonly Parameters<typeof servicePublic>[0][]) => {
    const out: ReturnType<typeof dtoOf>[] = [];
    for (const service of services) {
      const parsed = serviceSchema.safeParse(servicePublic(service));
      if (parsed.success) out.push(parsed.data);
      else console.warn('[service] 跳过一条不合契约的记录', service.id, parsed.error.issues[0]?.message);
    }
    return out;
  };

  app.post('/api/tasks/:taskId/services', async (c) => {
    const subject = subjectOf(c);
    const parsed = createServiceRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, { code: 'invalid', message: '请求体不合法' });
    const taskId = c.req.param('taskId');
    const result = await createServiceUseCase(deps, subject, {
      taskId,
      ...(parsed.data.sessionId === undefined || parsed.data.sessionId === null ? {} : { sessionId: parsed.data.sessionId }),
      ...(parsed.data.workspaceId === undefined || parsed.data.workspaceId === null ? {} : { workspaceId: parsed.data.workspaceId }),
      ...(parsed.data.workerId === undefined || parsed.data.workerId === null ? {} : { workerId: parsed.data.workerId }),
      ...(parsed.data.root === undefined || parsed.data.root === null ? {} : { root: parsed.data.root }),
      command: parsed.data.command,
      ...(parsed.data.port === undefined ? {} : { port: parsed.data.port }),
      ...(parsed.data.env === undefined ? {} : { env: parsed.data.env }),
      ...(parsed.data.restart === undefined ? {} : { restart: parsed.data.restart }),
    });
    if (!result.ok) return fail(c, result.error);
    await options.audit?.(c, subject, 'service.start', result.value.id, `在 ${result.value.workerId} 起服务：${commandDigest(result.value.command)}${result.value.port === null ? '' : `（端口 ${result.value.port}）`}`);
    return c.json({ service: dtoOf(result.value) }, 201);
  });

  app.get('/api/tasks/:taskId/services', async (c) => {
    const result = await listServicesUseCase(deps, subjectOf(c), { kind: 'task', taskId: c.req.param('taskId') });
    return result.ok ? c.json({ services: dtosOf(result.value) }) : fail(c, result.error);
  });

  app.get('/api/sessions/:sessionId/services', async (c) => {
    const result = await listServicesUseCase(deps, subjectOf(c), { kind: 'session', sessionId: c.req.param('sessionId') });
    return result.ok ? c.json({ services: dtosOf(result.value) }) : fail(c, result.error);
  });

  /** 一台 Worker 上消过毒的进程清单（只读）：和机器列表一样用 worker.read 过滤，看不见就 404。 */
  app.get('/api/workers/:workerId/processes', async (c) => {
    const workerId = c.req.param('workerId');
    const readable = await workerReader(deps.access, subjectOf(c));
    if (!(await readable(workerId))) return fail(c, notFound('没有这台机器'));
    if (!deps.gateway.processes) return fail(c, unavailable('这台 Worker 不支持进程清单'));
    const result = await deps.gateway.processes(workerId);
    return result.ok ? c.json({ processes: result.value }, 200, { 'cache-control': 'no-store' }) : fail(c, result.error);
  });

  /**
   * 会话视角：只报这个会话工作空间根之下的进程。
   * 拿不到工作空间（老会话 / 已删除）就回空数组，不让查看进程这件事本身变成错误。
   */
  app.get('/api/sessions/:sessionId/processes', async (c) => {
    const sessionId = c.req.param('sessionId');
    const session = await deps.sessions.byId(asSessionId(sessionId));
    if (!session) return fail(c, notFound('会话不存在'));
    const { project } = await projectOfRef(deps, { kind: 'session', id: sessionId });
    const allowed = await authorizeSession(deps.access, subjectOf(c), project, session, 'session.read');
    if (!allowed.ok) return fail(c, allowed.error);
    const workspace = session.workspaceId === null ? null : await deps.workspaces.byId(asWorkspaceId(session.workspaceId));
    const workerId = workspace === null ? null : workspace.workerId ?? session.workerId;
    if (workspace === null || workerId === null) return c.json({ processes: [] }, 200, { 'cache-control': 'no-store' });
    if (!deps.gateway.processes) return fail(c, unavailable('这台 Worker 不支持进程清单'));
    const result = await deps.gateway.processes(workerId);
    if (!result.ok) return fail(c, result.error);
    const root = workspace.path.endsWith('/') ? workspace.path : `${workspace.path}/`;
    return c.json(
      { processes: result.value.filter((process) => process.cwd === workspace.path || process.cwd.startsWith(root)) },
      200,
      { 'cache-control': 'no-store' },
    );
  });

  app.post('/api/services/:serviceId/stop', async (c) => {
    const subject = subjectOf(c);
    const result = await stopServiceUseCase(deps, subject, c.req.param('serviceId'));
    if (!result.ok) return fail(c, result.error);
    await options.audit?.(c, subject, 'service.stop', result.value.id, `停服务：${commandDigest(result.value.command)}`);
    return c.json({ service: dtoOf(result.value) });
  });

  app.delete('/api/services/:serviceId', async (c) => {
    const subject = subjectOf(c);
    const serviceId = c.req.param('serviceId');
    const result = await removeServiceUseCase(deps, subject, serviceId);
    if (!result.ok) return fail(c, result.error);
    await options.audit?.(c, subject, 'service.stop', serviceId, '删掉服务记录（在跑的先停）');
    return c.json({ ok: true });
  });

  app.get('/api/services/:serviceId/logs', async (c) => {
    const raw = c.req.query('maxBytes');
    const maxBytes = raw === undefined ? undefined : Number(raw);
    const result = await readServiceLogsUseCase(
      deps,
      subjectOf(c),
      c.req.param('serviceId'),
      Number.isInteger(maxBytes) && (maxBytes as number) > 0 ? (maxBytes as number) : undefined,
    );
    return result.ok ? c.json({ tail: result.value }) : fail(c, result.error);
  });
}
