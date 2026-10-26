import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { createProject } from '../project.ts';
import { createTask } from '../task.ts';
import { deriveSession } from '../session.ts';
import { asAgentId } from '../ids.ts';
import type { AuditEntry, Principal } from '../account.ts';
import { deleteProjectUseCase } from './delete-project.ts';

const actor = { user: { id: 'u1', email: 'm@b.co', role: 'member', disabledAt: null }, loginId: 'l1' } as unknown as Principal;

async function world(status: 'running' | 'stopped' = 'stopped') {
  const { deps } = inMemoryDeps();
  const project = createProject({ name: 'demo', now: 1, id: undefined });
  assert.ok(project.ok);
  const task = createTask({ projectId: project.value.id, title: 't', goal: '', now: 1, id: undefined });
  assert.ok(task.ok);
  const session = deriveSession({ task: task.value, agentId: asAgentId('pi'), model: 'm', now: 1 });
  assert.ok(session.ok);
  await deps.projects.save(project.value);
  await deps.tasks.save(task.value);
  await deps.sessions.save({ ...session.value, status });
  const revoked: string[] = [];
  const audit: AuditEntry[] = [];
  const all = {
    ...deps,
    toolGrants: { revokeSession: async (id: string) => (revoked.push(id), 1) },
    audit: { append: async (entry: AuditEntry) => void audit.push(entry), recent: async () => audit }
  };
  return { deps: all, project: project.value, session: session.value, revoked, audit };
}

test('删除项目：吊销会话令牌、删记录、记审计，并写明目录保留', async () => {
  const w = await world();
  const result = await deleteProjectUseCase(w.deps, actor, { projectId: w.project.id, confirmName: 'demo' });
  assert.ok(result.ok);
  assert.equal(await w.deps.projects.byId(w.project.id), null);
  assert.deepEqual(w.revoked, [w.session.id]);
  assert.equal(w.audit.length, 1);
  assert.equal(w.audit[0]?.action, 'project.delete');
  assert.match(w.audit[0]?.detail ?? '', /保留/);
});

test('名字对不上、未登录、还有会话在跑都拒绝，且什么都不删', async () => {
  const w = await world('running');
  const wrong = await deleteProjectUseCase(w.deps, actor, { projectId: w.project.id, confirmName: 'dem' });
  assert.equal(!wrong.ok && wrong.error.code, 'invalid');
  const anon = await deleteProjectUseCase(w.deps, null, { projectId: w.project.id, confirmName: 'demo' });
  assert.equal(!anon.ok && anon.error.code, 'forbidden');
  const busy = await deleteProjectUseCase(w.deps, actor, { projectId: w.project.id, confirmName: 'demo' });
  assert.equal(!busy.ok && busy.error.code, 'conflict');
  assert.ok(await w.deps.projects.byId(w.project.id));
  assert.deepEqual(w.revoked, []);
  assert.equal(w.audit.length, 0);
});
