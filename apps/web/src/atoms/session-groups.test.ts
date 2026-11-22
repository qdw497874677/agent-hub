import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COORDINATOR_KEY, COORDINATOR_TITLE, groupSessions, UNASSIGNED_KEY, UNASSIGNED_TITLE } from './session-groups.ts';
import type { CanvasDto } from '@agent-hub/contract';

type Session = CanvasDto['sessions'][number];
type Task = CanvasDto['tasks'][number];

function session(id: string, taskId: string | null, createdAt = 1, title: string | null = null): Session {
  return {
    id,
    taskId,
    title,
    createdAt,
    agentId: 'pi',
    model: 'pi-default',
    status: 'done',
    lastSeq: 0,
    origin: { kind: 'chat' },
    workspaceId: null,
    workerId: null,
    settledAt: null,
    pinned: false
  } as unknown as Session;
}

function task(id: string, title: string): Task {
  return { id, title, status: 'running', branch: null } as unknown as Task;
}

const canvas = (tasks: Task[], sessions: Session[]) =>
  ({ tasks, sessions, previews: {}, openings: {} }) satisfies Pick<CanvasDto, 'tasks' | 'sessions' | 'previews' | 'openings'>;

test('无任务会话自成一组：组名中性，不冒充任务', () => {
  const groups = groupSessions(canvas([task('tsk_1', '查登录 bug')], [
    session('ses_a', 'tsk_1', 1),
    session('ses_b', null, 2, '项目主会话')
  ]));
  assert.deepEqual(groups.map((group) => [group.taskId, group.title, group.taskless]), [
    ['tsk_1', '查登录 bug', false],
    [UNASSIGNED_KEY, UNASSIGNED_TITLE, true]
  ]);
  // 行还是用会话自己的名字，组名只说明「没有任务」
  assert.equal(groups[1]?.sessions[0]?.label, '项目主会话');
});

test('任务下面没有会话就不出组；只有无任务会话时也成组', () => {
  const groups = groupSessions(canvas([task('tsk_1', '任务一')], [session('ses_a', null, 3)]));
  assert.deepEqual(groups.map((group) => group.taskId), [UNASSIGNED_KEY]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.taskless, true);

  const onlyTaskless = groupSessions(canvas([], [session('ses_a', null, 1), session('ses_b', null, 2)]));
  assert.equal(onlyTaskless.length, 1);
  assert.equal(onlyTaskless[0]?.sessions.length, 2);
});

test('同一个任务的会话按开始时间排，没任务的也照此排', () => {
  const groups = groupSessions(canvas([], [session('ses_late', null, 20), session('ses_early', null, 10)]));
  assert.deepEqual(groups[0]?.sessions.map((entry) => entry.session.id), ['ses_early', 'ses_late']);
});

test('登记过的主会话单独一组，和 bot / 群的不喊成同一句', () => {
  // 三条都没有任务，但只有 ses_main 在登记表里：另外两条不能被冒称「主会话」。
  const groups = groupSessions(
    canvas([], [session('ses_main', null, 1, '项目主会话'), session('ses_bot', null, 2), session('ses_group', null, 3)]),
    new Set(['ses_main'])
  );
  assert.deepEqual(groups.map((group) => [group.taskId, group.kind, group.title]), [
    [COORDINATOR_KEY, 'coordinator', COORDINATOR_TITLE],
    [UNASSIGNED_KEY, 'unassigned', UNASSIGNED_TITLE]
  ]);
  assert.deepEqual(groups[0]?.sessions.map((entry) => entry.session.id), ['ses_main']);
  assert.deepEqual(groups[1]?.sessions.map((entry) => entry.session.id), ['ses_bot', 'ses_group']);
});

test('没有登记信息时（接口还没接上）全按中性组，绝不默认叫主会话', () => {
  const groups = groupSessions(canvas([], [session('ses_a', null, 1)]));
  assert.deepEqual(groups.map((group) => group.kind), ['unassigned']);
});
