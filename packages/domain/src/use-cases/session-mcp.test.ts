import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { createProject } from '../project.ts';
import { createTask } from '../task.ts';
import { deriveSession, MCP_DISABLED_MAX, normalizeMcpDisabled } from '../session.ts';
import { asAgentId, asSessionId } from '../ids.ts';
import type { Principal } from '../account.ts';
import type { AccessPolicy } from './authorization.ts';
import { setSessionMcpDisabledUseCase } from './sessions.ts';

const policy: AccessPolicy = {
  context: async () => ({ hubTeamId: 't1', settings: { membersCanAddMachines: true } }),
  worker: async (workerId) => ({ kind: 'worker', id: workerId ?? 'local', teamId: 't1', createdBy: null })
};

function principal(id: string, role: 'owner' | 'admin' | 'member' | 'viewer'): Principal {
  return {
    user: { id, email: `${id}@b.co`, role, disabledAt: null, deletedAt: null, teamId: 't1', clusterAdmin: false },
    loginId: `l-${id}`
  } as unknown as Principal;
}

async function world(options: { createdBy?: string } = {}) {
  const world = inMemoryDeps({ access: policy });
  const project = createProject({ name: 'demo', now: 1, teamId: 't1', createdBy: 'u1' });
  assert.ok(project.ok);
  const task = createTask({ projectId: project.value.id, title: 't', goal: '', now: 1 });
  assert.ok(task.ok);
  const session = deriveSession({ task: task.value, agentId: asAgentId('pi'), model: 'm', now: 1, createdBy: options.createdBy ?? 'u1' });
  assert.ok(session.ok);
  await world.deps.projects.save(project.value);
  await world.deps.tasks.save(task.value);
  await world.deps.sessions.save(session.value);
  return { ...world, project: project.value, task: task.value, session: session.value };
}

test('按会话关 MCP：落库、返回新清单，并广播一条状态帧', async () => {
  const w = await world();
  const result = await setSessionMcpDisabledUseCase(w.deps, {
    sessionId: w.session.id,
    disabled: ['fs', 'browser'],
    actor: principal('u1', 'member')
  });
  assert.ok(result.ok, result.ok ? '' : result.error.message);
  assert.deepEqual(result.value.mcpDisabled, ['fs', 'browser']);
  assert.deepEqual((await w.deps.sessions.byId(w.session.id))?.mcpDisabled, ['fs', 'browser']);
  const frame = w.frames.at(-1);
  assert.equal(frame?.sessionId, w.session.id);
  assert.equal(frame?.event, null);
  assert.equal(frame?.status, 'running');
});

test('按会话关 MCP：空数组 = 全部开启', async () => {
  const w = await world();
  assert.ok((await setSessionMcpDisabledUseCase(w.deps, {
    sessionId: w.session.id,
    disabled: ['fs'],
    actor: principal('u1', 'member')
  })).ok);
  const cleared = await setSessionMcpDisabledUseCase(w.deps, {
    sessionId: w.session.id,
    disabled: [],
    actor: principal('u1', 'member')
  });
  assert.ok(cleared.ok);
  assert.deepEqual((await w.deps.sessions.byId(w.session.id))?.mcpDisabled, []);
});

test('按会话关 MCP：重复名字去重，保留首次出现的顺序', async () => {
  const w = await world();
  const result = await setSessionMcpDisabledUseCase(w.deps, {
    sessionId: w.session.id,
    disabled: ['fs', 'browser', 'fs'],
    actor: principal('u1', 'member')
  });
  assert.ok(result.ok);
  assert.deepEqual(result.value.mcpDisabled, ['fs', 'browser']);
  assert.deepEqual((await w.deps.sessions.byId(w.session.id))?.mcpDisabled, ['fs', 'browser']);
});

test('按会话关 MCP：非法名字拒绝，库里不落', async () => {
  const w = await world();
  const result = await setSessionMcpDisabledUseCase(w.deps, {
    sessionId: w.session.id,
    disabled: ['FS'],
    actor: principal('u1', 'member')
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error.message, /MCP 服务器名不合法/);
  assert.deepEqual((await w.deps.sessions.byId(w.session.id))?.mcpDisabled, []);
});

test('按会话关 MCP：超过上限拒绝', async () => {
  const w = await world();
  const tooMany = Array.from({ length: MCP_DISABLED_MAX + 1 }, (_, index) => `mcp-${index}`);
  const result = await setSessionMcpDisabledUseCase(w.deps, {
    sessionId: w.session.id,
    disabled: tooMany,
    actor: principal('u1', 'member')
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error.message, /最多关掉/);
});

test('按会话关 MCP：不相干的人不能改（403）', async () => {
  const w = await world();
  // viewer 能看见团队项目，但没有 session.prompt：拒绝，且库里不落。
  const denied = await setSessionMcpDisabledUseCase(w.deps, {
    sessionId: w.session.id,
    disabled: ['fs'],
    actor: principal('u2', 'viewer')
  });
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.match(denied.error.message, /角色没有这项权限/);
  assert.deepEqual((await w.deps.sessions.byId(w.session.id))?.mcpDisabled, []);
});

test('按会话关 MCP：会话不存在 404', async () => {
  const w = await world();
  const missing = await setSessionMcpDisabledUseCase(w.deps, {
    sessionId: asSessionId('nope'),
    disabled: ['fs'],
    actor: principal('u1', 'member')
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.error.message, /会话不存在/);
});

test('normalizeMcpDisabled：非数组 / 非字符串一律报错', () => {
  assert.equal(normalizeMcpDisabled('fs').ok, false);
  assert.equal(normalizeMcpDisabled([1]).ok, false);
  assert.deepEqual(normalizeMcpDisabled([]), { ok: true, value: [] });
});
