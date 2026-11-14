import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDescriptor } from '../agent.ts';
import { asAgentId, asWorkspaceGroupId } from '../ids.ts';
import { capabilityMatrix, available } from '../capability.ts';
import { ok } from '../result.ts';
import { inMemoryDeps } from '../testing/in-memory.ts';
import type { BrowserEntry, WorkspaceBrowser } from '../ports/workspace-browser.ts';
import type { WorkspaceGroupRepository } from '../ports/workspace-groups.ts';
import type { WorkspaceGit } from '../ports/workspace-git.ts';
import { newWorkspace } from '../workspace.ts';
import type { WorkspaceGroup } from '../workspace-group.ts';
import { createProjectUseCase } from './projects.ts';
import { createTaskUseCase } from './tasks.ts';
import { deriveSessionUseCase } from './sessions.ts';
import { createWorkspaceFilesService } from './workspace-files.ts';
import { createGitWorkflowService } from './git-workflow.ts';

const agent: AgentDescriptor = {
  id: asAgentId('fake'),
  label: 'Fake',
  capabilities: capabilityMatrix({ prompt: available, interrupt: available, fork: available, resume: available, tool_calls: available, artifacts: available, structured_events: available, attachments: available }),
  models: ['m1'],
  defaultModel: 'm1',
  options: []
};

const CONTAINER = '/srv/work/groups/group_test';

function fakeGroups(): WorkspaceGroupRepository & { rows: Map<string, WorkspaceGroup> } {
  const rows = new Map<string, WorkspaceGroup>();
  return {
    rows,
    async byId(id) {
      return rows.get(id) ?? null;
    },
    async listByProject(projectId) {
      return [...rows.values()].filter((group) => group.projectId === projectId);
    },
    async save(group) {
      rows.set(group.id, group);
    },
    async remove(id) {
      rows.delete(id);
    }
  };
}

function entry(name: string, type: 'file' | 'dir'): BrowserEntry {
  return { name, path: name, type, size: 0, modifiedAt: 0, ignored: false, sensitive: false, git: null };
}

function fakeBrowser(tag: string, calls: string[]): WorkspaceBrowser {
  return {
    list: async (root, path) => {
      calls.push(`${tag}:list:${root}:${path}`);
      const entries = root === CONTAINER && path === '' ? [entry('.agent-hub', 'dir'), entry('web', 'dir'), entry('api', 'dir')] : [];
      return ok({ path, entries, truncated: false, isGit: root !== CONTAINER });
    },
    read: async (root, path) => (calls.push(`${tag}:read:${root}:${path}`), ok({ path, size: 1, modifiedAt: 0, binary: false, truncated: false, bytes: new Uint8Array([65]) })),
    find: async (root) => (calls.push(`${tag}:find:${root}`), ok(['.agent-hub/group.json', 'src/a.ts'])),
    changes: async (root, base, target) => (calls.push(`${tag}:changes:${root}:${base}${target ? `..${target}` : ''}`), ok(target ? [{ path: 'a.ts', status: 'modified' as const, additions: 2, deletions: 1 }] : [])),
    diff: async (root, path, base, _max, target) => (calls.push(`${tag}:diff:${root}:${path}:${base}${target ? `..${target}` : ''}`), ok({ path, patch: '', truncated: false, binary: false })),
    checkpoint: async (root, ref) => (calls.push(`${tag}:checkpoint:${root}:${ref.split('/').at(-1)}`), ok(`c0ffee${ref.split('/').at(-1)}`)),
    dropRefs: async () => ok(0),
    restore: async (root, commit) => (calls.push(`${tag}:restore:${root}:${commit}`), ok({ safety: 'safe', restored: 1, removed: 0 })),
    head: async (root) => (calls.push(`${tag}:head:${root}`), ok(root === CONTAINER ? 'container' : 'member-head')),
    watch: async (root, paths) => (calls.push(`${tag}:watch:${root}:${paths.join(',')}`), ok(() => calls.push(`${tag}:unwatch`)))
  };
}

