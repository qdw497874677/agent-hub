import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homeSessionRows, homeSessionSearch, homeSessionTitle, UNASSIGNED_SESSION } from './recent-session.ts';
import type { RecentSessionDto } from '@agent-hub/contract';

const base = {
  sessionId: 'ses_1',
  projectId: 'prj_1',
  projectName: 'agent-hub',
  agentId: 'pi',
  status: 'done' as const,
  lastSeq: 3,
  updatedAt: 1
};

test('有任务：还是显示任务名，搜索也算上项目名', () => {
  const [row] = homeSessionRows([{ ...base, taskId: 'tsk_1', taskTitle: '查登录 bug' } as unknown as RecentSessionDto]);
  assert.ok(row);
  assert.equal(homeSessionTitle(row), '查登录 bug');
  assert.equal(homeSessionSearch(row), '查登录 bug agent-hub');
});

test('无任务会话：有名字用名字，没有就如实说「没有任务的会话」，不显示 null', () => {
  const rows = homeSessionRows([
    { ...base, sessionId: 'ses_2', taskId: null, taskTitle: '', title: '项目主会话' },
    { ...base, sessionId: 'ses_3', taskId: null, taskTitle: '' }
  ] as unknown as RecentSessionDto[]);
  assert.deepEqual(rows.map(homeSessionTitle), ['项目主会话', UNASSIGNED_SESSION]);
  // 空字符串 / 纯空白任务名都不能冒出来
  assert.equal(homeSessionTitle({ ...rows[1]!, taskTitle: '   ' }), UNASSIGNED_SESSION);
});

test('契约还没补上 title 时也不炸：缺字段走任务名/兜底', () => {
  const [row] = homeSessionRows([{ ...base, taskId: 'tsk_2', taskTitle: '改文档' } as unknown as RecentSessionDto]);
  assert.ok(row);
  assert.equal(homeSessionTitle({ ...row, title: undefined }), '改文档');
  assert.equal(homeSessionTitle({ ...row, title: '  ' }), '改文档');
});
