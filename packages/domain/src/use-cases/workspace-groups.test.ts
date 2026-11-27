import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { asAgentId, asWorkspaceId } from '../ids.ts';
import { invalid } from '../errors.ts';
import { ok, err } from '../result.ts';
import { deriveSession } from '../session.ts';
import { newWorkspace, type Workspace } from '../workspace.ts';
import { groupMemberRoot, groupReady, groupSessionRoot, memberBriefingPath, type WorkspaceGroup } from '../workspace-group.ts';
import type { WorkspaceGroupGit } from '../ports/workspace-group-git.ts';
import type { WorkspaceGroupRepository } from '../ports/workspace-groups.ts';
import type { Deps } from './deps.ts';
import { createProjectUseCase, updateProjectReposUseCase } from './projects.ts';
import { createTaskUseCase } from './tasks.ts';
import { addWorkspaceGroupMemberUseCase, buildWorkspaceGroupUseCase, memberWorktreePath, prepareRepoWorktreeUseCase, removeWorkspaceGroupUseCase, retryWorkspaceGroupUseCase } from './workspace-groups.ts';
import type { WorkdirSafety } from '../workdir-safety.ts';
import { deriveSessionUseCase } from './sessions.ts';

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

function fakeGroupGit() {
  const calls: string[] = [];
  const removed: { root: string; id: string }[] = [];
  let failure: string | null = null;
  const git: WorkspaceGroupGit = {
    async init(input) {
      calls.push(`init:${input.slug}:${input.id}`);
      return ok({ root: `/srv/work/groups/${input.id}` });
    },
    async remove(input) {
      calls.push(`remove:${input.root}`);
      removed.push(input);
      return ok({ removed: true });
    },
    async newWorktree(input) {
      calls.push(`worktree:${input.repoPath}->${input.path}@${input.branch}`);
      if (failure) {
        const message = failure;
        failure = null;
        return err(invalid(message));
      }
      return ok({ path: input.path, branch: input.branch });
    }
  };
  return {
    git,
    calls,
    removed,
    failNext(message: string) {
      failure = message;
    }
  };
}

async function world() {
  const groupGit = fakeGroupGit();
  const groups = fakeGroups();
  const memory = inMemoryDeps();
  memory.workers.push({ workerId: 'remote-1', label: '远程', origin: 'remote', state: 'online', roots: ['/srv/work'] });
  const deps: Deps = {
    ...memory.deps,
    workspaceGroups: groups,
    gateway: { ...memory.deps.gateway, groups: () => groupGit.git }
  };
  const project = await createProjectUseCase(deps, { name: 'Demo App' });
  assert.ok(project.ok);
  const withRepos = await updateProjectReposUseCase(deps, {
    projectId: project.value.id,
    repos: [
      { name: 'web', url: 'https://example.com/web.git' },
      { name: 'api', url: 'https://example.com/api.git' }
    ]
  });
  assert.ok(withRepos.ok);
  const primary = withRepos.value.repos.find((repo) => repo.name === 'web');
  assert.ok(primary);
  const designated = await updateProjectReposUseCase(deps, {
    projectId: project.value.id,
    repos: withRepos.value.repos,
    primaryRepoId: primary.id
  });
  assert.ok(designated.ok);
  const task = await createTaskUseCase(deps, { projectId: project.value.id, title: 'Ship multi repo' });
  assert.ok(task.ok);
  // 每个仓库在这台机器上已经有一个长期工作空间（组合的 base）
  for (const repo of withRepos.value.repos) {
    const base = newWorkspace({
      projectId: project.value.id,
      repoUrl: repo.url,
      workerId: 'remote-1',
      path: `/srv/work/${repo.name}`,
      kind: 'long_lived',
      source: 'cloned',
      isGit: true,
      now: 1
    });
    assert.ok(base.ok);
    await deps.workspaces.save(base.value);
    await deps.workspaces.claim({ projectId: project.value.id, workspaceId: base.value.id, linkedBy: null, linkedAt: 1 });
  }
  const build = () =>
    buildWorkspaceGroupUseCase(deps, {
      projectId: project.value.id,
      taskId: task.value.id,
      workerId: 'remote-1',
      home: '/home/me'
    });
  return { deps, groups, groupGit, memory, project: designated.value, task: task.value, build };
}

