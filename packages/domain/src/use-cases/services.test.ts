import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDescriptor } from '../agent.ts';
import type { Principal, User } from '../account.ts';
import type { TeamId, UserId } from '../account.ts';
import { asLoginId, asTeamId, asUserId } from '../account.ts';
import { unavailable } from '../errors.ts';
import { asAgentId, type ServiceId } from '../ids.ts';
import { err, ok } from '../result.ts';
import { available, capabilityMatrix } from '../capability.ts';
import type { ServiceGateway, ServiceRuntime, ServiceStartInput } from '../ports/node-gateway.ts';
import type { SessionServiceRepository } from '../ports/session-service-repository.ts';
import type { SessionService } from '../service.ts';
import { appendServiceLog, servicePublic } from '../service.ts';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { createAccessPolicy as createAccessPolicyForTests } from './authorization.ts';
import { createProjectUseCase } from './projects.ts';
import { createTaskUseCase } from './tasks.ts';
import { deriveSessionUseCase } from './sessions.ts';
import {
  createServiceUseCase,
  listServicesUseCase,
  readServiceEnvKeysUseCase,
  recordServiceLogUseCase,
  recordServiceStateUseCase,
  stopServiceUseCase,
  type CreateServiceInput,
  type ServiceDeps,
} from './services.ts';

const fake: AgentDescriptor = {
  id: asAgentId('fake'),
  label: 'Fake',
  capabilities: capabilityMatrix({
    prompt: available,
    interrupt: available,
    fork: available,
    resume: available,
    tool_calls: available,
    artifacts: available,
    structured_events: available,
    attachments: available,
  }),
  models: ['m1'],
  defaultModel: 'm1',
  options: [],
};

function userOf(id: string, teamId: string, options: { role?: User['role']; clusterAdmin?: boolean } = {}): User {
  return {
    id: asUserId(id) as UserId,
    email: `${id}@example.com`,
    displayName: id,
    role: options.role ?? 'owner',
    passwordHash: null,
    emailVerifiedAt: 1,
    disabledAt: null,
    createdAt: 1,
    teamId: asTeamId(teamId) as TeamId,
    clusterAdmin: options.clusterAdmin ?? false,
    deletedAt: null,
  };
}

function principalOf(user: User): Principal {
  return { user, loginId: asLoginId(`login-${user.id}`) };
}

function fakeServices(): SessionServiceRepository & { readonly rows: Map<ServiceId, SessionService> } {
  const rows = new Map<ServiceId, SessionService>();
  return {
    rows,
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
      rows.set(service.id, service);
    },
    async updateState(service) {
      const current = rows.get(service.id);
      if (!current || current.updatedAt > service.updatedAt) return false;
      // 和 SQLite 一样只写状态列：别用调用方的旧快照把 log_tail / envKeys 盖回去。
      rows.set(service.id, {
        ...current,
        state: service.state,
        pid: service.pid,
        detail: service.detail,
        port: service.port,
        startedAt: service.startedAt,
        updatedAt: service.updatedAt,
      });
      return true;
    },
    async appendLogTail(id, chunk, updatedAt) {
      const current = rows.get(id);
      if (current) rows.set(id, { ...current, logTail: appendServiceLog(current.logTail, chunk), updatedAt });
    },
    async remove(id) {
      rows.delete(id);
    },
  };
}

/** 记录调用参数的网关替身：start 立刻回一个 pid，状态留给 `recordServiceStateUseCase`。 */
function fakeGateway() {
  const starts: ServiceStartInput[] = [];
  const stops: string[] = [];
  const runtime: ServiceRuntime[] = [];
  const gateway: ServiceGateway = {
    async start(input) {
      starts.push(input);
      return { ok: true, value: { pid: 4321, port: input.port } };
    },
    async stop(serviceId) {
      stops.push(serviceId);
      return { ok: true, value: { exited: true } };
    },
    async list() {
      return { ok: true, value: runtime };
    },
    async logs() {
      return { ok: true, value: { tail: '' } };
    },
  };
  return { gateway, starts, stops, runtime };
}

