import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskProgress } from './task-progress.ts';
import type { TaskDispatch, WorkLogRepository } from '@agent-hub/domain';

function dispatch(over: Partial<TaskDispatch> = {}): TaskDispatch {
  return {
    id: 'd1',
    taskId: 't1',
    accountId: 'a1',
    projectId: 'p1',
    title: '补外部 MCP 的缺口',
    goal: '',
    human: true,
    notifySessionId: 's1',
    agentId: 'opencode',
    model: '',
    originConnector: null,
    originExternalId: null,
    state: 'running',
    workerId: 'w1',
    sessionId: 's1',
    waitReason: null,
    result: null,
    notified: false,
    createdAt: 0,
    startedAt: 0,
    updatedAt: 0,
    ...over
  };
}

function harness(options: { inGroup?: boolean } = {}) {
  const logged: string[] = [];
  const posted: { groupId: string; body: string }[] = [];
  let clock = 0;
  const reporter = createTaskProgress({
    now: () => clock,
    workLog: {
      append: async (draft: Parameters<WorkLogRepository['append']>[0]) => {
        logged.push(draft.body);
        return { ...draft, seq: logged.length, supersededBy: null } as never;
      }
    } as unknown as WorkLogRepository,
    groupOfSession: async (id) => (options.inGroup === false ? null : { groupId: `g-${id}` }),
    postToGroup: async (groupId, body) => void posted.push({ groupId, body })
  });
  return { reporter, logged, posted, tick: (ms: number) => void (clock += ms) };
}

test('任务开始/结束：写进任务日志；群来源再发一条系统帖', async () => {
  const h = harness();
  await h.reporter.emit(dispatch(), 'started');
  await h.reporter.emit(dispatch({ state: 'done', result: '改了 3 个文件' }), 'finished', '改了 3 个文件');
  assert.equal(h.logged.length, 2);
  assert.match(h.logged[0]!, /开始处理/);
  assert.match(h.logged[1]!, /完成/);
  assert.deepEqual(h.posted.map((p) => p.groupId), ['g-s1', 'g-s1']);
});

test('阶段进展：节流后只落一条，且不刷群', async () => {
  const h = harness();
  await h.reporter.emit(dispatch(), 'milestone', 'bash');
  await h.reporter.emit(dispatch(), 'milestone', 'grep');
  assert.equal(h.logged.length, 1, '间隔不够的第二条被吞掉');
  assert.match(h.logged[0]!, /跑命令/);
  h.tick(120_000);
  await h.reporter.emit(dispatch(), 'milestone', 'edit');
  assert.equal(h.logged.length, 2);
  assert.match(h.logged[1]!, /改文件/);
});

test('来源不是群：只写任务日志，不往任何群发', async () => {
  const h = harness({ inGroup: false });
  await h.reporter.emit(dispatch(), 'started');
  assert.equal(h.logged.length, 1);
  assert.equal(h.posted.length, 0);
});
