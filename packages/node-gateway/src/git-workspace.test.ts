import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitWorkspace, mainWorktreeDir, networkEnv, resolveRemoteBase } from './git-workspace.ts';

test('git-common-dir 的相对路径按 worktree 解析，不按进程 cwd', () => {
  const worktree = '/tmp/ws/agent-hub/.worktrees/demo-fix';
  assert.equal(mainWorktreeDir(worktree, '../../demo/.git'), '/tmp/ws/agent-hub/demo');
  assert.equal(mainWorktreeDir(worktree, '/tmp/ws/agent-hub/demo/.git'), '/tmp/ws/agent-hub/demo');
  assert.equal(mainWorktreeDir(worktree, ''), worktree);
});

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
  const { head, sizeBytes, ...plain } = clean.value;
  assert.match(head ?? '', /^[0-9a-f]{40}$/);
  assert.ok((sizeBytes ?? 0) > 0);
  assert.deepEqual({ ...plain, upstream: null }, { dirty: false, untracked: 0, unpushed: 0, branch: 'agent-hub/fix-1a2b', upstream: null });

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
  assert.equal(sh(cloned.value.path, 'worktree', 'list').includes(tree), false, 'remove 之后要 prune，登记里不再留这份路径');
  assert.match(sh(cloned.value.path, 'branch', '--list', 'agent-hub/fix-1a2b'), /fix-1a2b/);

  // 远端已有这个分支：再开 worktree 就基于 origin/<branch>（换个地方继续）
  sh(cloned.value.path, 'branch', '-D', 'agent-hub/fix-1a2b');
  const resumed = await git.addWorktree({ repoPath: cloned.value.path, path: tree, branch: 'agent-hub/fix-1a2b' });
  assert.ok(resumed.ok, resumed.ok ? '' : resumed.error.message);
  assert.equal(existsSync(join(tree, 'new.txt')), true);
});

test('squash 合并：HEAD 等于 PR head 才允许删「只在本分支」的提交；showUntrackedFiles=no 也看得见未跟踪文件', async () => {
  const { root, url } = await origin();
  const git = createGitWorkspace();
  const cloned = await git.clone({ repoUrl: url, parent: join(root, 'agent-hub'), name: 'demo' });
  assert.ok(cloned.ok);
  sh(cloned.value.path, 'config', 'status.showUntrackedFiles', 'no');
  const tree = join(root, 'agent-hub', '.worktrees', 'demo', 'sq');
  assert.ok((await git.addWorktree({ repoPath: cloned.value.path, path: tree, branch: 'agent-hub/sq' })).ok);
  await writeFile(join(tree, 'a.txt'), 'a');
  const seen = await git.status(tree);
  assert.ok(seen.ok && seen.value.untracked === 1, JSON.stringify(seen));
  sh(tree, 'add', '.');
  sh(tree, 'commit', '-qm', 'feat');
  const head = sh(tree, 'rev-parse', 'HEAD').trim();
  const wrong = await git.remove(tree, 'worktree', { mergedHead: '0'.repeat(40) });
  assert.ok(wrong.ok && !wrong.value.removed, '别的 head 不算');
  await writeFile(join(tree, 'later.txt'), 'x');
  const dirty = await git.remove(tree, 'worktree', { mergedHead: head });
  assert.ok(dirty.ok && !dirty.value.removed, '合并后又有未跟踪文件：保留');
  sh(tree, 'clean', '-fq');
  const gone = await git.remove(tree, 'worktree', { mergedHead: head });
  assert.ok(gone.ok && gone.value.removed, JSON.stringify(gone));
  assert.equal(existsSync(tree), false);
  assert.match(sh(cloned.value.path, 'branch', '--list', 'agent-hub/sq'), /sq/, '分支保留');
});

