import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { abortRelease, commitRelease, currentRelease, pruneReleases, readUpdateState, runReleaseUpdate, trialInProgress, writeUpdateState } from './releases.ts';
import { readRollbackNote } from './boot-marker.ts';
import { execRunner, type CommandRunner, type UpdateReport } from './updater.ts';

const guard = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'worker-boot-guard.sh');
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

/** 假「原地工作区」：两个提交，第二个的 selfcheck 可以设成失败。 */
function fixture(badSelfcheck = false) {
  const base = mkdtempSync(join(tmpdir(), 'releases-'));
  const legacy = join(base, 'legacy');
  mkdirSync(join(legacy, 'apps', 'worker', 'src'), { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: legacy, encoding: 'utf8', env: gitEnv }).trim();
  git('init', '-q');
  writeFileSync(join(legacy, 'apps', 'worker', 'src', 'main.ts'), 'old\n');
  writeFileSync(join(legacy, 'apps', 'worker', 'src', 'selfcheck.ts'), 'console.log("ok")\n');
  git('add', '-A');
  git('commit', '-qm', 'old');
  const previous = git('rev-parse', 'HEAD');
  writeFileSync(join(legacy, 'apps', 'worker', 'src', 'main.ts'), 'new\n');
  if (badSelfcheck) writeFileSync(join(legacy, 'apps', 'worker', 'src', 'selfcheck.ts'), 'process.exit(1)\n');
  git('commit', '-qam', 'new');
  const target = git('rev-parse', 'HEAD');
  git('checkout', '-q', '--detach', previous);
  const root = join(base, 'worker');
  const state = join(base, 'state');
  const calls: string[] = [];
  // npm ci 不真跑；git 和 node（selfcheck）真跑
  const run: CommandRunner = async (command, args, cwd) => {
    calls.push(`${command} ${args.join(' ')}`);
    return command === 'npm' ? { code: 0, output: 'added 0 packages' } : execRunner(command, args, cwd);
  };
  const reports: UpdateReport[] = [];
  const update = (commit: string, runningDir = legacy, runningCommit = previous) =>
    runReleaseUpdate({ root, runningDir, runningCommit, commit, run, report: (r) => void reports.push(r) });
  const boot = () =>
    execFileSync('bash', [guard], { env: { ...process.env, WORKER_STATE_DIR: state, HUB_WORKER_UPDATE_MODE: 'releases', WORKER_RELEASES_DIR: root }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { base, legacy, root, state, previous, target, calls, reports, update, boot, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test('releases：第一次更新 = 迁移：原工作区原样当 previous，新版本装进 releases/<sha> 当 current，写 trial', async () => {
  const f = fixture();
  try {
    assert.equal(await f.update(f.target), true);
    assert.equal(realpathSync(join(f.root, 'previous')), realpathSync(f.legacy));
    assert.equal(currentRelease(f.root), f.target);
    assert.equal(readFileSync(join(f.root, 'current', 'apps', 'worker', 'src', 'main.ts'), 'utf8'), 'new\n');
    assert.equal(readFileSync(join(f.legacy, 'apps', 'worker', 'src', 'main.ts'), 'utf8'), 'old\n', '原工作区一点没动');
    const state = readUpdateState(f.root);
    assert.equal(state?.phase, 'trial');
    assert.equal(state?.previous, f.previous);
    assert.equal(state?.target, f.target);
    assert.ok(f.calls.some((c) => c.startsWith('npm ci')));
    assert.ok(f.calls.some((c) => c.endsWith('apps/worker/src/selfcheck.ts')));
    assert.ok(trialInProgress(f.root, join(f.root, 'current')));
    assert.equal(trialInProgress(f.root, f.legacy), null, '旧版本跑着时不算试运行');
    assert.equal((await f.update(f.previous, join(f.root, 'current'), f.target)) || f.reports.at(-1)?.state, 'refused', '试运行没结束不接新的更新');
  } finally {
    f.cleanup();
  }
});

test('releases：预检失败 → 删 staging、current / previous 都不建，报 failed', async () => {
  const f = fixture(true);
  try {
    assert.equal(await f.update(f.target), false);
    assert.equal(f.reports.at(-1)?.state, 'failed');
    assert.match(f.reports.at(-1)?.message ?? '', /预检失败/);
    assert.equal(existsSync(join(f.root, 'current')), false);
    assert.equal(existsSync(join(f.root, 'releases', f.target)), false);
    assert.equal(readUpdateState(f.root), null);
  } finally {
    f.cleanup();
  }
});

test('releases：hub 提交 → committed、守卫不再理它；id 对不上不认', async () => {
  const f = fixture();
  try {
    await f.update(f.target);
    const id = readUpdateState(f.root)!.id;
    assert.equal(commitRelease(f.root, 'other'), false);
    assert.equal(commitRelease(f.root, id), true);
    assert.equal(readUpdateState(f.root)?.phase, 'committed');
    for (let i = 0; i < 4; i += 1) f.boot();
    assert.equal(currentRelease(f.root), f.target, '提交后怎么重启都不回退');
  } finally {
    f.cleanup();
  }
});

test('releases：hub 让回退 → current 切回 previous、写回退记录，不重装依赖', async () => {
  const f = fixture();
  try {
    await f.update(f.target);
    const id = readUpdateState(f.root)!.id;
    const before = f.calls.length;
    assert.equal(abortRelease(f.root, f.state, id, '没报上套件清单'), true);
    assert.equal(realpathSync(join(f.root, 'current')), realpathSync(f.legacy));
    assert.equal(readUpdateState(f.root)?.phase, 'rolled_back');
    assert.equal(f.calls.length, before, '没跑任何命令');
    const note = readRollbackNote(f.state);
    assert.equal(note?.failed, f.target);
    assert.equal(note?.restored, f.previous);
    assert.match(note?.reason ?? '', /套件清单/);
  } finally {
    f.cleanup();
  }
});

test('releases 启动守卫：试运行的新版本连续起不来，第 3 次启动前把 current 切回 previous 并写回退记录', async () => {
  const f = fixture();
  try {
    await f.update(f.target);
    f.boot();
    f.boot();
    assert.equal(currentRelease(f.root), f.target, '前两次照常用新版本');
    assert.equal(readUpdateState(f.root)?.boots, 2);
    f.boot();
    assert.equal(realpathSync(join(f.root, 'current')), realpathSync(f.legacy));
    assert.equal(readUpdateState(f.root)?.phase, 'rolled_back');
    const note = readRollbackNote(f.state);
    assert.equal(note?.failed, f.target);
    assert.equal(note?.restored, f.previous);
    assert.match(note?.reason ?? '', /切回上一个版本/);
    f.boot();
    assert.equal(realpathSync(join(f.root, 'current')), realpathSync(f.legacy), '回退后守卫不再动');
  } finally {
    f.cleanup();
  }
});

test('releases：清理只留 current、previous 和 1 个更早的', () => {
  const root = mkdtempSync(join(tmpdir(), 'prune-'));
  try {
    const shas = ['1', '2', '3', '4', '5'].map((c) => c.repeat(40));
    shas.forEach((sha, i) => {
      mkdirSync(join(root, 'releases', sha), { recursive: true });
      const t = new Date(Date.now() - (10 - i) * 60_000);
      execFileSync('touch', ['-d', t.toISOString(), join(root, 'releases', sha)]);
    });
    execFileSync('ln', ['-s', join(root, 'releases', shas[4]!), join(root, 'current')]);
    execFileSync('ln', ['-s', join(root, 'releases', shas[1]!), join(root, 'previous')]);
    writeUpdateState(root, { id: 'x', previous: shas[1]!, target: shas[4]!, phase: 'committed', boots: 0, startedAt: 0 });
    const removed = pruneReleases(root).map((dir) => dir.slice(-40)).sort();
    assert.deepEqual(removed, [shas[0], shas[2]].sort());
    assert.ok(existsSync(join(root, 'releases', shas[3]!)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

