import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Block } from './live-core.ts';
import {
  GROUP_EMOJI,
  draftText,
  draftVisible,
  liveDrafts,
  mergeReaction,
  mineOf,
  toggleReaction,
  typingLine,
  typingRoles,
  type GroupReaction,
  type TypingMember
} from './group-live.ts';

const prompt = (text: string, seq = 0): Block => ({ kind: 'prompt', text, attachments: [], seq });
const say = (text: string, seq = 1): Block => ({ kind: 'text', text, seq });
const think = (text: string, seq = 2): Block => ({ kind: 'thinking', text, seq });
const tool: Block = { kind: 'tool', name: 'bash', input: '{}', result: null, seq: 3 };

const reaction = (emoji: string, ...names: string[]): GroupReaction => ({
  emoji,
  actors: names.map((name) => ({ kind: 'user' as const, name }))
});

test('GROUP_EMOJI 是设计的七个表情，顺序就是面板顺序', () => {
  assert.deepEqual([...GROUP_EMOJI], ['👍', '👀', '🎉', '✅', '❤️', '😄', '🤔']);
});

test('mineOf：只认自己的名字，agent 用同名不算我点过', () => {
  assert.equal(mineOf(reaction('👍', 'Ada'), 'Ada'), true);
  assert.equal(mineOf(reaction('👍', 'Bob'), 'Ada'), false);
  assert.equal(mineOf({ emoji: '👍', actors: [{ kind: 'agent', name: 'Ada' }] }, 'Ada'), false);
  assert.equal(mineOf(reaction('👍', 'Ada'), null), false);
});

test('toggleReaction：没点过就加，屏幕上先出现我这一票', () => {
  const { action, reactions } = toggleReaction([], '👍', 'Ada');
  assert.equal(action, 'add');
  assert.deepEqual(reactions, [{ emoji: '👍', actors: [{ kind: 'user', name: 'Ada' }] }]);
});

test('toggleReaction：点过就撤，我是最后一票时整个 chip 消失', () => {
  const { action, reactions } = toggleReaction([reaction('👍', 'Ada')], '👍', 'Ada');
  assert.equal(action, 'remove');
  assert.deepEqual(reactions, []);
});

test('toggleReaction：别人也点过时只撤我这一票', () => {
  const { action, reactions } = toggleReaction([reaction('👍', 'Ada', 'Bob')], '👍', 'Ada');
  assert.equal(action, 'remove');
  assert.deepEqual(reactions, [{ emoji: '👍', actors: [{ kind: 'user', name: 'Bob' }] }]);
});

test('toggleReaction：不知道我是谁时不编名字，只给出动作', () => {
  const before = [reaction('👍', 'Ada')];
  const { action, reactions } = toggleReaction(before, '👀', null);
  assert.equal(action, 'add');
  assert.deepEqual(reactions, before);
});

test('mergeReaction：同一人只留一条，撤不存在的人不动列表', () => {
  const once = mergeReaction([], '🎉', { kind: 'user', name: 'Ada' }, true);
  const twice = mergeReaction(once, '🎉', { kind: 'user', name: 'Ada' }, true);
  assert.deepEqual(twice, [{ emoji: '🎉', actors: [{ kind: 'user', name: 'Ada' }] }]);
  assert.deepEqual(mergeReaction(twice, '🎉', { kind: 'user', name: 'Bob' }, false), twice);
});

test('draftText：只拼最后一个 prompt 之后的正文，思考和工具调用不算说话', () => {
  const blocks = [
    prompt('上一轮', 0),
    say('上一轮的回答', 1),
    prompt('新问题', 2),
    think('想一下', 3),
    say('正在写', 4),
    tool,
    say('的下半句', 5)
  ];
  assert.equal(draftText(blocks), '正在写的下半句');
});

test('draftText：还没开口就是 null（沉默开场的轮次不画空气泡）', () => {
  assert.equal(draftText([]), null);
  assert.equal(draftText([say('没有 prompt 的历史', 1)]), null);
  assert.equal(draftText([prompt('问', 0), think('想', 1), tool]), null);
  assert.equal(draftText([prompt('问', 0), say('   \n ', 1)]), null);
});

test('draftVisible：同成员同轮的正式帖子出现后草稿退场', () => {
  const posts = [{ round: 2, author: { kind: 'agent' as const, role: 'reviewer' } }];
  assert.equal(draftVisible({ role: 'reviewer', round: 2, posts }), false);
  assert.equal(draftVisible({ role: 'reviewer', round: 3, posts }), true);
  assert.equal(draftVisible({ role: 'builder', round: 2, posts }), true);
  assert.equal(draftVisible({ role: 'reviewer', round: 2, posts: [] }), true);
});

test('liveDrafts + typingRoles：有草稿的人画气泡，其余人只进正在输入行', () => {
  const typing: TypingMember[] = [
    { role: 'reviewer', sessionId: 's1', since: 1 },
    { role: 'builder', sessionId: 's2', since: 2 }
  ];
  const stream = { s1: [prompt('看看这个', 0), say('我看下', 1)], s2: [prompt('写吧', 0)] };
  const drafts = liveDrafts({ typing, blocksOf: (id) => stream[id as keyof typeof stream] ?? [], round: 1, posts: [] });
  assert.deepEqual(drafts, [{ role: 'reviewer', sessionId: 's1', body: '我看下' }]);
  assert.deepEqual(typingRoles(typing, drafts), ['builder']);
});

test('liveDrafts：这一轮已经发帖的成员不再有草稿（哪怕流里还留着上一轮的尾巴）', () => {
  const typing: TypingMember[] = [{ role: 'reviewer', sessionId: 's1', since: 1 }];
  const drafts = liveDrafts({
    typing,
    blocksOf: () => [prompt('看看这个', 0), say('我看下', 1)],
    round: 4,
    posts: [{ round: 4, author: { kind: 'agent', role: 'reviewer' } }]
  });
  assert.deepEqual(drafts, []);
});

test('typingLine：一到三个列全名，超过三个写「等 N 人」', () => {
  assert.equal(typingLine([]), null);
  assert.equal(typingLine(['reviewer']), 'reviewer 正在输入…');
  assert.equal(typingLine(['a', 'b', 'c']), 'a、b、c 正在输入…');
  assert.equal(typingLine(['a', 'b', 'c', 'd', 'e']), 'a、b 等 5 人正在输入…');
});

test('typingLine：同名成员只报一次，空名字不算人', () => {
  assert.equal(typingLine(['reviewer', 'reviewer']), 'reviewer 正在输入…');
  assert.equal(typingLine(['', '  ']), null);
  assert.equal(typingLine(['', 'reviewer']), 'reviewer 正在输入…');
});