test('planned groups identify primary by output workspace ID and reject legacy retry, append and clone', async () => {
  const w = await world();
  const built = await w.build();
  assert.ok(built.ok);
  const members = built.value.members.map((member) => ({ ...member, repoId: null, sourceWorkspaceId: asWorkspaceId(`source-${member.name}`) }));
  const planned: WorkspaceGroup = { ...built.value, state: 'failed', members, primaryWorkspaceId: members[1]!.workspaceId };
  await w.groups.save(planned);
  assert.equal(groupSessionRoot(planned), `${planned.root}/api`);
  assert.equal(groupMemberRoot(planned, members[0]!.workspaceId), `${planned.root}/repos/web`);
  assert.equal(memberBriefingPath(planned, members[1]!), '.');
  const before = w.groupGit.calls.length;
  const retry = await retryWorkspaceGroupUseCase(w.deps, { groupId: planned.id, home: '/home/me' });
  const append = await addWorkspaceGroupMemberUseCase(w.deps, { groupId: planned.id, repoId: w.project.repos[0]!.id, home: '/home/me' });
  const clone = await buildWorkspaceGroupUseCase(w.deps, { projectId: w.project.id, taskId: w.task.id, workerId: 'remote-1', home: '/home/me', fromGroupId: planned.id });
  assert.equal(retry.ok, false);
  assert.equal(append.ok, false);
  assert.equal(clone.ok, false);
  assert.equal(w.groupGit.calls.length, before);
});

test('legacy group reference must belong to same project and owning task', async () => {
  const w = await world();
  const built = await w.build();
  assert.ok(built.ok);
  const task = await createTaskUseCase(w.deps, { projectId: w.project.id, title: 'Other task' });
  assert.ok(task.ok);
  const before = w.groupGit.calls.length;
  const clone = await buildWorkspaceGroupUseCase(w.deps, { projectId: w.project.id, taskId: task.value.id, workerId: 'remote-1', home: '/home/me', fromGroupId: built.value.id });
  assert.equal(clone.ok, false);
  if (!clone.ok) assert.equal(clone.error.code, 'not_found');
  assert.equal(w.groupGit.calls.length, before);
});

test('protected groups and source members reject legacy mutations and manual removal, including ready-unused', async () => {
  const w = await world();
  const built = await w.build();
  assert.ok(built.ok);
  const group = { ...built.value, state: 'failed' as const };
  await w.groups.save(group);
  for (const protectedBy of ['group', 'member'] as const) {
    for (const state of ['pending', 'unknown', 'ready-unused'] as const) {
      const guard: NonNullable<Deps['plannedWorktreeGuard']> = {
        isGroupProtected: (id) => protectedBy === 'group' && id === group.id,
        isWorkspaceProtected: (id) => protectedBy === 'member' && id === group.members[0]!.workspaceId,
        forOutput: () => ({ source: 'local', state, groupId: group.id }), noteStarted() {}
      };
      const deps = { ...w.deps, plannedWorktreeGuard: guard };
      const before = w.groupGit.calls.length;
      assert.equal((await retryWorkspaceGroupUseCase(deps, { groupId: group.id, home: '/home/me' })).ok, false);
      assert.equal((await addWorkspaceGroupMemberUseCase(deps, { groupId: group.id, repoId: 'new', home: '/home/me' })).ok, false);
      assert.equal((await removeWorkspaceGroupUseCase(deps, { groupId: group.id })).ok, false);
      assert.equal(w.groupGit.calls.length, before);
      assert.ok(w.groups.rows.has(group.id));
    }
  }
});

