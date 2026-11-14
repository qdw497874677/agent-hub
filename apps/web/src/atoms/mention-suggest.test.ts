import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insertMention, mentionItems, mentionRange, stepMention, SUGGEST_LIMIT } from './mention-suggest.ts';

const members = [
  { name: 'echo', label: '回声', host: true },
  { name: 'perf', label: '性能' },
  { name: 'ghost', label: '幽灵', held: true }
];

test('刚打完 @ 就弹候选，区间是 @ 到光标', () => {
  assert.deepEqual(mentionRange('大家好 @', 5), { start: 4, end: 5, query: '' });
  assert.deepEqual(mentionRange('@', 1), { start: 0, end: 1, query: '' });
});

test('@ 后面打了前几个字符：token 是这几个字符', () => {
  assert.deepEqual(mentionRange('@ec', 3), { start: 0, end: 3, query: 'ec' });
  assert.deepEqual(mentionRange('叫 @per 看看', 6), { start: 2, end: 6, query: 'per' });
});

test('邮箱不弹：@ 前面是词字符或点都不算', () => {
  assert.equal(mentionRange('a@b', 3), null);
  assert.equal(mentionRange('x@ec', 4), null);
  assert.equal(mentionRange('v1.@ec', 6), null);
});

test('中文 / 空格后面可以弹（后端 \w 也不含中文）', () => {
  assert.deepEqual(mentionRange('你好@ec', 5), { start: 2, end: 5, query: 'ec' });
});

test('光标不在 @ 段里就不弹：空格后、普通文字、行首之外', () => {
  assert.equal(mentionRange('@echo 你好', 8), null);
  assert.equal(mentionRange('随便写点什么', 6), null);
  assert.equal(mentionRange('', 0), null);
});

test('光标停在名字中间：整段名字都算进来，插入时一起替换', () => {
  assert.deepEqual(mentionRange('@echo', 3), { start: 0, end: 5, query: 'ec' });
  assert.deepEqual(insertMention('@echo 你好', mentionRange('@echo 你好', 3)!, 'perf'), { text: '@perf 你好', caret: 6 });
});

test('插入：换掉整段并补一个空格，光标落在空格后面', () => {
  const range = mentionRange('@ec', 3)!;
  assert.deepEqual(insertMention('@ec', range, 'echo'), { text: '@echo ', caret: 6 });
  const mid = mentionRange('先说 @ec 再继续', 6)!;
  assert.deepEqual(insertMention('先说 @ec 再继续', mid, 'echo'), { text: '先说 @echo 再继续', caret: 9 });
});

test('候选按前缀过滤，名字和显示名都认，大小写不敏感', () => {
  assert.deepEqual(mentionItems(members, 'ec').map((i) => i.token), ['echo']);
  assert.deepEqual(mentionItems(members, '性').map((i) => i.token), ['perf']);
  assert.deepEqual(mentionItems(members, 'GH').map((i) => i.token), ['ghost']);
});

test('空 query 时成员按群里顺序全给，特殊项排在后面', () => {
  const tokens = mentionItems(members, '').map((i) => i.token);
  assert.deepEqual(tokens, ['echo', 'perf', 'ghost', 'all', 'user']);
  assert.equal(mentionItems(members, '')[3]?.kind, 'all');
});

test('特殊项：@all 与 @user，加上前缀过滤后不会混进来', () => {
  assert.deepEqual(mentionItems(members, 'al').map((i) => i.token), ['all']);
  assert.deepEqual(mentionItems(members, 'us').map((i) => i.token), ['user']);
  assert.deepEqual(mentionItems(members, 'ec').map((i) => i.kind), ['member']);
});

test('主持人 / 已暂停 作为角标带出来', () => {
  assert.equal(mentionItems(members, 'echo')[0]?.note, '主持人');
  assert.equal(mentionItems(members, 'ghost')[0]?.note, '已暂停');
  assert.equal(mentionItems(members, 'perf')[0]?.note, undefined);
});

test('候选数量有上限，前缀匹的排在包含匹前面', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ name: `bot${i}`, label: `Bot ${i}` }));
  many.push({ name: 'xbot', label: 'x' });
  const list = mentionItems(many, 'bot');
  assert.equal(list.length, SUGGEST_LIMIT);
  assert.equal(list[0]?.token, 'bot0');
  assert.deepEqual(list.map((i) => i.token), ['bot0', 'bot1', 'bot2', 'bot3', 'bot4', 'bot5', 'bot6', 'bot7']);
});

test('上下键移动会绕回两端', () => {
  assert.equal(stepMention(0, 1, 3), 1);
  assert.equal(stepMention(2, 1, 3), 0);
  assert.equal(stepMention(0, -1, 3), 2);
  assert.equal(stepMention(1, 1, 0), 0);
});
