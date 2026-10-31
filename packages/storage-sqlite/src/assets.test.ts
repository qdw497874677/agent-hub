import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packAsset, type Asset } from '@agent-hub/domain';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteStore } from './store.ts';

const enc = (text: string) => new TextEncoder().encode(text);

test('资产：建 / 加版本 / 安装 / 删（只清没人引用的 blob），跨重开保留', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-assets-'));
  try {
    const path = join(dir, 'hub.db');
    let store = openSqliteStore(path);
    const v1 = await packAsset('skill', [{ path: 'SKILL.md', data: enc('one') }, { path: 'shared.txt', data: enc('same') }]);
    const v2 = await packAsset('skill', [{ path: 'SKILL.md', data: enc('two') }, { path: 'shared.txt', data: enc('same') }]);
    assert.ok(v1.ok && v2.ok);
    const asset: Asset = {
      id: 'a1', kind: 'skill', name: 'greeter', description: 'd', source: { type: 'git', url: 'https://x/y.git', ref: 'main', path: 's' },
      pinned: v1.value.digest, latest: v1.value.digest, projectId: null, scope: 'global', ownerId: '', teamId: null, createdAt: 1, updatedAt: 1
    };
    const rev = (packed: typeof v1.value, at: number) => ({ assetId: 'a1', digest: packed.digest, name: 'greeter', description: 'd', files: packed.files, commit: 'c', createdAt: at });
    await store.assets.create(asset, rev(v1.value, 1), v1.value.blobs);
    await store.assets.addRevision(rev(v2.value, 2), v2.value.blobs);
    await store.assets.addRevision(rev(v2.value, 3), v2.value.blobs);
    await store.assets.update({ ...asset, latest: v2.value.digest, updatedAt: 2 });
    await store.assets.install('w1', 'a1', 5);
    await store.assets.install('w1', 'a1', 6);
    store.close();

    store = openSqliteStore(path);
    assert.deepEqual((await store.assets.byName('skill', 'greeter', null))?.source, asset.source);
    assert.equal((await store.assets.get('a1'))?.latest, v2.value.digest);
    assert.deepEqual((await store.assets.revisions('a1')).map((r) => r.digest), [v2.value.digest, v1.value.digest]);
    assert.deepEqual(await store.assets.installations(), [{ workerId: 'w1', assetId: 'a1' }]);
    const file = v1.value.files[0]!;
    assert.equal(new TextDecoder().decode((await store.assets.blob(file.sha256))!), 'one');

    // 另一个资产共享 shared.txt：删 a1 后它的 blob 要留着
    const other = await packAsset('skill', [{ path: 'SKILL.md', data: enc('other') }, { path: 'shared.txt', data: enc('same') }]);
    assert.ok(other.ok);
    await store.assets.create({ ...asset, id: 'a2', name: 'other', pinned: other.value.digest, latest: other.value.digest }, { ...rev(other.value, 4), assetId: 'a2' }, other.value.blobs);
    await store.assets.remove('a1');
    assert.equal(await store.assets.get('a1'), null);
    assert.deepEqual(await store.assets.installations(), []);
    assert.equal(await store.assets.blob(file.sha256), null);
    const shared = other.value.files.find((f) => f.path === 'shared.txt')!;
    assert.ok(await store.assets.blob(shared.sha256));
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('资产同步状态：跨重开保留；重开前「同步中」的读出来是「待同步」', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-sync-'));
  try {
    const path = join(dir, 'hub.db');
    let store = openSqliteStore(path);
    assert.equal(store.assetSync.get('w1'), null);
    store.assetSync.set({ workerId: 'w1', state: 'synced', root: '/r', installed: { a1: 'd1' }, error: null, at: 1 });
    store.assetSync.set({ workerId: 'w2', state: 'syncing', root: null, installed: {}, error: null, at: 2 });
    store.assetSync.set({ workerId: 'w1', state: 'synced', root: '/r', installed: { a1: 'd2' }, error: null, at: 3 });
    store.close();

    store = openSqliteStore(path);
    assert.deepEqual(store.assetSync.get('w1'), { workerId: 'w1', state: 'synced', root: '/r', installed: { a1: 'd2' }, error: null, at: 3 });
    assert.deepEqual(store.assetSync.all().map((s) => [s.workerId, s.state]), [['w1', 'synced'], ['w2', 'pending']]);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('资产作用域：旧库迁移后原有资产成全局；同名可分属全局与项目；项目开关可设可清', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-scope-'));
  try {
    const path = join(dir, 'hub.db');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE assets (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, source TEXT NOT NULL,
      pinned TEXT NOT NULL, latest TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(kind, name));
      INSERT INTO assets VALUES ('a1','skill','greeter','d','{"type":"upload"}','x','x',1,1);`);
    old.close();
    const store = openSqliteStore(path);
    assert.equal((await store.assets.get('a1'))?.projectId, null);
    assert.equal((await store.assets.byName('skill', 'greeter', null))?.id, 'a1');
    assert.equal(await store.assets.byName('skill', 'greeter', 'p1'), null);
    const packed = await packAsset('skill', [{ path: 'SKILL.md', data: enc('p') }]);
    assert.ok(packed.ok);
    const asset: Asset = { id: 'a2', kind: 'skill', name: 'greeter', description: 'd', source: { type: 'upload' }, pinned: packed.value.digest, latest: packed.value.digest, projectId: 'p1', scope: 'project', ownerId: '', teamId: null, createdAt: 2, updatedAt: 2 };
    await store.assets.create(asset, { assetId: 'a2', digest: packed.value.digest, name: 'greeter', description: 'd', files: packed.value.files, commit: null, createdAt: 2 }, packed.value.blobs);
    assert.equal((await store.assets.byName('skill', 'greeter', 'p1'))?.id, 'a2');
    await store.assets.setProjectSetting('p1', 'a1', false);
    assert.deepEqual(await store.assets.projectSettings('p1'), { a1: false });
    await store.assets.setProjectSetting('p1', 'a1', null);
    assert.deepEqual(await store.assets.projectSettings('p1'), {});
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('会话资产清单：按会话记下，再启动覆盖成最新一次，跨重开保留', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-session-assets-'));
  try {
    const path = join(dir, 'hub.db');
    let store = openSqliteStore(path);
    assert.equal(await store.assets.sessionAssets('s1'), null);
    const entry = { assetId: 'a1', kind: 'skill' as const, name: 'greeter', digest: 'd1', scope: 'project' as const };
    await store.assets.recordSessionAssets({ sessionId: 's1', workerId: 'w1', entries: [entry], at: 1 });
    await store.assets.recordSessionAssets({ sessionId: 's1', workerId: 'w2', entries: [{ ...entry, digest: 'd2' }], at: 2 });
    store.close();
    store = openSqliteStore(path);
    assert.deepEqual(await store.assets.sessionAssets('s1'), { sessionId: 's1', workerId: 'w2', entries: [{ ...entry, digest: 'd2' }], at: 2 });
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