test('closed unprotected planned groups cannot use legacy recursive removal', async () => {
  const w = await world();
  const built = await w.build();
  assert.ok(built.ok);
  const planned: WorkspaceGroup = { ...built.value, primaryWorkspaceId: built.value.members[0]!.workspaceId };
  await w.groups.save(planned);
  const guard: NonNullable<Deps['plannedWorktreeGuard']> = {
    isGroupProtected: () => false, isWorkspaceProtected: () => false,
    forOutput: () => ({ source: 'local', state: 'closed', groupId: planned.id }), noteStarted() {}
  };
  const before = w.groupGit.calls.length;
  const result = await removeWorkspaceGroupUseCase({ ...w.deps, plannedWorktreeGuard: guard }, { groupId: planned.id });
  assert.equal(result.ok, false);
  assert.equal(w.groupGit.calls.length, before);
  assert.equal(w.groupGit.removed.length, 0);
  assert.ok(w.groups.rows.has(planned.id));
});

test('group deletion rechecks plan protection inside the removal admission lock', async () => {
  const w = await world();
  const built = await w.build();
  assert.ok(built.ok);
  let protectedNow = false;
  let began = false;
  const guard: NonNullable<Deps['plannedWorktreeGuard']> = {
    isGroupProtected: () => protectedNow, isWorkspaceProtected: () => false, forOutput: () => null, noteStarted() {}
  };
  const safety: WorkdirSafety = {
    hasOutstanding: () => false,
    runExclusive: async (fn) => { protectedNow = true; return fn(); },
    assertNoRemoval() {}, assertUnoccupied() {}, assertProjectUnoccupied() {},
    beginRemoval() { began = true; return 'fence'; }, finishRemoval() {}
  };
  const before = w.groupGit.removed.length;
  const result = await removeWorkspaceGroupUseCase({ ...w.deps, plannedWorktreeGuard: guard, workdirSafety: safety }, { groupId: built.value.id });
  assert.equal(result.ok, false);
  assert.equal(began, false);
  assert.equal(w.groupGit.removed.length, before);
  assert.ok(w.groups.rows.has(built.value.id));
});

test('recursive group worktree rollback is admitted before Worker RPC', async () => {
  const w = await world();
  await w.deps.projects.save({ ...w.project, submodules: 'recursive' });
  let calls = 0;
  const safety: WorkdirSafety = {
    hasOutstanding: () => false,
    runExclusive: async (fn) => fn(), assertNoRemoval() {}, assertUnoccupied() {}, assertProjectUnoccupied() {},
    beginRemoval() { throw Error('occupied'); }, finishRemoval() {}
  };
  const groupGit = { ...w.groupGit.git, newWorktree: async (...args: Parameters<WorkspaceGroupGit['newWorktree']>) => { calls++; return w.groupGit.git.newWorktree(...args); } };
  const deps = { ...w.deps, workdirSafety: safety, gateway: { ...w.deps.gateway, groups: () => groupGit } };
  const result = await buildWorkspaceGroupUseCase(deps, { projectId: w.project.id, taskId: w.task.id, workerId: 'remote-1', home: '/home/me' });
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
});

test('建组：每个仓库一个成员，路径 <root>/<name>，全部就绪', async () => {
  const w = await world();
  const built = await w.build();
  assert.ok(built.ok, built.ok ? '' : built.error.message);
  const group = built.value;
  assert.equal(group.state, 'ready');
  assert.equal(groupReady(group), true);
  assert.match(group.root, /^\/srv\/work\/groups\/group_[0-9a-f]{8}$/);
  assert.equal(group.layout, 'amp');
  assert.equal(group.primaryRepoId, w.project.primaryRepoId);
  assert.deepEqual(group.members.map((member) => [member.name, member.state]), [
    ['web', 'ready'],
    ['api', 'ready']
  ]);
  for (const member of group.members) {
    const repo = w.project.repos.find((item) => item.id === member.repoId);
    assert.ok(repo);
    assert.equal(groupMemberRoot(group, member.workspaceId), memberWorktreePath(group.root, repo, group.primaryRepoId!));
    const workspace = await w.deps.workspaces.byId(member.workspaceId);
    assert.ok(workspace);
    assert.equal(workspace.groupId, group.id);
    assert.equal(workspace.kind, 'temporary');
    assert.equal(workspace.source, 'worktree');
    assert.equal(workspace.ownerTaskId, w.task.id);
    assert.equal(workspace.workerId, 'remote-1');
    assert.ok(group.sessionId);
    assert.equal(workspace.branch, `agent-hub/${member.name}-${group.sessionId.replace(/-/g, '').slice(0, 12)}`);
    assert.ok(workspace.baseWorkspaceId, '成员要记着是从哪个长期空间开出来的');
    assert.equal(workspace.state, 'ready');
  }
  // 组行也落了库；容器只 init 一次
  assert.equal(w.groups.rows.size, 1);
  assert.equal(w.groups.rows.get(group.id)?.members.length, 2);
  assert.equal(w.groupGit.calls.filter((call) => call.startsWith('init:')).length, 1);
});

