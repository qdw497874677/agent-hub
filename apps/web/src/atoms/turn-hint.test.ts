import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DeliveryDto } from '@agent-hub/contract';
import type { PendingPrompt } from './pending-prompt.ts';
import type { TurnProgress } from './turn-progress.ts';
import { deliveryNeedsAction, queuedBehind, queuedDeliveryText, turnHint } from './turn-hint.ts';

const T0 = 1_700_000_000_000;

function delivery(seq: number, state: DeliveryDto['state'], patch: Partial<DeliveryDto> = {}): DeliveryDto {
  return {
    id: `d${seq}`,
    sessionId: 's1',
    seq,
    kind: 'prompt',
    state,
    attempt: 0,
    nextAt: null,
    lastError: null,
    createdAt: T0,
    updatedAt: T0,
    ...patch
  };
}

function pending(state: PendingPrompt['state'], seq?: number): PendingPrompt {
  return { id: 'p1', text: '你好', attachments: [], state, seq, sentAt: T0 };
}

const writing: TurnProgress = { phase: 'writing', label: '正在输出…', seconds: 3, detail: 'Codex 正在回复：正在输出…' };
const starting: TurnProgress = { phase: 'starting', label: '等 Codex 的第一条输出…', seconds: 6, detail: 'Codex 正在回复：等 Codex 的第一条输出…' };
const waiting: TurnProgress = { phase: 'waiting', label: '等待模型回应…', seconds: 8, detail: 'Codex 正在回复：等待模型回应…' };
const toolWait: TurnProgress = { phase: 'tool-wait', label: '工具已结束 · 等待模型回应…', seconds: 8, detail: 'Codex 正在回复：工具已结束 · 等待模型回应…' };

test('什么都没有：不显示（回合没在跑、也没有待送的消息）', () => {
  assert.equal(turnHint({ pending: [], delivery: undefined, deliveries: [], progress: null }), null);
});

test('本地刚发、还没回执：正在发送，说清是「没回执」而不是送达', () => {
  const hint = turnHint({ pending: [pending('sending')], delivery: undefined, deliveries: [], progress: null });
  assert.equal(hint?.text, '正在发送…');
  assert.equal(hint?.stage, 'delivery');
  assert.match(hint?.detail ?? '', /回执/);
});

test('有回执（带 seq）就改用服务端的送达状态：投递在途', () => {
  const hint = turnHint({
    pending: [pending('queued', 4)],
    delivery: delivery(4, 'sending'),
    deliveries: [delivery(4, 'sending')],
    progress: null
  });
  assert.equal(hint?.text, '等待模型首次回应');
  assert.equal(hint?.stage, 'delivery');
  assert.match(hint?.detail ?? '', /还没有看到本轮输出/);
});

test('交出去但一个字都没吐：还是送达层，不因为「没有块」说运行时在动', () => {
  const sent = delivery(4, 'sending');
  const hint = turnHint({ pending: [], delivery: sent, deliveries: [sent], progress: starting });
  assert.equal(hint?.stage, 'delivery');
  assert.equal(hint?.text, '等待模型首次回应');
  assert.equal(hint?.phase, 'sending');
});

test('只有登记块（附件 / 批准卡这类）：也不算 agent 在动', () => {
  const sent = delivery(4, 'sending');
  const hint = turnHint({ pending: [], delivery: sent, deliveries: [sent], progress: waiting });
  assert.equal(hint?.stage, 'delivery');
  assert.equal(hint?.text, '等待模型首次回应');
});

test('工具已结束后说等待后续，不说首次回应；投递不确定或更新消息仍优先', () => {
  const sent = delivery(4, 'sending');
  const hint = turnHint({ pending: [], delivery: sent, deliveries: [sent], progress: toolWait });
  assert.equal(hint?.phase, 'tool-wait');
  assert.equal(hint?.text, toolWait.label);
  assert.equal(turnHint({ pending: [], delivery: sent, deliveries: [sent], progress: toolWait, uncertainDeliveryIds: [sent.id] })?.text, '暂未确认这一轮的结果');
  assert.equal(turnHint({ pending: [pending('queued', 5)], delivery: sent, deliveries: [sent], progress: toolWait })?.phase, 'queued');
  assert.equal(turnHint({ pending: [pending('unknown', 5)], delivery: sent, deliveries: [sent], progress: toolWait }), null);
});

test('当前这句还在排队，上一句在输出：说排队，不把上一句的输出算到它头上', () => {
  const running = delivery(4, 'sending');
  const queued = pending('queued', 5);
  const hint = turnHint({ pending: [queued], delivery: running, deliveries: [running], progress: writing });
  assert.equal(hint?.stage, 'delivery');
  assert.equal(hint?.phase, 'queued');
  assert.equal(hint?.text, '已排队 · 前面还有消息');
});

test('回执到了但还没写进对话：仍说自己在发，不借上一句的输出', () => {
  const running = delivery(4, 'sending');
  const hint = turnHint({ pending: [pending('sending', 5)], delivery: running, deliveries: [running], progress: writing });
  assert.equal(hint?.stage, 'delivery');
  assert.equal(hint?.phase, 'sending');
  assert.equal(hint?.text, '正在发送…');
});

