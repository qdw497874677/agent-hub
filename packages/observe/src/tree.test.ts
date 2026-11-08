import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree, durationBetween, type ObserveNode } from './index.ts';

const node = (over: Partial<ObserveNode> & Pick<ObserveNode, 'id'>): ObserveNode => ({
  name: over.id, kind: 'n', state: null, stateLabel: null, startedAt: null, endedAt: null,
  durationMs: null, durationLabel: null, parentId: null, links: [], attrs: [], ...over
});

test('父子只在 parentId 对得上时成立；对不上的不挂到根下面', () => {
  const tree = buildTree({
    headId: 'root',
    nodes: [
      node({ id: 'root', links: [] }),
      node({ id: 'child', parentId: 'root' }),
      node({ id: 'orphan', parentId: 'gone' })
    ]
  });
  assert.deepEqual(tree.roots.map((r) => r.node.id), ['root']);
  assert.deepEqual(tree.roots[0]!.children.map((c) => c.node.id), ['child']);
  assert.deepEqual(tree.missingParent.map((n) => n.id), ['orphan']);
  assert.equal(tree.roots[0]!.children.some((c) => c.node.id === 'orphan'), false);
});

test('链接不是子节点；环上再走一遍就停', () => {
  const tree = buildTree({
    headId: 'trigger',
    nodes: [
      node({ id: 'trigger', kind: 'trigger', links: [{ to: 'job', label: '由这次唤醒建下' }] }),
      node({ id: 'job', kind: 'dispatch', parentId: null, links: [{ to: 'trigger', label: '回到触发' }] })
    ]
  });
  assert.deepEqual(tree.roots[0]!.children, []);
  assert.equal(tree.roots[0]!.links[0]!.label, '由这次唤醒建下');
  assert.equal(tree.roots[0]!.links[0]!.branch.node.id, 'job');
  assert.deepEqual(tree.roots[0]!.links[0]!.branch.links, []);
});

test('没有边的节点进未关联；sink 进未记录', () => {
  const tree = buildTree({
    headId: 'trigger',
    nodes: [
      node({ id: 'trigger', kind: 'trigger' }),
      node({ id: 'delivery', kind: 'delivery' }),
      node({ id: 'sink', kind: 'sink', name: '回写' })
    ]
  });
  assert.deepEqual(tree.unlinked.map((n) => n.id), ['delivery']);
  assert.deepEqual(tree.unrecorded.map((n) => n.id), ['sink']);
});

test('耗时要求两个时间，结束早于开始则没有', () => {
  assert.equal(durationBetween(10, 15), 5);
  assert.equal(durationBetween(null, 15), null);
  assert.equal(durationBetween(10, null), null);
  assert.equal(durationBetween(20, 10), null);
});
