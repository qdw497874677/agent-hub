import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { asProjectId, asWorkspaceGroupId, asWorkspaceId } from '@agent-hub/domain';
import type { WorkspaceGroup } from '@agent-hub/domain';
import { createSqliteWorkspaceGroups, groupIdOfWorkspace } from './workspace-groups.ts';

const group = (over: Partial<WorkspaceGroup> = {}): WorkspaceGroup => ({
  id: asWorkspaceGroupId('group_00000001'),
  projectId: asProjectId('p1'),
  workerId: 'remote-1',
  root: '/srv/work/agent-hub-groups/demo/x1',
  members: [
    { workspaceId: asWorkspaceId('ws_a'), repoId: 'repo_a', name: 'web', state: 'ready', error: null },
    { workspaceId: asWorkspaceId('ws_b'), repoId: 'repo_b', name: 'api', state: 'preparing', error: null }
  ],
  state: 'preparing',
  ownerTaskId: null,
  createdAt: 10,
  error: null,
  ...over
});

test('组合工作空间仓储：存进去按 position 取出，覆盖写会清掉旧成员', async () => {
  const db = new DatabaseSync(':memory:');
  const repo = createSqliteWorkspaceGroups(db);
  await repo.save(group());
  const first = await repo.byId(group().id);
  assert.ok(first);
  assert.deepEqual(first.members.map((member) => member.name), ['web', 'api']);

  const replaced = group({
    state: 'ready',
    members: [{ workspaceId: asWorkspaceId('ws_c'), repoId: 'repo_c', name: 'docs', state: 'ready', error: null }]
  });
  await repo.save(replaced);
  const second = await repo.byId(group().id);
  assert.ok(second);
  assert.equal(second.state, 'ready');
  assert.deepEqual(second.members.map((member) => member.name), ['docs']);
  assert.equal(groupIdOfWorkspace(db, asWorkspaceId('ws_a')), null);
  assert.equal(groupIdOfWorkspace(db, asWorkspaceId('ws_c')), group().id);
});

test('组合工作空间仓储：按项目列新→旧，remove 只删归属', async () => {
  const db = new DatabaseSync(':memory:');
  const repo = createSqliteWorkspaceGroups(db);
  await repo.save(group({ createdAt: 10 }));
  await repo.save(group({ id: asWorkspaceGroupId('group_00000002'), createdAt: 20 }));
  const listed = await repo.listByProject(asProjectId('p1'));
  assert.deepEqual(listed.map((item) => item.id), [asWorkspaceGroupId('group_00000002'), asWorkspaceGroupId('group_00000001')]);

  await repo.remove(asWorkspaceGroupId('group_00000002'));
  assert.equal(await repo.byId(asWorkspaceGroupId('group_00000002')), null);
  assert.equal(groupIdOfWorkspace(db, asWorkspaceId('ws_a')), group().id);
});
