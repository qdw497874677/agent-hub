import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readlink, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssetManifestEntryWire } from '@agent-hub/contract';
import { createWorkerAssets, type FetchBlobs } from './worker-assets.ts';

const store = new Map<string, Buffer>();
const put = (text: string) => {
  const bytes = Buffer.from(text);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  store.set(sha256, bytes);
  return { sha256, size: bytes.length };
};
const fetched: string[][] = [];
const fetch: FetchBlobs = async (hashes) => {
  fetched.push([...hashes]);
  return hashes.map((sha256) => ({ sha256, data: store.get(sha256)!.toString('base64') }));
};
const skill = (name: string, body: string, digest: string): AssetManifestEntryWire => ({
  assetId: `a-${name}`,
  kind: 'skill',
  name,
  description: `${name} desc`,
  digest,
  files: [
    { path: 'SKILL.md', ...put(`---\nname: ${name}\n---\n${body}`) },
    { path: 'refs/notes.md', ...put('shared notes') }
  ]
});
const rule: AssetManifestEntryWire = {
  assetId: 'a-rules',
  kind: 'instruction',
  name: 'house-rules',
  description: 'Rules',
  digest: 'c'.repeat(64),
  files: [{ path: 'AGENTS.md', ...put('Always answer in haiku.') }]
};
const a12 = 'a'.repeat(12);
const b12 = 'b'.repeat(12);
const c12 = 'c'.repeat(12);
const d12 = 'd'.repeat(12);