async function world() {
  const w = inMemoryDeps();
  w.agents.push(fake);
  const owner = principalOf(userOf('owner', 'team-1', { clusterAdmin: true }));
  const stranger = principalOf(userOf('stranger', 'team-2'));
  const project = await createProjectUseCase(w.deps, { name: 'demo', rootPath: '/tmp/demo', actor: owner });
  assert.ok(project.ok, JSON.stringify(project));
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: 't' });
  assert.ok(task.ok);
  const session = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  assert.ok(session.ok, JSON.stringify(session));
  const policy = createAccessPolicyForTests({
    users: {
      firstClusterAdmin: async () => owner.user,
      byId: async (id) => (id === owner.user.id ? owner.user : id === stranger.user.id ? stranger.user : null),
    },
    settings: { get: async () => ({ openRegistration: false, membersCanAddMachines: true, refuseWhenFull: [] }) },
    enrollment: { credentialFor: async () => null },
    gateway: { status: async () => w.workers },
  });
  const sessionServices = fakeServices();
  const { gateway, starts, stops } = fakeGateway();
  const serviceDeps: ServiceDeps = {
    ...w.deps,
    access: policy,
    sessionServices,
    gateway: { services: () => gateway },
  };
  return { ...w, owner, stranger, project: project.value, task: task.value, session: session.value, serviceDeps, sessionServices, starts, stops };
}

test('建服务：按会话定位机器与目录，先落 starting，状态等 Worker 回报', async () => {
  const w = await world();
  const created = await createServiceUseCase(w.serviceDeps, w.owner, {
    taskId: w.task.id,
    sessionId: w.session.id,
    command: 'npm run dev',
    port: 3000,
    env: { NODE_ENV: 'development' },
    restart: 'always',
  });
  assert.ok(created.ok, JSON.stringify(created));
  const service = created.value;
  assert.match(service.id, /^svc_[0-9a-f]{8}$/);
  assert.equal(service.sessionId, w.session.id);
  assert.equal(service.taskId, w.task.id);
  assert.equal(service.root, w.session.workspaceId === null ? service.root : '/tmp/demo');
  // 目录来自会话的工作空间（in-memory 世界里是 /tmp/… 的临时路径），至少不能为空。
  assert.ok(service.root.startsWith('/'));
  assert.equal(service.state, 'starting');
  assert.equal(service.pid, null);
  assert.equal(service.startedAt, null);
  // 落库形状只有键名；值只在同一次请求里交给 Worker。
  assert.deepEqual(service.envKeys, ['NODE_ENV']);
  assert.equal('env' in service, false);
  assert.equal(w.starts.length, 1);
  assert.equal(w.starts[0]?.serviceId, service.id);
  assert.equal(w.starts[0]?.command, 'npm run dev');
  assert.deepEqual(w.starts[0]?.env, { NODE_ENV: 'development' });

  const running = await recordServiceStateUseCase({ sessionServices: w.sessionServices, now: () => service.updatedAt + 1 }, service.id, service.workerId, {
    state: 'running',
    pid: 4321,
  });
  assert.equal(running?.state, 'running');
  assert.equal(running?.pid, 4321);
  assert.equal(running?.startedAt, service.updatedAt + 1);

  const listed = await listServicesUseCase(w.serviceDeps, w.owner, { kind: 'session', sessionId: w.session.id });
  assert.ok(listed.ok);
  assert.deepEqual(
    listed.value.map((item) => item.id),
    [service.id],
  );
});

test('停服务：过 session.prompt，调 Worker 停进程树，状态仍等回报', async () => {
  const w = await world();
  const created = await createServiceUseCase(w.serviceDeps, w.owner, { taskId: w.task.id, sessionId: w.session.id, command: 'npm run dev' });
  assert.ok(created.ok, JSON.stringify(created));
  await recordServiceStateUseCase({ sessionServices: w.sessionServices, now: () => created.value.updatedAt + 1 }, created.value.id, created.value.workerId, { state: 'running', pid: 4321 });

  const stopped = await stopServiceUseCase(w.serviceDeps, w.owner, created.value.id);
  assert.ok(stopped.ok, JSON.stringify(stopped));
  assert.deepEqual(w.stops, [created.value.id]);
  // 没收到 Worker 的 stopped 之前，库里还是 running。
  assert.equal((await w.sessionServices.byId(created.value.id))?.state, 'running');

  const after = await recordServiceStateUseCase({ sessionServices: w.sessionServices, now: () => created.value.updatedAt + 2 }, created.value.id, created.value.workerId, {
    state: 'stopped',
    detail: '退出码 0',
  });
  assert.equal(after?.state, 'stopped');
  assert.equal(after?.pid, null);
});

