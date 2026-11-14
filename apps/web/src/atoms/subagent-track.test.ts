import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findSubagentBlock,
  resolveSubagentPath,
  subagentActivity,
  subagentBucket,
  subagentEntries,
  subagentStatusLabel,
  subagentStepsLabel,
  subagentSummary,
  subagentTone,
  type SubagentBlock
} from './subagent-track.ts';
import type { Block } from './live-core.ts';

let seq = 0;
const nextSeq = () => {
  seq += 1;
  return seq;
};

const text = (value: string): Block => ({ kind: 'text', text: value, seq: nextSeq() });
const tool = (name: string, input: string): Block => ({ kind: 'tool', name, input, result: null, seq: nextSeq() });

function sub(
  id: string,
  options: {
    parentId?: string;
    depth?: number;
    title?: string;
    agent?: string;
    status?: SubagentBlock['status'];
    children?: readonly Block[];
  } = {}
): SubagentBlock {
  return {
    kind: 'subagent',
    id,
    parentId: options.parentId ?? 'root',
    depth: options.depth ?? 1,
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.agent === undefined ? {} : { agent: options.agent }),
    status: options.status ?? 'running',
    children: options.children ?? [],
    seq: nextSeq()
  };
}

test('拍平：深度优先前序，父在子前，兄弟按时间线顺序，只收子代理块', () => {
  const blocks: readonly Block[] = [
    text('开头'),
    sub('a', { children: [text('a 在干活'), sub('a1', { parentId: 'a', depth: 2 })] }),
    sub('b', { status: 'completed' }),
    text('结尾')
  ];
  const entries = subagentEntries(blocks);
  assert.deepEqual(
    entries.map((entry) => [entry.id, entry.depth]),
    [
      ['a', 1],
      ['a1', 2],
      ['b', 1]
    ]
  );
});

test('每行的名字按 title → agent → 子代理 兜底，agent 单独留着', () => {
  const entries = subagentEntries([
    sub('a', { title: '查文档', agent: 'explore' }),
    sub('b', { agent: 'explore' }),
    sub('c')
  ]);
  assert.deepEqual(
    entries.map((entry) => [entry.title, entry.agent]),
    [
      ['查文档', 'explore'],
      ['explore', 'explore'],
      ['子代理', null]
    ]
  );
});

test('桶：取消按失败计（它没走完），行内文字仍是「已取消」', () => {
  assert.equal(subagentBucket('running'), 'running');
  assert.equal(subagentBucket('completed'), 'done');
  assert.equal(subagentBucket('failed'), 'failed');
  assert.equal(subagentBucket('cancelled'), 'failed');
  assert.equal(subagentStatusLabel('cancelled'), '已取消');
  assert.equal(subagentStatusLabel('running'), '运行中');
});

test('汇总分片：运行中排最前，0 的桶不出现；全完成也照样有文案', () => {
  const entries = subagentEntries([
    sub('a'),
    sub('b', { status: 'failed' }),
    sub('c', { status: 'completed' }),
    sub('d', { status: 'cancelled' }),
    sub('e', { status: 'completed' })
  ]);
  assert.equal(subagentSummary(entries), '1 运行中 · 2 失败 · 2 完成');
  assert.equal(subagentSummary(subagentEntries([sub('x', { status: 'completed' })])), '1 完成');
  assert.equal(subagentSummary([]), null);
});

test('轨道色调：有运行中就 accent，否则有失败就 rust，否则完成', () => {
  const done = sub('a', { status: 'completed' });
  const failed = sub('b', { status: 'failed' });
  const running = sub('c');
  assert.equal(subagentTone(subagentEntries([done])), 'done');
  assert.equal(subagentTone(subagentEntries([done, failed])), 'failed');
  assert.equal(subagentTone(subagentEntries([done, failed, running])), 'running');
  assert.equal(subagentTone([]), null);
});

test('最近动态取子时间线尾部：text 压成一行并截断', () => {
  const block = sub('a', { children: [text('第一行\n  第二行'), text('最后一句')] });
  assert.equal(subagentActivity(block), '最后一句');
  const long = sub('a', { children: [text('长'.repeat(300))] });
  const activity = subagentActivity(long);
  assert.ok(activity !== null && activity.length < 120);
  assert.ok(activity.endsWith('…'));
});

test('最近动态认工具调用；尾部是嵌套子代理就看它自己的尾巴', () => {
  assert.equal(subagentActivity(sub('a', { children: [tool('bash', JSON.stringify({ command: 'npm test -- --watch=false' }))] })), 'npm test -- --watch=false');
  const nested = sub('a', { children: [sub('a1', { parentId: 'a', depth: 2, children: [text('嵌套里的最后一句')] })] });
  assert.equal(subagentActivity(nested), '嵌套里的最后一句');
  assert.equal(subagentActivity(sub('empty')), null);
});

test('步数：叶子块才算一步，嵌套子代理继续往下数；0 步说「暂无输出」', () => {
  const entries = subagentEntries([sub('a', { children: [text('一'), tool('read', '{}'), sub('a1', { parentId: 'a', depth: 2, children: [text('二')] })] }), sub('b')]);
  assert.deepEqual(
    entries.map((entry) => [entry.id, entry.steps]),
    [
      ['a', 3],
      ['a1', 1],
      ['b', 0]
    ]
  );
  assert.equal(subagentStepsLabel(3), '3 步');
  assert.equal(subagentStepsLabel(0), '暂无输出');
});

test('按 id 找块；返回栈逐层解析，缺失的层级截断', () => {
  const blocks: readonly Block[] = [sub('a', { children: [sub('a1', { parentId: 'a', depth: 2 })] })];
  assert.equal(findSubagentBlock(blocks, 'a1')?.parentId, 'a');
  assert.equal(findSubagentBlock(blocks, 'nope'), null);
  assert.deepEqual(
    resolveSubagentPath(blocks, ['a', 'a1']).map((block) => block.id),
    ['a', 'a1']
  );
  assert.deepEqual(
    resolveSubagentPath(blocks, ['a', 'missing', 'a1']).map((block) => block.id),
    ['a']
  );
});

test('父会话结束后计数照常：状态是块自己的，跟会话状态无关', () => {
  const blocks: readonly Block[] = [sub('a', { status: 'completed' }), sub('b', { status: 'completed' })];
  assert.equal(subagentSummary(subagentEntries(blocks)), '2 完成');
});
