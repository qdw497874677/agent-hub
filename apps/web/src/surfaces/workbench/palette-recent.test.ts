import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paletteSnapshot, readPaletteRecent, rememberPaletteRecent } from './palette-recent.ts';

test('最近打开只记录真实访问，账号和项目隔离，去重并限制条数', () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); }
  };
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  try {
    assert.deepEqual(readPaletteRecent('a', 'p'), []);
    for (let i = 0; i < 22; i++) rememberPaletteRecent('a', 'p', `s${i}`);
    rememberPaletteRecent('a', 'p', 's5');
    assert.equal(readPaletteRecent('a', 'p').length, 20);
    assert.equal(readPaletteRecent('a', 'p')[0], 's5');
    assert.equal(readPaletteRecent('a', 'p').filter((id) => id === 's5').length, 1);
    assert.deepEqual(readPaletteRecent('a', 'other'), []);
    assert.deepEqual(readPaletteRecent('other', 'p'), []);
    rememberPaletteRecent('a:p', 'x', 'different');
    assert.deepEqual(readPaletteRecent('a', 'p:x'), []);
    const snapshot = paletteSnapshot('a', 'p', ['s5', 's21', 's20'], [
      { projectId: 'p', sessionId: 's20' }, { projectId: 'p', sessionId: 'hidden' },
      { projectId: 'other', sessionId: 's21' }, { projectId: 'p', sessionId: 's20' }
    ]);
    assert.deepEqual(snapshot, { attention: ['s20'], recent: ['s5', 's21'] });
    rememberPaletteRecent('a', 'p', 's21');
    assert.deepEqual(snapshot.recent, ['s5', 's21']);
    assert.deepEqual(paletteSnapshot(null, 'p', ['s5'], []).recent, []);
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

test('本地存储不可用或损坏时不会阻断面板', () => {
  Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => '{', setItem: () => { throw new Error('denied'); } }, configurable: true });
  try {
    assert.deepEqual(readPaletteRecent('a', 'p'), []);
    assert.doesNotThrow(() => rememberPaletteRecent('a', 'p', 's'));
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});
