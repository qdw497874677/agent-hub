import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CanvasDto, SessionDto, TaskDto } from '@agent-hub/contract';
import { patchCanvasSessionConfig, patchCanvasTask, patchSessionConfig } from './confirmed-patch.ts';

const session = (over: Partial<SessionDto> = {}): SessionDto => ({
  id: 's1',
  taskId: 't1',
  agentId: 'fakeacp',
  model: 'a',
  origin: { kind: 'derive' },
  status: 'running',
  lastSeq: 7,
  turn: 1,
  agentSessionRef: null,
  options: { model: 'a', mode: 'ask' },
  optionSpec: [],
  workerId: null,
  workspaceId: null,
  mcpDisabled: [],
  createdAt: 1,
  updatedAt: 1,
  ...over
});

const task = (over: Partial<TaskDto> = {}): TaskDto => ({
  id: 't1',
  projectId: 'p1',
  title: '任务',
  goal: null,
  status: 'in_progress',
  ownerId: null,
  branch: null,
  summary: null,
  archivedAt: null,
  logSeq: 0,
  createdAt: 1,
  updatedAt: 1,
  ...over
});

const canvas = (over: Partial<CanvasDto> = {}): CanvasDto =>
  ({
    project: { id: 'p1' },
    workspaces: [],
    tasks: [task()],
    sessions: [session()],
    artifacts: [],
    edges: [],
    layout: { projectId: 'p1', positions: {}, sizes: {}, updatedAt: 1 },
    agents: [],
    previews: {},
    openings: {},
    ...over
  }) as CanvasDto;

test('会话配置只并模型与可调项，保留画布里更新的状态与正文位置', () => {
  const base = session({ status: 'running', lastSeq: 12, turn: 2, title: '正在跑' });
  const confirmed = session({ model: 'b', options: { model: 'b', mode: 'ask' }, optionSpec: [], status: 'running', lastSeq: 9 });

  const next = patchSessionConfig(base, confirmed);
  assert.equal(next.model, 'b');
  assert.deepEqual(next.options, { model: 'b', mode: 'ask' });
  assert.equal(next.lastSeq, 12);
  assert.equal(next.turn, 2);
  assert.equal(next.title, '正在跑');
});

test('画布补配置只碰目标会话', () => {
  const other = session({ id: 's2', model: 'z' });
  const base = canvas({ sessions: [session(), other] });
  const next = patchCanvasSessionConfig(base, session({ model: 'b' }));

  assert.deepEqual(next.sessions.map((item) => item.model), ['b', 'z']);
  assert.equal(base.sessions[0]?.model, 'a', '原画布不被就地改动');
  assert.equal(next.project, base.project);
});

test('会话不在画布时原样返回同一对象', () => {
  const base = canvas();
  assert.equal(patchCanvasSessionConfig(base, session({ id: 'missing' })), base);
});

test('归档回执只并归档时间，保留任务其它更新的字段', () => {
  const base = canvas({
    tasks: [task({ status: 'done', summary: '刚写完', logSeq: 8, title: '跑着的标题', updatedAt: 50 })]
  });
  const confirmed = task({ archivedAt: 99, updatedAt: 60, status: 'in_progress', title: '旧标题', logSeq: 2 });
  const archived = patchCanvasTask(base, confirmed);

  assert.equal(archived.tasks[0]?.archivedAt, 99);
  assert.equal(archived.tasks[0]?.updatedAt, 60);
  assert.equal(archived.tasks[0]?.status, 'done');
  assert.equal(archived.tasks[0]?.summary, '刚写完');
  assert.equal(archived.tasks[0]?.logSeq, 8);
  assert.equal(archived.tasks[0]?.title, '跑着的标题');
  assert.equal(base.tasks[0]?.archivedAt, null, '原画布不被就地改动');
  assert.equal(archived.tasks.length, 1);
});

test('恢复回执清掉归档时间，但不把更新的 updatedAt 退回去', () => {
  const base = canvas({
    tasks: [task({ archivedAt: 99, updatedAt: 120, summary: '恢复前刚更新' })]
  });
  const restored = patchCanvasTask(base, task({ archivedAt: null, updatedAt: 110, summary: '旧摘要' }));

  assert.equal(restored.tasks[0]?.archivedAt, null);
  assert.equal(restored.tasks[0]?.updatedAt, 120);
  assert.equal(restored.tasks[0]?.summary, '恢复前刚更新');
});

test('任务不在画布时补进去，不丢已有任务', () => {
  const next = patchCanvasTask(canvas(), task({ id: 't2', title: '另一条' }));
  assert.deepEqual(next.tasks.map((item) => item.id), ['t1', 't2']);
});