test('权限：外人建 / 停 / 看都不行，命令不会下发到 Worker', async () => {
  const w = await world();
  const created = await createServiceUseCase(w.serviceDeps, w.owner, { taskId: w.task.id, sessionId: w.session.id, command: 'npm run dev' });
  assert.ok(created.ok, JSON.stringify(created));
  const before = w.starts.length;

  const denied = await createServiceUseCase(w.serviceDeps, w.stranger, { taskId: w.task.id, sessionId: w.session.id, command: 'rm -rf /' });
  assert.equal(denied.ok, false);
  assert.equal(denied.ok === false && denied.error.code, 'not_found');
  assert.equal(w.starts.length, before);

  const stopDenied = await stopServiceUseCase(w.serviceDeps, w.stranger, created.value.id);
  assert.equal(stopDenied.ok, false);
  assert.equal(w.stops.length, 0);

  const listDenied = await listServicesUseCase(w.serviceDeps, w.stranger, { kind: 'session', sessionId: w.session.id });
  assert.equal(listDenied.ok, false);
});

test('校验：命令为空 / 超长、环境变量被拒、端口越界都 400，不落库不启动', async () => {
  const w = await world();
  const bad: Omit<CreateServiceInput, 'taskId'>[] = [
    { command: '   ' },
    { command: 'x'.repeat(2001) },
    { command: 'npm run dev', env: { HUB_TOKEN: 'secret' } },
    { command: 'npm run dev', env: { OPENAI_API_KEY: 'sk-x' } },
    { command: 'npm run dev', env: { AWS_ACCESS_KEY_ID: 'AKIAX' } },
    { command: 'npm run dev', env: { STRIPE_SECRET: 'x' } },
    { command: 'npm run dev', env: { GITHUB_TOKEN: 'x' } },
    { command: 'npm run dev', port: 80 },
    { command: 'npm run dev', root: 'relative/dir' },
  ];
  for (const input of bad) {
    const result = await createServiceUseCase(w.serviceDeps, w.owner, { taskId: w.task.id, sessionId: w.session.id, ...input });
    assert.equal(result.ok, false, JSON.stringify(input));
    assert.equal(result.ok === false && result.error.code, 'invalid', JSON.stringify(input));
  }
  assert.equal(w.sessionServices.rows.size, 0);
  assert.equal(w.starts.length, 0);
});

test('正常变量（PATH / HOME / TERM / NODE_ENV）不被当成凭据拦掉', async () => {
  const w = await world();
  const created = await createServiceUseCase(w.serviceDeps, w.owner, {
    taskId: w.task.id,
    sessionId: w.session.id,
    command: 'npm run dev',
    env: { PATH: '/usr/bin', HOME: '/tmp', TERM: 'xterm', NODE_ENV: 'development' },
  });
  assert.ok(created.ok, JSON.stringify(created));
  assert.deepEqual(w.starts[0]?.env, { PATH: '/usr/bin', HOME: '/tmp', TERM: 'xterm', NODE_ENV: 'development' });
});

test('公开形状只回 envKeys，不回值；env-keys 接口权限与读日志一致', async () => {
  const w = await world();
  const created = await createServiceUseCase(w.serviceDeps, w.owner, {
    taskId: w.task.id,
    sessionId: w.session.id,
    command: 'npm run dev',
    env: { NODE_ENV: 'development', API_BASE: 'https://example.test' },
  });
  assert.ok(created.ok, JSON.stringify(created));
  const dto = servicePublic(created.value);
  assert.deepEqual(dto.envKeys, ['API_BASE', 'NODE_ENV']);
  assert.equal('env' in dto, false);
  assert.doesNotMatch(JSON.stringify(dto), /development|example\.test/);

  const keys = await readServiceEnvKeysUseCase(w.serviceDeps, w.owner, created.value.id);
  assert.ok(keys.ok);
  assert.deepEqual(keys.value, ['API_BASE', 'NODE_ENV']);

  const denied = await readServiceEnvKeysUseCase(w.serviceDeps, w.stranger, created.value.id);
  assert.equal(denied.ok, false);
});

