import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DELETE_HINT,
  FORK_HINT,
  MENU_WIDTH,
  dropSession,
  menuPosition,
  normalizeSessionTitle,
  patchSession,
  pinHint,
  sessionActionItems,
  settleGate,
  type SessionActionInput
} from './session-actions.ts';
import { DELETE_SESSION_RUNNING_HINT, DELETE_SESSION_UNAVAILABLE_HINT } from './delete-session.ts';

const idle: SessionActionInput = {
  status: 'done',
  settled: false,
  pinned: false,
  lastSeq: 5,
  turnRunning: false,
  forkDenied: false,
  canExpand: true
};

const ids = (input: SessionActionInput) => sessionActionItems(input).map((item) => item.id);
const item = (input: SessionActionInput, id: string) => sessionActionItems(input).find((entry) => entry.id === id);

test('改名：连续空白并成一个、去头尾；全空白就是清掉名字', () => {
  assert.equal(normalizeSessionTitle('  修 \n 登录   页 '), '修 登录 页');
  assert.equal(normalizeSessionTitle('   '), '');
});

test('收起：跑着的不能收；收起过的能移回', () => {
  assert.deepEqual(settleGate({ settled: false, status: 'running' }), { disabled: true, hint: '会话还在跑，停下来才能收起' });
  assert.equal(settleGate({ settled: false, status: 'done' }).disabled, false);
  assert.equal(settleGate({ settled: true, status: 'running' }).disabled, false);
  assert.match(pinHint(true), /空闲回收/);
});

test('菜单顺序：展开、改名、分叉、收起、常驻、删除；没在跑时没有「停止」', () => {
  assert.deepEqual(ids(idle), ['expand', 'rename', 'fork', 'settle', 'pin', 'delete']);
  assert.deepEqual(ids({ ...idle, canExpand: false }), ['rename', 'fork', 'settle', 'pin', 'delete']);
});

test('这一轮在跑：出现「停止」，分叉置灰并说原因', () => {
  const running = { ...idle, status: 'running' as const, turnRunning: true };
  assert.deepEqual(ids(running).slice(0, 2), ['expand', 'interrupt']);
  const fork = item(running, 'fork');
  assert.equal(fork?.disabled, true);
  assert.equal(fork?.hint, '这一轮还在进行，等它结束再分叉');
  assert.equal(item(running, 'settle')?.disabled, true);
  assert.equal(item(running, 'delete')?.hint, DELETE_SESSION_RUNNING_HINT);
});

test('分叉：没内容 / agent 不支持时置灰；可以时用统一说明', () => {
  assert.equal(item({ ...idle, lastSeq: 0 }, 'fork')?.disabled, true);
  assert.equal(item({ ...idle, forkDenied: true }, 'fork')?.hint, '这个 agent 不支持分叉');
  assert.deepEqual(item(idle, 'fork'), { id: 'fork', label: '分叉', hint: FORK_HINT, disabled: false, danger: false });
});

test('标签随状态变：收起 / 移回活跃，设为常驻 / 取消常驻', () => {
  assert.equal(item(idle, 'settle')?.label, '收起');
  assert.equal(item({ ...idle, settled: true }, 'settle')?.label, '移回活跃');
  assert.equal(item(idle, 'pin')?.label, '设为常驻');
  assert.equal(item({ ...idle, pinned: true }, 'pin')?.label, '取消常驻');
});

test('删除：危险项、带确认的省略号；没权限时说没权限', () => {
  const remove = item(idle, 'delete');
  assert.equal(remove?.danger, true);
  assert.equal(remove?.label, '删除…');
  assert.equal(remove?.hint, DELETE_HINT);
  assert.equal(item({ ...idle, deleteAllowed: false }, 'delete')?.hint, DELETE_SESSION_UNAVAILABLE_HINT);
});

test('缓存改写：只动目标会话；删掉时连带挂在它身上的边', () => {
  const canvas = {
    sessions: [{ id: 'a', pinned: false }, { id: 'b', pinned: false }],
    edges: [
      { kind: 'derive' as const, sessionId: 'a' },
      { kind: 'fork' as const, fromSessionId: 'a', toSessionId: 'b' },
      { kind: 'link' as const, aSessionId: 'b', bSessionId: 'c' }
    ]
  };
  assert.deepEqual(patchSession(canvas, 'b', { pinned: true }).sessions, [{ id: 'a', pinned: false }, { id: 'b', pinned: true }]);
  const dropped = dropSession(canvas, 'a');
  assert.deepEqual(dropped.sessions.map((s) => s.id), ['b']);
  assert.deepEqual(dropped.edges, [{ kind: 'link', aSessionId: 'b', bSessionId: 'c' }]);
});

test('菜单位置：夹在视口里', () => {
  const viewport = { width: 390, height: 600 };
  assert.deepEqual(menuPosition({ x: 20, y: 30 }, 6, viewport), { left: 20, top: 30 });
  const edge = menuPosition({ x: 380, y: 590 }, 6, viewport);
  assert.equal(edge.left, 390 - MENU_WIDTH - 4);
  assert.ok(edge.top + 6 * 44 + 8 <= 600 - 4);
});
