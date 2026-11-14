import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  failedGroupIdFromWorkspaces,
  groupHeadline,
  groupStateNote,
  memberStateLabel,
  workspaceGroupFrom,
  type WorkspaceGroupMemberView
} from './workspace-group.ts';

const member = (over: Partial<WorkspaceGroupMemberView> = {}): WorkspaceGroupMemberView => ({
  workspaceId: 'ws_1',
  repoId: 'repo_1',
  name: 'api',
  state: 'ready',
  error: null,
  ...over
});

test('workspaceGroupFrom：接口返回的形状读成视图', () => {
  const group = workspaceGroupFrom({
    id: 'grp_1',
    projectId: 'p1',
    workerId: 'remote-1',
    root: '/home/me/agent-hub/组合',
    state: 'ready',
    error: null,
    members: [
      { workspaceId: 'ws_1', repoId: 'repo_1', name: 'api', state: 'ready', error: null },
      { workspaceId: 'ws_2', repoId: 'repo_2', name: 'web', state: 'preparing', error: null }
    ]
  });
  assert.ok(group);
  assert.equal(group.id, 'grp_1');
  assert.equal(group.members.length, 2);
  assert.deepEqual(group.members[1], { workspaceId: 'ws_2', repoId: 'repo_2', name: 'web', state: 'preparing', error: null });
});

test('workspaceGroupFrom：形状不对 → null，不抛', () => {
  assert.equal(workspaceGroupFrom(null), null);
  assert.equal(workspaceGroupFrom('nope'), null);
  assert.equal(workspaceGroupFrom([]), null);
  assert.equal(workspaceGroupFrom({ members: [] }), null); // 没有 id
});

test('workspaceGroupFrom：早期叫 repoName 的成员名也认；坏成员丢掉', () => {
  const group = workspaceGroupFrom({
    id: 'grp_1',
    state: 'failed',
    error: '下载失败',
    members: [{ workspaceId: 'ws_1', repoName: 'api', state: 'failed', error: 'exit 128' }, null, 'x', { name: 'no-id' }]
  });
  assert.ok(group);
  assert.equal(group.members.length, 1);
  assert.equal(group.members[0]?.name, 'api');
  assert.equal(group.state, 'failed');
  assert.equal(group.error, '下载失败');
});

test('memberStateLabel：三种状态各自的说法', () => {
  assert.equal(memberStateLabel(member({ state: 'ready' })), '已就绪');
  assert.equal(memberStateLabel(member({ state: 'preparing' })), '准备中');
  assert.equal(memberStateLabel(member({ state: 'failed' })), '准备失败');
});

test('groupHeadline：按成员数说几个仓库', () => {
  assert.equal(groupHeadline(3), '组合工作空间 · 3 个仓库');
  assert.equal(groupHeadline(0), '组合工作空间 · 0 个仓库');
});

test('groupStateNote：失败带原因，准备中给一句话，就绪不占位', () => {
  const base = { id: 'grp_1', projectId: 'p1', workerId: 'w', root: '/r', members: [], error: null } as const;
  assert.equal(groupStateNote({ ...base, state: 'ready' }), null);
  assert.equal(groupStateNote({ ...base, state: 'preparing' }), '正在准备组合工作空间…');
  assert.equal(groupStateNote({ ...base, state: 'failed' }), '组合工作空间准备失败');
  assert.equal(groupStateNote({ ...base, state: 'failed', error: '磁盘满了' }), '组合工作空间准备失败：磁盘满了');
  assert.equal(groupStateNote({ ...base, state: 'failed', error: '  ' }), '组合工作空间准备失败');
});

test('failedGroupIdFromWorkspaces：只认同任务、刚登记的成员', () => {
  const spaces = [
    { id: 'ws_old', ownerTaskId: 't1', groupId: 'grp_old', updatedAt: 100 },
    { id: 'ws_new', ownerTaskId: 't1', groupId: 'grp_new', updatedAt: 900 },
    { id: 'ws_other', ownerTaskId: 't2', groupId: 'grp_other', updatedAt: 1000 },
    { id: 'ws_plain', ownerTaskId: 't1', groupId: null, updatedAt: 1000 },
    { id: 'ws_garbage', ownerTaskId: 't1', groupId: '', updatedAt: 1000 }
  ];
  assert.equal(failedGroupIdFromWorkspaces(spaces, 't1'), 'grp_new');
  // 本次尝试之后才登记：上一次失败的那一组不算
  assert.equal(failedGroupIdFromWorkspaces(spaces, 't1', 500), 'grp_new');
  assert.equal(failedGroupIdFromWorkspaces(spaces, 't1', 901), null);
  assert.equal(failedGroupIdFromWorkspaces(spaces, 't3'), null);
  assert.equal(failedGroupIdFromWorkspaces([null, 'x', 3], 't1'), null);
});
