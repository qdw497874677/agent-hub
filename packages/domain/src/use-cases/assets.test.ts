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
  workerAssetManifest,
  sessionMcpLaunch,
  remoteMcpTarget,
  listSecrets,
  setSecret,
  deleteSecret,
  projectAssets,
  setProjectAsset,
  sessionAssetPlan
} from './assets.ts';
import { assetSlot } from '../asset.ts';

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

test('MCP 资产：不进文件清单；会话启动时 stdio 展开密钥，http 只给名字；hub 代连只认装在本机的 http', async () => {
  const { deps, pushes } = inMemoryAssets();
  const json = (value: unknown) => [{ path: 'mcp.json', data: enc(JSON.stringify(value)) }];
  const local = await uploadAsset(deps, { kind: 'mcp', files: json({ name: 'local-fs', command: 'node', args: ['srv.js'], env: { FS_TOKEN: '${secret:FS_TOKEN}' } }) });
  const remote = await uploadAsset(deps, { kind: 'mcp', files: json({ name: 'remote', url: 'https://e/mcp', headers: { Authorization: 'Bearer ${secret:REMOTE_TOKEN}' } }) });
  assert.ok(local.ok && remote.ok);
  assert.equal((await uploadAsset(deps, { kind: 'mcp', files: [{ path: 'other.json', data: enc('{}') }] })).ok, false);
  await setAssetInstalled(deps, { workerId: 'w1', assetId: local.value.id, installed: true });
  await setAssetInstalled(deps, { workerId: 'w1', assetId: remote.value.id, installed: true });
  await flush();
  assert.deepEqual(await workerAssetManifest(deps, 'w1'), []);
  assert.ok(pushes.every((push) => push.manifest.length === 0));

  // 没设密钥：stdio 那项被跳过（只报名字），http 照给
  let started = await sessionMcpLaunch(deps, 'w1');
  assert.deepEqual(started.launch.map((entry) => entry.name), ['remote']);
  assert.deepEqual(started.skipped.map((entry) => entry.name), ['local-fs']);
  assert.ok((await listSecrets(deps)).missing.some((row) => row.name === 'FS_TOKEN' && row.usedBy.includes('local-fs')));

  assert.equal((await setSecret(deps, 'bad name', 'x')).ok, false);
  assert.equal((await setSecret(deps, 'FS_TOKEN', 'a\nb')).ok, false);
  assert.ok((await setSecret(deps, 'FS_TOKEN', 'fs-value')).ok);
  assert.ok((await setSecret(deps, 'REMOTE_TOKEN', 'remote-value')).ok);
  started = await sessionMcpLaunch(deps, 'w1');
  const stdio = started.launch.find((entry) => entry.name === 'local-fs');
  assert.ok(stdio && stdio.transport === 'stdio');
  assert.equal(stdio.env['FS_TOKEN'], 'fs-value');
  // http 的密钥不下发
  assert.doesNotMatch(JSON.stringify(started.launch), /remote-value/);

  const target = await remoteMcpTarget(deps, 'w1', 'remote');
  assert.ok(target.ok);
  assert.equal(target.value.headers['Authorization'], 'Bearer remote-value');
  assert.equal((await remoteMcpTarget(deps, 'w2', 'remote')).ok, false);
  assert.equal((await remoteMcpTarget(deps, 'w1', 'local-fs')).ok, false);

  const view = await listSecrets(deps);
  assert.deepEqual(view.missing, []);
  assert.doesNotMatch(JSON.stringify(view), /fs-value|remote-value/);
  assert.ok((await deleteSecret(deps, 'FS_TOKEN')).ok);
  assert.equal((await deleteSecret(deps, 'FS_TOKEN')).ok, false);
});

