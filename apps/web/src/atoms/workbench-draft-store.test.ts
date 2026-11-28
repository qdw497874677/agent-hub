import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkbenchDraftStore } from './workbench-draft-store.ts';
import type { Draft } from './attachments.ts';

const file = (id: string): Draft => ({ kind: 'file', id, name: id, mimeType: 'text/plain', data: 'eA==', bytes: 1 });

test('claim is synchronous and success leaves later draft and files alone', () => {
  const store = new WorkbenchDraftStore();
  store.setText('s', '  first  '); store.addItem('s', file('a'));
  const claim = store.claim('s')!;
  assert.equal(claim.text, '  first  '); assert.deepEqual(claim.items.map((x) => x.id), ['a']);
  assert.equal(store.claim('s'), null);
  store.setText('s', 'next'); store.addItem('s', file('b'));
  store.finish(claim, true);
  assert.equal(store.getEntry('s').text, 'next');
  assert.deepEqual(store.getEntry('s').items.map((x) => x.id), ['b']);
});

test('failure restores exact snapshot only without intervening edits', () => {
  const store = new WorkbenchDraftStore();
  store.setText('s', '  original\n'); store.addItem('s', file('a'));
  const claim = store.claim('s')!; store.finish(claim, false);
  assert.equal(store.getEntry('s').text, '  original\n');
  assert.equal(store.getEntry('s').items[0]?.id, 'a');
  const second = store.claim('s')!;
  store.setText('s', 'new'); store.setText('s', '');
  store.finish(second, false);
  assert.equal(store.getEntry('s').text, '');
  assert.equal(store.getEntry('s').recovery.length, 1);
  store.setText('s', 'do not overwrite');
  assert.equal(store.recover('s'), false);
  store.setText('s', ''); assert.equal(store.recover('s'), true);
  assert.equal(store.getEntry('s').text, '  original\n');
});

test('late item additions merge against origin current files and enforce limits', () => {
  const store = new WorkbenchDraftStore();
  for (let i = 0; i < 8; i++) assert.equal(store.addItem('a', file(String(i))), null);
  assert.equal(store.addItem('a', file('late')), '最多 8 个附件');
  assert.equal(store.getEntry('b').items.length, 0);
  assert.equal(new WorkbenchDraftStore().getEntry('a').items.length, 0);
});

test('tokens cannot release another claim and sessions are independent', () => {
  const store = new WorkbenchDraftStore();
  store.setText('a', 'one'); store.setText('b', 'two');
  const a = store.claim('a')!; const b = store.claim('b')!;
  store.finish(a, true); store.setText('a', 'three'); const next = store.claim('a')!;
  store.finish(a, false); assert.equal(store.getEntry('a').pending, true);
  store.finish(next, true); store.finish(b, false);
  assert.equal(store.getEntry('b').text, 'two');
});
