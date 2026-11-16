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
import { pinSessionUseCase } from './session-pin.ts';

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

async function world(options: { createdBy?: string } = {}) {
  const { deps } = inMemoryDeps({ access: policy });
  const project = createProject({ name: 'demo', now: 1, teamId: 't1', createdBy: 'u1' });
  assert.ok(project.ok);
  const task = createTask({ projectId: project.value.id, title: 't', goal: '', now: 1 });
  assert.ok(task.ok);
  const session = deriveSession({ task: task.value, agentId: asAgentId('pi'), model: 'm', now: 1, createdBy: options.createdBy ?? 'u1' });
  assert.ok(session.ok);
  await deps.projects.save(project.value);
  await deps.tasks.save(task.value);
  await deps.sessions.save({ ...session.value, status: 'stopped' });
  return { deps, project: project.value, task: task.value, session: session.value };
}

test('常驻：创建者可以设，标记落库并写审计；取消后回到普通会话', async () => {
  const { deps, session } = await world();
  const audit = auditLog();
  const pinned = await pinSessionUseCase(
    { ...deps, audit },
    { sessionId: session.id, pinned: true, actor: principal('u1', 'member'), now: 10 }
  );
  assert.ok(pinned.ok, pinned.ok ? '' : pinned.error.message);
  assert.equal(pinned.value.pinned, true);
  assert.equal((await deps.sessions.byId(session.id))?.pinned, true);
  assert.equal(audit.entries[0]?.action, 'session.pin');
  assert.equal(audit.entries[0]?.detail, '设为常驻');

  const off = await pinSessionUseCase(
    { ...deps, audit },
    { sessionId: session.id, pinned: false, actor: principal('u1', 'member'), now: 20 }
  );
  assert.ok(off.ok);
  assert.equal((await deps.sessions.byId(session.id))?.pinned, undefined);
});

test('常驻：不相干的人不能把别人的会话钉住', async () => {
  const { deps, session } = await world();
  const denied = await pinSessionUseCase(
    deps,
    { sessionId: session.id, pinned: true, actor: principal('u2', 'member'), now: 10 }
  );
  assert.equal(denied.ok, false);
  assert.equal((await deps.sessions.byId(session.id))?.pinned, undefined);
});

test('常驻：整行 save 不会把已设的常驻冲掉', async () => {
  const { deps, session } = await world();
  assert.ok((await pinSessionUseCase(deps, { sessionId: session.id, pinned: true, actor: principal('u1', 'member'), now: 10 })).ok);
  // 跑着的会话拿旧快照整行回写（旧对象里没有 pinned）。
  await deps.sessions.save({ ...session });
  assert.equal((await deps.sessions.byId(session.id))?.pinned, true);
});

test('未登录不能设常驻', async () => {
  const { deps, session } = await world();
  const anonymous = await pinSessionUseCase(deps, { sessionId: session.id, pinned: true, actor: null, now: 10 });
  assert.equal(anonymous.ok, false);
});
