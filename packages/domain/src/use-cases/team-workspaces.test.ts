import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { createProject } from '../project.ts';
import { createTask } from '../task.ts';
import { deriveSession } from '../session.ts';
import { asAgentId } from '../ids.ts';
import type { Principal } from '../account.ts';
import { DEFAULT_SETTINGS } from '../account.ts';
import type { AccessPolicy } from './authorization.ts';
import { authorizeWorkspace } from './authorization.ts';
import { prepareLongLivedWorkspaceUseCase, workspaceViewsUseCase } from './workspaces.ts';
import {
  createTeamWorkspaceUseCase,
  deleteWorkspaceUseCase,
  linkWorkspaceUseCase,
  listTeamWorkspacesUseCase,
  unlinkWorkspaceUseCase
} from './team-workspaces.ts';

const who = (id: string, role: string) =>
  ({ user: { id, email: `${id}@b.co`, role, disabledAt: null, deletedAt: null, teamId: 't1', clusterAdmin: false }, loginId: `l-${id}` }) as unknown as Principal;
const owner = who('boss', 'owner');
const alice = who('alice', 'member');
const bob = who('bob', 'member');

async function world() {
  const w = inMemoryDeps();
  w.workers.push({ workerId: 'remote-1', label: '远程', origin: 'remote', state: 'online', roots: ['/srv/work'] });
  const policy: AccessPolicy = {
    context: async () => ({ hubTeamId: 't1', settings: DEFAULT_SETTINGS }),
    worker: async (id) => ({ kind: 'worker', id: id ?? 'local', teamId: 't1', createdBy: null })
  };
  const deps = { ...w.deps, access: policy };
  const mk = async (name: string, by: string) => {
    const p = createProject({ name, now: 1, teamId: 't1', createdBy: by });
    assert.ok(p.ok);
    await deps.projects.save(p.value);
    return p.value;
  };
  const a = await mk('alpha', 'alice');
  const b = await mk('beta', 'bob');
  return { ...w, deps, a, b };
}

test('团队页：owner 新建（不关联），成员看不见没关联的；为项目新建会关联、成员只看见自己项目关联的', async () => {
  const w = await world();
  const denied = await createTeamWorkspaceUseCase(w.deps, { actor: alice, workerId: 'remote-1', plan: { mode: 'link', path: '/srv/work/x' }, home: '/h' });
  assert.equal(denied.ok, false);
  const made = await createTeamWorkspaceUseCase(w.deps, { actor: owner, workerId: 'remote-1', plan: { mode: 'link', path: '/srv/work/x' }, home: '/h' });
  assert.ok(made.ok, made.ok ? '' : made.error.message);
  assert.equal(made.value.projectId, null);
  assert.equal(made.value.teamId, 't1');
  assert.deepEqual(await listTeamWorkspacesUseCase(w.deps, owner), { ok: true, value: [{ workspace: made.value, projects: [], hiddenProjects: 0, runningSessions: 0 }] });
  const forAlice = await listTeamWorkspacesUseCase(w.deps, alice);
  assert.ok(forAlice.ok);
  assert.equal(forAlice.value.length, 0, '未关联的只给有 workspace.manage 的人看');

  const own = await prepareLongLivedWorkspaceUseCase(w.deps, { projectId: w.a.id, workerId: 'remote-1', plan: { mode: 'link', path: '/srv/work/a' }, home: '/h', actor: alice });
  assert.ok(own.ok);
  const listed = await listTeamWorkspacesUseCase(w.deps, alice);
  assert.ok(listed.ok);
  assert.deepEqual(listed.value.map((v) => [v.workspace.path, v.projects.map((p) => p.name)]), [['/srv/work/a', ['alpha']]]);
  const forBob = await listTeamWorkspacesUseCase(w.deps, bob);
  assert.ok(forBob.ok);
  assert.equal(forBob.value.length, 0);
});

test('关联（Q4）：要项目的 project.update 且看得见工作空间；关联后两个项目都能用，别人只看到个数', async () => {
  const w = await world();
  const ws = await prepareLongLivedWorkspaceUseCase(w.deps, { projectId: w.a.id, workerId: 'remote-1', plan: { mode: 'link', path: '/srv/work/a' }, home: '/h', actor: alice });
  assert.ok(ws.ok);
  // bob 看不见 alpha 的工作空间 → 不能关联到 beta
  const hidden = await linkWorkspaceUseCase(w.deps, { actor: bob, projectId: w.b.id, workspaceId: ws.value.id });
  assert.equal(hidden.ok, false);
  // alice 不能改 beta
  const notHers = await linkWorkspaceUseCase(w.deps, { actor: alice, projectId: w.b.id, workspaceId: ws.value.id });
  assert.equal(notHers.ok, false);
  // owner 可以
  assert.ok((await linkWorkspaceUseCase(w.deps, { actor: owner, projectId: w.b.id, workspaceId: ws.value.id })).ok);
  assert.ok((await authorizeWorkspace(w.deps, bob, ws.value, 'project.read')).ok, '关联后 bob 经 beta 看得见');
  const forBob = await listTeamWorkspacesUseCase(w.deps, bob);
  assert.ok(forBob.ok);
  assert.deepEqual(forBob.value[0]?.projects.map((p) => p.name), ['beta']);
  assert.equal(forBob.value[0]?.hiddenProjects, 1);

  // 跨项目并发：alpha 里有会话在跑，beta 的视图只看到个数
  const task = createTask({ projectId: w.a.id, title: 't', goal: '', now: 1 });
  assert.ok(task.ok);
  await w.deps.tasks.save(task.value);
  const session = deriveSession({ task: task.value, agentId: asAgentId('pi'), model: 'm', now: 1 });
  assert.ok(session.ok);
  await w.deps.sessions.save({ ...session.value, status: 'running', workspaceId: ws.value.id });
  const views = await workspaceViewsUseCase(w.deps, w.b.id);
  assert.ok(views.ok);
  assert.deepEqual(views.value.map((v) => [v.runningTaskIds.length, v.otherProjectSessions]), [[0, 1]]);
  const mine = await workspaceViewsUseCase(w.deps, w.a.id);
  assert.ok(mine.ok);
  assert.deepEqual(mine.value.map((v) => [v.runningTaskIds, v.otherProjectSessions]), [[[task.value.id], 0]]);

  // 关联了两个项目：成员不能删，只能取消关联；本项目有会话在跑时不能取消关联
  const del = await deleteWorkspaceUseCase(w.deps, { actor: alice, workspaceId: ws.value.id, deleteDirectory: false });
  assert.equal(del.ok, false);
  const busy = await unlinkWorkspaceUseCase(w.deps, { actor: alice, projectId: w.a.id, workspaceId: ws.value.id });
  assert.equal(busy.ok, false);
  await w.deps.sessions.save({ ...session.value, status: 'stopped', workspaceId: ws.value.id });
  assert.ok((await unlinkWorkspaceUseCase(w.deps, { actor: alice, projectId: w.a.id, workspaceId: ws.value.id })).ok);
  assert.deepEqual((await w.deps.workspaces.byProject(w.a.id)).map((x) => x.id), []);
  assert.deepEqual((await w.deps.workspaces.byProject(w.b.id)).map((x) => x.id), [ws.value.id]);
  // 只剩 beta：bob 可以删（只移除登记）
  assert.ok((await deleteWorkspaceUseCase(w.deps, { actor: bob, workspaceId: ws.value.id, deleteDirectory: false })).ok);
});
