import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { asProjectId, asWorkspaceGroupId, asWorkspaceId } from '../ids.ts';
import { newWorkspace } from '../workspace.ts';
import type { WorkspaceGroup } from '../workspace-group.ts';
import type { WorkspaceGroupRepository } from '../ports/workspace-groups.ts';
import { locationsOf } from './workspaces.ts';

const project = {
  id: asProjectId('prj_1'),
  name: 'Demo App',
  repo: null,
  repos: [],
  description: null,
  worktree: null,
  createdAt: 1,
  teamId: null,
  createdBy: null,
  members: [],
  deletedAt: null
};

function groupRepo(group: WorkspaceGroup): WorkspaceGroupRepository {
  return {
    async byId(id) {
      return id === group.id ? group : null;
    },
    async listByProject() {
      return [group];
    },
    async save() {},
    async remove() {}
  };
}

const group: WorkspaceGroup = {
  id: asWorkspaceGroupId('group_deadbeef'),
  projectId: project.id,
  workerId: 'remote-1',
  root: '/srv/work/agent-hub-groups/demo-app/x1',
  members: [
    { workspaceId: asWorkspaceId('ws_a'), repoId: 'repo_a', name: 'web', state: 'ready', error: null },
    { workspaceId: asWorkspaceId('ws_b'), repoId: 'repo_b', name: 'api', state: 'preparing', error: null }
  ],
  state: 'preparing',
  ownerTaskId: null,
  createdAt: 1,
  error: null
};

test('组合工作空间：容器根 + 每个成员仓库的真实路径', async () => {
  const w = inMemoryDeps();
  const deps = { ...w.deps, workspaceGroups: groupRepo(group) };
  const located = await locationsOf(deps, project, {
    workerId: 'remote-1',
    workspaceId: asWorkspaceId('ws_a'),
    groupId: group.id
  });
  assert.equal(located.root, '/srv/work/agent-hub-groups/demo-app/x1');
  assert.equal(located.workerId, 'remote-1');
  assert.deepEqual(
    located.members.map((member) => [member.name, member.root, member.state]),
    [
      ['web', '/srv/work/agent-hub-groups/demo-app/x1/web', 'ready'],
      ['api', '/srv/work/agent-hub-groups/demo-app/x1/api', 'preparing']
    ]
  );
});

test('单仓库会话：一项成员，root 就是那个工作空间', async () => {
  const w = inMemoryDeps();
  const longLived = newWorkspace({
    projectId: project.id,
    workerId: 'remote-1',
    path: '/srv/work/demo-app/',
    kind: 'long_lived',
    source: 'linked',
    now: 1
  });
  assert.ok(longLived.ok);
  await w.deps.workspaces.save(longLived.value);
  const located = await locationsOf(w.deps, project, { workerId: 'remote-1', workspaceId: longLived.value.id });
  assert.equal(located.group, null);
  assert.equal(located.root, '/srv/work/demo-app');
  assert.deepEqual(located.members.map((member) => member.root), ['/srv/work/demo-app']);
});

test('没有工作空间也没有默认空间：root 空串（调用方必须拒绝）', async () => {
  const w = inMemoryDeps();
  const located = await locationsOf(w.deps, project, { workerId: null, workspaceId: null });
  assert.equal(located.root, '');
  assert.deepEqual(located.members, []);
});