async function world() {
  const groups = fakeGroups();
  const memory = inMemoryDeps({ now: () => 1000 });
  memory.agents.push(agent);
  memory.workers.push({ workerId: 'remote-1', label: '远程', origin: 'remote', state: 'online', roots: ['/srv/work'] });
  memory.workers.push({ workerId: 'local-1', label: '本机', origin: 'local', state: 'online', roots: ['/srv/work'] });
  const base = memory.deps;
  const deps = { ...base, workspaceGroups: groups };
  const project = await createProjectUseCase(deps, { name: 'Demo' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(deps, { projectId: project.value.id, title: 'multi repo' });
  assert.ok(task.ok);

  const members: WorkspaceGroup['members'][number][] = [];
  for (const name of ['web', 'api']) {
    const created = newWorkspace({
      projectId: project.value.id,
      workerId: 'remote-1',
      path: `${CONTAINER}/${name}`,
      kind: 'temporary',
      source: 'worktree',
      ownerTaskId: task.value.id,
      isGit: true,
      now: 1
    });
    assert.ok(created.ok);
    await deps.workspaces.save(created.value);
    await deps.workspaces.link({ projectId: project.value.id, workspaceId: created.value.id, linkedBy: null, linkedAt: 1 });
    members.push({ workspaceId: created.value.id, repoId: `repo_${name}`, name, state: 'ready', error: null });
  }
  const group = {
    id: asWorkspaceGroupId('group_test'),
    projectId: project.value.id,
    workerId: 'remote-1',
    root: CONTAINER,
    members,
    state: 'ready' as const,
    ownerTaskId: task.value.id,
    createdAt: 1,
    error: null
  };
  await groups.save(group);

  const session = await deriveSessionUseCase(deps, { taskId: task.value.id, agentId: 'fake', model: 'm1', groupId: group.id });
  assert.ok(session.ok);

  const calls: string[] = [];
  const bases = new Map<string, string>();
  const svc = createWorkspaceFilesService({
    ...deps,
    audit: { append: async () => undefined },
    local: fakeBrowser('local', calls),
    remote: (id) => fakeBrowser(id, calls),
    bases: { get: async (id) => bases.get(id) ?? null, setIfAbsent: async (id, h) => void (bases.has(id) || bases.set(id, h)) },
    now: () => 1000
  });
  const git = {} as WorkspaceGit;
  const gitSvc = createGitWorkflowService({
    ...deps,
    audit: { append: async () => undefined },
    workLog: { list: async () => [], append: async () => ({}) } as never,
    git,
    pullRequests: { byTask: async () => [], save: async () => undefined } as never,
    tokens: { status: async () => ({ configured: false, last4: null, updatedAt: null }), reveal: async () => null, set: async () => true, remove: async () => true } as never,
    host: {} as never,
    hubTeamId: async () => null,
    now: () => 1000
  });
  return { deps, groups, svc, gitSvc, calls, bases, session: session.value, group, project: project.value, webId: members[0]!.workspaceId };
}

test('组合会话：不指定 member 时落在容器根，context 带成员清单', async () => {
  const w = await world();
  const ctx = await w.svc.context(null, w.session.id);
  assert.ok(ctx.ok, ctx.ok ? '' : ctx.error.message);
  assert.equal(ctx.value.root, CONTAINER);
  assert.equal(ctx.value.member, null);
  assert.equal(ctx.value.sessionBase, null);
  assert.deepEqual(ctx.value.group?.members.map((m) => [m.name, m.state]), [['web', 'ready'], ['api', 'ready']]);
  assert.equal(ctx.value.group?.root, CONTAINER);

  const listed = await w.svc.list(null, w.session.id, '');
  assert.ok(listed.ok);
  assert.deepEqual(listed.value.entries.map((e) => e.name), ['web', 'api']);
  assert.deepEqual(w.calls, ['remote-1:list:/srv/work/groups/group_test:']);
});

test('组合会话：指定 member 时 root 指向该成员，context 标出当前成员', async () => {
  const w = await world();
  const ctx = await w.svc.context(null, w.session.id, w.webId);
  assert.ok(ctx.ok);
  assert.equal(ctx.value.root, `${CONTAINER}/web`);
  assert.equal(ctx.value.member, w.webId);
  assert.equal(ctx.value.group?.root, CONTAINER);
  const listed = await w.svc.list(null, w.session.id, '', w.webId);
  assert.ok(listed.ok);
  assert.deepEqual(w.calls, ['remote-1:list:/srv/work/groups/group_test/web:']);
});

test('组合会话：member 不属于这组 → 拒绝', async () => {
  const w = await world();
  const other = newWorkspace({ projectId: w.project.id, workerId: 'remote-1', path: '/srv/work/other', kind: 'long_lived', source: 'linked', now: 1 });
  assert.ok(other.ok);
  const listed = await w.svc.list(null, w.session.id, '', other.value.id);
  assert.equal(listed.ok, false);
  if (!listed.ok) assert.equal(listed.error.message, '这颗仓库不属于这条会话的组合工作空间');
  const single = await w.svc.context(null, w.session.id, 'nope');
  assert.equal(single.ok, false);
});

test('.agent-hub：容器里不列、不读、不搜，diff 也拒绝', async () => {
  const w = await world();
  const listed = await w.svc.list(null, w.session.id, '');
  assert.ok(listed.ok);
  assert.equal(listed.value.entries.some((e) => e.name === '.agent-hub'), false);

  for (const path of ['.agent-hub', '.agent-hub/group.json']) {
    const read = await w.svc.read(null, w.session.id, path, true);
    assert.equal(read.ok, false, path);
    if (!read.ok) assert.equal(read.error.message, '路径不合法');
  }
  const download = await w.svc.download(null, w.session.id, '.agent-hub/group.json', true);
  assert.equal(download.ok, false);
  const found = await w.svc.find(null, w.session.id, 'group');
  assert.ok(found.ok);
  assert.deepEqual(found.value, ['src/a.ts']);
  const diff = await w.svc.diff(null, w.session.id, '.agent-hub/group.json', 'head');
  assert.equal(diff.ok, false);
});

test('组合会话：不指定 member 时 changes 为空、不在容器根跑 git；diff 要求选仓库', async () => {
  const w = await world();
  const changes = await w.svc.changes(null, w.session.id, 'session');
  assert.ok(changes.ok);
  assert.deepEqual(changes.value.files, []);
  assert.equal(w.calls.some((c) => c.includes(':changes:')), false);

  const diff = await w.svc.diff(null, w.session.id, 'a.ts', 'head');
  assert.equal(diff.ok, false);
  if (!diff.ok) assert.equal(diff.error.message, '请选择要查看改动的仓库');

  const picked = await w.svc.changes(null, w.session.id, 'session', undefined, w.webId);
  assert.ok(picked.ok);
  assert.deepEqual(w.calls, ['remote-1:changes:/srv/work/groups/group_test/web:null']);
});

test('组合会话：commit / state 必须选仓库；选了就在成员仓库上跑', async () => {
  const w = await world();
  const refused = await w.gitSvc.run(null, w.session.id, { action: 'commit', message: 'x' });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.error.message, '请选择要提交的仓库');
  const stateRefused = await w.gitSvc.run(null, w.session.id, { action: 'commit', message: 'x' }, undefined);
  assert.equal(stateRefused.ok, false);

  // 选了成员：preview 走成员 root；没有改动 → 明确的业务错误（而不是「不是 git 仓库」）。
  const calls: string[] = [];
  const memberGit = {
    preview: async (root: string) => {
      calls.push(root);
      return ok({ isGit: true, branch: 'main', defaultBranch: 'main', remoteUrl: null, upstream: null, ahead: 0, head: 'abc', files: [], patch: '', truncated: false });
    }
  } as unknown as WorkspaceGit;
  // 重新构造一个指向 memberGit 的服务（deps 里的 git 在工厂闭包里，测试里换不了）。
  const svc = createGitWorkflowService({
    ...w.deps,
    gateway: { ...w.deps.gateway, git: () => memberGit },
    audit: { append: async () => undefined },
    workLog: { list: async () => [], append: async () => ({}) } as never,
    git: memberGit,
    pullRequests: { byTask: async () => [], save: async () => undefined } as never,
    tokens: { status: async () => ({ configured: false, last4: null, updatedAt: null }), reveal: async () => null, set: async () => true, remove: async () => true } as never,
    host: {} as never,
    hubTeamId: async () => null,
    now: () => 1000
  });
  const ran = await svc.run(null, w.session.id, { action: 'commit', message: 'x' }, w.webId);
  assert.equal(ran.ok, false);
  if (!ran.ok) assert.equal(ran.error.message, '没有要提交的改动');
  assert.deepEqual(calls, [`${CONTAINER}/web`]);
});

test('组合会话：每个成员各记一份会话基准', async () => {
  const w = await world();
  await w.svc.recordBase(w.session.id);
  assert.equal(w.bases.get(w.session.id), undefined);
  assert.equal(w.bases.get(`${w.session.id}:${w.webId}`), 'member-head');
  const ctx = await w.svc.context(null, w.session.id, w.webId);
  assert.ok(ctx.ok);
  assert.equal(ctx.value.sessionBase, 'member-head');
});

test('组合会话：回滚带文件明确拒绝', async () => {
  const w = await world();
  const restored = await w.svc.restoreTurn(w.session.id, 1);
  assert.equal(restored.ok, false);
  if (!restored.ok) assert.equal(restored.error.message, '组合工作空间暂不支持回滚，请在成员仓库里各自提交');
});
