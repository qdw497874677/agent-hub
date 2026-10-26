import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitWorkspace } from './git-workspace.ts';

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

/** 一个「远端」（bare）+ 一份初始提交。 */
async function origin() {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'ws-git-')));
  const seed = join(root, 'seed');
  await mkdir(seed);
  sh(seed, 'init', '-q', '-b', 'main');
  await writeFile(join(seed, 'README.md'), 'hi\n');
  sh(seed, 'add', '.');
  sh(seed, 'commit', '-qm', 'init');
  sh(root, 'clone', '-q', '--bare', seed, 'origin.git');
  return { root, url: join(root, 'origin.git') };
}

test('clone → inspect → worktree → status → remove：有改动拒删，干净的删掉、分支保留', async () => {
  const { root, url } = await origin();
  const git = createGitWorkspace();
  const cloned = await git.clone({ repoUrl: url, parent: join(root, 'agent-hub'), name: 'demo' });
  assert.ok(cloned.ok, cloned.ok ? '' : cloned.error.message);
  assert.equal(cloned.value.branch, 'main');

  const inspected = await git.inspect(cloned.value.path);
  assert.ok(inspected.ok);
  assert.deepEqual(inspected.value, { exists: true, isGit: true, remoteUrl: url, branch: 'main' });
  const missing = await git.inspect(join(root, 'nope'));
  assert.ok(missing.ok && missing.value.exists === false);

  const tree = join(root, 'agent-hub', '.worktrees', 'demo-fix');
  const added = await git.addWorktree({ repoPath: cloned.value.path, path: tree, branch: 'agent-hub/fix-1a2b' });
  assert.ok(added.ok, added.ok ? '' : added.error.message);
  const again = await git.addWorktree({ repoPath: cloned.value.path, path: join(root, 'x'), branch: 'agent-hub/fix-1a2b' });
  assert.equal(again.ok, false, '同一分支不能检出两次');

  // 新分支什么都没做：干净（提交都在 main 上）
  const clean = await git.status(tree);
  assert.ok(clean.ok);
  assert.deepEqual({ ...clean.value, upstream: null }, { dirty: false, untracked: 0, unpushed: 0, branch: 'agent-hub/fix-1a2b', upstream: null });

  // 未跟踪文件 → 拒删
  await writeFile(join(tree, 'new.txt'), 'x');
  const refused = await git.remove(tree, 'worktree');
  assert.ok(refused.ok);
  assert.equal(refused.value.removed, false);
  assert.match(refused.value.removed ? '' : refused.value.reason, /未跟踪/);

  // 提交了但没推送 → 仍拒删
  sh(tree, 'add', '.');
  sh(tree, 'commit', '-qm', 'work');
  const unpushed = await git.status(tree);
  assert.ok(unpushed.ok && unpushed.value.unpushed === 1 && unpushed.value.dirty === false);
  const stillRefused = await git.remove(tree, 'worktree');
  assert.ok(stillRefused.ok && !stillRefused.value.removed);

  // 推上去 → 干净 → 删掉；分支还在
  sh(tree, 'push', '-q', 'origin', 'agent-hub/fix-1a2b');
  const removed = await git.remove(tree, 'worktree');
  assert.ok(removed.ok && removed.value.removed, JSON.stringify(removed));
  assert.equal(existsSync(tree), false);
  assert.match(sh(cloned.value.path, 'branch', '--list', 'agent-hub/fix-1a2b'), /fix-1a2b/);

  // 远端已有这个分支：再开 worktree 就基于 origin/<branch>（换个地方继续）
  sh(cloned.value.path, 'branch', '-D', 'agent-hub/fix-1a2b');
  const resumed = await git.addWorktree({ repoPath: cloned.value.path, path: tree, branch: 'agent-hub/fix-1a2b' });
  assert.ok(resumed.ok, resumed.ok ? '' : resumed.error.message);
  assert.equal(existsSync(join(tree, 'new.txt')), true);
});

test('非 git 临时目录：空的删，有文件的保留；边界外的一律拒绝', async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'ws-plain-')));
  const git = createGitWorkspace(async (path) => (path.startsWith(root) ? null : '不在允许的目录里'));
  const empty = join(root, 'empty');
  const full = join(root, 'full');
  await mkdir(empty);
  await mkdir(full);
  await writeFile(join(full, 'notes.md'), 'x');
  const status = await git.status(full);
  assert.ok(status.ok && status.value.dirty === null);
  const kept = await git.remove(full, 'directory');
  assert.ok(kept.ok && !kept.value.removed);
  const gone = await git.remove(empty, 'directory');
  assert.ok(gone.ok && gone.value.removed);
  assert.equal(existsSync(empty), false);
  const outside = await git.inspect('/etc');
  assert.equal(outside.ok, false);
  const notWorktree = await git.remove(full, 'worktree');
  assert.equal(notWorktree.ok, false);
});

test('clone 失败：不留半截目录，报错里不带凭据', async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'ws-fail-')));
  const git = createGitWorkspace();
  const failed = await git.clone({ repoUrl: 'https://user:secret@127.0.0.1:9/none.git', parent: root, name: 'x' });
  assert.equal(failed.ok, false);
  assert.doesNotMatch(failed.ok ? '' : failed.error.message, /secret/);
  assert.equal(existsSync(join(root, 'x')), false);
});