test('某个仓库建 worktree 失败：整组 failed，容器保留，成员登记都留着等重试', async () => {
  const w = await world();
  w.groupGit.failNext('分支已经在别处 checkout');
  const built = await w.build();
  assert.equal(built.ok, false);
  const rows = [...w.groups.rows.values()];
  assert.equal(rows.length, 1);
  const group = rows[0];
  assert.ok(group);
  assert.equal(group.state, 'failed');
  assert.match(group.error ?? '', /分支已经在别处 checkout/);
  // 容器没删：root 还在，可以原地重试
  assert.match(group.root, /^\/srv\/work\/groups\//);
  assert.equal(w.groupGit.calls.some((call) => call.startsWith('remove:')), false);
  assert.deepEqual(group.members.map((member) => [member.name, member.state]), [
    ['web', 'failed'],
    ['api', 'failed']
  ]);
  for (const member of group.members) {
    const workspace = await w.deps.workspaces.byId(member.workspaceId);
    assert.ok(workspace, '失败的成员也要有工作空间登记，重试才有地方下手');
    assert.equal(workspace.state, 'failed');
    const repo = w.project.repos.find((item) => item.id === member.repoId);
    assert.ok(repo);
    assert.equal(groupMemberRoot(group, member.workspaceId), memberWorktreePath(group.root, repo, group.primaryRepoId!));
  }
});

test('重试：只接受 failed 的组；重建成之后整组 ready', async () => {
  const w = await world();
  const ready = await w.build();
  assert.ok(ready.ok);
  const refused = await retryWorkspaceGroupUseCase(w.deps, { groupId: ready.value.id, home: '/home/me' });
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? '' : refused.error.message, /已经准备好了/);

  w.groupGit.failNext('worktree 目录已经存在');
  const broken = await w.build();
  assert.equal(broken.ok, false);
  const group = [...w.groups.rows.values()].find((row) => row.state === 'failed');
  assert.ok(group);
  const retried = await retryWorkspaceGroupUseCase(w.deps, { groupId: group.id, home: '/home/me' });
  assert.ok(retried.ok, retried.ok ? '' : retried.error.message);
  assert.equal(retried.value.state, 'ready');
  assert.deepEqual(retried.value.members.map((member) => member.state), ['ready', 'ready']);
  for (const member of retried.value.members) {
    assert.equal((await w.deps.workspaces.byId(member.workspaceId))?.state, 'ready');
  }
});

