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
import { prepareLongLivedWorkspaceUseCase, workspaceViewsUseCase } from './workspaces.ts';
import { deriveSessionUseCase } from './sessions.ts';
import {
  createTeamWorkspaceUseCase,
  deleteWorkspaceUseCase,
  linkWorkspaceUseCase,
  listTeamWorkspacesUseCase,
  transferWorkspaceUseCase
} from './team-workspaces.ts';
import { newWorkspace } from '../workspace.ts';

import type { AgentDescriptor } from '../agent.ts';
const fake: AgentDescriptor = {
  id: asAgentId('fake'),
  label: 'Fake',
  capabilities: {
    prompt: { state: 'available' },
    interrupt: { state: 'available' },
    fork: { state: 'available' },
    resume: { state: 'available' },
    tool_calls: { state: 'available' },
    artifacts: { state: 'available' },
    structured_events: { state: 'available' },
    attachments: { state: 'available' }
  },
  models: [],
  defaultModel: '',
  options: []
};


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
  assert.equal(forAlice.value.length, 1, '未认领的目录团队里谁都看得见（要能认领）');
  assert.deepEqual(forAlice.value[0]!.projects, []);

  const own = await prepareLongLivedWorkspaceUseCase(w.deps, { projectId: w.a.id, workerId: 'remote-1', plan: { mode: 'link', path: '/srv/work/a' }, home: '/h', actor: alice });
  assert.ok(own.ok);
  const listed = await listTeamWorkspacesUseCase(w.deps, alice);
  assert.ok(listed.ok);
  assert.deepEqual(
    listed.value.map((v) => [v.workspace.path, v.projects.map((p) => p.name)]).sort(),
    [['/srv/work/a', ['alpha']], ['/srv/work/x', []]].sort()
  );
  const forBob = await listTeamWorkspacesUseCase(w.deps, bob);
  assert.ok(forBob.ok);
  assert.equal(forBob.value.length, 1, '未认领的那个也看得见');
});

test('独占归属：别的项目不能直接关联（conflict 点名当前项目）；同一项目重复关联幂等；视图带认领者', async () => {
  const w = await world();
  const ws = await prepareLongLivedWorkspaceUseCase(w.deps, { projectId: w.a.id, workerId: 'remote-1', plan: { mode: 'link', path: '/srv/work/a' }, home: '/h', actor: alice });
  assert.ok(ws.ok);
  // bob 看不见 alpha 的工作空间 → 不能关联到 beta
  assert.equal((await linkWorkspaceUseCase(w.deps, { actor: bob, projectId: w.b.id, workspaceId: ws.value.id })).ok, false);
  // alice 不能改 beta → 授权先挡住
  assert.equal((await linkWorkspaceUseCase(w.deps, { actor: alice, projectId: w.b.id, workspaceId: ws.value.id })).ok, false);
  // owner 能改 beta、也看得见工作空间：被独占拦下，消息里点名 alpha
  const taken = await linkWorkspaceUseCase(w.deps, { actor: owner, projectId: w.b.id, workspaceId: ws.value.id });
  assert.equal(taken.ok ? '' : taken.error.code, 'conflict');
  assert.match(taken.ok ? '' : taken.error.message, /alpha/);
  assert.deepEqual((await w.deps.workspaces.linksOf(ws.value.id)).map((l) => l.projectId), [w.a.id]);

  // 同一个项目重复关联幂等；登记还是只有一条
  assert.ok((await linkWorkspaceUseCase(w.deps, { actor: alice, projectId: w.a.id, workspaceId: ws.value.id })).ok);
  assert.deepEqual((await w.deps.workspaces.linksOf(ws.value.id)).map((l) => l.projectId), [w.a.id]);

  // 运行面板 / 项目设置里带认领者；bob 在团队页看不到它
  const views = await workspaceViewsUseCase(w.deps, w.a.id);
  assert.ok(views.ok);
  assert.deepEqual(views.value.map((v) => [v.ownerProjectId, v.ownerProjectName]), [[w.a.id, 'alpha']]);
  const forBob = await listTeamWorkspacesUseCase(w.deps, bob);
  assert.ok(forBob.ok);
  assert.deepEqual(forBob.value, []);

  // 独占后只有一个认领者：对 alpha 有 project.update 的 alice 一个人就能删（只移除登记）
  assert.ok((await deleteWorkspaceUseCase(w.deps, { actor: alice, workspaceId: ws.value.id, deleteDirectory: false })).ok);
});

