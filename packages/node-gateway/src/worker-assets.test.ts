import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
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

test('Worker 资产目录：落地、只取缺的、升级换整份、清单外的删掉、外人放的也清', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wa-'));
  try {
    const assets = createWorkerAssets({ root });
    assert.equal(await assets.current(), undefined);

    const first = await assets.sync([skill('greeter', 'v1', 'a'.repeat(64)), rule], fetch);
    assert.deepEqual(first.installed, { 'a-greeter': 'a'.repeat(64), 'a-rules': 'c'.repeat(64) });
    assert.match(await readFile(join(root, 'skills/greeter/SKILL.md'), 'utf8'), /v1/);
    assert.equal(await readFile(join(root, 'instructions/house-rules.md'), 'utf8'), 'Always answer in haiku.');
    const now = await assets.current();
    assert.deepEqual(now?.skills.map((s) => s.path), [join(root, 'skills/greeter/SKILL.md')]);
    assert.deepEqual(now?.instructions.map((s) => s.path), [join(root, 'instructions/house-rules.md')]);

    // 外人丢进来的东西，下次同步清掉（目录是 hub 专属的）
    await mkdir(join(root, 'skills/stray'), { recursive: true });
    await writeFile(join(root, 'skills/stray/SKILL.md'), 'x');
    fetched.length = 0;
    await assets.sync([skill('greeter', 'v2', 'b'.repeat(64))], fetch);
    assert.equal(fetched.flat().length, 1, '只有改了的 SKILL.md 要取');
    assert.match(await readFile(join(root, 'skills/greeter/SKILL.md'), 'utf8'), /v2/);
    assert.deepEqual(await readdir(join(root, 'skills')), ['greeter']);
    assert.deepEqual(await readdir(join(root, 'instructions')), []);
    assert.equal((await readdir(join(root, '.blobs'))).length, 2, '旧版本的内容回收了');

    await assets.sync([], fetch);
    assert.equal(await assets.current(), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Worker 资产目录：路径越界、哈希不对都拒绝，旧的一版保持不动', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wa-'));
  try {
    const assets = createWorkerAssets({ root });
    await assets.sync([skill('greeter', 'v1', 'a'.repeat(64))], fetch);
    const evil = skill('greeter', 'v2', 'b'.repeat(64));
    const escape = { ...evil, files: [...evil.files, { path: '../../x.md', ...put('x') }] };
    await assert.rejects(assets.sync([escape], fetch), /路径不合法/);
    const lying: FetchBlobs = async (hashes) => hashes.map((sha256) => ({ sha256, data: Buffer.from('nope').toString('base64') }));
    await assert.rejects(assets.sync([skill('greeter', 'v3', 'd'.repeat(64))], lying), /哈希不对/);
    assert.match(await readFile(join(root, 'skills/greeter/SKILL.md'), 'utf8'), /v1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Worker 资产目录：项目级同名技能落到 project-skills/<id8>/<name>，current 只给这次会话生效的', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wa-scope-'));
  try {
    const assets = createWorkerAssets({ root });
    const global = skill('greeter', 'global', 'a'.repeat(64));
    const local = { ...skill('greeter', 'local', 'b'.repeat(64)), assetId: 'a-local', slot: 'greeter--abcd1234' };
    await assets.sync([global, local, rule], fetch);
    assert.match(await readFile(join(root, 'skills/greeter/SKILL.md'), 'utf8'), /global/);
    assert.match(await readFile(join(root, 'project-skills/abcd1234/greeter/SKILL.md'), 'utf8'), /local/);
    const only = await assets.current(new Set(['a-local', 'a-rules']));
    assert.deepEqual(only?.skills.map((s) => s.path), [join(root, 'project-skills/abcd1234/greeter/SKILL.md')]);
    assert.equal(only?.instructions.length, 1);
    assert.equal((await assets.current())?.skills.length, 2);
    await assets.sync([global], fetch);
    assert.deepEqual(await readdir(join(root, 'project-skills')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
