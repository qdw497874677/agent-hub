import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionDto } from '@agent-hub/contract';
import { sessionLinkInfo } from './session-link-info.ts';

function session(patch: Partial<SessionDto> = {}): SessionDto {
  return {
    id: 's-1',
    taskId: 't-1',
    agentId: 'agent-7f3a',
    model: 'gpt-5',
    origin: { kind: 'derive' },
    status: 'running',
    lastSeq: 3,
    agentSessionRef: null,
    options: {},
    optionSpec: [],
    workerId: null,
    workspaceId: null,
    title: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_060_000,
    ...patch
  } as SessionDto;
}

test('小窗信息：没起名就把首句当名字，下面不再重复一遍', () => {
  const info = sessionLinkInfo({ session: session({ title: null }), opening: '  看看登录\n日志  ' });
  assert.equal(info.name, '看看登录 日志');
  assert.equal(info.preview, null);
});

test('小窗信息：起过名用名字，首句进摘要（换行折成空格）', () => {
  const info = sessionLinkInfo({ session: session({ title: '查登录 bug' }), opening: '第一条：\n看看日志' });
  assert.equal(info.name, '查登录 bug');
  assert.equal(info.preview, '第一条： 看看日志');
});

test('小窗信息：什么都没有才是「未命名会话」，摘要为空', () => {
  const info = sessionLinkInfo({ session: session({ title: null }), opening: undefined });
  assert.equal(info.name, '未命名会话');
  assert.equal(info.preview, null);
  assert.equal(sessionLinkInfo({ session: session({ title: '   ' }), opening: '  ' }).name, '未命名会话');
});

test('小窗信息：超长首句先截到 160 字以内，末尾留省略号', () => {
  const info = sessionLinkInfo({ session: session({ title: '长会话' }), opening: '啊'.repeat(400) });
  assert.equal(info.preview?.length, 160);
  assert.ok(info.preview?.endsWith('…'));
});

test('小窗信息：运行时优先显示 agent 显示名，没有才落回 agentId', () => {
  assert.equal(sessionLinkInfo({ session: session(), agentLabel: 'Claude Code' }).runtime, 'Claude Code · gpt-5');
  assert.equal(sessionLinkInfo({ session: session() }).runtime, 'agent-7f3a · gpt-5');
  assert.equal(sessionLinkInfo({ session: session({ model: '' }), agentLabel: 'Codex' }).runtime, 'Codex');
});

test('小窗信息：分叉给出「分叉自」，来源找不到也有一句人话；派生不带', () => {
  const forked = session({ origin: { kind: 'fork', fromSessionId: 's-0', atSeq: 4 } });
  assert.equal(sessionLinkInfo({ session: forked, forkedFromName: '原方案' }).forkedFrom, '分叉自「原方案」');
  assert.equal(sessionLinkInfo({ session: forked }).forkedFrom, '分叉自「来源会话」');
  assert.equal(sessionLinkInfo({ session: session() }).forkedFrom, null);
});

test('小窗信息：状态与 lastSeq 原样带出，就绪 / 运行中由状态位去分', () => {
  const info = sessionLinkInfo({ session: session({ status: 'done', lastSeq: 0, updatedAt: 1_700_000_120_000 }) });
  assert.equal(info.status, 'done');
  assert.equal(info.lastSeq, 0);
  assert.equal(info.updatedAt, 1_700_000_120_000);
  assert.equal(info.id, 's-1');
});