test('转移：A→B 成功，登记只剩 B；对已经属于本项目的空间再转移是幂等的', async () => {
  const w = await world();
  const ws = await prepareLongLivedWorkspaceUseCase(w.deps, { projectId: w.a.id, workerId: 'remote-1', plan: { mode: 'link', path: '/srv/work/a' }, home: '/h', actor: alice });
  assert.ok(ws.ok);
  // owner 能同时改 alpha / beta
  const moved = await transferWorkspaceUseCase(w.deps, { actor: owner, projectId: w.b.id, workspaceId: ws.value.id });
  assert.ok(moved.ok, moved.ok ? '' : moved.error.message);
  assert.deepEqual((await w.deps.workspaces.linksOf(ws.value.id)).map((l) => l.projectId), [w.b.id]);
  const again = await transferWorkspaceUseCase(w.deps, { actor: owner, projectId: w.b.id, workspaceId: ws.value.id });
  assert.ok(again.ok, again.ok ? '' : again.error.message);
  assert.deepEqual((await w.deps.workspaces.linksOf(ws.value.id)).map((l) => l.projectId), [w.b.id]);
  const views = await workspaceViewsUseCase(w.deps, w.b.id);
  assert.ok(views.ok);
  assert.deepEqual(views.value.map((v) => [v.ownerProjectId, v.ownerProjectName]), [[w.b.id, 'beta']]);
});

test('转移：没有源项目 project.update 的人不能转（forbidden），登记保持原样', async () => {
  const w = await world();
  const ws = await prepareLongLivedWorkspaceUseCase(w.deps, { projectId: w.a.id, workerId: 'remote-1', plan: { mode: 'link', path: '/srv/work/a' }, home: '/h', actor: alice });
  assert.ok(ws.ok);
  // eve：自定义角色读全团队、只改共享给自己的项目；beta 的成员列表里有他，alpha 没有
  await w.deps.projects.save({ ...w.b, members: ['eve'] });
  const eve = {
    user: { id: 'eve', email: 'eve@b.co', role: 'custom:limited', disabledAt: null, deletedAt: null, teamId: 't1', clusterAdmin: false },
    loginId: 'l-eve',
    customRole: {
      id: 'limited',
      teamId: 't1',
      name: 'Limited',
      permissions: { 'project.read': 'team', 'project.update': 'own' },
      createdBy: 'boss',
      createdAt: 1,
      updatedAt: 1
    }
  } as unknown as Principal;
  const moved = await transferWorkspaceUseCase(w.deps, { actor: eve, projectId: w.b.id, workspaceId: ws.value.id });
  assert.equal(moved.ok ? '' : moved.error.code, 'forbidden');
  assert.match(moved.ok ? '' : moved.error.message, /同时能改这两个项目/);
  assert.deepEqual((await w.deps.workspaces.linksOf(ws.value.id)).map((l) => l.projectId), [w.a.id]);
});

test('转移：源项目还有会话在这个目录里跑 → conflict，停了才能转', async () => {
  const w = await world();
  const ws = await prepareLongLivedWorkspaceUseCase(w.deps, { projectId: w.a.id, workerId: 'remote-1', plan: { mode: 'link', path: '/srv/work/a' }, home: '/h', actor: alice });
  assert.ok(ws.ok);
  const task = createTask({ projectId: w.a.id, title: 't', goal: '', now: 1 });
  assert.ok(task.ok);
  await w.deps.tasks.save(task.value);
  const session = deriveSession({ task: task.value, agentId: asAgentId('pi'), model: 'm', now: 1 });
  assert.ok(session.ok);
  await w.deps.sessions.save({ ...session.value, status: 'running', workspaceId: ws.value.id });
  const blocked = await transferWorkspaceUseCase(w.deps, { actor: owner, projectId: w.b.id, workspaceId: ws.value.id });
  assert.equal(blocked.ok ? '' : blocked.error.code, 'conflict');
  assert.match(blocked.ok ? '' : blocked.error.message, /先停掉再转移/);
  await w.deps.sessions.save({ ...session.value, status: 'stopped', workspaceId: ws.value.id });
  assert.ok((await transferWorkspaceUseCase(w.deps, { actor: owner, projectId: w.b.id, workspaceId: ws.value.id })).ok);
  assert.deepEqual((await w.deps.workspaces.linksOf(ws.value.id)).map((l) => l.projectId), [w.b.id]);
});