test('非 git 临时目录：空的删，有文件的保留；边界外的一律拒绝', async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'ws-plain-')));
  const git = createGitWorkspace(async (path) => (path.startsWith(root) ? null : '不在允许的目录里'));
  const empty = join(root, 'empty');
  const full = join(root, 'full');
  await mkdir(empty);
  await mkdir(full);
  await writeFile(join(full, 'notes.md'), 'x');
  await mkdir(join(full, 'sub'));
  await writeFile(join(full, 'sub', 'b.txt'), 'y');
  const status = await git.status(full);
  assert.ok(status.ok && status.value.dirty === null);
  assert.equal(status.value.files, 2); // 递归数文件，Hub 据此提前保留并记原因
  const kept = await git.remove(full, 'directory');
  assert.ok(kept.ok && !kept.value.removed && /还有 2 个文件/.test(kept.value.reason));
  assert.equal(existsSync(join(full, 'notes.md')), true);
  // 只剩空文件夹也不是空目录：留着
  const hollow = join(root, 'hollow');
  await mkdir(join(hollow, 'dir'), { recursive: true });
  const hollowKept = await git.remove(hollow, 'directory');
  assert.ok(hollowKept.ok && !hollowKept.value.removed && /不是空的/.test(hollowKept.value.reason));
  const gone = await git.remove(empty, 'directory');
  assert.ok(gone.ok && gone.value.removed);
  assert.equal(existsSync(empty), false);
  const outside = await git.inspect('/etc');
  assert.equal(outside.ok, false);
  const notWorktree = await git.remove(full, 'worktree');
  assert.equal(notWorktree.ok, false);
  // 建在别的仓库里面的非 git 临时目录（Worker 根目录本身是仓库）：外层仓库干净也不能删
  const outer = join(root, 'outer');
  await mkdir(outer);
  execFileSync('git', ['init', '-q'], { cwd: outer });
  await writeFile(join(outer, '.gitignore'), 'tmp/\n');
  const nested = join(outer, 'tmp', 'job');
  await mkdir(nested, { recursive: true });
  await writeFile(join(nested, 'notes.md'), 'keep');
  const nestedStatus = await git.status(nested);
  assert.ok(nestedStatus.ok && nestedStatus.value.dirty === null && nestedStatus.value.files === 1);
  const nestedKept = await git.remove(nested, 'directory');
  assert.ok(nestedKept.ok && !nestedKept.value.removed && /还有 1 个文件/.test(nestedKept.value.reason));
  assert.equal(existsSync(join(nested, 'notes.md')), true);
});

test('clone 失败：不留半截目录，报错里不带凭据', async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'ws-fail-')));
  const git = createGitWorkspace();
  const failed = await git.clone({ repoUrl: 'https://user:secret@127.0.0.1:9/none.git', parent: root, name: 'x' });
  assert.equal(failed.ok, false);
  assert.doesNotMatch(failed.ok ? '' : failed.error.message, /secret/);
  assert.equal(existsSync(join(root, 'x')), false);
});

test('saveWip：提交全部改动并推送分支；另一份克隆按已有分支检出 worktree', async () => {
  const { root, url } = await origin();
  const git = createGitWorkspace();
  const a = await git.clone({ repoUrl: url, parent: join(root, 'a'), name: 'demo' });
  assert.ok(a.ok);
  const tree = join(root, 'a', '.worktrees', 'demo-wip');
  assert.ok((await git.addWorktree({ repoPath: a.value.path, path: tree, branch: 'agent-hub/wip-1' })).ok);
  await writeFile(join(tree, 'new.txt'), 'x');
  const saved = await git.saveWip(tree, 'WIP: 测试');
  assert.ok(saved.ok, saved.ok ? '' : saved.error.message);
  assert.deepEqual(saved.value, { committed: true, pushed: true, branch: 'agent-hub/wip-1', reason: null });
  const after = await git.status(tree);
  assert.ok(after.ok && after.value.dirty === false && after.value.unpushed === 0);

  const b = await git.clone({ repoUrl: url, parent: join(root, 'b'), name: 'demo' });
  assert.ok(b.ok);
  const there = join(root, 'b', '.worktrees', 'demo-wip');
  const checked = await git.addWorktree({ repoPath: b.value.path, path: there, branch: 'agent-hub/wip-1', existing: true });
  assert.ok(checked.ok, checked.ok ? '' : checked.error.message);
  assert.ok(existsSync(join(there, 'new.txt')));

  // 没有 origin：提交了，但明说没推
  const lone = join(root, 'lone');
  await mkdir(lone);
  sh(lone, 'init', '-q', '-b', 'main');
  await writeFile(join(lone, 'f.txt'), 'y');
  const local = await git.saveWip(lone, 'WIP');
  assert.ok(local.ok && local.value.committed && !local.value.pushed && /origin/.test(local.value.reason ?? ''));
  // 非 git 目录：什么都不做
  const plain = join(root, 'plain');
  await mkdir(plain);
  const none = await git.saveWip(plain, 'WIP');
  assert.ok(none.ok && !none.value.committed && none.value.reason === '不是 git 仓库');
});