test('删组：有 running 会话拒绝；没有就删容器、成员登记与组行', async () => {
  const w = await world();
  const built = await w.build();
  assert.ok(built.ok);
  const group = built.value;
  const member = group.members[0];
  assert.ok(member);
  const session = deriveSession({ task: w.task, agentId: asAgentId('fake'), model: '', now: 2 });
  assert.ok(session.ok);
  await w.deps.sessions.save({ ...session.value, workspaceId: member.workspaceId, groupId: group.id, status: 'running' });
  const refused = await removeWorkspaceGroupUseCase(w.deps, { groupId: group.id, actor: null });
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? '' : refused.error.message, /正在跑的会话/);
  assert.equal(w.groupGit.removed.length, 0);

  await w.deps.sessions.save({ ...session.value, workspaceId: member.workspaceId, groupId: group.id, status: 'done' });
  let occupied = true;
  let fenced = false;
  const safety: WorkdirSafety = {
    hasOutstanding: () => false,
    runExclusive: async (fn) => fn(), assertNoRemoval() {}, assertUnoccupied() {}, assertProjectUnoccupied() {},
    beginRemoval() { if (occupied) throw new Error('occupied'); fenced = true; return 'fence'; },
    finishRemoval() { fenced = false; }
  };
  const deps = { ...w.deps, workdirSafety: safety };
  assert.equal((await removeWorkspaceGroupUseCase(deps, { groupId: group.id, actor: null })).ok, false);
  assert.equal(w.groupGit.removed.length, 0);
  occupied = false;
  const removed = await removeWorkspaceGroupUseCase(deps, { groupId: group.id, actor: null });
  assert.ok(removed.ok, removed.ok ? '' : removed.error.message);
  assert.equal(fenced, false);
  assert.deepEqual(w.groupGit.removed, [{ root: group.root, id: group.id }]);
  for (const each of group.members) {
    assert.equal((await w.deps.workspaces.byId(each.workspaceId))?.state, 'removed');
  }
  assert.equal(w.groups.rows.size, 0);
});

test('group deletion releases settled failures, keeps unknown fences and saves before release', async () => {
  for (const result of ['settled', 'unknown', 'not-removed', 'success', 'save-error'] as const) {
    const w = await world();
    const built = await w.build(); assert.ok(built.ok);
    let fenced = false;
    let sawSave = false;
    const safety: WorkdirSafety = {
      hasOutstanding: () => fenced, runExclusive: async (fn) => fn(), assertNoRemoval() {}, assertUnoccupied() {}, assertProjectUnoccupied() {},
      beginRemoval() { fenced = true; return 'f'; }, finishRemoval() { fenced = false; }
    };
    const groupGit = { ...w.groupGit.git, remove: async () => result === 'settled' ? err({ ...invalid('refused'), operationSettled: true as const }) : result === 'unknown' ? err(invalid('unknown')) : ok({ removed: result !== 'not-removed' }) };
    const workspaces = { ...w.deps.workspaces, save: async (workspace: Workspace) => {
      if (workspace.state === 'removed') { sawSave = fenced; if (result === 'save-error') throw Error('DB failure'); }
      return w.deps.workspaces.save(workspace);
    } };
    const deps = { ...w.deps, workspaces, workdirSafety: safety, gateway: { ...w.deps.gateway, groups: () => groupGit } };
    const remove = () => removeWorkspaceGroupUseCase(deps, { groupId: built.value.id, actor: null });
    if (result === 'save-error') await assert.rejects(remove, /DB failure/);
    else assert.equal((await remove()).ok, result === 'success');
    assert.equal(fenced, result === 'unknown' || result === 'save-error', result);
    if (result === 'save-error' || result === 'success') assert.equal(sawSave, true);
    if (result !== 'success') assert.ok(await w.groups.byId(built.value.id));
  }
});

test('派生会话：给 groupId 就跟着整组走，workspaceId 取 primary 成员', async () => {
  const w = await world();
  w.memory.agents.push({
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
  });
  const built = await w.build();
  assert.ok(built.ok);
  const primary = built.value.members[0]!;
  const derived = await deriveSessionUseCase(w.deps, {
    taskId: w.task.id,
    agentId: 'fake',
    model: '',
    groupId: built.value.id,
    // 传了别的 workspaceId 也该被组覆盖
    workspaceId: built.value.members[1]?.workspaceId ?? null
  });
  assert.ok(derived.ok);
  assert.equal(derived.value.groupId, built.value.id);
  assert.equal(derived.value.workspaceId, primary.workspaceId);
  assert.equal(derived.value.id, built.value.sessionId);
});