test('Worker 资产目录：不可变版本目录、.digest、相对兼容链接，清单外的删掉', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wa-layout-'));
  try {
    const assets = createWorkerAssets({ root });
    assert.equal(await assets.current(), undefined);

    const first = await assets.sync([skill('greeter', 'v1', 'a'.repeat(64)), rule], fetch);
    assert.deepEqual(first.installed, { 'a-greeter': 'a'.repeat(64), 'a-rules': 'c'.repeat(64) });

    // 版本目录按内容寻址，写一次；.digest 记完整哈希，用来发现 12 位前缀撞车。
    assert.match(await readFile(join(root, 'assets', a12, 'greeter', 'SKILL.md'), 'utf8'), /v1/);
    assert.equal(await readFile(join(root, 'assets', a12, 'greeter', 'refs', 'notes.md'), 'utf8'), 'shared notes');
    assert.equal((await readFile(join(root, 'assets', a12, '.digest'), 'utf8')).trim(), 'a'.repeat(64));
    assert.equal(await readFile(join(root, 'assets', c12, 'house-rules.md'), 'utf8'), 'Always answer in haiku.');
    assert.equal((await readFile(join(root, 'assets', c12, '.digest'), 'utf8')).trim(), 'c'.repeat(64));

    // 兼容链接用相对路径指向当前版本。
    assert.equal(await readlink(join(root, 'skills', 'greeter')), join('..', 'assets', a12, 'greeter'));
    assert.equal(await readlink(join(root, 'instructions', 'house-rules.md')), join('..', 'assets', c12, 'house-rules.md'));
    assert.match(await readFile(join(root, 'skills', 'greeter', 'SKILL.md'), 'utf8'), /v1/);

    // current 返回版本化绝对路径，不是兼容链接。
    const now = await assets.current(new Set(['a-greeter', 'a-rules']));
    assert.deepEqual(now?.skills.map((s) => s.path), [join(root, 'assets', a12, 'greeter', 'SKILL.md')]);
    assert.deepEqual(now?.instructions.map((s) => s.path), [join(root, 'assets', c12, 'house-rules.md')]);

    // 外人丢进来的东西，下次同步清掉（目录是 hub 专属的）；旧版本靠 retain 保住。
    await mkdir(join(root, 'skills', 'stray'), { recursive: true });
    await writeFile(join(root, 'skills', 'stray', 'SKILL.md'), 'x');
    fetched.length = 0;
    await assets.sync([skill('greeter', 'v2', 'b'.repeat(64))], fetch, ['a'.repeat(64)]);
    assert.equal(fetched.flat().length, 1, '只有改了的 SKILL.md 要取');
    assert.equal(await readFile(now!.skills[0]!.path, 'utf8').then((text) => /v1/.test(text)), true, '旧版本内容不变');
    assert.equal(await readlink(join(root, 'skills', 'greeter')), join('..', 'assets', b12, 'greeter'));
    assert.match(await readFile(join(root, 'skills', 'greeter', 'SKILL.md'), 'utf8'), /v2/);
    assert.deepEqual(await readdir(join(root, 'skills')), ['greeter']);
    assert.deepEqual(await readdir(join(root, 'instructions')), []);
    assert.equal((await readdir(join(root, '.blobs'))).length, 2, '旧版本的内容回收了');

    await assets.sync([], fetch);
    assert.equal(await assets.current(), undefined);
    assert.deepEqual(await readdir(join(root, 'assets')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Worker 资产目录：retain 保住旧版本目录，不带 retain 就清掉', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wa-retain-'));
  try {
    const assets = createWorkerAssets({ root });
    await assets.sync([skill('greeter', 'v1', 'a'.repeat(64))], fetch);
    const oldPath = join(root, 'assets', a12, 'greeter', 'SKILL.md');

    const second = await assets.sync([skill('greeter', 'v2', 'b'.repeat(64))], fetch, ['a'.repeat(64)]);
    assert.deepEqual(second.installed, { 'a-greeter': 'b'.repeat(64) });
    assert.match(await readFile(oldPath, 'utf8'), /v1/, 'retain 里的旧版本仍然可读');
    assert.deepEqual((await readdir(join(root, 'assets'))).sort(), [a12, b12]);

    await assets.sync([skill('greeter', 'v2', 'b'.repeat(64))], fetch);
    assert.deepEqual(await readdir(join(root, 'assets')), [b12], '不带 retain 的旧版本被清掉');
    await assert.rejects(readFile(oldPath), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Worker 资产目录：指令同样落到版本化 .md + 兼容链接', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wa-instruction-'));
  try {
    const assets = createWorkerAssets({ root });
    await assets.sync([rule], fetch);
    const oldPath = join(root, 'assets', c12, 'house-rules.md');
    assert.equal(await readFile(oldPath, 'utf8'), 'Always answer in haiku.');
    assert.equal(await readlink(join(root, 'instructions', 'house-rules.md')), join('..', 'assets', c12, 'house-rules.md'));

    const rulesV2: AssetManifestEntryWire = {
      ...rule,
      digest: 'd'.repeat(64),
      files: [{ path: 'AGENTS.md', ...put('Always answer in limerick.') }]
    };
    const now = await assets.sync([rulesV2], fetch, ['c'.repeat(64)]);
    assert.deepEqual(now.installed, { 'a-rules': 'd'.repeat(64) });
    assert.equal(await readFile(oldPath, 'utf8'), 'Always answer in haiku.', '旧指令内容不变');
    assert.equal(await readFile(join(root, 'assets', d12, 'house-rules.md'), 'utf8'), 'Always answer in limerick.');
    assert.equal(await readlink(join(root, 'instructions', 'house-rules.md')), join('..', 'assets', d12, 'house-rules.md'));

    const current = await assets.current(new Set(['a-rules']));
    assert.deepEqual(current?.instructions.map((s) => s.path), [join(root, 'assets', d12, 'house-rules.md')]);

    await assets.sync([rulesV2], fetch);
    assert.deepEqual(await readdir(join(root, 'assets')), [d12]);
    await assert.rejects(readFile(oldPath), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Worker 资产目录：同一 digest12 目录里 .digest 不一致 = 前缀冲突，拒绝', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wa-collision-'));
  try {
    const assets = createWorkerAssets({ root });
    await mkdir(join(root, 'assets', a12), { recursive: true });
    await writeFile(join(root, 'assets', a12, '.digest'), 'f'.repeat(64));
    await assert.rejects(assets.sync([skill('greeter', 'v1', 'a'.repeat(64))], fetch), /前缀冲突/);
    assert.equal(await readFile(join(root, 'assets', a12, '.digest'), 'utf8'), 'f'.repeat(64));
    assert.deepEqual(await readdir(join(root, 'assets', a12)), ['.digest'], '冲突时不写入内容');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Worker 资产目录：清单重复 / 缺 SKILL.md / 路径越界 / 哈希不对都拒绝，旧的一版保持不动', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wa-invalid-'));
  try {
    const assets = createWorkerAssets({ root });
    await assets.sync([skill('greeter', 'v1', 'a'.repeat(64))], fetch);

    await assert.rejects(
      assets.sync([skill('greeter', 'x', 'b'.repeat(64)), skill('greeter', 'y', 'd'.repeat(64))], fetch),
      /重复了/
    );
    const noSkillMd = { ...skill('greeter', 'v2', 'b'.repeat(64)), files: [{ path: 'other.md', ...put('x') }] };
    await assert.rejects(assets.sync([noSkillMd], fetch), /缺 SKILL.md/);
    const evil = skill('greeter', 'v2', 'b'.repeat(64));
    const escape = { ...evil, files: [...evil.files, { path: '../../x.md', ...put('x') }] };
    await assert.rejects(assets.sync([escape], fetch), /路径不合法/);
    const lying: FetchBlobs = async (hashes) => hashes.map((sha256) => ({ sha256, data: Buffer.from('nope').toString('base64') }));
    await assert.rejects(assets.sync([skill('greeter', 'v3', 'd'.repeat(64))], lying), /哈希不对/);

    assert.match(await readFile(join(root, 'skills', 'greeter', 'SKILL.md'), 'utf8'), /v1/);
    assert.deepEqual(await readdir(join(root, 'assets')), [a12], '失败的同步不留下半个版本');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Worker 资产目录：没给资产清单 = 一个都不给，不再等于「全给」（#223）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wa-failclosed-'));
  try {
    const assets = createWorkerAssets({ root });
    await assets.sync([skill('greeter', 'v1', 'a'.repeat(64)), rule], fetch);
    // 缺省 / 显式空集都按空集过滤：hub 解析失败时不能把机器上装着的全塞给会话。
    assert.equal(await assets.current(), undefined);
    assert.equal(await assets.current(new Set()), undefined);
    // 只有白名单里的才给。
    const only = await assets.current(new Set(['a-greeter']));
    assert.deepEqual(only?.skills.map((s) => s.name), ['greeter']);
    assert.deepEqual(only?.instructions, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Worker 资产目录：清单里点名但版本目录不在了 = missing 报出来，current 不给（#225 M3）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wa-missing-'));
  try {
    const assets = createWorkerAssets({ root });
    await assets.sync([skill('greeter', 'v1', 'a'.repeat(64)), rule], fetch);
    assert.deepEqual(await assets.missing(new Set(['a-greeter', 'a-rules'])), []);
    await rm(join(root, 'assets', a12), { recursive: true, force: true });
    assert.deepEqual(await assets.missing(new Set(['a-greeter'])), ['greeter']);
    assert.equal(await assets.current(new Set(['a-greeter'])), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Worker 资产目录：项目级同名技能落到 project-skills/<id8>/<name> 链接，current 只给这次会话生效的', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wa-scope-'));
  try {
    const assets = createWorkerAssets({ root });
    const global = skill('greeter', 'global', 'a'.repeat(64));
    const local = { ...skill('greeter', 'local', 'b'.repeat(64)), assetId: 'a-local', slot: 'greeter--abcd1234' };
    await assets.sync([global, local, rule], fetch);
    assert.match(await readFile(join(root, 'skills', 'greeter', 'SKILL.md'), 'utf8'), /global/);
    assert.match(await readFile(join(root, 'project-skills', 'abcd1234', 'greeter', 'SKILL.md'), 'utf8'), /local/);
    assert.equal(
      await readlink(join(root, 'project-skills', 'abcd1234', 'greeter')),
      join('..', '..', 'assets', b12, 'greeter--abcd1234')
    );
    const only = await assets.current(new Set(['a-local', 'a-rules']));
    assert.deepEqual(only?.skills.map((s) => s.path), [join(root, 'assets', b12, 'greeter--abcd1234', 'SKILL.md')]);
    assert.equal(only?.instructions.length, 1);
    assert.equal((await assets.current(new Set(['a-greeter', 'a-local', 'a-rules'])))?.skills.length, 2);
    await assets.sync([global], fetch);
    assert.deepEqual(await readdir(join(root, 'project-skills')), []);
    assert.deepEqual(await readdir(join(root, 'assets')), [a12], '项目级旧版本被清掉');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('按 digest 取版本：换钉后仍读到旧版；旧版被清则算缺失（#226 E4c）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wa-pin-'));
  try {
    const assets = createWorkerAssets({ root });
    const kept = await assets.sync([skill('greeter', 'v1', 'a'.repeat(64))], fetch);
    assert.deepEqual(kept.installed, { 'a-greeter': 'a'.repeat(64) });
    // 换钉：同一 assetId 换成新 digest，旧版本靠 retain 留着。
    await assets.sync([skill('greeter', 'v2', 'b'.repeat(64))], fetch, ['a'.repeat(64)]);

    const pinned = await assets.current(new Set(['a-greeter']), { 'a-greeter': 'a'.repeat(64) });
    assert.ok(pinned);
    assert.match(pinned!.skills[0]!.path, new RegExp(`assets/${a12}/greeter/SKILL\\.md$`));
    assert.match(await readFile(pinned!.skills[0]!.path, 'utf8'), /v1/);
    // 没给 digest 仍是当前版本。
    const latest = await assets.current(new Set(['a-greeter']));
    assert.match(latest!.skills[0]!.path, new RegExp(`assets/${b12}/greeter/SKILL\\.md$`));
    // 点名一个不存在的版本：不给路径，missing 说得出名字。
    assert.equal(await assets.current(new Set(['a-greeter']), { 'a-greeter': 'd'.repeat(64) }), undefined);
    assert.deepEqual(await assets.missing(new Set(['a-greeter']), { 'a-greeter': 'd'.repeat(64) }), ['greeter']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Worker 会话视图：同名资产的两个版本同时给两个会话用，相对链接、互不覆盖（#226 P4）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wa-view-'));
  try {
    const assets = createWorkerAssets({ root });
    // 先落 v1；换钉到 v2，旧版本靠 retain 留着（hub 按 session_assets 算）。
    await assets.sync([skill('greeter', 'v1', 'a'.repeat(64)), rule], fetch, ['a'.repeat(64)]);
    await assets.sync([skill('greeter', 'v2', 'b'.repeat(64)), rule], fetch, ['a'.repeat(64)]);
    const one = await assets.view({
      sessionId: 's-one',
      assetIds: ['a-greeter', 'a-rules'],
      digests: { 'a-greeter': 'a'.repeat(64) }
    });
    const two = await assets.view({ sessionId: 's-two', assetIds: ['a-greeter', 'a-rules'] });
    assert.ok(one && two);
    assert.equal(one!.sessionId, 's-one');
    assert.equal(one!.skillsDir, join(root, 'sessions', 's-one', 'skills'));
    assert.equal(one!.instructionsDir, join(root, 'sessions', 's-one', 'instructions'));
    assert.equal(one!.assets.root, join(root, 'sessions', 's-one'));
    assert.deepEqual(one!.assets.skills.map((s) => s.path), [join(root, 'sessions', 's-one', 'skills', 'greeter', 'SKILL.md')]);
    assert.deepEqual(one!.assets.instructions.map((s) => s.path), [join(root, 'sessions', 's-one', 'instructions', 'house-rules.md')]);

    // 视图链接是相对路径：整个 root 搬走/挂到别处仍然有效。
    assert.equal(
      await readlink(join(root, 'sessions', 's-one', 'skills', 'greeter')),
      join('..', '..', '..', 'assets', a12, 'greeter')
    );
    assert.equal(
      await readlink(join(root, 'sessions', 's-one', 'instructions', 'house-rules.md')),
      join('..', '..', '..', 'assets', c12, 'house-rules.md')
    );
    // 两个会话各读自己钉住的那一版；兼容链接照旧指向当前版本。
    assert.match(await readFile(one!.assets.skills[0]!.path, 'utf8'), /v1/);
    assert.match(await readFile(two!.assets.skills[0]!.path, 'utf8'), /v2/);
    assert.match(await readFile(join(root, 'skills', 'greeter', 'SKILL.md'), 'utf8'), /v2/);
    assert.equal(await readFile(one!.assets.instructions[0]!.path, 'utf8'), 'Always answer in haiku.');
    assert.deepEqual(one!.missing, []);

    // 项目级同名技能用 slot 当文件名，不会和全局的撞在同一处。
    const local = { ...skill('greeter', 'local', 'd'.repeat(64)), assetId: 'a-local', slot: 'greeter--abcd1234' };
    await assets.sync([skill('greeter', 'v2', 'b'.repeat(64)), local], fetch, ['a'.repeat(64)]);
    const scoped = await assets.view({ sessionId: 's-scoped', assetIds: ['a-local'] });
    assert.deepEqual(scoped!.assets.skills.map((s) => s.path), [
      join(root, 'sessions', 's-scoped', 'skills', 'greeter--abcd1234', 'SKILL.md')
    ]);
    assert.equal(await readlink(join(root, 'sessions', 's-scoped', 'skills', 'greeter--abcd1234')), join('..', '..', '..', 'assets', d12, 'greeter--abcd1234'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Worker 会话视图：sync 带 sessions 时重建并回报路径、清孤儿视图，旧版本按视图引用保留', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wa-view-sync-'));
  try {
    const assets = createWorkerAssets({ root });
    await assets.sync([skill('greeter', 'v1', 'a'.repeat(64))], fetch);
    await assets.view({ sessionId: 's-old', assetIds: ['a-greeter'], digests: { 'a-greeter': 'a'.repeat(64) } });
    await mkdir(join(root, 'sessions', 's-orphan'), { recursive: true });

    // 换钉到 v2，且 hub 没给 retain：只靠 s-old 的视图引用保住 a 那一版。
    const report = await assets.sync([skill('greeter', 'v2', 'b'.repeat(64))], fetch, [], [
      { sessionId: 's-old', assetIds: ['a-greeter'], digests: { 'a-greeter': 'a'.repeat(64) } },
      { sessionId: 's-new', assetIds: ['a-greeter'] }
    ]);
    assert.deepEqual(Object.keys(report.views).sort(), ['s-new', 's-old']);
    assert.equal(report.views['s-old']!.skillsDir, join(root, 'sessions', 's-old', 'skills'));
    assert.equal(report.views['s-old']!.instructionsDir, join(root, 'sessions', 's-old', 'instructions'));
    assert.match(await readFile(report.views['s-old']!.assets.skills[0]!.path, 'utf8'), /v1/);
    assert.match(await readFile(report.views['s-new']!.assets.skills[0]!.path, 'utf8'), /v2/);
    assert.deepEqual((await readdir(join(root, 'sessions'))).sort(), ['s-new', 's-old'], '不在列表里的孤儿视图清掉');
    assert.deepEqual((await readdir(join(root, 'assets'))).sort(), [a12, b12], '视图还引用着的旧版本不能清');

    // 旧 hub 不发 sessions：不动视图，只回报空对象。
    const legacy = await assets.sync([skill('greeter', 'v2', 'b'.repeat(64))], fetch);
    assert.deepEqual(legacy.views, {});
    assert.deepEqual((await readdir(join(root, 'sessions'))).sort(), ['s-new', 's-old']);

    // 会话都没了（视图删掉）以后，旧版本才允许被清。
    assert.equal(await assets.dropSession('s-old'), true);
    assert.equal(await assets.dropSession('s-new'), true);
    assert.deepEqual(await readdir(join(root, 'sessions')), []);
    await assets.sync([skill('greeter', 'v2', 'b'.repeat(64))], fetch);
    assert.deepEqual(await readdir(join(root, 'assets')), [b12]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Worker 会话视图：空清单删视图、缺版本报 missing、非法会话 id 拒绝（#226 P4）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wa-view-clean-'));
  try {
    const assets = createWorkerAssets({ root });
    await assets.sync([skill('greeter', 'v1', 'a'.repeat(64))], fetch);

    const view = await assets.view({ sessionId: 's1', assetIds: ['a-greeter'] });
    assert.ok(view);
    assert.match(await readFile(view!.assets.skills[0]!.path, 'utf8'), /v1/);
    // 会话结束/归档：删视图（重复删返回 false）。
    assert.equal(await assets.dropSession('s1'), true);
    assert.equal(await assets.dropSession('s1'), false);
    // 空清单 = 不建视图，并把旧视图收掉（drop_session 的等价写法）。
    assert.equal(await assets.view({ sessionId: 's1', assetIds: [] }), undefined);
    assert.deepEqual(await readdir(join(root, 'sessions')), []);

    // 钉住的版本本机没有：视图照建，缺的 id 说得出名字（调用方报 degraded）。
    const gone = await assets.view({ sessionId: 's2', assetIds: ['a-greeter'], digests: { 'a-greeter': 'd'.repeat(64) } });
    assert.ok(gone);
    assert.deepEqual(gone!.missing, ['a-greeter']);
    assert.deepEqual(gone!.assets.skills, []);

    // 会话 id 直接当目录名：不允许跳出 sessions/。
    await assert.rejects(assets.view({ sessionId: '../evil', assetIds: ['a-greeter'] }), /不能用作目录名/);
    await assert.rejects(assets.dropSession('a/b'), /不能用作目录名/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
