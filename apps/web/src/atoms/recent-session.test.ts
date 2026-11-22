import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homeSessionRows, homeSessionSearch, homeSessionTitle } from './recent-session.ts';
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

test('有会话名：显示会话名，任务名只进搜索和次级信息', () => {
  const [row] = homeSessionRows([
    {
      ...base,
      taskId: 'tsk_1',
      taskTitle: '查登录 bug',
      sessionTitle: '复现登录超时'
    } as unknown as RecentSessionDto
  ]);
  assert.ok(row);
  assert.equal(homeSessionTitle(row), '复现登录超时');
  assert.equal(homeSessionSearch(row), '复现登录超时 查登录 bug agent-hub');
});

test('同一任务下的无标题会话用短 ID 分开，不拿任务名冒充会话名', () => {
  const rows = homeSessionRows([
    { ...base, sessionId: 'ses_abcdef', taskId: 'tsk_1', taskTitle: '查登录 bug' },
    { ...base, sessionId: 'ses_uvwxyz', taskId: 'tsk_1', taskTitle: '查登录 bug' }
  ] as unknown as RecentSessionDto[]);
  assert.deepEqual(rows.map(homeSessionTitle), ['会话 ses_ab', '会话 ses_uv']);
  assert.notEqual(homeSessionTitle(rows[0]!), homeSessionTitle(rows[1]!));
});

test('无任务会话也显示会话名；空白名回退短 ID，不显示 null', () => {
  const rows = homeSessionRows([
    { ...base, sessionId: 'ses_2', taskId: null, taskTitle: '', sessionTitle: '项目主会话' },
    { ...base, sessionId: 'ses_3', taskId: null, taskTitle: '', sessionTitle: '   ' }
  ] as unknown as RecentSessionDto[]);
  assert.deepEqual(rows.map(homeSessionTitle), ['项目主会话', '会话 ses_3']);
});
