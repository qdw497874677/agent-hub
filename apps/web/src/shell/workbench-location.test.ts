import assert from 'node:assert/strict';
import test from 'node:test';
import { forgetWorkbenchLocation, readWorkbenchLocation, rememberWorkbenchLocation, type ProjectLocation } from './workbench-location.ts';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); }
  };
}

const focus: ProjectLocation = { page: 'project', projectId: 'p/1', view: 'focus', sessionId: 's#2' };
const list: ProjectLocation = { ...focus, view: 'list', sessionId: null };

test('last workbench is account scoped and only invalidates the matching location', () => {
  const storage = memoryStorage();
  rememberWorkbenchLocation('a/b', focus, storage);
  rememberWorkbenchLocation('a', list, storage);
  assert.equal(storage.getItem('agent-hub:last-workbench:a%2Fb'), '#/p/p%2F1/focus/s%232');
  assert.deepEqual(readWorkbenchLocation('a/b', storage), focus);
  assert.deepEqual(readWorkbenchLocation('a', storage), list);
  forgetWorkbenchLocation('a/b', list, storage);
  assert.deepEqual(readWorkbenchLocation('a/b', storage), focus);
  forgetWorkbenchLocation('a/b', focus, storage);
  assert.equal(readWorkbenchLocation('a/b', storage), null);
  assert.deepEqual(readWorkbenchLocation('a', storage), list);
});

test('ignores unrelated, malformed and noncanonical locations and blocked storage', () => {
  const storage = memoryStorage();
  for (const hash of ['#/settings/personal/tokens', '#/p/%ZZ/focus/s', '#/p/p/focus', '#/p/p/list/trailing/extra']) {
    storage.setItem('agent-hub:last-workbench:a', hash);
    assert.equal(readWorkbenchLocation('a', storage), null);
  }
  const denied = () => { throw new Error('storage denied'); };
  const blocked = { getItem: denied, setItem: denied, removeItem: denied };
  assert.equal(readWorkbenchLocation('a', blocked), null);
  assert.doesNotThrow(() => rememberWorkbenchLocation('a', focus, blocked));
  assert.doesNotThrow(() => forgetWorkbenchLocation('a', focus, blocked));
});