test('没指定主仓库不能建组', async () => {
  const w = await world();
  await updateProjectReposUseCase(w.deps, { projectId: w.project.id, repos: w.project.repos, primaryRepoId: null });
  const built = await w.build();
  assert.equal(built.ok, false);
  if (!built.ok) assert.match(built.error.message, /主仓库/);
});

test('建组可以只选一部分仓库，主仓库一定在内', async () => {
  const w = await world();
  const primary = w.project.repos.find((repo) => repo.name === 'web');
  assert.ok(primary);
  const built = await buildWorkspaceGroupUseCase(w.deps, {
    projectId: w.project.id,
    taskId: w.task.id,
    workerId: 'remote-1',
    home: '/home/me',
    repoIds: [primary.id]
  });
  assert.ok(built.ok, built.ok ? '' : built.error.message);
  assert.deepEqual(built.value.members.map((member) => member.name), ['web']);
  assert.equal(groupMemberRoot(built.value, built.value.members[0]!.workspaceId), `${built.value.root}/web`);
});

test('给已有组合追加仓库：worktree 建在 repos/ 下，并标记下一轮要再说明成员', async () => {
  const w = await world();
  const built = await buildWorkspaceGroupUseCase(w.deps, {
    projectId: w.project.id,
    taskId: w.task.id,
    workerId: 'remote-1',
    home: '/home/me',
    repoIds: [w.project.repos.find((repo) => repo.name === 'web')!.id]
  });
  assert.ok(built.ok, built.ok ? '' : built.error.message);
  const addedRepos = await updateProjectReposUseCase(w.deps, {
    projectId: w.project.id,
    repos: [...w.project.repos, { name: 'docs', url: 'https://example.com/docs.git' }],
    primaryRepoId: w.project.primaryRepoId
  });
  assert.ok(addedRepos.ok);
  const docs = addedRepos.value.repos.find((repo) => repo.name === 'docs');
  assert.ok(docs);
  const base = newWorkspace({
    projectId: w.project.id,
    repoUrl: docs.url,
    workerId: 'remote-1',
    path: '/srv/work/docs',
    kind: 'long_lived',
    source: 'cloned',
    isGit: true,
    now: 1
  });
  assert.ok(base.ok);
  await w.deps.workspaces.save(base.value);
  await w.deps.workspaces.claim({ projectId: w.project.id, workspaceId: base.value.id, linkedBy: null, linkedAt: 1 });
  const added = await addWorkspaceGroupMemberUseCase(w.deps, {
    groupId: built.value.id,
    repoId: docs.id,
    home: '/home/me'
  });
  assert.ok(added.ok, added.ok ? '' : added.error.message);
  assert.equal(added.value.pendingBriefing, true);
  const docsMember = added.value.members.find((member) => member.name === 'docs');
  assert.ok(docsMember);
  assert.equal(groupMemberRoot(added.value, docsMember.workspaceId), `${added.value.root}/repos/docs`);
  assert.ok(w.groupGit.calls.some((call) => call.includes('/repos/docs@')));
});

test('删组：成员有未保存改动就整组留下', async () => {
  const w = await world();
  const built = await w.build();
  assert.ok(built.ok);
  const member = built.value.members[0]!;
  const workspace = await w.deps.workspaces.byId(member.workspaceId);
  assert.ok(workspace);
  w.memory.git.statuses.set(workspace.path, { dirty: true, untracked: 0, unpushed: 0, branch: workspace.branch, upstream: null });
  const removed = await removeWorkspaceGroupUseCase(w.deps, { groupId: built.value.id });
  assert.equal(removed.ok, false);
  if (!removed.ok) assert.match(removed.error.message, /没有删/);
  assert.ok(await w.deps.workspaceGroups.byId(built.value.id));
});


