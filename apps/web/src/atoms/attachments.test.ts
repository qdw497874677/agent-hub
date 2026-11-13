import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAdd, filterCommands, mentionDraft, triggerAt, type Draft } from './attachments.ts';

test('triggerAt：@ 只在词首触发，/ 只在开头触发', () => {
  assert.deepEqual(triggerAt('看看 @src/ma', 10), { kind: '@', query: 'src/ma', start: 3 });
  assert.equal(triggerAt('mail@host', 9), null);
  assert.deepEqual(triggerAt('/fo', 3), { kind: '/', query: 'fo', start: 0 });
  assert.equal(triggerAt('a /fo', 5), null);
});

test('checkAdd：数量、单个大小、合计大小都会给出理由', () => {
  const image = (bytes: number): Draft => ({ kind: 'image', id: 'x', name: 'a.png', mimeType: 'image/png', data: '', bytes });
  assert.equal(checkAdd([], { kind: 'image', name: 'a.png', bytes: 10 }), null);
  assert.match(checkAdd([], { kind: 'image', name: 'big.png', bytes: 6 * 1024 * 1024 }) ?? '', /big\.png 超过 5\.0 MB/);
  assert.match(checkAdd([], { kind: 'file', name: 'f', bytes: 3 * 1024 * 1024 }) ?? '', /超过 2\.0 MB/);
  assert.match(checkAdd([image(4e6), image(4e6)], { kind: 'image', name: 'c', bytes: 4e6 }) ?? '', /合计/);
  assert.match(checkAdd(Array.from({ length: 8 }, () => mentionDraft('a')), { kind: 'file', name: 'f', bytes: 1 }) ?? '', /最多 8/);
});

test('filterCommands：按前缀筛', () => {
  const run = async () => null;
  const commands = [{ name: 'fork', hint: '', run }, { name: 'new', hint: '', run }];
  assert.deepEqual(filterCommands(commands, 'F').map((command) => command.name), ['fork']);
  assert.equal(filterCommands(commands, '').length, 2);
});
