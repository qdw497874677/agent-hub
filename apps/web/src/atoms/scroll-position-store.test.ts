import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRestorePosition, createScrollPositionStore, type ScrollPositionKey } from './scroll-position-store.ts';

test('positions are separated by every key part and store lifetime', () => {
  const store = createScrollPositionStore();
  const key: ScrollPositionKey = ['account', 'project', 'host', 'session'];
  store.write(key, { following: false, scrollTop: 120 });
  assert.deepEqual(store.read([...key]), { following: false, scrollTop: 120 });
  for (let i = 0; i < key.length; i++) {
    const other = [...key] as [string, string, string, string];
    other[i] += '-other';
    assert.equal(store.read(other), undefined);
  }
  assert.equal(createScrollPositionStore().read(key), undefined);
});

test('detached restoration waits for complete history and sufficient visible geometry', () => {
  const position = { following: false, scrollTop: 120 };
  assert.equal(canRestorePosition(position, { clientHeight: 0, scrollHeight: 500, scrollTop: 0 }, true), false);
  assert.equal(canRestorePosition(position, { clientHeight: 100, scrollHeight: 500, scrollTop: 0 }, false), false);
  assert.equal(canRestorePosition(position, { clientHeight: 100, scrollHeight: 219, scrollTop: 0 }, true), false);
  assert.equal(canRestorePosition(position, { clientHeight: 100, scrollHeight: 220, scrollTop: 0 }, true), true);
});
