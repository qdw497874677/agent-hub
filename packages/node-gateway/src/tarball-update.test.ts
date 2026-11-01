import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRollbackNote, writeBootMarker } from './boot-marker.ts';
import { readBuildInfo } from './build-info.ts';
import { runTarballUpdate, type UpdateReport } from './updater.ts';

const guard = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'worker-boot-guard.sh');
const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);

/** 一个「解压安装」：<root>/agent-hub 里是旧版，另有一个新版 tar 包。 */
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'tar-update-'));
  const dir = join(root, 'agent-hub');
  mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
  mkdirSync(join(dir, 'scripts'));
  cpSync(guard, join(dir, 'scripts', 'worker-boot-guard.sh'));
  writeFileSync(join(dir, 'version'), 'old');
  writeFileSync(join(dir, 'package.json'), '{"version":"1.0.0"}\n');
  writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), 'dep');
  writeFileSync(join(dir, '.agent-hub-commit'), `${OLD}\n`);
  const src = join(root, 'src');
  mkdirSync(join(src, 'scripts'), { recursive: true });
  cpSync(guard, join(src, 'scripts', 'worker-boot-guard.sh'));
  writeFileSync(join(src, 'version'), 'new');
  writeFileSync(join(src, 'package.json'), '{"version":"2.0.0"}\n');
  const tarball = join(root, 'w.tar.gz');
  execFileSync('tar', ['-czf', tarball, '-C', src, '.']);
  return { root, dir, tarball };
}

test('解压安装更新：解到 .next、复用 node_modules、npm install、换上，旧版留在 .prev，提交号写好', async () => {
  const s = setup();
  try {
    const reports: UpdateReport[] = [];
    const changed = await runTarballUpdate({ repoDir: s.dir, commit: NEW, report: (r) => reports.push(r), fetchTarball: async () => s.tarball, installArgs: ['--version'] });
    assert.equal(changed, true, reports.map((r) => r.message).join(' / '));
    assert.equal(readFileSync(join(s.dir, 'version'), 'utf8'), 'new');
    assert.equal(readBuildInfo(s.dir).commit, NEW);
    assert.equal(readBuildInfo(s.dir).version, '2.0.0');
    assert.equal(readFileSync(join(s.dir, 'node_modules', 'dep', 'index.js'), 'utf8'), 'dep', '旧依赖带过来了');
    assert.equal(readFileSync(join(`${s.dir}.prev`, 'version'), 'utf8'), 'old');
    assert.equal(existsSync(`${s.dir}.next`), false);
    assert.equal(reports.at(-1)?.state, 'succeeded');
    // 同一提交再来一次：无需更新
    assert.equal(await runTarballUpdate({ repoDir: s.dir, commit: NEW, report: (r) => reports.push(r), fetchTarball: async () => null }), false);
    assert.match(reports.at(-1)?.message ?? '', /无需更新/);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('解压安装更新：下载失败 / npm install 失败都不动当前版本，报 failed', async () => {
  const s = setup();
  try {
    const reports: UpdateReport[] = [];
    assert.equal(await runTarballUpdate({ repoDir: s.dir, commit: NEW, report: (r) => reports.push(r), fetchTarball: async () => null }), false);
    assert.match(reports.at(-1)?.message ?? '', /下载代码包失败/);
    assert.equal(await runTarballUpdate({ repoDir: s.dir, commit: NEW, report: (r) => reports.push(r), fetchTarball: async () => s.tarball, installArgs: ['no-such-npm-command-xyz'] }), false);
    assert.equal(reports.at(-1)?.state, 'failed');
    assert.match(reports.at(-1)?.message ?? '', /npm install 失败/);
    assert.equal(readFileSync(join(s.dir, 'version'), 'utf8'), 'old');
    assert.equal(readBuildInfo(s.dir).commit, OLD);
    assert.equal(existsSync(`${s.dir}.next`), false);
    assert.equal(existsSync(`${s.dir}.prev`), false);
    assert.equal(await runTarballUpdate({ repoDir: s.dir, commit: 'zz', report: (r) => reports.push(r), fetchTarball: async () => s.tarball }), false);
    assert.equal(reports.at(-1)?.state, 'refused');
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('解压安装：换上的新版一直起不来，boot guard 把 .prev 换回来', async () => {
  const s = setup();
  const state = join(s.root, 'state');
  try {
    assert.equal(await runTarballUpdate({ repoDir: s.dir, commit: NEW, report: () => {}, fetchTarball: async () => s.tarball, installArgs: ['--version'] }), true);
    writeBootMarker(state, OLD, NEW);
    const boot = () => execFileSync('bash', [join(s.dir, 'scripts', 'worker-boot-guard.sh')], { env: { ...process.env, WORKER_STATE_DIR: state }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    boot();
    boot();
    assert.equal(readFileSync(join(s.dir, 'version'), 'utf8'), 'new', '前两次照常用新版');
    boot();
    assert.equal(readFileSync(join(s.dir, 'version'), 'utf8'), 'old');
    assert.equal(readBuildInfo(s.dir).commit, OLD);
    assert.equal(readFileSync(join(`${s.dir}.failed`, 'version'), 'utf8'), 'new');
    assert.equal(existsSync(join(state, 'update-pending')), false);
    const note = readRollbackNote(state);
    assert.equal(note?.failed, NEW);
    assert.equal(note?.restored, OLD);
    assert.match(note?.reason ?? '', /旧版目录换回来/);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});
