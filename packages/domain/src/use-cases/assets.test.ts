import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryAssets } from '../testing/in-memory.ts';
import { normalizeAssetPath, packAsset, checkAssetName } from '../asset.ts';
import {
  assetBlobsForWorker,
  assetsOverview,
  checkAssetUpdate,
  deleteAsset,
  diffAssetRevisions,
  importGitAsset,
  pinAssetRevision,
  setAssetInstalled,
  syncWorkerAssets,
  uploadAsset,
  uploadAssetRevision,
  workerAssetManifest
} from './assets.ts';

const enc = (text: string) => new TextEncoder().encode(text);
const skill = (body = 'say hi', name = 'greeter') => [
  { path: 'SKILL.md', data: enc(`---\nname: ${name}\ndescription: Greets people\n---\n${body}\n`) },
  { path: 'scripts/x.txt', data: enc('helper') }
];
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('名字和路径规则', () => {
  assert.ok(checkAssetName('pdf-tools').ok);
  for (const bad of ['', 'PDF', '-a', 'a-', 'a--b', 'a_b', 'x'.repeat(65)]) assert.equal(checkAssetName(bad).ok, false, bad);
  assert.deepEqual(normalizeAssetPath('./a/b.md'), { ok: true, value: 'a/b.md' });
  for (const bad of ['/etc/passwd', '../x', 'a/../b', 'a\\b', 'a//b', '']) assert.equal(normalizeAssetPath(bad).ok, false, bad);
});

test('打包：内容寻址、与顺序无关，拒绝 hooks/bin 和缺 SKILL.md', async () => {
  const a = await packAsset('skill', skill());
  const b = await packAsset('skill', [...skill()].reverse());
  assert.ok(a.ok && b.ok);
  assert.equal(a.value.digest, b.value.digest);
  assert.equal((await packAsset('skill', [...skill(), { path: 'hooks/pre.sh', data: enc('x') }])).ok, false);
  assert.equal((await packAsset('skill', [...skill(), { path: 'bin/run', data: enc('x') }])).ok, false);
  assert.equal((await packAsset('skill', [{ path: 'README.md', data: enc('x') }])).ok, false);
  assert.equal((await packAsset('instruction', [{ path: 'a.md', data: enc('x') }, { path: 'b.md', data: enc('y') }])).ok, false);
  assert.equal((await packAsset('skill', [...skill(), { path: 'SKILL.md', data: enc('dup') }])).ok, false);
});

test('上传技能：名字来自 frontmatter，同名冲突', async () => {
  const { deps } = inMemoryAssets();
  const made = await uploadAsset(deps, { kind: 'skill', files: skill() });
  assert.ok(made.ok);
  assert.equal(made.value.name, 'greeter');
  assert.equal(made.value.description, 'Greets people');
  assert.equal(made.value.pinned, made.value.latest);
  const again = await uploadAsset(deps, { kind: 'skill', files: skill('other') });
  assert.equal(again.ok || again.error.code, 'conflict');
  const instr = await uploadAsset(deps, { kind: 'instruction', name: 'house-rules', files: [{ path: 'house-rules.md', data: enc('Be terse.') }] });
  assert.ok(instr.ok);
  const unnamed = await uploadAsset(deps, { kind: 'instruction', files: [{ path: 'x.md', data: enc('x') }] });
  assert.equal(unnamed.ok, false);
});

