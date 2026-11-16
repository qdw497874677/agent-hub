import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import {
  asProjectId,
  asTaskId,
  type ProcessInfo,
  type Project,
  type ServiceDeps,
  type ServiceGateway,
  type ServiceId,
  type SessionService,
  type SessionServiceRepository,
  type Task,
} from '@agent-hub/domain';
import { serviceSchema } from '@agent-hub/contract';
import { installServiceRoutes } from './service-routes.ts';

const project: Project = {
  id: asProjectId('p-1'),
  name: 'demo',
  repo: null,
  repos: [],
  description: null,
  createdAt: 1,
  teamId: null,
  createdBy: null,
  members: [],
  worktree: null,
  checks: [],
  deletedAt: null,
};

const task: Task = {
  id: asTaskId('t-1'),
  projectId: project.id,
  title: 't',
  goal: null,
  status: 'todo',
  ownerId: null,
  branch: null,
  baseBranch: null,
  summary: null,
  logSeq: 0,
  createdAt: 1,
  updatedAt: 1,
};

function repo(): SessionServiceRepository & { readonly rows: Map<ServiceId, SessionService>; readonly saved: SessionService[] } {
  const rows = new Map<ServiceId, SessionService>();
  const saved: SessionService[] = [];
  return {
    rows,
    saved,
    async byId(id) {
      return rows.get(id) ?? null;
    },
    async listByTask(taskId) {
      return [...rows.values()].filter((service) => service.taskId === taskId);
    },
    async listBySession(sessionId) {
      return [...rows.values()].filter((service) => service.sessionId === sessionId);
    },
    async listByWorker(workerId) {
      return [...rows.values()].filter((service) => service.workerId === workerId);
    },
    async save(service) {
      saved.push(service);
      rows.set(service.id, service);
    },
    async remove(id) {
      rows.delete(id);
    },
  };
}

function gatewayOf(starts: unknown[], stops: string[]): ServiceGateway {
  return {
    async start(input) {
      starts.push(input);
      return { ok: true, value: { pid: 4321, port: input.port } };
    },
    async stop(serviceId) {
      stops.push(serviceId);
      return { ok: true, value: { exited: true } };
    },
    async list() {
      return { ok: true, value: [] };
    },
    async logs() {
      return { ok: true, value: { tail: '' } };
    },
  };
}

function appWith() {
  const sessionServices = repo();
  const starts: unknown[] = [];
  const stops: string[] = [];
  const deps = {
    projects: { byId: async (id: string) => (id === project.id ? project : null) },
    tasks: { byId: async (id: string) => (id === task.id ? task : null) },
    sessions: { byId: async () => null },
    workspaces: { byId: async () => null },
    access: undefined,
    now: () => 1_700_000_000_000,
    sessionServices,
    gateway: { services: () => gatewayOf(starts, stops) },
  } as unknown as ServiceDeps;
  const app = new Hono();
  installServiceRoutes(app, { deps }, () => null);
  return { app, sessionServices, starts, stops };
}

test('建服务 201，列表能看到；body 按 serviceSchema 出，命令进到 Worker 网关', async () => {
  const { app, sessionServices, starts } = appWith();
  const created = await app.request('/api/tasks/t-1/services', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command: 'npm run dev', workerId: 'local', root: '/tmp/demo', port: 3000, restart: 'always' }),
  });
  assert.equal(created.status, 201);
  const body = (await created.json()) as { service?: unknown };
  const service = serviceSchema.parse(body.service);
  assert.equal(service.taskId, 't-1');
  assert.equal(service.root, '/tmp/demo');
  assert.equal(service.command, 'npm run dev');
  assert.equal(service.state, 'starting');
  assert.equal(starts.length, 1);
  assert.equal(sessionServices.rows.size, 1);

  const listed = await app.request('/api/tasks/t-1/services');
  assert.equal(listed.status, 200);
  const list = (await listed.json()) as { services?: unknown[] };
  assert.equal(list.services?.length, 1);
  assert.equal(serviceSchema.parse(list.services?.[0]).id, service.id);
});

