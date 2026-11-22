import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanvasDto } from '@agent-hub/contract';
import { splitArchivedTasks } from './task-display.ts';

function canvas(overrides: Partial<CanvasDto> = {}): CanvasDto {
  return {
    project: { id: 'p', name: '项目', rootPath: '/p' },
    tasks: [],
    sessions: [],
    agents: [],
    workspaces: [],
    openings: {},
    layout: {},
    ...overrides
  } as unknown as CanvasDto;
}

test('归档任务从日常视图退场，连同它名下的会话', () => {
  const raw = canvas({
    tasks: [
      { id: 'keep', title: '保留', archivedAt: null },
      { id: 'gone', title: '归档', archivedAt: 10 }
    ],
    sessions: [
      { id: 's1', taskId: 'keep' },
      { id: 's2', taskId: 'gone' }
    ]
  } as unknown as Partial<CanvasDto>);

  const display = splitArchivedTasks(raw);
  assert.deepEqual(display.archived.map((task) => task.id), ['gone']);
  assert.deepEqual(display.canvas.tasks.map((task) => task.id), ['keep']);
  assert.deepEqual(display.canvas.sessions.map((session) => session.id), ['s1']);
});

test('没有任务归属的会话照常保留，不能被任务过滤顺手扫掉', () => {
  const raw = canvas({
    tasks: [{ id: 'gone', title: '归档', archivedAt: 10 }],
    sessions: [
      { id: 'loose', taskId: null },
      { id: 'hidden', taskId: 'gone' }
    ]
  } as unknown as Partial<CanvasDto>);

  const display = splitArchivedTasks(raw);
  assert.deepEqual(display.canvas.sessions.map((session) => session.id), ['loose']);
  assert.equal(display.archived.length, 1);
});

test('没有归档任务时返回同一份画布，不制造多余重渲染', () => {
  const raw = canvas();
  assert.equal(splitArchivedTasks(raw).canvas, raw);
});