test('clone 进空目录可以（目录选择器里刚新建的）；有东西的目录拒绝；失败了还原成空目录', async () => {
  const { root, url } = await origin();
  const git = createGitWorkspace();
  await mkdir(join(root, 'picked'));
  const cloned = await git.clone({ repoUrl: url, parent: root, name: 'picked' });
  assert.ok(cloned.ok, cloned.ok ? '' : cloned.error.message);
  assert.equal(cloned.value.path, join(root, 'picked'));
  assert.equal(cloned.value.branch, 'main');

  const again = await git.clone({ repoUrl: url, parent: root, name: 'picked' });
  assert.equal(again.ok, false);
  assert.equal(again.ok ? '' : again.error.code, 'conflict');

  await mkdir(join(root, 'empty'));
  const broken = await git.clone({ repoUrl: join(root, 'nope.git'), parent: root, name: 'empty' });
  assert.equal(broken.ok, false);
  assert.deepEqual(await readdir(join(root, 'empty')), []);
});

test('提交预览 → 提交（--author）→ 推送 -u（ADR 0027 阶段 2）', async () => {
  const { root, url } = await origin();
  const git = createGitWorkspace();
  const cloned = await git.clone({ repoUrl: url, parent: join(root, 'p'), name: 'demo' });
  assert.ok(cloned.ok);
  const repo = cloned.value.path;
  sh(repo, 'checkout', '-qb', 'feat/x');
  await writeFile(join(repo, 'README.md'), 'changed\n');
  await mkdir(join(repo, 'dir'));
  await writeFile(join(repo, 'dir', 'new.txt'), 'new\n');

  const p = await git.preview(repo, 64 * 1024);
  assert.ok(p.ok, p.ok ? '' : p.error.message);
  assert.equal(p.value.isGit, true);
  assert.equal(p.value.branch, 'feat/x');
  assert.equal(p.value.defaultBranch, 'main');
  assert.equal(p.value.remoteUrl, url);
  // 未跟踪的也列出（showUntrackedFiles=normal：新目录显示成目录）
  const paths = p.value.files.map((f) => f.path);
  assert.ok(paths.includes('README.md'), paths.join(','));
  assert.ok(paths.some((x) => x.startsWith('dir')), paths.join(','));
  assert.match(p.value.patch, /README\.md/);

  const c = await git.commit(repo, { message: 'feat: 改 README', authorName: '小明', authorEmail: 'xm@example.com' });
  assert.ok(c.ok && c.value.committed, c.ok ? c.value.reason ?? '' : c.error.message);
  assert.equal(sh(repo, 'log', '-1', '--format=%an <%ae>|%s').trim(), '小明 <xm@example.com>|feat: 改 README');
  assert.equal(sh(repo, 'status', '--porcelain').trim(), '');
  const after = await git.preview(repo, 0);
  assert.ok(after.ok);
  assert.equal(after.value.files.length, 0);
  assert.equal(after.value.ahead, 1);

  const pushed = await git.push(repo);
  assert.ok(pushed.ok && pushed.value.pushed, pushed.ok ? pushed.value.reason ?? '' : pushed.error.message);
  assert.equal(sh(url, 'log', '-1', '--format=%s', 'feat/x').trim(), 'feat: 改 README');
  const synced = await git.preview(repo, 0);
  assert.ok(synced.ok);
  assert.equal(synced.value.upstream, 'origin/feat/x');
  assert.equal(synced.value.ahead, 0);

  const nothing = await git.commit(repo, { message: 'x', authorName: 'a', authorEmail: 'a@a' });
  assert.ok(nothing.ok && !nothing.value.committed);

  const notRepo = await git.preview(join(root), 0);
  assert.ok(notRepo.ok && notRepo.value.isGit === false);
});

