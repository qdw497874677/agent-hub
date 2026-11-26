import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CanvasDto } from '@agent-hub/contract';
import type { SessionGroup } from '../../atoms/session-groups.ts';
import { listWorkspaceGroups } from './list-workspaces.ts';

type Session = CanvasDto['sessions'][number];
type Workspace = CanvasDto['workspaces'][number];
const session = (id: string, workerId: string | null, workspaceId: string | null, groupId: string | null = null) =>
  ({ id, workerId, workspaceId, groupId } as Session);
const workspace = (id: string, path: string, groupId: string | null = null) =>
  ({ id, path, groupId, label: null } as Workspace);
const group = (sessions: Session[], taskId = 'task'): SessionGroup => ({
  taskId, kind: 'task', taskless: false, title: 'Task', sessions: sessions.map((item) => ({ session: item, label: item.id }))
});

test('工作空间按任务、机器和稳定 ID 分组，不按同名目录合并', () => {
  const input = group([session('a', 'w1', 'one'), session('b', 'w1', 'two'), session('c', 'w2', 'one'), session('d', 'w1', 'one')]);
  const result = listWorkspaceGroups(input, { workspaces: [workspace('one', '/a/repo'), workspace('two', '/b/repo')] });
  assert.deepEqual(result.map((item) => item.sessions.map(({ session: s }) => s.id)), [['a', 'd'], ['b'], ['c']]);
  assert.equal(new Set(result.map((item) => item.key)).size, 3);
  assert.notEqual(result[0]?.key, listWorkspaceGroups(group([session('a', 'w1', 'one')], 'other'), { workspaces: [] })[0]?.key);
});

test('组合按 groupId 而不是 primary 聚合，缺失信息也明确说明', () => {
  const result = listWorkspaceGroups(group([
    session('a', 'w1', 'one', 'combo'), session('b', 'w1', 'two', 'combo'),
    session('c', 'w1', 'one'), session('d', 'w1', null), session('e', 'w1', 'gone'),
    session('f', 'w1', 'one', 'unknown')
  ]), { workspaces: [workspace('one', '/a/repo', 'combo'), workspace('two', '/b/app', 'combo')] });
  assert.deepEqual(result.map((item) => item.sessions.map(({ session: s }) => s.id)), [['a', 'b'], ['c'], ['d'], ['e'], ['f']]);
  assert.equal(result[0]?.title, '组合工作空间 · repo + app');
  assert.equal(result[2]?.title, '未指定工作空间');
  assert.equal(result[3]?.title, '工作空间不可用 · gone');
  assert.equal(result[4]?.title, '组合工作空间 · repo');
});
