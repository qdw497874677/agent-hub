import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { asAgentId } from '../ids.ts';
import { invalid } from '../errors.ts';
import { ok, err } from '../result.ts';
import { deriveSession } from '../session.ts';
import { newWorkspace } from '../workspace.ts';
import { groupMemberRoot, groupReady, type WorkspaceGroup } from '../workspace-group.ts';
import type { WorkspaceGroupGit } from '../ports/workspace-group-git.ts';
import type { WorkspaceGroupRepository } from '../ports/workspace-groups.ts';
import type { Deps } from './deps.ts';
import { createProjectUseCase, updateProjectReposUseCase } from './projects.ts';
import { createTaskUseCase } from './tasks.ts';
import { buildWorkspaceGroupUseCase, removeWorkspaceGroupUseCase, retryWorkspaceGroupUseCase } from './workspace-groups.ts';

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
    await deps.workspaces.link({ projectId: project.value.id, workspaceId: base.value.id, linkedBy: null, linkedAt: 1 });
  }
  const build = () =>
    buildWorkspaceGroupUseCase(deps, {
      projectId: project.value.id,
      taskId: task.value.id,
      workerId: 'remote-1',
      home: '/home/me'
    });
  return { deps, groups, groupGit, project: withRepos.value, task: task.value, build };
}

test('建组：每个仓库一个成员，路径 <root>/<name>，全部就绪', async () => {
  const w = await world();
  const built = await w.build();
  assert.ok(built.ok, built.ok ? '' : built.error.message);
  const group = built.value;
  assert.equal(group.state, 'ready');
  assert.equal(groupReady(group), true);
  assert.match(group.root, /^\/srv\/work\/groups\/group_[0-9a-f]{8}$/);
  assert.deepEqual(group.members.map((member) => [member.name, member.state]), [
    ['web', 'ready'],
    ['api', 'ready']
  ]);
  for (const member of group.members) {
    assert.equal(groupMemberRoot(group, member.workspaceId), `${group.root}/${member.name}`);
    const workspace = await w.deps.workspaces.byId(member.workspaceId);
    assert.ok(workspace);
    assert.equal(workspace.groupId, group.id);
    assert.equal(workspace.kind, 'temporary');
    assert.equal(workspace.source, 'worktree');
    assert.equal(workspace.ownerTaskId, w.task.id);
    assert.equal(workspace.workerId, 'remote-1');
    assert.match(workspace.branch ?? '', new RegExp(`^agent-hub/${member.name}-[0-9a-f]{4}$`));
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
    assert.equal(groupMemberRoot(group, member.workspaceId), `${group.root}/${member.name}`);
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
  const removed = await removeWorkspaceGroupUseCase(w.deps, { groupId: group.id, actor: null });
  assert.ok(removed.ok, removed.ok ? '' : removed.error.message);
  assert.deepEqual(w.groupGit.removed, [{ root: group.root, id: group.id }]);
  for (const each of group.members) {
    assert.equal((await w.deps.workspaces.byId(each.workspaceId))?.state, 'removed');
  }
  assert.equal(w.groups.rows.size, 0);
});