test('gh：没装 gh → 明确原因，不抛', async () => {
  const { root, url } = await origin();
  const git = createGitWorkspace();
  const cloned = await git.clone({ repoUrl: url, parent: join(root, 'p'), name: 'demo' });
  assert.ok(cloned.ok);
  const saved = process.env.PATH;
  process.env.PATH = join(root, 'empty-bin');
  try {
    const r = await git.gh(cloned.value.path, { action: 'view', number: 1 });
    assert.ok(r.ok);
    assert.equal(r.value.ok, false);
  } finally {
    process.env.PATH = saved;
  }
});

test('D10 worktreesDir：新建放到配置的位置（<dir>/<仓库名>/<目录名>），沿用原分支重建仍用登记的路径', async () => {
  const { root, url } = await origin();
  const custom = join(root, 'trees');
  const git = createGitWorkspace(async () => null, { worktreesDir: custom });
  const cloned = await git.clone({ repoUrl: url, parent: join(root, 'agent-hub'), name: 'demo' });
  assert.ok(cloned.ok);
  const asked = join(root, 'agent-hub', '.worktrees', 'demo', 'fix-1');
  const made = await git.addWorktree({ repoPath: cloned.value.path, path: asked, branch: 'agent-hub/fix-1' });
  assert.ok(made.ok, JSON.stringify(made));
  assert.equal(made.value.path, join(custom, 'demo', 'fix-1'));
  assert.equal(existsSync(asked), false);
  assert.ok((await git.remove(made.value.path, 'worktree')).ok);
  const old = join(root, 'agent-hub', '.worktrees', 'demo', 'fix-1');
  const revived = await git.addWorktree({ repoPath: cloned.value.path, path: old, branch: 'agent-hub/fix-1', existing: true });
  assert.ok(revived.ok && revived.value.path === old, JSON.stringify(revived));
});

test('checkRepo：ls-remote 读默认分支和分支存在性；坏地址不抛', async () => {
  const { url } = await origin();
  const git = createGitWorkspace();

  const main = await git.checkRepo(url, 'main');
  assert.ok(main.ok, main.ok ? '' : main.error.message);
  assert.deepEqual(main.value, { reachable: true, defaultBranch: 'main', branchExists: true, message: null });

  const missing = await git.checkRepo(url, 'master');
  assert.ok(missing.ok);
  assert.equal(missing.value.reachable, true);
  assert.equal(missing.value.defaultBranch, 'main');
  assert.equal(missing.value.branchExists, false);

  // 不填分支 = 用远端默认分支，永远成立
  const any = await git.checkRepo(url, null);
  assert.ok(any.ok && any.value.branchExists === true);

  const broken = await git.checkRepo(join(url, 'nope'), 'main');
  assert.ok(broken.ok);
  assert.equal(broken.value.reachable, false);
  assert.equal(broken.value.defaultBranch, null);
  assert.ok((broken.value.message ?? '').length > 0);
});