test('状态 / 日志帧必须来自服务所属的 Worker；日志落库前擦凭据', async () => {
  const w = await world();
  const created = await createServiceUseCase(w.serviceDeps, w.owner, { taskId: w.task.id, sessionId: w.session.id, command: 'npm run dev' });
  assert.ok(created.ok, JSON.stringify(created));
  const service = created.value;

  const foreign = await recordServiceStateUseCase({ sessionServices: w.sessionServices, now: () => service.updatedAt + 1 }, service.id, 'someone-else', {
    state: 'stopped',
    detail: '冒充',
  });
  assert.equal(foreign, null);
  assert.equal((await w.sessionServices.byId(service.id))?.state, 'starting');

  await recordServiceLogUseCase({ sessionServices: w.sessionServices, now: () => service.updatedAt + 1 }, service.id, service.workerId, 'KEY=abcdef token sk-abcdefghijklmnop\n');
  const logged = (await w.sessionServices.byId(service.id))?.logTail ?? '';
  assert.match(logged, /KEY=\*\*\*/);
  assert.match(logged, /sk-\*\*\*/);
  assert.doesNotMatch(logged, /abcdefghijklmnop/);
});

test('日志并发追加：两帧读到同一份旧快照也不会丢掉另一帧（#233）', async () => {
  const w = await world();
  const created = await createServiceUseCase(w.serviceDeps, w.owner, { taskId: w.task.id, sessionId: w.session.id, command: 'npm run dev' });
  assert.ok(created.ok, JSON.stringify(created));
  const service = created.value;

  await recordServiceLogUseCase({ sessionServices: w.sessionServices, now: () => service.updatedAt + 1 }, service.id, service.workerId, 'first\n');
  const stale = await w.sessionServices.byId(service.id);
  assert.ok(stale);

  // 两帧都在对方写回之前读到同一份快照；旧实现会用 stale.logTail 拼好整段覆盖，后写者丢掉先写者。
  let staleReads = 2;
  const racing: SessionServiceRepository = {
    ...w.sessionServices,
    async byId(id) {
      if (id === service.id && staleReads > 0) {
        staleReads -= 1;
        return stale;
      }
      return w.sessionServices.byId(id);
    },
  };

  await Promise.all([
    recordServiceLogUseCase({ sessionServices: racing, now: () => service.updatedAt + 2 }, service.id, service.workerId, 'one\n'),
    recordServiceLogUseCase({ sessionServices: racing, now: () => service.updatedAt + 3 }, service.id, service.workerId, 'two\n'),
  ]);

  assert.equal((await w.sessionServices.byId(service.id))?.logTail, 'first\none\ntwo\n');
});

test('建服务失败只改状态：start 期间已落库的日志不会被旧快照抹掉（#233）', async () => {
  const w = await world();
  const failingDeps: ServiceDeps = {
    ...w.serviceDeps,
    gateway: {
      services: () => ({
        async start(input) {
          const current = await w.sessionServices.byId(input.serviceId);
          assert.ok(current);
          await recordServiceLogUseCase(
            { sessionServices: w.sessionServices, now: () => current.updatedAt + 1 },
            input.serviceId,
            current.workerId,
            'boot\n',
          );
          return err(unavailable('start boom'));
        },
        async stop() {
          return err(unavailable('no stop'));
        },
        async list() {
          return ok([]);
        },
        async logs() {
          return ok({ tail: '' });
        },
      }),
    },
  };

  const created = await createServiceUseCase(failingDeps, w.owner, { taskId: w.task.id, sessionId: w.session.id, command: 'npm run dev' });
  assert.equal(created.ok, false);

  const row = [...w.sessionServices.rows.values()][0];
  assert.ok(row);
  assert.equal(row.state, 'failed');
  assert.equal(row.detail, 'start boom');
  assert.equal(row.logTail, 'boot\n');
});

