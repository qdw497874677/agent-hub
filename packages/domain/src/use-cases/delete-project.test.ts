import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { createProject } from '../project.ts';
import { createTask } from '../task.ts';
import { deriveSession } from '../session.ts';
import { asAgentId } from '../ids.ts';
import type { AuditEntry, Principal } from '../account.ts';
import { deleteProjectUseCase, listTrashUseCase, purgeProjectUseCase, restoreProjectUseCase } from './delete-project.ts';

const actor = { user: { id: 'u1', email: 'm@b.co', role: 'member', disabledAt: null, deletedAt: null, teamId: 't1', clusterAdmin: false }, loginId: 'l1' } as unknown as Principal;

async function world(status: 'running' | 'stopped' = 'stopped', lastSeq = 0) {
  const { deps } = inMemoryDeps();
  const project = createProject({ name: 'demo', now: 1, id: undefined });
  assert.ok(project.ok);
  const task = createTask({ projectId: project.value.id, title: 't', goal: '', now: 1, id: undefined });
  assert.ok(task.ok);
  const session = deriveSession({ task: task.value, agentId: asAgentId('pi'), model: 'm', now: 1 });
  assert.ok(session.ok);
  await deps.projects.save(project.value);
  await deps.tasks.save(task.value);
  await deps.sessions.save({ ...session.value, status, lastSeq });
  const revoked: string[] = [];
  const audit: AuditEntry[] = [];
  const all = {
    ...deps,
    toolGrants: { revokeSession: async (id: string) => (revoked.push(id), 1) },
    audit: { append: async (entry: AuditEntry) => void audit.push(entry), recent: async () => audit, query: async () => audit }
  };
  return { deps: all, project: project.value, session: session.value, revoked, audit };
}

test('删除项目：放进回收站、吊销会话令牌、记审计，并写明目录保留', async () => {
  const w = await world();
  const result = await deleteProjectUseCase(w.deps, actor, { projectId: w.project.id, confirmName: 'demo' });
  assert.ok(result.ok);
  assert.ok((await w.deps.projects.byId(w.project.id))?.deletedAt);
  assert.deepEqual((await w.deps.projects.list()).map((p) => p.id), []);
  assert.deepEqual((await listTrashUseCase(w.deps, actor)).map((p) => p.id), [w.project.id]);
  assert.deepEqual(w.revoked, [w.session.id]);
  assert.equal(w.audit.length, 1);
  assert.equal(w.audit[0]?.action, 'project.delete');
  assert.match(w.audit[0]?.detail ?? '', /保留/);
});

test('名字对不上、未登录、还有会话在跑都拒绝，且什么都不删', async () => {
  const w = await world('running', 3);
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

test('从没发过话、只是挂着 running 的会话不挡删除', async () => {
  const w = await world('running', 0);
  const result = await deleteProjectUseCase(w.deps, actor, { projectId: w.project.id, confirmName: 'demo' });
  assert.ok(result.ok);
  assert.ok((await w.deps.projects.byId(w.project.id))?.deletedAt);
});

test('回收站：还原后回到列表；彻底删除要再输一次名字，之后真没了', async () => {
  const w = await world();
  assert.ok((await deleteProjectUseCase(w.deps, actor, { projectId: w.project.id, confirmName: 'demo' })).ok);
  assert.ok((await restoreProjectUseCase(w.deps, actor, w.project.id)).ok);
  assert.deepEqual((await w.deps.projects.list()).map((p) => p.id), [w.project.id]);
  // 没在回收站里的不能彻底删
  assert.equal((await purgeProjectUseCase(w.deps, actor, { projectId: w.project.id, confirmName: 'demo' })).ok, false);
  assert.ok((await deleteProjectUseCase(w.deps, actor, { projectId: w.project.id, confirmName: 'demo' })).ok);
  assert.equal((await purgeProjectUseCase(w.deps, actor, { projectId: w.project.id, confirmName: 'x' })).ok, false);
  assert.ok((await purgeProjectUseCase(w.deps, actor, { projectId: w.project.id, confirmName: 'demo' })).ok);
  assert.equal(await w.deps.projects.byId(w.project.id), null);
  assert.deepEqual(w.audit.map((e) => e.action), ['project.delete', 'project.restore', 'project.delete', 'project.purge']);
});