test('networkEnv：有 auth 才注入 GIT_CONFIG_* 三条，没有就一条都不设', () => {
  const header = 'Authorization: Basic eC1hY2Nlc3MtdG9rZW46Z2xwYXQtYWJj';
  const withAuth = networkEnv({ header }, {});
  assert.equal(withAuth.GIT_CONFIG_COUNT, '1');
  assert.equal(withAuth.GIT_CONFIG_KEY_0, 'http.extraHeader');
  assert.equal(withAuth.GIT_CONFIG_VALUE_0, header);
  assert.equal(withAuth.GIT_TERMINAL_PROMPT, '0');

  const without = networkEnv(undefined, {});
  assert.equal(without.GIT_CONFIG_COUNT, undefined);
  assert.equal(without.GIT_CONFIG_KEY_0, undefined);
  assert.equal(without.GIT_CONFIG_VALUE_0, undefined);

  // 空白头等于没给（不让 git 收到一个空 extraHeader）
  const blank = networkEnv({ header: '   ' }, {});
  assert.equal(blank.GIT_CONFIG_COUNT, undefined);

  // 机器自己的凭据照旧透传，令牌不进 argv 也不挤掉它们
  const env = networkEnv({ header }, { GIT_SSH_COMMAND: 'ssh -i k', HOME: '/home/me', PATH: '/bin' });
  assert.equal(env.GIT_SSH_COMMAND, 'ssh -i k');
  assert.equal(env.HOME, '/home/me');
  assert.equal(env.PATH, '/bin');
});

/** 一个带 submodule 的本地 bare 远端（子模块也是本地 bare，不走网络）。 */
async function originWithSubmodule() {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'ws-sub-')));
  const childSeed = join(root, 'child-seed');
  await mkdir(childSeed);
  sh(childSeed, 'init', '-q', '-b', 'main');
  await writeFile(join(childSeed, 'lib.txt'), 'lib\n');
  sh(childSeed, 'add', '.');
  sh(childSeed, 'commit', '-qm', 'child');
  sh(root, 'clone', '-q', '--bare', childSeed, 'child.git');
  const childUrl = join(root, 'child.git');

  const seed = join(root, 'seed');
  await mkdir(seed);
  sh(seed, 'init', '-q', '-b', 'main');
  await writeFile(join(seed, 'README.md'), 'hi\n');
  sh(seed, 'add', '.');
  sh(seed, 'commit', '-qm', 'init');
  sh(seed, '-c', 'protocol.file.allow=always', 'submodule', 'add', childUrl, 'vendor');
  sh(seed, 'commit', '-qm', 'add submodule');
  sh(root, 'clone', '-q', '--bare', seed, 'origin.git');
  return { root, url: join(root, 'origin.git') };
}

test('clone / worktree：recurseSubmodules 关闭时不初始化子模块', async () => {
  const { root, url } = await originWithSubmodule();
  const git = createGitWorkspace();
  const cloned = await git.clone({ repoUrl: url, parent: join(root, 'out'), name: 'demo' });
  assert.ok(cloned.ok, cloned.ok ? '' : cloned.error.message);
  assert.equal(existsSync(join(cloned.value.path, 'vendor', 'lib.txt')), false);
  const tree = join(root, 'out', 'wt');
  const added = await git.addWorktree({ repoPath: cloned.value.path, path: tree, branch: 'agent-hub/sub-off' });
  assert.ok(added.ok, added.ok ? '' : added.error.message);
  assert.equal(existsSync(join(tree, 'vendor', 'lib.txt')), false);
});

test('clone / worktree：recurseSubmodules 打开时递归初始化子模块', async () => {
  const { root, url } = await originWithSubmodule();
  const git = createGitWorkspace();
  const cloned = await git.clone({ repoUrl: url, parent: join(root, 'out'), name: 'demo', recurseSubmodules: true });
  assert.ok(cloned.ok, cloned.ok ? '' : cloned.error.message);
  assert.equal(existsSync(join(cloned.value.path, 'vendor', 'lib.txt')), true);
  const tree = join(root, 'out', 'wt');
  const added = await git.addWorktree({
    repoPath: cloned.value.path,
    path: tree,
    branch: 'agent-hub/sub-on',
    recurseSubmodules: true
  });
  assert.ok(added.ok, added.ok ? '' : added.error.message);
  assert.equal(existsSync(join(tree, 'vendor', 'lib.txt')), true);
});


