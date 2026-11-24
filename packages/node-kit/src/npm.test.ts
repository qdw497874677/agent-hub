import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { findNpm, npmBin } from './npm.ts';

test('findNpm：优先用 Worker 自己 node 旁边的 npm，其次 PATH，按真实路径返回', async () => {
  const root = await mkdtemp(join(tmpdir(), 'node-kit-npm-'));
  try {
    const node = join(root, 'bin', 'node');
    const ownNpm = join(root, 'bin', 'npm');
    const pathNpm = join(root, 'path-bin', 'npm');
    await mkdir(join(root, 'bin'), { recursive: true });
    await mkdir(join(root, 'path-bin'), { recursive: true });
    await writeFile(node, '');
    await writeFile(ownNpm, '');
    await writeFile(pathNpm, '');
    assert.equal(findNpm(node, join(root, 'path-bin')), ownNpm);
    await rm(ownNpm);
    assert.equal(findNpm(node, join(root, 'path-bin')), pathNpm);
    assert.equal(findNpm(node, ''), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('npmBin：读包自己的 package.json，字符串和映射两种 bin 都认，拒绝逃出包目录', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'node-kit-bin-'));
  const write = async (name: string, manifest: unknown) => {
    await mkdir(join(dir, 'node_modules', name), { recursive: true });
    await writeFile(join(dir, 'node_modules', name, 'package.json'), JSON.stringify(manifest));
  };
  try {
    await write('string-bin', { bin: './cli.js' });
    assert.equal(npmBin(dir, 'string-bin', 'anything'), join('node_modules', 'string-bin', 'cli.js'));
    await write('map-bin', { bin: { tool: 'bin/tool.js', other: 'other.js' } });
    assert.equal(npmBin(dir, 'map-bin', 'tool'), join('node_modules', 'map-bin', 'bin', 'tool.js'));
    await write('bad-bin', { bin: '../escape.js' });
    assert.throws(() => npmBin(dir, 'bad-bin', 'tool'), /bad-bin 的 package.json 里没有 tool 入口/);
    await write('no-bin', {});
    assert.throws(() => npmBin(dir, 'no-bin', 'tool'), /no-bin 的 package.json 里没有 tool 入口/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