test('排在别人后面：说排队，不说在发', () => {
  const all = [delivery(1, 'undelivered'), delivery(2, 'queued')];
  const hint = turnHint({ pending: [], delivery: all[1], deliveries: all, progress: null });
  assert.equal(hint?.text, '已排队 · 前面还有消息');
  assert.equal(hint?.stage, 'delivery');
  assert.equal(hint?.phase, 'queued');
});

test('轮到它自己、带着「撤回」的那行：交给气泡下面说，这里不重复', () => {
  const only = delivery(2, 'queued');
  assert.equal(deliveryNeedsAction(only, [only]), true);
  assert.equal(turnHint({ pending: [], delivery: only, deliveries: [only], progress: null }), null);
});

test('要人动手的（未送达 / 重试倒计时）不在进度里重复', () => {
  const failed = delivery(3, 'undelivered', { lastError: '连接被拒绝' });
  assert.equal(turnHint({ pending: [], delivery: failed, deliveries: [failed], progress: null }), null);
  const retrying = delivery(3, 'undelivered', { attempt: 2, nextAt: T0 + 4_000 });
  assert.equal(turnHint({ pending: [], delivery: retrying, deliveries: [retrying], progress: null }), null);
});

test('超时只是「不确定」：不推成失败，也不自己编一行状态', () => {
  const hint = turnHint({ pending: [pending('unknown')], delivery: undefined, deliveries: [], progress: null });
  assert.equal(hint, null);
});

test('时间过去多久都不改口：sending 一直是在发', () => {
  const old = delivery(5, 'sending', { createdAt: T0 - 3_600_000, updatedAt: T0 - 3_600_000 });
  const hint = turnHint({ pending: [], delivery: old, deliveries: [old], progress: null });
  assert.equal(hint?.text, '等待模型首次回应');
  assert.equal(hint?.stage, 'delivery');
});

test('sending 期间运行时已经动了：说运行时（delivered 要等这一轮结束才写）', () => {
  const old = delivery(5, 'sending');
  const hint = turnHint({ pending: [], delivery: old, deliveries: [old], progress: writing });
  assert.equal(hint?.stage, 'runtime');
  assert.equal(hint?.text, '正在输出…');
});

test('送达之后才轮到运行时说话', () => {
  const done = delivery(6, 'delivered');
  const hint = turnHint({ pending: [], delivery: done, deliveries: [done], progress: writing });
  assert.equal(hint?.text, '正在输出…');
  assert.equal(hint?.stage, 'runtime');
  assert.equal(hint?.phase, 'writing');
  assert.equal(hint?.detail, writing.detail);
});

test('送达了但回合已经结束：一片安静', () => {
  const done = delivery(6, 'delivered');
  assert.equal(turnHint({ pending: [], delivery: done, deliveries: [done], progress: null }), null);
});

test('已撤回：没有进度可说', () => {
  const cancelled = delivery(7, 'cancelled');
  assert.equal(turnHint({ pending: [], delivery: cancelled, deliveries: [cancelled], progress: null }), null);
});

test('queuedBehind 只看前面没送到的那些', () => {
  assert.equal(queuedBehind(delivery(1, 'sending'), [delivery(1, 'sending')]), false);
  assert.equal(queuedBehind(delivery(2, 'queued'), [delivery(1, 'delivered'), delivery(2, 'queued')]), false);
  assert.equal(queuedBehind(delivery(3, 'queued'), [delivery(1, 'queued'), delivery(3, 'queued')]), true);
});

test('队首回执不证明前面有消息，明确离线或启动失败才说明排队', () => {
  const head = delivery(1, 'queued');
  assert.equal(queuedDeliveryText(1, [head]), '发送中…');
  assert.equal(queuedDeliveryText(1, [head], [], 'offline'), '已排队 · 等待机器上线');
  assert.equal(queuedDeliveryText(1, [head], [], 'starting'), '已排队 · 等待运行时就绪');
  assert.equal(queuedDeliveryText(1, [head], [], 'blocked'), '已排队 · 等待投递');
  assert.equal(turnHint({ pending: [pending('queued', 1)], delivery: undefined, deliveries: [], progress: null })?.text, '发送中…');
  assert.equal(turnHint({ pending: [pending('queued', 1)], delivery: undefined, deliveries: [], progress: null, queueReason: 'offline' })?.text, '已排队 · 等待机器上线');
});

test('前序结果不确定时等待确认，单次迭代器也能识别前序', () => {
  const first = delivery(1, 'sending');
  const next = delivery(2, 'queued');
  assert.equal(queuedDeliveryText(2, [first, next], [first.id]), '已排队 · 等待上一轮状态确认');
  const hint = turnHint({ pending: [], delivery: next, deliveries: new Map([[1, first], [2, next]]).values(), progress: null, uncertainDeliveryIds: [first.id] });
  assert.equal(hint?.text, '已排队 · 等待上一轮状态确认');
});