test('转移：临时工作空间只属于一个任务，不能转移（invalid）', async () => {
  const w = await world();
  const task = createTask({ projectId: w.a.id, title: 't', goal: '', now: 1 });
  assert.ok(task.ok);
  await w.deps.tasks.save(task.value);
  const temp = newWorkspace({ projectId: w.a.id, teamId: 't1', workerId: 'remote-1', path: '/srv/work/t1', kind: 'temporary', source: 'worktree', ownerTaskId: task.value.id, now: 2 });
  assert.ok(temp.ok);
  await w.deps.workspaces.save(temp.value);
  // alice 不能改 beta，先被目标项目授权挡住；owner 才走到「临时空间不能转移」
  assert.equal((await transferWorkspaceUseCase(w.deps, { actor: alice, projectId: w.b.id, workspaceId: temp.value.id })).ok, false);
  const moved = await transferWorkspaceUseCase(w.deps, { actor: owner, projectId: w.b.id, workspaceId: temp.value.id });
  assert.equal(moved.ok ? '' : moved.error.code, 'invalid');
  assert.match(moved.ok ? '' : moved.error.message, /临时工作空间/);
});

test('团队页新建（还没分配）的长期工作空间可以被项目认领', async () => {
  const w = await world();
  const ws = await createTeamWorkspaceUseCase(w.deps, { actor: owner, workerId: 'remote-1', plan: { mode: 'link', path: '/srv/work/shared' }, home: '/h' });
  assert.ok(ws.ok);
  assert.equal(ws.value.projectId, null);
  assert.deepEqual(await w.deps.workspaces.linksOf(ws.value.id), []);
  // 没认领的目录：项目 owner 有 project.update 就能认领，不需要 workspace.manage
  const claimed = await linkWorkspaceUseCase(w.deps, { actor: bob, projectId: w.b.id, workspaceId: ws.value.id });
  assert.ok(claimed.ok, claimed.ok ? '' : claimed.error.message);
  assert.deepEqual((await w.deps.workspaces.linksOf(ws.value.id)).map((l) => [l.projectId, l.linkedBy]), [[w.b.id, 'bob']]);
});

test('在关联的团队工作空间里开会话（projectId 为 null 也认关联表）；没关联的项目不认', async () => {
  const w = await world();
  w.agents.push(fake);
  const ws = await createTeamWorkspaceUseCase(w.deps, { actor: owner, workerId: 'remote-1', plan: { mode: 'link', path: '/srv/work/shared' }, home: '/h' });
  assert.ok(ws.ok);
  assert.equal(ws.value.projectId, null);
  const linked = await linkWorkspaceUseCase(w.deps, { actor: owner, projectId: w.a.id, workspaceId: ws.value.id });
  assert.ok(linked.ok, linked.ok ? '' : linked.error.message);
  const mkTask = async (projectId: typeof w.a.id) => {
    const t = createTask({ projectId, title: 't', goal: '', now: 1 });
    assert.ok(t.ok);
    await w.deps.tasks.save(t.value);
    return t.value;
  };
  const started = await deriveSessionUseCase(w.deps, { taskId: (await mkTask(w.a.id)).id, agentId: 'fake', model: '', workspaceId: ws.value.id, actor: owner });
  assert.ok(started.ok, started.ok ? '' : started.error.message);
  assert.equal(started.value.workspaceId, ws.value.id);
  const foreign = await deriveSessionUseCase(w.deps, { taskId: (await mkTask(w.b.id)).id, agentId: 'fake', model: '', workspaceId: ws.value.id, actor: owner });
  assert.equal(foreign.ok, false);
});
