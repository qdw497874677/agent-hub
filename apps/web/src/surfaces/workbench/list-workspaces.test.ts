import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CanvasDto, WorkspaceViewDto } from '@agent-hub/contract';
import { projectWorkspaceGroups, workspaceSessionGroups, workspaceWorkerLabel } from './list-workspaces.ts';

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

const registered = (id: string, path: string, options: {
  workerId?: string | null; groupId?: string | null; owner?: string | null; state?: Workspace['state']; kind?: Workspace['kind'];
} = {}): WorkspaceViewDto => ({
  workspace: { ...workspace(id, path, options.groupId), workerId: options.workerId ?? null, state: options.state ?? 'ready', kind: options.kind ?? 'long_lived' },
  ownerProjectId: options.owner === undefined ? 'p' : options.owner, ownerProjectName: null, runningTaskIds: [], otherProjectSessions: 0
});

test('项目目录与会话按精确机器、种类、ID 合并，保留空目录和稳定顺序', () => {
  const rows = [session('s1', 'w1', 'one'), session('s2', 'w2', 'one'), session('s3', 'w1', null), session('s4', 'w1', 'gone')];
  const views = [registered('one', '/a/repo', { workerId: 'w1' }), registered('one', '/b/repo', { workerId: 'w2' }), registered('empty', '/c/repo', { workerId: 'w1' }), registered('one', '/d/repo', { workerId: 'w3' })];
  const result = projectWorkspaceGroups(canvas(rows), views, undefined, 'p');
  assert.deepEqual(result.map((group) => group.key), [
    '["w1","workspace","one"]', '["w2","workspace","one"]', '["w1","missing",null]', '["w1","workspace","gone"]',
    '["w1","workspace","empty"]', '["w3","workspace","one"]'
  ]);
  assert.deepEqual(result.map((group) => group.detail), ['/a/repo', '/b/repo', undefined, undefined, '/c/repo', '/d/repo']);
  assert.deepEqual(result.map((group) => group.openWorkspaceId), ['one', 'one', null, null, 'empty', 'one']);
  assert.deepEqual(result.map((group) => group.sessions.map((item) => item.id)), [['s1'], ['s2'], ['s3'], ['s4'], [], []]);
});

test('组合与同 ID 普通目录不混淆；无任务和真实主会话保持既有分组', () => {
  const rows = [session('s1', 'w', 'member', 'same', null), session('s2', 'w', 'member', 'same', null), session('s3', 'w', 'same')];
  const views = [registered('member', '/x/member', { workerId: 'w', groupId: 'same' }), registered('second', '/y/second', { workerId: 'w', groupId: 'same' }), registered('same', '/z/same', { workerId: 'w' })];
  const result = projectWorkspaceGroups(canvas(rows), views, new Set(['s1']), 'p');
  assert.deepEqual(result.map((item) => item.key), ['["w","group","same"]', '["w","workspace","same"]']);
  assert.equal(result[0]?.title, '组合工作空间 · member + second');
  assert.equal(result[0]?.detail, '/x/member · /y/second');
  assert.deepEqual(result[0]?.groups.map((item) => item.kind), ['coordinator', 'unassigned']);
  assert.equal(result[0]?.openWorkspaceId, null);
  assert.equal(result[1]?.openWorkspaceId, 'same');
});

test('打开资格只认明确归属与现有工作目录规则；不可打开的登记仍保留', () => {
  const views = [
    registered('ready', '/ready'), registered('kept', '/kept', { state: 'kept', kind: 'temporary' }),
    registered('unowned', '/unowned', { owner: null }), registered('other', '/other', { owner: 'other' }),
    registered('preparing', '/preparing', { state: 'preparing' }), registered('failed', '/failed', { state: 'failed' }),
    registered('removed', '/removed', { state: 'removed' })
  ];
  const result = projectWorkspaceGroups(canvas([]), views, undefined, 'p');
  assert.deepEqual(result.map((group) => group.openWorkspaceId), ['ready', 'kept', null, null, null, null]);
  assert.equal(projectWorkspaceGroups(canvas([]), views)[0]?.openWorkspaceId, null);
  const withProject = { ...canvas([]), project: { id: 'p' } } as CanvasDto;
  assert.equal(projectWorkspaceGroups(withProject, views)[0]?.openWorkspaceId, 'ready');
});

test('缺失或已删除登记不抹去会话，重复登记不复制组合成员', () => {
  const rows = [session('s1', null, 'gone'), session('s2', null, 'member', 'g')];
  const member = registered('member', '/a/member', { groupId: 'g' });
  const result = projectWorkspaceGroups(canvas(rows), [registered('gone', '/gone', { state: 'removed' }), member, member], undefined, 'p');
  assert.equal(result[0]?.title, '工作空间不可用 · gone');
  assert.equal(result[0]?.openWorkspaceId, null);
  assert.equal(result[1]?.title, '组合工作空间 · member');
  assert.equal(result[1]?.detail, '/a/member');
});

test('组合展示联合登记与同机器画布成员，不合并其他机器同名组合', () => {
  const spaces = [
    { ...workspace('canvas', '/a/canvas', 'g'), workerId: 'w' },
    { ...workspace('foreign', '/b/foreign', 'g'), workerId: 'other' }
  ];
  const result = projectWorkspaceGroups(canvas([session('s1', 'w', 'canvas', 'g')], spaces), [registered('registered', '/c/registered', { workerId: 'w', groupId: 'g' })], undefined, 'p');
  assert.equal(result[0]?.title, '组合工作空间 · registered + canvas');
  assert.equal(result[0]?.detail, '/c/registered · /a/canvas');
});