test('建组可只选子集；branches / fromGroupId 按已有分支在另一台机器上再建一组', async () => {
  const w = await world();
  const api = w.project.repos.find((repo) => repo.name === 'api');
  assert.ok(api);
  const subset = await buildWorkspaceGroupUseCase(w.deps, {
    projectId: w.project.id,
    taskId: w.task.id,
    workerId: 'remote-1',
    home: '/home/me',
    repoIds: [w.project.primaryRepoId!],
    sessionId: '11111111-1111-4111-8111-111111111111'
  });
  assert.ok(subset.ok, subset.ok ? '' : subset.error.message);
  assert.deepEqual(subset.value.members.map((member) => member.name), ['web']);
  const added = await addWorkspaceGroupMemberUseCase(w.deps, { groupId: subset.value.id, repoId: api.id, home: '/home/me' });
  assert.ok(added.ok, added.ok ? '' : added.error.message);
  assert.deepEqual(added.value.members.map((member) => member.name), ['web', 'api']);

  w.memory.workers.push({ workerId: 'remote-2', label: '验证机', origin: 'remote', state: 'online', roots: ['/srv/work'] });
  const web = added.value.members.find((member) => member.name === 'web');
  assert.ok(web);
  const handed = await buildWorkspaceGroupUseCase(w.deps, {
    projectId: w.project.id,
    taskId: w.task.id,
    workerId: 'remote-2',
    home: '/home/me',
    fromGroupId: added.value.id,
    branches: [{ repoId: api.id, branch: 'agent-hub/api-custom' }]
  });
  assert.ok(handed.ok, handed.ok ? '' : handed.error.message);
  assert.equal(handed.value.workerId, 'remote-2');
  const webWs = await w.deps.workspaces.byId(web.workspaceId);
  const handedWeb = handed.value.members.find((member) => member.name === 'web');
  const handedApi = handed.value.members.find((member) => member.name === 'api');
  assert.ok(handedWeb && handedApi && webWs?.branch);
  const handedWebWs = await w.deps.workspaces.byId(handedWeb.workspaceId);
  const handedApiWs = await w.deps.workspaces.byId(handedApi.workspaceId);
  assert.equal(handedWebWs?.branch, webWs.branch);
  assert.equal(handedApiWs?.branch, 'agent-hub/api-custom');
  assert.ok(w.groupGit.calls.some((call) => call.includes(`@${webWs.branch}`)));
  assert.ok(w.groupGit.calls.some((call) => call.includes('@agent-hub/api-custom')));
});

test('会话通信 P1b · 一仓一会话：只给指定仓库开隔离 worktree（按 id 或名字），不建组；不在项目里的仓库 400', async () => {
  const w = await world();
  const api = w.project.repos.find((repo) => repo.name === 'api')!;
  const prepared = await prepareRepoWorktreeUseCase(w.deps, { projectId: w.project.id, taskId: w.task.id, repoId: api.id, workerId: 'remote-1', home: '/home/me', sessionId: 'sess-abcd1234' });
  assert.ok(prepared.ok, prepared.ok ? '' : prepared.error.message);
  assert.equal(prepared.value.kind, 'temporary');
  assert.equal(prepared.value.repoUrl, api.url);
  assert.equal(prepared.value.groupId ?? null, null);
  assert.match(prepared.value.branch ?? '', /^agent-hub\/api-/);
  assert.match(prepared.value.path, /^\/srv\/work\/\.worktrees\/api\//);
  assert.ok(w.memory.git.calls.some((call) => call.includes('worktree:/srv/work/api->')), w.memory.git.calls.join('\n'));
  assert.equal(w.groups.rows.size, 0);
  const byName = await prepareRepoWorktreeUseCase(w.deps, { projectId: w.project.id, taskId: w.task.id, repoId: 'web', workerId: 'remote-1', home: '/home/me' });
  assert.ok(byName.ok);
  assert.equal(byName.value.repoUrl, 'https://example.com/web.git');
  const missing = await prepareRepoWorktreeUseCase(w.deps, { projectId: w.project.id, taskId: w.task.id, repoId: 'nope', workerId: 'remote-1', home: '/home/me' });
  assert.equal(missing.ok ? null : missing.error.code, 'invalid');
});
