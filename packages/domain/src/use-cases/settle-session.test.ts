import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { createProject } from '../project.ts';
import { createTask } from '../task.ts';
import { deriveSession } from '../session.ts';
import { asAgentId } from '../ids.ts';
import type { AuditEntry, Principal } from '../account.ts';
import type { AuditLog } from '../ports/audit-log.ts';
import type { AccessPolicy } from './authorization.ts';
import { settleSessionUseCase } from './settle-session.ts';

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

function auditLog(): AuditLog & { readonly entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return {
    entries,
    append: async (entry) => void entries.push(entry),
    recent: async () => entries.slice().reverse(),
    query: async () => entries.slice().reverse()
  };
}

const actor = principal('u1', 'member');

async function world(options: { status?: 'running' | 'stopped' | 'done'; createdBy?: string; projectCreatedBy?: string; teamId?: string } = {}) {
  const { deps } = inMemoryDeps({ access: policy });
  const project = createProject({ name: 'demo', now: 1, teamId: options.teamId ?? 't1', createdBy: options.projectCreatedBy ?? 'u1' });
  assert.ok(project.ok);
  const task = createTask({ projectId: project.value.id, title: 't', goal: '', now: 1 });
  assert.ok(task.ok);
  const session = deriveSession({ task: task.value, agentId: asAgentId('pi'), model: 'm', now: 1, createdBy: options.createdBy ?? 'u1' });
  assert.ok(session.ok);
  await deps.projects.save(project.value);
  await deps.tasks.save(task.value);
  await deps.sessions.save({ ...session.value, status: options.status ?? 'stopped' });
  return { deps, project: project.value, task: task.value, session: session.value };
}

test('收起自己的会话：只写 settledAt，状态和更新时间不变，审计记一条', async () => {
  const w = await world();
  const audit = auditLog();
  const before = (await w.deps.sessions.byId(w.session.id))!;
  const result = await settleSessionUseCase(
    { ...w.deps, audit },
    { sessionId: w.session.id, settled: true, actor, now: 1000 }
  );
  assert.ok(result.ok);
  assert.equal(result.value.settledAt, 1000);
  const after = (await w.deps.sessions.byId(w.session.id))!;
  assert.deepEqual(
    { ...after, title: undefined },
    { ...before, settledAt: 1000, title: undefined }
  );
  assert.equal(audit.entries.length, 1);
  assert.equal(audit.entries[0]?.action, 'session.settle');
  assert.equal(audit.entries[0]?.target, w.session.id);
  assert.equal(audit.entries[0]?.detail, '收起');
  assert.equal(audit.entries[0]?.at, 1000);
  assert.equal(audit.entries[0]?.teamId, 't1');
});

test('恢复：settledAt 写成 null，无条件允许，审计记「恢复」', async () => {
  const w = await world({ status: 'done' });
  const audit = auditLog();
  await w.deps.sessions.save({ ...w.session, status: 'done', settledAt: 500 });
  const result = await settleSessionUseCase(
    { ...w.deps, audit },
    { sessionId: w.session.id, settled: false, actor, now: 2000 }
  );
  assert.ok(result.ok);
  assert.equal(result.value.settledAt, null);
  assert.equal((await w.deps.sessions.byId(w.session.id))?.settledAt, null);
  assert.equal(audit.entries[0]?.detail, '恢复');
});

test('还在跑的会话拒绝收起（conflict），库不变', async () => {
  const w = await world({ status: 'running' });
  const result = await settleSessionUseCase(
    w.deps,
    { sessionId: w.session.id, settled: true, actor, now: 1000 }
  );
  assert.equal(!result.ok && result.error.code, 'conflict');
  assert.match(!result.ok ? result.error.message : '', /还在跑/);
  assert.equal((await w.deps.sessions.byId(w.session.id))?.settledAt, undefined);
});

test('跑着的会话也允许恢复', async () => {
  const w = await world({ status: 'running' });
  await w.deps.sessions.save({ ...w.session, status: 'running', settledAt: 500 });
  const result = await settleSessionUseCase(
    w.deps,
    { sessionId: w.session.id, settled: false, actor, now: 2000 }
  );
  assert.ok(result.ok);
  assert.equal(result.value.settledAt, null);
});

test('团队成员不能收起别人的会话，viewer 也不行；owner / admin 可以', async () => {
  const w = await world({ createdBy: 'u2' });
  const member = await settleSessionUseCase(w.deps, { sessionId: w.session.id, settled: true, actor, now: 1 });
  assert.equal(!member.ok && member.error.code, 'forbidden');
  assert.equal((await w.deps.sessions.byId(w.session.id))?.settledAt, undefined);

  const viewer = await settleSessionUseCase(w.deps, {
    sessionId: w.session.id,
    settled: true,
    actor: principal('u3', 'viewer'),
    now: 1
  });
  assert.equal(!viewer.ok && viewer.error.code, 'forbidden');

  const admin = await settleSessionUseCase(w.deps, {
    sessionId: w.session.id,
    settled: true,
    actor: principal('u4', 'admin'),
    now: 7
  });
  assert.ok(admin.ok);
  assert.equal((await w.deps.sessions.byId(w.session.id))?.settledAt, 7);

  const w2 = await world({ createdBy: 'u2' });
  const owner = await settleSessionUseCase(w2.deps, {
    sessionId: w2.session.id,
    settled: true,
    actor: principal('u5', 'owner'),
    now: 1
  });
  assert.ok(owner.ok);
});

test('未登录、会话不存在都拒绝', async () => {
  const w = await world();
  const anon = await settleSessionUseCase(w.deps, { sessionId: w.session.id, settled: true, actor: null, now: 1 });
  assert.equal(!anon.ok && anon.error.code, 'forbidden');
  const missing = await settleSessionUseCase(w.deps, {
    sessionId: 'nope' as typeof w.session.id,
    settled: true,
    actor,
    now: 1
  });
  assert.equal(!missing.ok && missing.error.code, 'not_found');
});
