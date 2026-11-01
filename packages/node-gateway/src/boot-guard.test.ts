import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootMarkerPath, clearBootMarker, readRollbackNote, rollbackNotePath, writeBootMarker } from './boot-marker.ts';

const guard = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'worker-boot-guard.sh');

/** 一个两次提交的假仓库：守卫脚本从它自己所在仓库回滚，所以把脚本拷进去跑。 */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'boot-guard-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
  git('init', '-q');
  mkdirSync(join(dir, 'scripts'));
  cpSync(guard, join(dir, 'scripts', 'worker-boot-guard.sh'));
  writeFileSync(join(dir, 'version'), 'old');
  git('add', '-A');
  git('commit', '-qm', 'old');
  const previous = git('rev-parse', 'HEAD');
  writeFileSync(join(dir, 'version'), 'new');
  git('commit', '-qam', 'new');
  const target = git('rev-parse', 'HEAD');
  const state = join(dir, 'state');
  const boot = () =>
    execFileSync('bash', [join(dir, 'scripts', 'worker-boot-guard.sh')], {
      env: { ...process.env, WORKER_STATE_DIR: state, AGENT_HUB_NPM: 'true' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  return { dir, state, previous, target, boot, head: () => git('rev-parse', 'HEAD') };
}

test('自更新后新版本一直没报健康：第 3 次启动前回滚到原提交并删标记', () => {
  const r = repo();
  try {
    writeBootMarker(r.state, r.previous, r.target);
    r.boot();
    r.boot();
    assert.equal(r.head(), r.target, '前两次照常用新版本启动');
    assert.match(readFileSync(bootMarkerPath(r.state), 'utf8'), / 2\n$/);
    r.boot();
    assert.equal(r.head(), r.previous);
    assert.equal(readFileSync(join(r.dir, 'version'), 'utf8'), 'old');
    assert.equal(existsSync(bootMarkerPath(r.state)), false);
    const note = readRollbackNote(r.state);
    assert.equal(note?.failed, r.target);
    assert.equal(note?.restored, r.previous);
    assert.match(note?.reason ?? '', /git 回滚/);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test('新版本报了健康（标记被删）：之后怎么重启都不回滚；没有标记时守卫什么也不做', () => {
  const r = repo();
  try {
    writeBootMarker(r.state, r.previous, r.target);
    r.boot();
    assert.equal(clearBootMarker(r.state), true);
    assert.equal(clearBootMarker(r.state), false);
    r.boot();
    r.boot();
    r.boot();
    assert.equal(r.head(), r.target);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test('标记格式不对：删掉、不动代码', () => {
  const r = repo();
  try {
    mkdirSync(r.state, { recursive: true });
    writeFileSync(bootMarkerPath(r.state), 'garbage; rm -rf /\n');
    r.boot();
    assert.equal(existsSync(bootMarkerPath(r.state)), false);
    assert.equal(r.head(), r.target);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test('回退记录：格式不对就删掉，不报', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rb-note-'));
  try {
    assert.equal(readRollbackNote(dir), null);
    writeFileSync(rollbackNotePath(dir), 'nope\nwhatever');
    assert.equal(readRollbackNote(dir), null);
    assert.equal(existsSync(rollbackNotePath(dir)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
