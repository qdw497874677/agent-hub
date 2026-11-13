import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SETUP_COMMAND_MAX,
  WORKTREE_TIMEOUT_DEFAULT,
  WORKTREE_TIMEOUT_MAX,
  WORKTREE_TIMEOUT_MIN,
  projectWorktree,
  setupOutputTail,
  setupStatusLine,
  workspaceSetup,
  worktreeDraft,
  worktreeDraftProblem,
  worktreePayload,
  type WorktreeDraft
} from './worktree-config.ts';

const draft = (over: Partial<WorktreeDraft> = {}): WorktreeDraft => ({
  mode: 'shared',
  command: '',
  waitForSetup: false,
  timeout: String(WORKTREE_TIMEOUT_DEFAULT),
  ...over
});

test('worktreeDraft：老项目没有 worktree 字段 → 共用、不跑命令、默认超时', () => {
  assert.deepEqual(worktreeDraft({ id: 'p1', name: 'x' }), {
    mode: 'shared',
    command: '',
    waitForSetup: false,
    timeout: '600'
  });
  // 字段存在但为 null 也一样
  assert.deepEqual(worktreeDraft({ worktree: null }), worktreeDraft({}));
});

test('worktreeDraft：读回孤立档位和准备命令', () => {
  const project = {
    worktree: {
      mode: 'isolated',
      setup: { command: ' npm ci && npm run db:migrate ', waitForSetup: true, timeoutSeconds: 120 }
    }
  };
  assert.deepEqual(worktreeDraft(project), {
    mode: 'isolated',
    command: ' npm ci && npm run db:migrate ',
    waitForSetup: true,
    timeout: '120'
  });
});

test('projectWorktree：模式 / 超时不合理时退回安全值，空命令当没配', () => {
  const parsed = projectWorktree({ worktree: { mode: 'weird', setup: { command: 'npm ci', waitForSetup: 'yes', timeoutSeconds: 5 } } });
  assert.deepEqual(parsed, {
    mode: 'shared',
    setup: { command: 'npm ci', waitForSetup: false, timeoutSeconds: WORKTREE_TIMEOUT_DEFAULT }
  });
  assert.equal(projectWorktree({ worktree: { mode: 'isolated', setup: { command: '   ' } } })?.setup, null);
  assert.equal(projectWorktree({ worktree: 'nope' }), null);
});

test('worktreeDraftProblem：命令为空但开了等待 → 提醒；等待关掉则放行', () => {
  assert.match(worktreeDraftProblem(draft({ command: '', waitForSetup: true })) ?? '', /还没写命令/);
  assert.equal(worktreeDraftProblem(draft({ command: '', waitForSetup: false })), null);
  assert.equal(worktreeDraftProblem(draft({ command: '  npm ci  ', waitForSetup: true })), null);
});

test('worktreeDraftProblem：超时必须是区间内的整数秒', () => {
  for (const timeout of ['', 'abc', '1.5', '30.5']) {
    assert.notEqual(worktreeDraftProblem(draft({ command: 'npm ci', timeout })), null, `timeout=${timeout}`);
  }
  assert.match(worktreeDraftProblem(draft({ command: 'npm ci', timeout: '10' })) ?? '', /30–1800/);
  assert.match(worktreeDraftProblem(draft({ command: 'npm ci', timeout: '1801' })) ?? '', /30–1800/);
  assert.equal(worktreeDraftProblem(draft({ command: 'npm ci', timeout: '30' })), null);
  assert.equal(worktreeDraftProblem(draft({ command: 'npm ci', timeout: String(WORKTREE_TIMEOUT_MAX) })), null);
});

test('worktreeDraftProblem：命令超过 4000 字符报错，刚好 4000 放行', () => {
  assert.match(worktreeDraftProblem(draft({ command: 'x'.repeat(SETUP_COMMAND_MAX + 1) })) ?? '', /太长/);
  assert.equal(worktreeDraftProblem(draft({ command: 'x'.repeat(SETUP_COMMAND_MAX) })), null);
});