test('worktree add：fetch 后从远端默认分支起步，不用本地过期的 master', async () => {
  const { root, url } = await origin();
  const git = createGitWorkspace();
  const cloned = await git.clone({ repoUrl: url, parent: join(root, 'agent-hub'), name: 'demo' });
  assert.ok(cloned.ok, cloned.ok ? '' : cloned.error.message);
  // 本地留一条停在初始提交上的 master，模拟过期的默认分支
  sh(cloned.value.path, 'branch', 'master');
  const updater = join(root, 'updater');
  sh(root, 'clone', '-q', url, 'updater');
  await writeFile(join(updater, 'NEW.md'), 'fresh\n');
  sh(updater, 'add', '.');
  sh(updater, 'commit', '-qm', 'advance main');
  sh(updater, 'push', '-q', 'origin', 'main');

  const raw = async (args: string[]) => execFileSync('git', args, { cwd: cloned.value.path, encoding: 'utf8' });
  // fetch 之前本地还看不到新提交；resolve 在 fetch 之后应由 origin/HEAD（main）赢过 origin/master（没有）和本地 master
  sh(cloned.value.path, 'fetch', '-q', 'origin');
  assert.equal(await resolveRemoteBase({ raw }, true, 'master'), 'origin/main');

  const tree = join(root, 'agent-hub', '.worktrees', 'from-remote');
  const added = await git.addWorktree({
    repoPath: cloned.value.path,
    path: tree,
    branch: 'agent-hub/sess-aaaaaaaaaaaa',
    base: 'master'
  });
  assert.ok(added.ok, added.ok ? '' : added.error.message);
  assert.equal(existsSync(join(tree, 'NEW.md')), true, '新 worktree 应包含远端 main 的新提交，而不是本地过期 master');
  assert.equal(existsSync(join(cloned.value.path, 'NEW.md')), false);
});

test('同一源仓库上并发加 worktree 都能成功（按仓库串行，不抢 .git 锁）', async () => {
  const { root, url } = await origin();
  const git = createGitWorkspace();
  const cloned = await git.clone({ repoUrl: url, parent: join(root, 'agent-hub'), name: 'demo' });
  assert.ok(cloned.ok);
  const first = join(root, 'agent-hub', '.worktrees', 'one');
  const second = join(root, 'agent-hub', '.worktrees', 'two');
  const [a, b] = await Promise.all([
    git.addWorktree({ repoPath: cloned.value.path, path: first, branch: 'agent-hub/sess-111111111111' }),
    git.addWorktree({ repoPath: cloned.value.path, path: second, branch: 'agent-hub/sess-222222222222' })
  ]);
  assert.ok(a.ok, a.ok ? '' : a.error.message);
  assert.ok(b.ok, b.ok ? '' : b.error.message);
  assert.equal(existsSync(first) && existsSync(second), true);
});


test('worktree add：origin 不可达时退回本地默认分支，不把无效的 origin/main 交给 git', async () => {
  const { root, url } = await origin();
  const git = createGitWorkspace();
  const cloned = await git.clone({ repoUrl: url, parent: join(root, 'agent-hub'), name: 'demo' });
  assert.ok(cloned.ok, cloned.ok ? '' : cloned.error.message);
  sh(cloned.value.path, 'remote', 'set-url', 'origin', 'https://example.invalid/acme/demo.git');
  // 模拟从未 fetch 成功：只挂了 origin 地址，没有 origin/* 跟踪分支（组合 e2e 的本地仓库就是这样）。
  for (const ref of sh(cloned.value.path, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin').split('\n').map((line) => line.trim()).filter(Boolean)) {
    sh(cloned.value.path, 'update-ref', '-d', ref);
  }
  const raw = async (args: string[]) => execFileSync('git', args, { cwd: cloned.value.path, encoding: 'utf8' });
  assert.equal(await resolveRemoteBase({ raw }, true, 'origin/main'), 'main');

  const tree = join(root, 'agent-hub', '.worktrees', 'offline-origin');
  const added = await git.addWorktree({
    repoPath: cloned.value.path,
    path: tree,
    branch: 'agent-hub/sess-ffffffffffff',
    base: 'origin/main'
  });
  assert.ok(added.ok, added.ok ? '' : added.error.message);
  assert.equal(existsSync(join(tree, 'README.md')), true);
});