test('进程清单：按 worker 返回全部，按会话只留 workspace 根之下的，root 前缀相同但不在其内的排除', async () => {
  const processes: ProcessInfo[] = [
    { pid: 10, ppid: 1, cmd: 'npm run dev', cwd: '/tmp/demo', ports: [3000] },
    { pid: 11, ppid: 10, cmd: 'node server.js', cwd: '/tmp/demo/sub', ports: [] },
    { pid: 12, ppid: 1, cmd: 'other', cwd: '/tmp/demo2', ports: [] }
  ];
  const deps = {
    projects: { byId: async (id: string) => (id === project.id ? project : null) },
    tasks: { byId: async (id: string) => (id === task.id ? task : null) },
    sessions: {
      byId: async (id: string) =>
        id === 's-1'
          ? { id: 's-1', taskId: task.id, workspaceId: 'w-1', workerId: 'w1', createdAt: 1, updatedAt: 1 }
          : null,
    },
    workspaces: {
      byId: async (id: string) =>
        id === 'w-1' ? { id: 'w-1', workerId: 'w1', path: '/tmp/demo', state: 'ready' } : null,
    },
    access: undefined,
    now: () => 1_700_000_000_000,
    sessionServices: repo(),
    gateway: {
      services: () => gatewayOf([], []),
      processes: async (workerId: string) =>
        workerId === 'w1' ? { ok: true as const, value: processes } : { ok: false as const, error: { code: 'not_found', message: 'x' } },
    },
  } as unknown as ServiceDeps;
  const app = new Hono();
  installServiceRoutes(app, { deps }, () => null);

  const byWorker = await app.request('/api/workers/w1/processes');
  assert.equal(byWorker.status, 200);
  const workerBody = (await byWorker.json()) as { processes?: ProcessInfo[] };
  assert.deepEqual(workerBody.processes?.map((process) => process.pid), [10, 11, 12]);

  const bySession = await app.request('/api/sessions/s-1/processes');
  assert.equal(bySession.status, 200);
  const sessionBody = (await bySession.json()) as { processes?: ProcessInfo[] };
  assert.deepEqual(sessionBody.processes?.map((process) => process.pid), [10, 11]);

  // 没有 workspace 的会话：空数组，不是错误
  const orphan = {
    ...deps,
    sessions: { byId: async () => ({ id: 's-2', taskId: task.id, workspaceId: null, workerId: 'w1' }) },
  } as unknown as ServiceDeps;
  const orphanApp = new Hono();
  installServiceRoutes(orphanApp, { deps: orphan }, () => null);
  const empty = await orphanApp.request('/api/sessions/s-2/processes');
  assert.equal(empty.status, 200);
  assert.deepEqual(((await empty.json()) as { processes?: ProcessInfo[] }).processes, []);
});

test('请求体不合法 400；任务 / 服务不存在 404', async () => {
  const { app, starts } = appWith();
  const bad = await app.request('/api/tasks/t-1/services', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command: '' }),
  });
  assert.equal(bad.status, 400);
  const error = (await bad.json()) as { error?: { code?: string } };
  assert.equal(error.error?.code, 'invalid');
  assert.equal(starts.length, 0);

  const unknownTask = await app.request('/api/tasks/t-missing/services');
  assert.equal(unknownTask.status, 404);
  assert.equal(((await unknownTask.json()) as { error?: { code?: string } }).error?.code, 'not_found');

  const unknownService = await app.request('/api/services/svc_ffffffff/logs');
  assert.equal(unknownService.status, 404);
  assert.equal(((await unknownService.json()) as { error?: { code?: string } }).error?.code, 'not_found');

  const removeUnknown = await app.request('/api/services/svc_ffffffff', { method: 'DELETE' });
  assert.equal(removeUnknown.status, 404);
});