test('项目级作用域：同名项目资产盖过全局，项目开关、别的项目看不见，会话清单 = 生效 ∩ 已落地', async () => {
  const { deps, projectList } = inMemoryAssets();
  projectList.set('p2', { id: 'p2', name: 'other' });
  const global = await uploadAsset(deps, { kind: 'skill', files: skill('global') });
  const local = await uploadAsset(deps, { kind: 'skill', files: skill('local'), projectId: 'p1' });
  const rules = await uploadAsset(deps, { kind: 'instruction', name: 'house-rules', files: [{ path: 'r.md', data: enc('x') }] });
  const foreign = await uploadAsset(deps, { kind: 'instruction', name: 'secret-rules', files: [{ path: 'r.md', data: enc('y') }], projectId: 'p2' });
  assert.ok(global.ok && local.ok && rules.ok && foreign.ok);
  // 同一作用域同名冲突；不存在的项目拒绝
  const dup = await uploadAsset(deps, { kind: 'skill', files: skill('again'), projectId: 'p1' });
  assert.equal(dup.ok || dup.error.code, 'conflict');
  assert.match(dup.ok ? '' : dup.error.message, /这个项目/);
  assert.equal((await uploadAsset(deps, { kind: 'skill', files: skill(), projectId: 'nope' })).ok, false);
  assert.equal(assetSlot(global.value), 'greeter');
  assert.match(assetSlot(local.value), /^greeter--[a-z0-9]{1,8}$/);

  const view = await projectAssets(deps, 'p1');
  assert.ok(view.ok);
  const byId = new Map(view.value.choices.map((c) => [c.assetId, c]));
  assert.equal(byId.has(foreign.value.id), false);
  assert.equal(byId.get(global.value.id)?.shadowedBy, local.value.id);
  assert.equal(byId.get(local.value.id)?.scope, 'project');
  assert.equal((await setProjectAsset(deps, { projectId: 'p1', assetId: foreign.value.id, enabled: true })).ok, false);

  for (const id of [global.value.id, local.value.id, rules.value.id, foreign.value.id]) await deps.assets.install('w1', id, 1);
  const landed = Object.fromEntries([global, local, rules, foreign].map((a) => [a.value.id, a.value.pinned]));
  deps.board.set({ workerId: 'w1', state: 'synced', root: '/r', installed: landed, error: null, at: 1 });
  const plan = await sessionAssetPlan(deps, 'w1', 'p1');
  assert.deepEqual(new Set(plan.assetIds), new Set([local.value.id, rules.value.id]));
  assert.equal(plan.entries.find((e) => e.assetId === local.value.id)?.scope, 'project');
  // 关掉本项目的那个 → 全局的回来
  assert.ok((await setProjectAsset(deps, { projectId: 'p1', assetId: local.value.id, enabled: false })).ok);
  assert.deepEqual(new Set((await sessionAssetPlan(deps, 'w1', 'p1')).assetIds), new Set([global.value.id, rules.value.id]));
  assert.ok((await setProjectAsset(deps, { projectId: 'p1', assetId: rules.value.id, enabled: false })).ok);
  assert.deepEqual((await sessionAssetPlan(deps, 'w1', 'p1')).assetIds, [global.value.id]);
  assert.ok((await setProjectAsset(deps, { projectId: 'p1', assetId: rules.value.id, enabled: null })).ok);
  // 没有项目（找不到任务）只给全局的；还没落地的不给
  assert.deepEqual(new Set((await sessionAssetPlan(deps, 'w1', null)).assetIds), new Set([global.value.id, rules.value.id]));
  deps.board.set({ workerId: 'w1', state: 'synced', root: '/r', installed: {}, error: null, at: 2 });
  assert.deepEqual((await sessionAssetPlan(deps, 'w1', null)).assetIds, []);
  // 清单里带落地名：项目级的同名不撞
  const manifest = await workerAssetManifest(deps, 'w1');
  assert.equal(new Set(manifest.map((e) => `${e.kind}:${e.slot}`)).size, manifest.length);
  assert.equal(manifest.filter((e) => e.name === 'greeter').length, 2);
});
