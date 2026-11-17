import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeAssetSets, inMemoryAssets } from '../testing/in-memory.ts';
import { normalizeAssetPath, packAsset, checkAssetName } from '../asset.ts';
import {
  assetBlobsForWorker,
  assetsOverview,
  checkAssetUpdate,
  checkAllAssetUpdates,
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
  resolveSessionAssets
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

test('同步带上这台机器上仍在用的旧版本 digest（#225 M2）', async () => {
  const { deps, pushes } = inMemoryAssets();
  const made = await uploadAsset(deps, { kind: 'skill', files: skill() });
  assert.ok(made.ok);
  const old = made.value.pinned;
  await deps.assets.recordSessionAssets({
    sessionId: 's1',
    workerId: 'w1',
    entries: [{ assetId: made.value.id, kind: 'skill', name: 'greeter', digest: old, scope: 'global' }],
    at: 1
  });
  const upgraded = await uploadAssetRevision(deps, made.value.id, skill('say hello'));
  assert.ok(upgraded.ok);
  const pinned = await pinAssetRevision(deps, made.value.id, upgraded.value.asset.latest);
  assert.ok(pinned.ok);
  assert.ok((await setAssetInstalled(deps, { workerId: 'w1', assetId: made.value.id, installed: true })).ok);
  await flush();
  const last = pushes.at(-1);
  assert.ok(last);
  assert.deepEqual(last.retain, [old]);
  assert.notEqual(last.manifest[0]?.digest, old);
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
  const made = await importGitAsset(deps, {
    kind: 'skill',
    url: 'https://github.com/x/y.git',
    ref: null,
    path: 'skills/greeter',
    policy: 'track'
  });
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

test('版本策略：默认 locked 钉住解析出的提交、跳过检查更新；track 保留 ref 并跟随内容变化', async () => {
  const { deps, git } = inMemoryAssets();
  git.commit = 'c0ffee';
  git.files = skill();
  const locked = await importGitAsset(deps, { kind: 'skill', url: 'https://github.com/x/y.git', ref: 'main', path: 'skills/greeter' });
  assert.ok(locked.ok);
  assert.equal(locked.value.source.type, 'git');
  if (locked.value.source.type !== 'git') return;
  assert.equal(locked.value.source.ref, 'c0ffee', 'locked 把 ref 钉成完整提交');
  assert.equal(locked.value.source.policy, 'locked');
  const skipped = await checkAssetUpdate(deps, locked.value.id);
  assert.equal(skipped.ok, false);
  assert.match(skipped.ok ? '' : skipped.error.message, /locked/);
  assert.equal((await checkAllAssetUpdates(deps)).checked, 0, '巡检不碰 locked 的资产');

  git.files = skill('v2', 'tracker');
  const tracked = await importGitAsset(deps, {
    kind: 'skill',
    url: 'https://github.com/x/z.git',
    ref: 'main',
    path: 'skills/tracker',
    policy: 'track'
  });
  assert.ok(tracked.ok);
  if (tracked.value.source.type !== 'git') return;
  assert.equal(tracked.value.source.ref, 'main', 'track 保留分支名');
  assert.equal(tracked.value.source.policy, 'track');
  // 标签被强推到别的提交也走同一条路：内容变了 digest 就变，记成待审的新版本。
  git.files = skill('v3', 'tracker');
  git.commit = 'c2';
  const changed = await checkAssetUpdate(deps, tracked.value.id);
  assert.ok(changed.ok && changed.value.changed);
  assert.notEqual(changed.value.asset.latest, changed.value.asset.pinned);
});

test('私有仓库：令牌只走这次拉取；track 存进密钥箱供以后巡检，locked 直接拒绝（#226）', async () => {
  const { deps, git } = inMemoryAssets();
  git.files = skill();
  const locked = await importGitAsset(deps, {
    kind: 'skill',
    url: 'https://github.com/x/private.git',
    ref: 'main',
    path: 'skills/greeter',
    credential: 'ghp_lockedtoken'
  });
  assert.equal(locked.ok, false);
  assert.match(locked.ok ? '' : locked.error.message, /track/);
  assert.deepEqual(await deps.secrets.list(), [], 'locked 不留令牌');

  git.files = skill('v2', 'tracker');
  const tracked = await importGitAsset(deps, {
    kind: 'skill',
    url: 'https://github.com/x/private2.git',
    ref: 'main',
    path: 'skills/tracker',
    policy: 'track',
    credential: 'ghp_trackedtoken'
  });
  assert.ok(tracked.ok);
  if (tracked.value.source.type !== 'git') return;
  const secret = tracked.value.source.tokenSecret ?? '';
  assert.equal(secret, `asset-git:${tracked.value.id}`);
  const stored = await deps.secrets.list();
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.name, secret);
  git.files = skill('v3', 'tracker');
  const changed = await checkAssetUpdate(deps, tracked.value.id);
  assert.ok(changed.ok);
  assert.equal(git.calls.at(-1)?.token, 'ghp_trackedtoken', '巡检复用密钥箱里的令牌');
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

test('会话视图：这台机器上一条会话资产都没有时不传 sessions（避免 Worker 清空视图）', async () => {
  const { deps, pushes } = inMemoryAssets();
  const a = await uploadAsset(deps, { kind: 'skill', files: skill() });
  assert.ok(a.ok);
  await deps.assets.install('w1', a.value.id, 1);
  await syncWorkerAssets(deps, 'w1');
  assert.equal(pushes.at(-1)?.sessions, undefined);
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
  projectList.set('p2', { id: 'p2', name: 'other', teamId: null, createdBy: null, members: [], deletedAt: null });
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
  const plan = await resolveSessionAssets(deps, { sessionId: 's1', workerId: 'w1', projectId: 'p1' });
  assert.deepEqual(new Set(plan.assetIds), new Set([local.value.id, rules.value.id]));
  assert.equal(plan.entries.find((e) => e.assetId === local.value.id)?.scope, 'project');
  // 关掉本项目的那个 → 全局的回来
  assert.ok((await setProjectAsset(deps, { projectId: 'p1', assetId: local.value.id, enabled: false })).ok);
  assert.deepEqual(new Set((await resolveSessionAssets(deps, { sessionId: 's1', workerId: 'w1', projectId: 'p1' })).assetIds), new Set([global.value.id, rules.value.id]));
  assert.ok((await setProjectAsset(deps, { projectId: 'p1', assetId: rules.value.id, enabled: false })).ok);
  assert.deepEqual((await resolveSessionAssets(deps, { sessionId: 's1', workerId: 'w1', projectId: 'p1' })).assetIds, [global.value.id]);
  assert.ok((await setProjectAsset(deps, { projectId: 'p1', assetId: rules.value.id, enabled: null })).ok);
  // 没有项目（找不到任务）只给全局的；还没落地的不给
  assert.deepEqual(new Set((await resolveSessionAssets(deps, { sessionId: 's1', workerId: 'w1', projectId: null })).assetIds), new Set([global.value.id, rules.value.id]));
  deps.board.set({ workerId: 'w1', state: 'synced', root: '/r', installed: {}, error: null, at: 2 });
  assert.deepEqual((await resolveSessionAssets(deps, { sessionId: 's1', workerId: 'w1', projectId: null })).assetIds, []);
  // 清单里带落地名：项目级的同名不撞
  const manifest = await workerAssetManifest(deps, 'w1');
  assert.equal(new Set(manifest.map((e) => `${e.kind}:${e.slot}`)).size, manifest.length);
  assert.equal(manifest.filter((e) => e.name === 'greeter').length, 2);
});

test('定时检查更新：只查 Git 来源，记新版本和审计，不自动升级；查不了的单列', async () => {
  const { deps, git } = inMemoryAssets();
  git.files = skill();
  const fromGit = await importGitAsset(deps, {
    kind: 'skill',
    url: 'https://github.com/x/y.git',
    ref: null,
    path: 'skills/greeter',
    policy: 'track'
  });
  const uploaded = await uploadAsset(deps, { kind: 'skill', files: skill('x', 'local-tool') });
  assert.ok(fromGit.ok && uploaded.ok);
  const entries: { action: string; target: string; actorEmail: string }[] = [];
  const audit = { append: async (entry: { action: string; target: string; actorEmail: string }) => void entries.push(entry), recent: async () => [] };
  const quiet = await checkAllAssetUpdates({ ...deps, audit: audit as never });
  assert.deepEqual([quiet.checked, quiet.changed.length, quiet.failed.length], [1, 0, 0]);
  git.files = skill('v2');
  git.commit = 'c2';
  const report = await checkAllAssetUpdates({ ...deps, audit: audit as never });
  assert.deepEqual(report.changed.map((asset) => asset.name), ['greeter']);
  const after = await deps.assets.get(fromGit.value.id);
  assert.ok(after && after.latest !== after.pinned, '只记成最新版本，钉住的不变');
  assert.deepEqual(entries.map((e) => [e.action, e.target, e.actorEmail]), [['asset.revision', 'greeter', '自动检查']]);
  git.files = [{ path: 'README.md', data: enc('no skill') }];
  const broken = await checkAllAssetUpdates(deps);
  assert.equal(broken.failed[0]?.asset.name, 'greeter');
});

test('会话资产解析：组合按槽位覆盖、无项目丢项目级、显式清单是白名单', async () => {
  const { deps } = inMemoryAssets();
  const assetSets = fakeAssetSets();
  // 全局 greeter + 团队 greeter（同名）：组合里的后者应该覆盖项目生效集里的前者。
  const shared = await uploadAsset(deps, { kind: 'skill', files: skill('global', 'greeter') });
  assert.ok(shared.ok);
  const teamOne = await uploadAsset(deps, { kind: 'skill', files: skill('team', 'greeter'), scope: 'team', teamId: 't1' });
  assert.ok(teamOne.ok);
  const mine = await uploadAsset(deps, { kind: 'instruction', files: [{ path: 'a.md', data: enc('personal') }], name: 'personal-note', scope: 'personal', ownerId: 'u1' });
  assert.ok(mine.ok);
  const projectOne = await uploadAsset(deps, { kind: 'instruction', files: [{ path: 'b.md', data: enc('project') }], name: 'project-note', scope: 'project', projectId: 'p1' });
  assert.ok(projectOne.ok);
  const others = await uploadAsset(deps, { kind: 'instruction', files: [{ path: 'c.md', data: enc('other') }], name: 'other-note', scope: 'personal', ownerId: 'u2' });
  assert.ok(others.ok);

  await assetSets.save({
    id: 'aset_t1',
    teamId: 't1',
    name: 'T1',
    description: null,
    items: [{ assetId: teamOne.value.id }, { assetId: mine.value.id }, { assetId: projectOne.value.id }],
    createdBy: 'u1',
    createdAt: 1,
    updatedAt: 1
  });

  for (const asset of [shared, teamOne, mine, projectOne, others]) await deps.assets.install('w1', asset.value.id, 1);
  const landed = Object.fromEntries([shared, teamOne, mine, projectOne, others].map((a) => [a.value.id, a.value.pinned]));
  deps.board.set({ workerId: 'w1', state: 'synced', root: '/r', installed: landed, error: null, at: 1 });

  const viewer = { userId: 'u1', teamId: 't1' };
  const withProject = await resolveSessionAssets(
    { assets: deps.assets, board: deps.board, assetSets },
    { sessionId: 's1', workerId: 'w1', projectId: 'p1', viewer, setIds: ['aset_t1'] }
  );
  // 组合里的 team greeter 覆盖全局 greeter；别的个人资产不会出现。
  assert.deepEqual(new Set(withProject.assetIds), new Set([teamOne.value.id, mine.value.id, projectOne.value.id]));
  assert.deepEqual(withProject.setIds, ['aset_t1']);

  // 没有项目：项目级资产无处安放，直接丢；个人资产仍按发起人给。
  const noProject = await resolveSessionAssets(
    { assets: deps.assets, board: deps.board, assetSets },
    { sessionId: 's1', workerId: 'w1', projectId: null, viewer, setIds: ['aset_t1'] }
  );
  assert.deepEqual(new Set(noProject.assetIds), new Set([teamOne.value.id, mine.value.id]));

  // 显式清单是白名单：空数组 = 一个都不带。
  const empty = await resolveSessionAssets(
    { assets: deps.assets, board: deps.board, assetSets },
    { sessionId: 's1', workerId: 'w1', projectId: 'p1', viewer, assetIds: [] }
  );
  assert.deepEqual(empty.assetIds, []);

  // 不存在/已删的组合被跳过，并留下日志。
  const logged: string[] = [];
  const missing = await resolveSessionAssets(
    { assets: deps.assets, board: deps.board, assetSets },
    { sessionId: 's9', workerId: 'w1', projectId: 'p1', viewer, setIds: ['aset_gone'], log: (line) => logged.push(line) }
  );
  assert.deepEqual(missing.setIds, []);
  assert.equal(logged.length, 1);
});

test('项目级资产：不能挂到别的团队的项目上（#227）', async () => {
  const { deps } = inMemoryAssets();
  const other = {
    ...deps,
    projects: { byId: async () => ({ id: 'prj-x', name: 'X', teamId: 'team-b', createdBy: null, members: [], deletedAt: null }) }
  };
  const made = await uploadAsset(other, { kind: 'skill', files: skill(), projectId: 'prj-x', scope: 'project', ownerId: 'u1', teamId: 'team-a' });
  assert.equal(made.ok, false);
  assert.equal(made.ok ? '' : made.error.code, 'forbidden');
});

test('项目级资产：回收站里的项目不收', async () => {
  const { deps } = inMemoryAssets();
  const trash = {
    ...deps,
    projects: { byId: async () => ({ id: 'prj-x', name: 'X', teamId: null, createdBy: null, members: [], deletedAt: 1 }) }
  };
  const made = await uploadAsset(trash, { kind: 'skill', files: skill(), projectId: 'prj-x', scope: 'project', ownerId: 'u1', teamId: null });
  assert.equal(made.ok, false);
  assert.equal(made.ok ? '' : made.error.code, 'not_found');
});

test('允许清单：候选资产没装在这台机器时，靠 ensure 预热后照样下发；预热失败就拦住（#226）', async () => {
  const { deps } = inMemoryAssets();
  const made = await uploadAsset(deps, { kind: 'skill', files: skill() });
  assert.ok(made.ok);
  const id = made.value.id;

  // 没装、也没落地：没有 ensure 时按旧语义跳过。
  const plain = await resolveSessionAssets(deps, { sessionId: 's1', workerId: 'w1', projectId: null });
  assert.deepEqual(plain.assetIds, []);

  // 有 ensure：预热钩子把它装好并给出落地 digest。
  const asked: string[][] = [];
  const warmed = await resolveSessionAssets(deps, {
    sessionId: 's1',
    workerId: 'w1',
    projectId: null,
    ensure: async (workerId, assetIds) => {
      asked.push([workerId, ...assetIds]);
      return Object.fromEntries(assetIds.map((assetId) => [assetId, made.value.pinned]));
    }
  });
  assert.deepEqual(asked, [['w1', id]]);
  assert.deepEqual(warmed.assetIds, [id]);
  assert.equal(warmed.entries[0]?.digest, made.value.pinned);

  // 预热失败：不给条目，并说明原因（调用方据此拦住启动）。
  const failed = await resolveSessionAssets(deps, {
    sessionId: 's1',
    workerId: 'w1',
    projectId: null,
    ensure: async () => null
  });
  assert.deepEqual(failed.assetIds, []);
  assert.match(failed.blocked ?? '', /预热失败/);
});

test('MCP 资产：一份 mcp.json 多台服务器，按服务器下发；跨资产撞名只留先到的', async () => {
  const { deps } = inMemoryAssets();
  const json = (value: unknown) => [{ path: 'mcp.json', data: enc(JSON.stringify(value)) }];
  const bundle = await uploadAsset(deps, {
    kind: 'mcp',
    name: 'toolbox',
    files: json({
      servers: [
        { name: 'files', command: 'node', args: ['fs.js'], env: { FS_TOKEN: '${secret:FS_TOKEN}' } },
        { name: 'vendor', url: 'https://e/mcp', tools: { deny: ['delete'] } }
      ]
    })
  });
  const clash = await uploadAsset(deps, {
    kind: 'mcp',
    files: json({ name: 'vendor', url: 'https://other/mcp' })
  });
  assert.ok(bundle.ok && clash.ok);
  assert.equal(bundle.value.name, 'toolbox');
  await setAssetInstalled(deps, { workerId: 'w1', assetId: bundle.value.id, installed: true });
  await setAssetInstalled(deps, { workerId: 'w1', assetId: clash.value.id, installed: true });
  await setSecret(deps, 'FS_TOKEN', 'fs-value');
  const started = await sessionMcpLaunch(deps, 'w1');
  assert.deepEqual(started.launch.map((entry) => entry.name), ['files', 'vendor']);
  assert.ok(started.skipped.some((entry) => entry.name === 'vendor'));
  const target = await remoteMcpTarget(deps, 'w1', 'vendor');
  assert.ok(target.ok);
  assert.equal(target.value.url, 'https://e/mcp');
  assert.deepEqual(target.value.tools, { deny: ['delete'] });
  const secrets = await listSecrets(deps);
  assert.deepEqual(secrets.missing, []);
  assert.ok(secrets.secrets.find((row) => row.name === 'FS_TOKEN')?.usedBy.includes('toolbox'));
});