test('新版本只是「可升级」，确认后才换钉并重新同步', async () => {
  const { deps, pushes } = inMemoryAssets();
  const made = await uploadAsset(deps, { kind: 'skill', files: skill() });
  assert.ok(made.ok);
  assert.ok((await setAssetInstalled(deps, { workerId: 'w1', assetId: made.value.id, installed: true })).ok);
  await flush();
  const v1 = made.value.pinned;
  assert.equal(pushes.at(-1)?.manifest[0]?.digest, v1);

  const next = await uploadAssetRevision(deps, made.value.id, skill('say hello'));
  assert.ok(next.ok && next.value.changed);
  const v2 = next.value.asset.latest;
  assert.notEqual(v2, v1);
  assert.equal(next.value.asset.pinned, v1);
  assert.equal((await workerAssetManifest(deps, 'w1'))[0]?.digest, v1, '没确认前 Worker 拿到的仍是旧版');

  const diff = await diffAssetRevisions(deps, made.value.id, v1, v2);
  assert.ok(diff.ok);
  assert.deepEqual(diff.value.map((d) => [d.path, d.change]), [['SKILL.md', 'modified'], ['scripts/x.txt', 'unchanged']]);
  assert.match(diff.value[0]?.patch ?? '', /say hello/);

  const renamed = await uploadAssetRevision(deps, made.value.id, skill('x', 'other-name'));
  assert.equal(renamed.ok, false, '名字不能变');

  const pinned = await pinAssetRevision(deps, made.value.id, v2);
  assert.ok(pinned.ok);
  await flush();
  assert.equal(pushes.at(-1)?.manifest[0]?.digest, v2);
});

test('git 来源：检查更新，内容没变就不记新版本', async () => {
  const { deps, git } = inMemoryAssets();
  git.files = skill();
  const made = await importGitAsset(deps, { kind: 'skill', url: 'https://github.com/x/y.git', ref: null, path: 'skills/greeter' });
  assert.ok(made.ok);
  assert.equal((await importGitAsset(deps, { kind: 'skill', url: 'file:///etc', ref: null, path: '' })).ok, false);
  const same = await checkAssetUpdate(deps, made.value.id);
  assert.ok(same.ok && !same.value.changed);
  git.files = skill('v2');
  git.commit = 'c2';
  const changed = await checkAssetUpdate(deps, made.value.id);
  assert.ok(changed.ok && changed.value.changed);
  assert.notEqual(changed.value.asset.latest, changed.value.asset.pinned);
});

test('同步：离线记待同步；blob 只给清单里有的；删除后重新同步', async () => {
  const { deps, workers, board, pushes } = inMemoryAssets();
  const a = await uploadAsset(deps, { kind: 'skill', files: skill() });
  const b = await uploadAsset(deps, { kind: 'skill', files: skill('x', 'secret-tool') });
  assert.ok(a.ok && b.ok);
  await setAssetInstalled(deps, { workerId: 'w1', assetId: a.value.id, installed: true });
  await flush();
  assert.equal(board.get('w1')?.state, 'synced');
  const mine = a.value && (await workerAssetManifest(deps, 'w1'))[0]!.files[0]!.sha256;
  const theirs = (await deps.assets.revision(b.value.id, b.value.pinned))!.files.find((f) => f.path === 'SKILL.md')!.sha256;
  assert.ok((await assetBlobsForWorker(deps, 'w1', [mine])).ok);
  assert.equal((await assetBlobsForWorker(deps, 'w1', [theirs])).ok, false);

  assert.equal((await setAssetInstalled(deps, { workerId: 'nope', assetId: a.value.id, installed: true })).ok, false);

  workers[0] = { ...workers[0]!, state: 'offline' };
  assert.equal((await syncWorkerAssets(deps, 'w1')).state, 'pending');
  workers[0] = { ...workers[0]!, state: 'online' };

  assert.ok((await deleteAsset(deps, a.value.id)).ok);
  await flush();
  assert.deepEqual(pushes.at(-1)?.manifest, []);
  const overview = await assetsOverview(deps);
  assert.deepEqual(overview.assets.map((x) => x.name), ['secret-tool']);
  assert.deepEqual(overview.workers[0]?.assetIds, []);
});

test('投递失败记 failed，带原因', async () => {
  const world = inMemoryAssets();
  const deps = { ...world.deps, delivery: { push: async () => ({ ok: false as const, error: { code: 'unavailable' as const, message: '磁盘满了' } }) } };
  const a = await uploadAsset(deps, { kind: 'skill', files: skill() });
  assert.ok(a.ok);
  await deps.assets.install('w1', a.value.id, 1);
  const status = await syncWorkerAssets(deps, 'w1');
  assert.equal(status.state, 'failed');
  assert.equal(status.error, '磁盘满了');
});