test('worktreePayload：命令去空白、超时转数字；空命令 → setup: null', () => {
  assert.deepEqual(worktreePayload(draft({ mode: 'isolated', command: '  npm ci  ', waitForSetup: true, timeout: '120' })), {
    worktree: {
      mode: 'isolated',
      setup: { command: 'npm ci', waitForSetup: true, timeoutSeconds: 120 }
    }
  });
  assert.deepEqual(worktreePayload(draft({ command: '   ', timeout: '999' })), {
    worktree: { mode: 'shared', setup: null }
  });
  // 保存前总有校验兜着；万一被绕过，非法超时回默认而不是写进库
  assert.deepEqual(worktreePayload(draft({ command: 'npm ci', timeout: 'abc' })), {
    worktree: {
      mode: 'shared',
      setup: { command: 'npm ci', waitForSetup: false, timeoutSeconds: WORKTREE_TIMEOUT_DEFAULT }
    }
  });
});

test('setupStatusLine：没准备过不占位置，准备中给中性提示', () => {
  assert.equal(setupStatusLine(null), null);
  assert.deepEqual(setupStatusLine({ state: 'none', exitCode: null, message: null, output: null, startedAt: null, finishedAt: null }), null);
  assert.deepEqual(setupStatusLine({ state: 'running', exitCode: null, message: null, output: 'partial', startedAt: 1, finishedAt: null }), {
    tone: 'busy',
    text: '正在准备 worktree…'
  });
});

test('setupStatusLine：失败带原因，没有原因时退回退出码', () => {
  const failed = setupStatusLine({ state: 'failed', exitCode: 1, message: 'npm ci 失败', output: 'ERR', startedAt: 1, finishedAt: 2 });
  assert.equal(failed?.tone, 'bad');
  assert.equal(failed?.text, '准备失败：npm ci 失败');
  const bare = setupStatusLine({ state: 'failed', exitCode: 127, message: null, output: null, startedAt: 1, finishedAt: 2 });
  assert.equal(bare?.text, '准备失败：退出码 127');
});

test('setupStatusLine：就绪且有输出才显示「准备完成」，无输出则安静', () => {
  assert.deepEqual(setupStatusLine({ state: 'ready', exitCode: 0, message: null, output: 'added 42 packages', startedAt: 1, finishedAt: 2 }), {
    tone: 'ok',
    text: '准备完成'
  });
  assert.equal(setupStatusLine({ state: 'ready', exitCode: 0, message: null, output: '   ', startedAt: 1, finishedAt: 2 }), null);
  assert.equal(setupStatusLine({ state: 'ready', exitCode: 0, message: null, output: null, startedAt: 1, finishedAt: 2 }), null);
});

test('workspaceSetup：缺字段 / 坏类型都读成 null，不认识的状态当 none', () => {
  assert.equal(workspaceSetup({ id: 'w1' }), null);
  assert.equal(workspaceSetup({ setup: 'nope' }), null);
  assert.deepEqual(workspaceSetup({ setup: { state: 'ready', exitCode: 0, output: 'ok', startedAt: 10, finishedAt: 20 } }), {
    state: 'ready',
    exitCode: 0,
    message: null,
    output: 'ok',
    startedAt: 10,
    finishedAt: 20
  });
  assert.equal(workspaceSetup({ setup: { state: 'weird', exitCode: 'x', startedAt: 'y' } })?.state, 'none');
  assert.equal(workspaceSetup({ setup: { state: 'failed', exitCode: 1.5 } })?.exitCode, null);
});

test('setupOutputTail：只留最后 8KB', () => {
  const long = 'a'.repeat(9000) + 'END';
  assert.equal(setupOutputTail(long).length, 8192);
  assert.ok(setupOutputTail(long).endsWith('END'));
  assert.equal(setupOutputTail('short'), 'short');
  assert.equal(setupOutputTail(null), '');
});

test('workspaceSetup：准备的起止时间只收有限的数字', () => {
  const parsed = workspaceSetup({ setup: { state: 'running', startedAt: Number.NaN, finishedAt: Number.POSITIVE_INFINITY } });
  assert.equal(parsed?.startedAt, null);
  assert.equal(parsed?.finishedAt, null);
  assert.ok(WORKTREE_TIMEOUT_MIN < WORKTREE_TIMEOUT_MAX);
});
