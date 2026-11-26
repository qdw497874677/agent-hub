import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CanvasDto } from '@agent-hub/contract';
import { workspaceSessionGroups, workspaceWorkerLabel } from './list-workspaces.ts';

type Session = CanvasDto['sessions'][number];
type Workspace = CanvasDto['workspaces'][number];
const session = (id: string, workerId: string | null, workspaceId: string | null, groupId: string | null = null, taskId: string | null = 'task') =>
  ({ id, workerId, workspaceId, groupId, taskId, createdAt: Number(id.replace(/\D/g, '')) || 0 } as Session);
const workspace = (id: string, path: string, groupId: string | null = null) =>
  ({ id, path, groupId, label: null } as Workspace);
const canvas = (sessions: Session[], workspaces: Workspace[] = []) => ({
  sessions, workspaces, tasks: [{ id: 'task', title: '任务' }], previews: {}, openings: {}
} as CanvasDto);

test('身份由机器和稳定 ID 决定，同任务跨空间且不重复；改任务关联不改空间 key', () => {
  const rows = [session('s1', 'w1', 'one'), session('s2', 'w1', 'two'), session('s3', 'w2', 'one'), session('s4', 'w1', 'one', null, null)];
  const spaces = [workspace('one', '/a/repo'), workspace('two', '/b/repo')];
  const result = workspaceSessionGroups(canvas(rows, spaces), new Set(['s4']));
  assert.deepEqual(result.map((item) => item.sessions.map((s) => s.id)), [['s1', 's4'], ['s2'], ['s3']]);
  assert.deepEqual(result[0]?.groups.map((item) => item.kind), ['task', 'coordinator']);
  assert.deepEqual(result.map((item) => item.detail), ['/a/repo', '/b/repo', '/a/repo']);
  assert.equal(new Set(result.map((item) => item.key)).size, 3);
  assert.equal(result[0]?.key, workspaceSessionGroups(canvas([{ ...rows[0]!, taskId: 'other' }], spaces))[0]?.key);
});

test('组合按 groupId 聚合，路径仅来自确认的成员；缺失信息明确', () => {
  const rows = [session('s1', 'w1', 'one', 'combo'), session('s2', 'w1', 'two', 'combo'), session('s3', 'w1', null), session('s4', 'w1', 'gone'), session('s5', 'w1', 'one', 'unknown-combo')];
  const result = workspaceSessionGroups(canvas(rows, [workspace('one', '/a/repo', 'combo'), workspace('two', '/b/app', 'combo')]));
  assert.deepEqual(result.map((item) => item.sessions.map((s) => s.id)), [['s1', 's2'], ['s3'], ['s4'], ['s5']]);
  assert.equal(result[0]?.title, '组合工作空间 · repo + app');
  assert.equal(result[0]?.detail, '/a/repo · /b/app');
  assert.equal(result[1]?.title, '未指定工作空间');
  assert.equal(result[2]?.title, '工作空间不可用 · gone');
  assert.equal(result[3]?.title, '组合工作空间不可用 · unknown-');
  assert.equal(result[3]?.detail, undefined);
});

test('未解析机器不叫本机', () => {
  assert.equal(workspaceWorkerLabel('remote-123456'), '机器 remote-1');
  assert.equal(workspaceWorkerLabel('remote-123456', '办公机'), '办公机');
  assert.equal(workspaceWorkerLabel(null), '本机');
});
