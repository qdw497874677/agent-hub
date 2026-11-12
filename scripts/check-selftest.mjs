#!/usr/bin/env node
// 门禁自检：坏 fixture 必须让检查函数显式失败，好 fixture 必须通过。
// 只依赖 node 内置模块；fixture 全部在 mkdtemp 出来的临时目录里，用完清理。
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkImportBoundaries } from './check-import-boundaries.mjs';
import { checkDomainPurity } from './check-domain-purity.mjs';
import { checkPortSignature } from './check-port-signature.mjs';
import { checkLockfile } from './check-lockfile.mjs';

const results = [];
const temps = [];

function record(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
}

async function makeTemp(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

async function writeJson(file, value) {
  await writeFile(file, JSON.stringify(value, null, 2) + '\n');
}

async function scaffold(dir) {
  for (const sub of ['packages/domain/src/ports', 'apps']) {
    await mkdir(join(dir, sub), { recursive: true });
  }
}

// --- 坏 fixture：package.json 不是合法 JSON ---------------------------------
const bad = await makeTemp('hub-check-selftest-bad-');
await scaffold(bad);
await writeFile(join(bad, 'packages/domain/package.json'), '{ "name": "@agent-hub/domain", ');
await writeFile(join(bad, 'package.json'), '{ "workspaces": [');
await writeFile(join(bad, 'packages/domain/src/ports/thing.ts'), 'export interface Thing { id: string }\n');

{
  const failures = await checkImportBoundaries(bad);
  record(
    'check-import-boundaries 对坏 package.json 失败',
    failures.length > 0 && failures.some((f) => f.includes('packages/domain')),
    JSON.stringify(failures)
  );
}
{
  const failures = await checkDomainPurity(bad);
  record(
    'check-domain-purity 对坏 package.json 失败',
    failures.length > 0 && failures.some((f) => f.includes('packages/domain/package.json')),
    JSON.stringify(failures)
  );
}
{
  const { failures } = await checkLockfile(bad);
  record(
    'check-lockfile 对坏根 package.json 失败',
    failures.length > 0 && failures.some((f) => f.includes('package.json')),
    JSON.stringify(failures)
  );
}

// --- 坏 fixture：ports 目录不可读 / 文件读不出来 ------------------------------
const noPorts = await makeTemp('hub-check-selftest-noports-');
await mkdir(join(noPorts, 'packages/domain/src'), { recursive: true });
{
  const { failures } = await checkPortSignature(noPorts);
  record(
    'check-port-signature 对缺失 ports 目录失败',
    failures.length > 0 && failures.some((f) => f.includes('packages/domain/src/ports')),
    JSON.stringify(failures)
  );
}

const unreadable = await makeTemp('hub-check-selftest-unreadable-');
await mkdir(join(unreadable, 'packages/domain/src/ports/broken.ts'), { recursive: true });
{
  const { failures } = await checkPortSignature(unreadable);
  record(
    'check-port-signature 对不可读的 .ts 文件失败',
    failures.length > 0 && failures.some((f) => f.includes('broken.ts')),
    JSON.stringify(failures)
  );
}

// --- 好 fixture：所有检查都应通过 --------------------------------------------
const good = await makeTemp('hub-check-selftest-good-');
await scaffold(good);
await writeJson(join(good, 'package.json'), { workspaces: ['packages/*'] });
await writeJson(join(good, 'packages/domain/package.json'), { name: '@agent-hub/domain' });
await writeFile(join(good, 'packages/domain/src/ports/thing.ts'), 'export interface Thing { id: string }\n');

const goodLock = {
  lockfileVersion: 3,
  packages: {
    '': { workspaces: ['packages/*'] },
    'packages/domain': { name: '@agent-hub/domain' },
    'node_modules/@agent-hub/domain': { resolved: 'packages/domain', link: true }
  }
};
await writeJson(join(good, 'package-lock.json'), goodLock);

{
  const failures = await checkImportBoundaries(good);
  record('check-import-boundaries 对好 fixture 通过', failures.length === 0, JSON.stringify(failures));
}
{
  const failures = await checkDomainPurity(good);
  record('check-domain-purity 对好 fixture 通过', failures.length === 0, JSON.stringify(failures));
}
{
  const { failures, ports } = await checkPortSignature(good);
  record('check-port-signature 对好 fixture 通过', failures.length === 0 && ports === 1, JSON.stringify(failures));
}
{
  const { failures, workspaces } = await checkLockfile(good);
  record('check-lockfile 对好 fixture 通过', failures.length === 0 && workspaces === 1, JSON.stringify(failures));
}

// --- 反向检查：lock 缺 workspace 条目 / 有 stale 条目 -------------------------
await writeJson(join(good, 'package-lock.json'), {
  lockfileVersion: 3,
  packages: { '': { workspaces: ['packages/*'] }, 'packages/domain': { name: '@agent-hub/domain' } }
});
{
  const { failures } = await checkLockfile(good);
  record(
    'check-lockfile 检出缺失的 workspace 条目',
    failures.some((f) => f.includes('缺少 workspace 条目') && f.includes('@agent-hub/domain')),
    JSON.stringify(failures)
  );
}

await writeJson(join(good, 'package-lock.json'), {
  lockfileVersion: 3,
  packages: {
    ...goodLock.packages,
    'node_modules/@agent-hub/ghost': { resolved: 'packages/ghost', link: true }
  }
});
{
  const { failures } = await checkLockfile(good);
  record(
    'check-lockfile 检出 stale @agent-hub 条目',
    failures.some((f) => f.includes('stale') && f.includes('@agent-hub/ghost')),
    JSON.stringify(failures)
  );
}

await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));

const failed = results.filter((ok) => !ok).length;
if (failed > 0) {
  console.error(`✗ 门禁自检失败：${failed}/${results.length}`);
  process.exit(1);
}
console.log(`✓ 门禁自检全部通过（${results.length} 项）`);
