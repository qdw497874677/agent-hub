import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authScopeUrl, createGitWorkspace, mainWorktreeDir, networkEnv, parseTrackedDiffPlan, protectedDiff, pushDestination, resolveRemoteBase } from './git-workspace.ts';

test('git-common-dir 的相对路径按 worktree 解析，不按进程 cwd', () => {
  const worktree = '/tmp/ws/agent-hub/.worktrees/demo-fix';
  assert.equal(mainWorktreeDir(worktree, '../../demo/.git'), '/tmp/ws/agent-hub/demo');
  assert.equal(mainWorktreeDir(worktree, '/tmp/ws/agent-hub/demo/.git'), '/tmp/ws/agent-hub/demo');
  assert.equal(mainWorktreeDir(worktree, ''), worktree);
});

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

/** rev-parse 一个 ref；不存在就回空串（`git rev-parse --verify` 会非零退出）。 */
const rev = (cwd: string, ref: string): string => {
  try {
    return sh(cwd, 'rev-parse', '-q', '--verify', ref).trim();
  } catch {
    return '';
  }
};

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

test('提交预览默认看见敏感改动；受保护预览不把内容和路径放进 diff 与元数据（#269）', async () => {
  const { root, url } = await origin();
  const git = createGitWorkspace();
  const cloned = await git.clone({ repoUrl: url, parent: join(root, 'p'), name: 'demo' });
  assert.ok(cloned.ok);
  const repo = cloned.value.path;
  // 合成的假密钥，只用于验证过滤，不是真实凭据
  await writeFile(join(repo, '.env'), 'SECRET=not-real-269-v1\n');
  await writeFile(join(repo, 'server.pem'), 'not-a-real-key-269-v1\n');
  await writeFile(join(repo, 'notes.md'), 'allowed notes 269\n');
  sh(repo, 'add', '.env', 'server.pem', 'notes.md');
  sh(repo, 'commit', '-qm', 'track fake secrets and notes');
  // 从“未修改的敏感文件”复制出一个普通文件并 stage：只有 --find-copies-harder 能认出复制源。
  await writeFile(join(repo, 'config-copy.txt'), 'SECRET=not-real-269-v1\n');
  sh(repo, 'add', 'config-copy.txt');
  await writeFile(join(repo, '.env'), 'SECRET=not-real-269-v2\n');
  await writeFile(join(repo, 'server.pem'), 'not-a-real-key-269-v2\n');

  // Git 工作流用的默认预览必须看得见敏感改动，否则提交门槛会误判“干净”。
  const visibleOnly = await git.preview(repo, 64 * 1024);
  assert.ok(visibleOnly.ok, visibleOnly.ok ? '' : visibleOnly.error.message);
  assert.equal(visibleOnly.value.redactedSensitive, undefined);
  const visiblePaths = visibleOnly.value.files.map((f) => f.path);
  assert.ok(visiblePaths.includes('.env'), visiblePaths.join(','));
  assert.ok(visiblePaths.includes('server.pem'), visiblePaths.join(','));
  assert.ok(visiblePaths.includes('config-copy.txt'), visiblePaths.join(','));
  assert.ok(visibleOnly.value.patch.includes('not-real-269-v2'), visibleOnly.value.patch);
  assert.ok(visibleOnly.value.patch.includes('not-a-real-key-269-v2'), visibleOnly.value.patch);

  // 只读展示用的受保护预览：只有敏感改动时元数据和 patch 都为空。
  const hiddenOnly = await git.preview(repo, 64 * 1024, { redactSensitive: true });
  assert.ok(hiddenOnly.ok, hiddenOnly.ok ? '' : hiddenOnly.error.message);
  assert.deepEqual(hiddenOnly.value.files, []);
  assert.equal(hiddenOnly.value.patch, '');
  assert.equal(hiddenOnly.value.truncated, false);
  assert.equal(hiddenOnly.value.redactedSensitive, true);

  await writeFile(join(repo, 'README.md'), 'allowed change 269\n');
  await mkdir(join(repo, 'src'));
  await writeFile(join(repo, 'src', 'ok.ts'), 'export const ok = 269;\n');

  const preview = await git.preview(repo, 64 * 1024, { redactSensitive: true });
  assert.ok(preview.ok, preview.ok ? '' : preview.error.message);
  const paths = preview.value.files.map((f) => f.path);
  assert.ok(!paths.includes('.env'), paths.join(','));
  assert.ok(!paths.includes('server.pem'), paths.join(','));
  assert.ok(!paths.includes('config-copy.txt'), paths.join(','));
  assert.ok(paths.includes('README.md'), paths.join(','));
  assert.ok(paths.some((p) => p.startsWith('src')), paths.join(','));
  assert.ok(!preview.value.patch.includes('not-real-269'), preview.value.patch);
  assert.ok(!preview.value.patch.includes('not-a-real-key-269'), preview.value.patch);
  assert.ok(preview.value.patch.includes('README.md'), preview.value.patch);
  assert.ok(preview.value.patch.includes('allowed change 269'), preview.value.patch);

  // 普通文件改名：两侧都在允许清单里，受保护预览要保留整段改名 diff。
  sh(repo, 'mv', 'notes.md', 'moved.md');
  const moved = await git.preview(repo, 64 * 1024, { redactSensitive: true });
  assert.ok(moved.ok, moved.ok ? '' : moved.error.message);
  assert.ok(moved.value.files.some((f) => f.path === 'moved.md'), moved.value.files.map((f) => f.path).join(','));
  assert.ok(moved.value.patch.includes('moved.md'), moved.value.patch);
  assert.ok(moved.value.patch.includes('rename from notes.md'), moved.value.patch);

  // 仓库关掉改名识别也不能绕过受保护预览；敏感文件改名成普通名字时，旧名 / 新名都不出现。
  sh(repo, 'config', 'status.renames', 'false');
  sh(repo, 'config', 'diff.renames', 'false');
  sh(repo, 'checkout', '--', '.env');
  sh(repo, 'mv', '.env', 'config.txt');
  const visibleRename = await git.preview(repo, 64 * 1024);
  assert.ok(visibleRename.ok, visibleRename.ok ? '' : visibleRename.error.message);
  assert.ok(visibleRename.value.files.some((f) => f.path === 'config.txt'), visibleRename.value.files.map((f) => f.path).join(','));
  assert.ok(visibleRename.value.patch.includes('config.txt'), visibleRename.value.patch);

  const renamed = await git.preview(repo, 64 * 1024, { redactSensitive: true });
  assert.ok(renamed.ok, renamed.ok ? '' : renamed.error.message);
  assert.ok(!renamed.value.files.some((f) => f.path === 'config.txt'), renamed.value.files.map((f) => f.path).join(','));
  assert.ok(!renamed.value.files.some((f) => f.path === '.env'), renamed.value.files.map((f) => f.path).join(','));
  assert.ok(!renamed.value.files.some((f) => f.path === 'config-copy.txt'), renamed.value.files.map((f) => f.path).join(','));
  assert.ok(!renamed.value.patch.includes('config.txt'), renamed.value.patch);
  assert.ok(!renamed.value.patch.includes('config-copy.txt'), renamed.value.patch);
  assert.ok(!renamed.value.patch.includes('not-real-269'), renamed.value.patch);
  assert.ok(renamed.value.patch.includes('README.md'), renamed.value.patch);
  assert.ok(renamed.value.files.some((f) => f.path === 'moved.md'), renamed.value.files.map((f) => f.path).join(','));
  assert.ok(renamed.value.patch.includes('moved.md'), renamed.value.patch);
  assert.equal(renamed.value.redactedSensitive, true);
});

test('受保护清单：隐藏路径覆盖后续记录，diff 使用解析后的 HEAD，失败不兜底', async () => {
  const plan = parseTrackedDiffPlan('R100\0.env\0config.txt\0M\0config.txt\0M\0src/ok.ts\0');
  assert.ok(plan);
  assert.deepEqual(plan.allowed, ['src/ok.ts']);
  assert.deepEqual(plan.entries.map((entry) => entry.path), ['src/ok.ts']);
  assert.equal(parseTrackedDiffPlan('R100\0.env\0'), null);

  let seen: string[] = [];
  const head = 'a'.repeat(40);
  const ok = await protectedDiff({ raw: async (args: string[]) => { seen = args; return 'PATCH'; } } as never, head, plan);
  assert.deepEqual(ok, { ok: true, patch: 'PATCH' });
  assert.ok(seen.includes(head));
  assert.equal(seen.includes('HEAD'), false);

  const failed = await protectedDiff({ raw: async () => { throw new Error('boom'); } } as never, head, plan);
  assert.deepEqual(failed, { ok: false });
});

test('受保护预览：路径清单失败时整段省略，不退回文本过滤', async () => {
  const { root, url } = await origin();
  const git = createGitWorkspace();
  const cloned = await git.clone({ repoUrl: url, parent: join(root, 'p'), name: 'demo' });
  assert.ok(cloned.ok);
  const repo = cloned.value.path;
  const head = sh(repo, 'rev-parse', 'HEAD').trim();
  await rm(join(repo, '.git', 'objects', head.slice(0, 2), head.slice(2)));

  const preview = await git.preview(repo, 64 * 1024, { redactSensitive: true });
  assert.ok(preview.ok, preview.ok ? '' : preview.error.message);
  assert.deepEqual(preview.value.files, []);
  assert.equal(preview.value.patch, '');
  assert.equal(preview.value.truncated, true);
  assert.equal(preview.value.redactedSensitive, true);
  assert.match(preview.value.notice ?? '', /过滤清单读取失败/);
});

test('受保护预览：diff 读取失败时 patch 留空并标 notice', async () => {
  const { root, url } = await origin();
  const git = createGitWorkspace();
  const cloned = await git.clone({ repoUrl: url, parent: join(root, 'p'), name: 'demo' });
  assert.ok(cloned.ok);
  const repo = cloned.value.path;
  // 合成一个必然失败的 textconv：--name-status 不需要内容，能成功；真正取 diff 时才失败。
  await writeFile(join(repo, '.gitattributes'), '*.md diff=broken-269\n');
  sh(repo, 'config', 'diff.broken-269.textconv', 'false');
  await writeFile(join(repo, 'README.md'), 'changed with broken textconv\n');

  const preview = await git.preview(repo, 64 * 1024, { redactSensitive: true });
  assert.ok(preview.ok, preview.ok ? '' : preview.error.message);
  assert.ok(preview.value.files.some((f) => f.path === 'README.md'), preview.value.files.map((f) => f.path).join(','));
  assert.equal(preview.value.patch, '');
  assert.equal(preview.value.truncated, true);
  assert.equal(preview.value.redactedSensitive, true);
  assert.match(preview.value.notice ?? '', /diff 读取失败/);
});

test('受保护预览：允许路径超过上限时整段省略 diff，不退回整树过滤', async () => {
  const { root, url } = await origin();
  const git = createGitWorkspace();
  const cloned = await git.clone({ repoUrl: url, parent: join(root, 'p'), name: 'demo' });
  assert.ok(cloned.ok);
  const repo = cloned.value.path;
  await mkdir(join(repo, 'bulk'));
  for (let i = 0; i < 1001; i++) await writeFile(join(repo, 'bulk', `${i}.txt`), 'x\n');
  sh(repo, 'add', 'bulk');
  sh(repo, 'commit', '-qm', 'bulk');
  for (let i = 0; i < 1001; i++) await writeFile(join(repo, 'bulk', `${i}.txt`), 'y\n');

  const preview = await git.preview(repo, 64 * 1024, { redactSensitive: true });
  assert.ok(preview.ok, preview.ok ? '' : preview.error.message);
  assert.ok(preview.value.files.length >= 1001);
  assert.equal(preview.value.patch, '');
  assert.equal(preview.value.truncated, true);
  assert.equal(preview.value.redactedSensitive, true);
  assert.match(preview.value.notice ?? '', /超过 1000/);
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

test('gh：列表只查 open，并带出 head 仓库 / 分支名（#269）', async () => {
  const { root, url } = await origin();
  const git = createGitWorkspace();
  const cloned = await git.clone({ repoUrl: url, parent: join(root, 'p'), name: 'demo' });
  assert.ok(cloned.ok);
  const bin = join(root, 'gh-bin');
  await mkdir(bin, { recursive: true });
  const log = join(root, 'gh-args');
  const prs = JSON.stringify([
    // gh 真实导出的常见形态：name 在 headRepository，owner 在 headRepositoryOwner
    { number: 21, url: 'https://github.com/o/r/pull/21', state: 'OPEN', headRefOid: 'h1', headRefName: 'feat/x', headRepository: { id: 'R_1', name: 'r' }, headRepositoryOwner: { id: 'O_1', login: 'o' }, mergedAt: null, baseRefName: 'main' },
    // fork：owner 不同
    { number: 9, url: 'https://github.com/o/r/pull/9', state: 'OPEN', headRefOid: 'h0', headRefName: 'feat/x', headRepository: { id: 'R_2', name: 'r' }, headRepositoryOwner: { id: 'O_2', login: 'someone' }, mergedAt: null, baseRefName: 'main' },
    // 老响应：只有 name，没有 owner → repo 只能是 null（调用方拒绝认领）
    { number: 10, url: 'https://github.com/o/r/pull/10', state: 'OPEN', headRefOid: 'h2', headRefName: 'feat/x', headRepository: { id: 'R_3', name: 'r' }, mergedAt: null, baseRefName: 'main' }
  ]);
  await writeFile(join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(log)}\ncat <<'EOF'\n${prs}\nEOF\n`, { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  try {
    const r = await git.gh(cloned.value.path, { action: 'list', head: 'feat/x', repo: 'o/r' });
    assert.ok(r.ok);
    const value = r.value;
    assert.ok(value.ok && 'prs' in value);
    if (!value.ok || !('prs' in value)) throw new Error('expected prs');
    assert.deepEqual(value.prs.map((pr) => [pr.number, pr.repo, pr.headRef, pr.headSha, pr.base]), [
      [21, 'o/r', 'feat/x', 'h1', 'main'],
      [9, 'someone/r', 'feat/x', 'h0', 'main'],
      [10, null, 'feat/x', 'h2', 'main']
    ]);
    const args = (await readFile(log, 'utf8')).trim().split('\n');
    assert.equal(args[args.indexOf('--state') + 1], 'open');
    assert.equal(args[args.indexOf('--repo') + 1], 'o/r');
    assert.ok(args.join(',').includes('headRepositoryOwner'));
  } finally {
    process.env.PATH = saved;
  }
});

test('gh：view 的 headRepository 带 nameWithOwner 时直接用（新旧导出都认）', async () => {
  const { root, url } = await origin();
  const git = createGitWorkspace();
  const cloned = await git.clone({ repoUrl: url, parent: join(root, 'p'), name: 'demo' });
  assert.ok(cloned.ok);
  const bin = join(root, 'gh-bin');
  await mkdir(bin, { recursive: true });
  const pr = JSON.stringify({ number: 21, url: 'https://github.com/o/r/pull/21', state: 'OPEN', headRefOid: 'h1', headRefName: 'feat/x', headRepository: { id: 'R_1', name: 'r', nameWithOwner: 'o/r' }, headRepositoryOwner: { id: 'O_1', login: 'o' }, mergedAt: null, baseRefName: 'main' });
  await writeFile(join(bin, 'gh'), `#!/bin/sh\ncat <<'EOF'\n${pr}\nEOF\n`, { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  try {
    const r = await git.gh(cloned.value.path, { action: 'view', number: 21 });
    assert.ok(r.ok);
    const value = r.value;
    assert.ok(value.ok && 'pr' in value);
    if (!value.ok || !('pr' in value)) throw new Error('expected pr');
    assert.equal(value.pr.repo, 'o/r');
    assert.equal(value.pr.headRef, 'feat/x');
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

  // Git 的模式会匹配路径尾部；只接受完整 refs/heads/...，不能把相似分支或标签当成目标。
  sh(url, 'update-ref', 'refs/heads/prefix/refs/heads/target', 'HEAD');
  sh(url, 'update-ref', 'refs/tags/target', 'HEAD');
  const exact = await git.checkRepo(url, 'target');
  assert.ok(exact.ok && exact.value.reachable && !exact.value.branchExists);
  const nested = await git.checkRepo(url, 'prefix/refs/heads/target');
  assert.ok(nested.ok && nested.value.branchExists);

  // 不填分支 = 用远端默认分支，永远成立
  const any = await git.checkRepo(url, null);
  assert.ok(any.ok && any.value.branchExists === true);

  const broken = await git.checkRepo(join(url, 'nope'), 'main');
  assert.ok(broken.ok);
  assert.equal(broken.value.reachable, false);
  assert.equal(broken.value.defaultBranch, null);
  assert.ok((broken.value.message ?? '').length > 0);
});

test('networkEnv：令牌必须绑定 hub 给的 HTTPS 地址，并关掉重定向', () => {
  const header = 'Authorization: Basic eC1hY2Nlc3MtdG9rZW46Z2xwYXQtYWJj';
  const api = 'https://gitlab.test/me/api.git';
  const withAuth = networkEnv({ header, url: api }, {}, api);
  assert.equal(withAuth.GIT_CONFIG_COUNT, '2');
  assert.equal(withAuth.GIT_CONFIG_KEY_0, `http.${api}.extraHeader`);
  assert.equal(withAuth.GIT_CONFIG_VALUE_0, header);
  assert.equal(withAuth.GIT_CONFIG_KEY_1, 'http.followRedirects');
  assert.equal(withAuth.GIT_CONFIG_VALUE_1, 'false');
  assert.equal(withAuth.GIT_TERMINAL_PROMPT, '0');

  // auth.url 与目的地只有尾斜杠 / userinfo 差异时视为同一个仓库
  assert.equal(networkEnv({ header, url: `${api}/` }, {}, api).GIT_CONFIG_KEY_0, `http.${api}.extraHeader`);
  assert.equal(networkEnv({ header, url: 'https://user:pw@GitLab.test/me/api.git' }, {}, api).GIT_CONFIG_COUNT, '2');

  // 目的地不可校验（没传 / 明文 http / ssh / 本地路径 / 带换行）→ 一条 GIT_CONFIG_* 都不设
  for (const destination of [undefined, null, '', 'http://gitlab.test/me/api.git', 'ssh://git@gitlab.test/me/api.git', '/srv/repo', 'https://gitlab.test/me/api.git\nx']) {
    const env = networkEnv({ header, url: api }, {}, destination);
    assert.equal(env.GIT_CONFIG_COUNT, undefined, `destination=${String(destination)}`);
    assert.equal(env.GIT_CONFIG_KEY_0, undefined);
  }

  // 目的地与 auth.url 不一致 → 拒绝把令牌带过去
  for (const destination of ['https://evil.test/me/api.git', 'https://gitlab.test/me/other.git', 'https://gitlab.test/me/api.git-evil']) {
    const env = networkEnv({ header, url: api }, {}, destination);
    assert.equal(env.GIT_CONFIG_COUNT, undefined, `destination=${destination}`);
  }

  // 旧 hub 的 auth 没带 url = 未绑定令牌：新 Worker 不把它套到任何目的地（滚动升级时失败关闭）
  for (const destination of [api, 'https://evil.test/me/api.git', null]) {
    const env = networkEnv({ header }, {}, destination);
    assert.equal(env.GIT_CONFIG_COUNT, undefined, `legacy destination=${String(destination)}`);
    assert.equal(env.GIT_CONFIG_KEY_0, undefined);
  }
  // auth.url 本身不合法（明文 http）同样拒绝
  assert.equal(networkEnv({ header, url: 'http://gitlab.test/me/api.git' }, {}, api).GIT_CONFIG_COUNT, undefined);

  const without = networkEnv(undefined, {}, api);
  assert.equal(without.GIT_CONFIG_COUNT, undefined);
  assert.equal(without.GIT_CONFIG_KEY_0, undefined);
  assert.equal(without.GIT_CONFIG_VALUE_0, undefined);

  // 空白头等于没给（不让 git 收到一个空 extraHeader）
  const blank = networkEnv({ header: '   ', url: api }, {}, api);
  assert.equal(blank.GIT_CONFIG_COUNT, undefined);

  // 机器自己的凭据照旧透传，令牌不进 argv 也不挤掉它们
  const env = networkEnv({ header, url: api }, { GIT_SSH_COMMAND: 'ssh -i k', HOME: '/home/me', PATH: '/bin' }, api);
  assert.equal(env.GIT_SSH_COMMAND, 'ssh -i k');
  assert.equal(env.HOME, '/home/me');
  assert.equal(env.PATH, '/bin');
});

test('authScopeUrl：只接受可绑定的 HTTPS 地址，去掉 userinfo / 尾斜杠', () => {
  assert.equal(authScopeUrl('https://gitlab.test/me/api.git'), 'https://gitlab.test/me/api.git');
  assert.equal(authScopeUrl(' HTTPS://user:pw@GitLab.test:8443/me/api.git/ '), 'https://gitlab.test:8443/me/api.git');
  assert.equal(authScopeUrl('https://gitlab.test/me/api.git?x=1#frag'), 'https://gitlab.test/me/api.git');
  for (const bad of ['', '   ', 'http://gitlab.test/x', 'ssh://git@gitlab.test/x', '/srv/repo', 'file:///srv/repo', 'https://gitlab.test/x\nfoo', 'https://gitlab.test/x\r', 'not a url', 'https://']) {
    assert.equal(authScopeUrl(bad), null, `input=${JSON.stringify(bad)}`);
  }
});

test('networkEnv：真实 git 的 URL 匹配只给目标仓库加头（#233）', () => {
  const header = 'Authorization: Basic eC1hY2Nlc3MtdG9rZW46Z2xwYXQtYWJj';
  const api = 'https://gitlab.test/me/api.git';
  const env = { ...process.env, ...networkEnv({ header, url: api }, {}, api) };
  const match = (url: string): string => {
    try {
      return execFileSync('git', ['config', '--get-urlmatch', 'http.extraHeader', url], { encoding: 'utf8', env }).trim();
    } catch {
      return '';
    }
  };
  assert.equal(match(api), header);
  assert.equal(match(`${api}/info/refs?service=git-upload-pack`), header);
  // 同 host 的兄弟路径（含前缀伪装）、别的 host、明文 http 都拿不到头
  assert.equal(match('https://gitlab.test/me/api.git-evil'), '');
  assert.equal(match('https://gitlab.test/me/other.git'), '');
  assert.equal(match('https://evil.test/me/api.git'), '');
  assert.equal(match('http://gitlab.test/me/api.git'), '');
  // 带凭据时任何重定向都算错误
  const redirects = execFileSync('git', ['config', '--get', 'http.followRedirects'], { encoding: 'utf8', env }).trim();
  assert.equal(redirects, 'false');
});

test('insteadOf 改写不会扩大令牌 scope：配置里写什么就绑什么（#233）', async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'ws-scope-')));
  sh(root, 'init', '-q', '-b', 'main');
  sh(root, 'remote', 'add', 'origin', 'https://gitlab.test/me/api.git');
  sh(root, 'config', 'url.https://evil.test/.insteadOf', 'https://gitlab.test/');
  // git 实际使用的地址会被改写到 evil.test
  assert.equal(sh(root, 'ls-remote', '--get-url', 'origin').trim(), 'https://evil.test/me/api.git');
  // 但 scope 绑的是配置里的原始 HTTPS URL：改写后的地址匹配不到头（安全失败）
  const configured = sh(root, 'config', '--get', 'remote.origin.url').trim();
  const env = { ...process.env, ...networkEnv({ header: 'Authorization: Basic x', url: configured }, {}, configured) };
  let leaked = 'unset';
  try {
    leaked = execFileSync('git', ['config', '--get-urlmatch', 'http.extraHeader', 'https://evil.test/me/api.git'], { encoding: 'utf8', env, cwd: root }).trim();
  } catch {
    leaked = '';
  }
  assert.equal(leaked, '');
  await rm(root, { recursive: true, force: true });
});

test('pushDestination：pushurl 指向别的目的地时不绑定令牌；多条也拒绝', async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'ws-push-')));
  sh(root, 'init', '-q', '-b', 'main');
  sh(root, 'remote', 'add', 'origin', 'https://gitlab.test/me/api.git');
  assert.equal(await pushDestination(root), 'https://gitlab.test/me/api.git');
  // pushurl 与 url 指向同一目的地（尾斜杠不改变判定）→ 可以绑定
  sh(root, 'config', 'remote.origin.pushurl', 'https://gitlab.test/me/api.git/');
  assert.equal(await pushDestination(root), 'https://gitlab.test/me/api.git/');
  const same = networkEnv({ header: 'Authorization: Basic x', url: 'https://gitlab.test/me/api.git' }, {}, await pushDestination(root));
  assert.equal(same.GIT_CONFIG_KEY_0, 'http.https://gitlab.test/me/api.git.extraHeader');
  // pushurl 指向另一个 host：不把令牌送到这个额外目的地
  sh(root, 'config', 'remote.origin.pushurl', 'https://mirror.test/me/api.git');
  assert.equal(await pushDestination(root), null);
  assert.equal(networkEnv({ header: 'Authorization: Basic x', url: 'https://mirror.test/me/api.git' }, {}, await pushDestination(root)).GIT_CONFIG_COUNT, undefined);
  // 多条 pushurl 时无法确定目的地，这一趟不带令牌
  sh(root, 'config', '--add', 'remote.origin.pushurl', 'https://gitlab.test/me/api.git');
  assert.equal(await pushDestination(root), null);
  await rm(root, { recursive: true, force: true });
});

test('有 auth 但绑定缺失 / 不匹配时，clone / check / fetch / push 全部失败关闭（#233）', async () => {
  const git = createGitWorkspace();
  const api = 'https://gitlab.test/me/api.git';
  const header = 'Authorization: Basic eC1hY2Nlc3MtdG9rZW46Z2xwYXQtYWJj';
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'ws-bind-')));

  // 旧 hub 只给 header、不给 url：新 Worker 不猜目的地，直接拒绝（不发起网络请求）
  const cloned = await git.clone({ repoUrl: api, parent: root, name: 'demo', auth: { header } });
  assert.equal(cloned.ok, false);
  assert.match(cloned.ok ? '' : cloned.error.message, /旧版 hub|拒绝/);

  const checked = await git.checkRepo(api, 'main', { header });
  assert.equal(checked.ok, true, checked.ok ? '' : checked.error.message);
  assert.equal(checked.ok ? checked.value.reachable : true, false);
  assert.match(checked.ok ? (checked.value.message ?? '') : '', /拒绝/);

  // 本地仓库 + 配置里的 HTTPS origin：fetch 目的地与 hub 预期不一致 → 拒绝
  sh(root, 'init', '-q', '-b', 'main');
  await writeFile(join(root, 'README.md'), 'hi\n');
  sh(root, 'add', '.');
  sh(root, 'commit', '-qm', 'init');
  sh(root, 'remote', 'add', 'origin', api);
  const added = await git.addWorktree({
    repoPath: root,
    path: join(root, 'wt'),
    branch: 'agent-hub/bound',
    auth: { header, url: 'https://evil.test/me/api.git' }
  });
  assert.equal(added.ok, false);
  assert.match(added.ok ? '' : added.error.message, /不一致/);

  // push 同样：目的地（pushurl 优先）绑不上就不推
  const pushed = await git.push(root, { header });
  assert.equal(pushed.ok, true, pushed.ok ? '' : pushed.error.message);
  assert.equal(pushed.ok ? pushed.value.pushed : true, false);
  assert.match(pushed.ok ? (pushed.value.reason ?? '') : '', /拒绝/);
  sh(root, 'config', 'remote.origin.pushurl', 'https://mirror.test/me/api.git');
  const mismatchedPush = await git.push(root, { header, url: api });
  assert.equal(mismatchedPush.ok, true, mismatchedPush.ok ? '' : mismatchedPush.error.message);
  assert.equal(mismatchedPush.ok ? mismatchedPush.value.pushed : true, false);
  assert.match(mismatchedPush.ok ? (mismatchedPush.value.reason ?? '') : '', /不能用令牌|拒绝/);
  await rm(root, { recursive: true, force: true });
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

/** publishRef 的真实本地 bare 远端：本地 clone 在功能分支上有一个尚未推送的提交。 */
async function publishFixture(branch = 'agent-hub/publish') {
  const { root, url } = await origin();
  const repo = join(root, 'clone');
  sh(root, 'clone', '-q', url, 'clone');
  sh(repo, 'config', 'user.name', 't');
  sh(repo, 'config', 'user.email', 't@t');
  sh(repo, 'checkout', '-q', '-b', branch);
  await writeFile(join(repo, 'work.txt'), 'work\n');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-qm', 'feat');
  const sha = sh(repo, 'rev-parse', 'HEAD').trim();
  const git = createGitWorkspace(undefined, { allowLocalPublishOrigin: true });
  return { root, url, repo, branch, sha, git };
}

const remoteRef = (repo: string, url: string, ref: string) => sh(repo, 'ls-remote', url, ref).trim().split('\t')[0] ?? '';

test('publishRef：批准的 SHA 作为新分支发布；重复调用只核验；verifyOnly 不推送', async () => {
  const { url, repo, branch, sha, git } = await publishFixture();
  const input = { path: repo, branch, sha, expectedUrl: url, baseBranch: 'main' };

  const verified = await git.publishRef!({ ...input, verifyOnly: true });
  assert.ok(verified.ok, verified.ok ? '' : verified.error.message);
  assert.equal(verified.value.published, false);
  assert.equal(verified.value.pushed, false);
  assert.equal(verified.value.remoteSha, null);
  assert.equal(verified.value.baseBranch, 'main');
  assert.equal(verified.value.defaultBranch, 'main');
  assert.match(verified.value.reason ?? '', /仅核验/);
  assert.equal(remoteRef(repo, url, `refs/heads/${branch}`), '');

  const published = await git.publishRef!(input);
  assert.ok(published.ok, published.ok ? '' : published.error.message);
  assert.equal(published.value.published, true);
  assert.equal(published.value.pushed, true);
  assert.equal(published.value.uncertain, false);
  assert.equal(published.value.baseSha, sh(repo, 'rev-parse', 'main').trim());
  assert.equal(remoteRef(repo, url, `refs/heads/${branch}`), sha);
  // 远端 base 没被这次发布挪动
  assert.equal(remoteRef(repo, url, 'refs/heads/main'), published.value.baseSha);

  const again = await git.publishRef!(input);
  assert.ok(again.ok, again.ok ? '' : again.error.message);
  assert.equal(again.value.published, true);
  assert.equal(again.value.pushed, false, '已经在远端同一个提交上时不再 push');
  assert.equal(again.value.remoteSha, sha);
});

test('publishRef：SHA / 分支 / 工作区 / 目的地 / base / 默认分支准入全部失败关闭', async () => {
  const { url, repo, branch, sha, git } = await publishFixture();
  const base = { path: repo, branch, sha, expectedUrl: url, baseBranch: 'main' };

  const wrongSha = await git.publishRef!({ ...base, sha: '0'.repeat(40) });
  assert.equal(wrongSha.ok, false);
  assert.equal(wrongSha.ok ? '' : wrongSha.error.code, 'conflict');
  assert.match(wrongSha.ok ? '' : wrongSha.error.message, /HEAD/);

  const wrongBranch = await git.publishRef!({ ...base, branch: 'agent-hub/other' });
  assert.equal(wrongBranch.ok, false);
  assert.match(wrongBranch.ok ? '' : wrongBranch.error.message, /当前分支/);

  const badName = await git.publishRef!({ ...base, branch: '--force' });
  assert.equal(badName.ok, false);
  assert.match(badName.ok ? '' : badName.error.message, /分支名不合法/);

  await writeFile(join(repo, 'dirty.txt'), 'x');
  const dirty = await git.publishRef!(base);
  assert.equal(dirty.ok, false);
  assert.match(dirty.ok ? '' : dirty.error.message, /不干净/);
  await rm(join(repo, 'dirty.txt'));

  const wrongUrl = await git.publishRef!({ ...base, expectedUrl: join(repo, '..', 'mirror.git') });
  assert.equal(wrongUrl.ok, false);
  assert.match(wrongUrl.ok ? '' : wrongUrl.error.message, /不一致/);

  const missingBase = await git.publishRef!({ ...base, baseBranch: 'nope' });
  assert.equal(missingBase.ok, false);
  assert.match(missingBase.ok ? '' : missingBase.error.message, /base 分支/);

  // 本地 insteadOf 把 origin 改写去别处：即使 raw 配置看起来对，也拒绝
  sh(repo, 'config', `url.${join(repo, '..', 'mirror.git')}.insteadOf`, url);
  const rewritten = await git.publishRef!(base);
  assert.equal(rewritten.ok, false);
  assert.match(rewritten.ok ? '' : rewritten.error.message, /改写/);
  sh(repo, 'config', '--unset', `url.${join(repo, '..', 'mirror.git')}.insteadOf`);

  // 功能分支就是远端默认分支：拒绝（base 记录成另一个真实分支来绕过 base 同名校验）
  sh(repo, 'push', '-q', 'origin', 'main:refs/heads/release');
  sh(repo, 'checkout', '-q', 'main');
  const mainSha = sh(repo, 'rev-parse', 'HEAD').trim();
  const defaultBranch = await git.publishRef!({ path: repo, branch: 'main', sha: mainSha, expectedUrl: url, baseBranch: 'release' });
  assert.equal(defaultBranch.ok, false);
  assert.match(defaultBranch.ok ? '' : defaultBranch.error.message, /默认分支/);
});

test('publishRef：远端已有不同提交时失败关闭，绝不覆盖', async () => {
  const { url, repo, branch, sha, git } = await publishFixture();
  const other = sh(repo, 'rev-parse', 'main').trim();
  sh(repo, 'push', '-q', 'origin', `main:refs/heads/${branch}`);
  assert.equal(remoteRef(repo, url, `refs/heads/${branch}`), other);

  const refused = await git.publishRef!({ path: repo, branch, sha, expectedUrl: url, baseBranch: 'main' });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok ? '' : refused.error.code, 'conflict');
  assert.match(refused.ok ? '' : refused.error.message, /另一个提交|失败关闭/);
  assert.equal(remoteRef(repo, url, `refs/heads/${branch}`), other, '远端未被改动');
});

test('publishRef：HTTPS origin 必须带绑定同一地址的 scoped auth，不读 ambient 凭据', async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'ws-publish-https-')));
  const repo = join(root, 'repo');
  await mkdir(repo);
  const api = 'https://gitlab.test/me/api.git';
  sh(repo, 'init', '-q', '-b', 'main');
  await writeFile(join(repo, 'a.txt'), 'a\n');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-qm', 'a');
  sh(repo, 'checkout', '-q', '-b', 'agent-hub/https');
  await writeFile(join(repo, 'b.txt'), 'b\n');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-qm', 'b');
  sh(repo, 'remote', 'add', 'origin', api);
  const sha = sh(repo, 'rev-parse', 'HEAD').trim();
  const git = createGitWorkspace();
  const input = { path: repo, branch: 'agent-hub/https', sha, expectedUrl: api, baseBranch: 'main' };

  const anonymous = await git.publishRef!(input);
  assert.equal(anonymous.ok, false);
  assert.match(anonymous.ok ? '' : anonymous.error.message, /必须使用绑定/);

  const header = 'Authorization: Basic eC1hY2Nlc3MtdG9rZW46Z2xwYXQtYWJj';
  const mismatched = await git.publishRef!({ ...input, auth: { header, url: 'https://evil.test/me/api.git' } });
  assert.equal(mismatched.ok, false);
  assert.match(mismatched.ok ? '' : mismatched.error.message, /不一致/);

  const unbound = await git.publishRef!({ ...input, auth: { header } });
  assert.equal(unbound.ok, false);
  assert.match(unbound.ok ? '' : unbound.error.message, /旧版 hub|拒绝/);
  await rm(root, { recursive: true, force: true });
});

/** A4 的真实本地 bare 远端：源仓库保持脏工作区（已跟踪改动 + 未跟踪文件），本地还有过期分支。 */
async function delegationFixture() {
  const { root, url } = await origin();
  const repo = join(root, 'source');
  sh(root, 'clone', '-q', url, 'source');
  sh(repo, 'config', 'user.name', 't');
  sh(repo, 'config', 'user.email', 't@t');
  sh(repo, 'branch', 'release'); // 本地过期 ref：远端没有 release
  const stale = sh(repo, 'rev-parse', 'HEAD').trim();
  sh(repo, 'update-ref', 'refs/remotes/origin/release', stale);
  await writeFile(join(repo, 'README.md'), 'local edit, do not lose\n');
  await writeFile(join(repo, 'scratch.txt'), 'untracked, do not lose\n');
  const before = {
    head: sh(repo, 'rev-parse', 'HEAD').trim(),
    branch: sh(repo, 'branch', '--show-current').trim(),
    status: sh(repo, 'status', '--porcelain').trim(),
    staged: sh(repo, 'diff', '--cached', '--name-only').trim(),
    indexSha: sh(repo, 'ls-files', '-s').trim()
  };
  await mkdir(join(root, 'trees'), { recursive: true });
  const git = createGitWorkspace(undefined, { allowLocalPublishOrigin: true });
  return { root, url, repo, stale, before, git };
}

test('prepareDelegationWorktree：从远端 base 开两个精确路径的 worktree，脏源仓库原样不动', async () => {
  const { root, url, repo, before, git } = await delegationFixture();
  const baseSha = sh(repo, 'rev-parse', 'refs/remotes/origin/release').trim();
  assert.equal(baseSha, before.head);

  const first = join(root, 'trees', 'one');
  const one = await git.prepareDelegationWorktree!({
    repoPath: repo,
    path: first,
    branch: 'agent-hub/delegation-one',
    baseBranch: 'main',
    expectedUrl: url
  });
  assert.ok(one.ok, one.ok ? '' : one.error.message);
  assert.equal(one.value.path, realpathSync(first));
  assert.equal(one.value.branch, 'agent-hub/delegation-one');
  assert.equal(one.value.baseSha, before.head);
  assert.equal(await readFile(join(first, 'README.md'), 'utf8'), 'hi\n');
  assert.equal(existsSync(join(first, 'scratch.txt')), false);
  assert.equal(sh(first, 'status', '--porcelain').trim(), '');
  assert.equal(sh(first, 'symbolic-ref', '--short', 'HEAD').trim(), 'agent-hub/delegation-one');

  const second = join(root, 'trees', 'two');
  const two = await git.prepareDelegationWorktree!({
    repoPath: repo,
    path: second,
    branch: 'agent-hub/delegation-two',
    baseBranch: 'main',
    expectedUrl: url
  });
  assert.ok(two.ok, two.ok ? '' : two.error.message);
  assert.notEqual(one.value.path, two.value.path);
  assert.equal(sh(second, 'rev-parse', 'HEAD').trim(), one.value.baseSha);

  // 源仓库：分支 / HEAD / index / 工作区一个都不能变
  assert.equal(sh(repo, 'rev-parse', 'HEAD').trim(), before.head);
  assert.equal(sh(repo, 'branch', '--show-current').trim(), before.branch);
  assert.equal(sh(repo, 'status', '--porcelain').trim(), before.status);
  assert.equal(sh(repo, 'diff', '--cached', '--name-only').trim(), before.staged);
  assert.equal(sh(repo, 'ls-files', '-s').trim(), before.indexSha);
  assert.match(await readFile(join(repo, 'README.md'), 'utf8'), /do not lose/);
  assert.match(await readFile(join(repo, 'scratch.txt'), 'utf8'), /do not lose/);
  assert.equal(sh(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length, 3);
});

test('prepareDelegationWorktree：目标目录 / 本地或远端分支已存在时拒绝，不采用', async () => {
  const { root, url, repo, before, git } = await delegationFixture();
  const input = { repoPath: repo, branch: 'agent-hub/delegation-x', baseBranch: 'main', expectedUrl: url };

  const occupied = join(root, 'trees', 'occupied');
  await mkdir(occupied);
  const dirTaken = await git.prepareDelegationWorktree!({ ...input, path: occupied });
  assert.equal(dirTaken.ok, false);
  assert.equal(dirTaken.ok ? '' : dirTaken.error.code, 'conflict');
  assert.match(dirTaken.ok ? '' : dirTaken.error.message, /已经存在/);
  assert.equal((await readdir(occupied)).length, 0);

  sh(repo, 'branch', 'agent-hub/delegation-x');
  const refTaken = await git.prepareDelegationWorktree!({ ...input, path: join(root, 'trees', 'ref-taken') });
  assert.equal(refTaken.ok, false);
  assert.equal(refTaken.ok ? '' : refTaken.error.code, 'conflict');
  assert.match(refTaken.ok ? '' : refTaken.error.message, /已经存在/);
  assert.equal(existsSync(join(root, 'trees', 'ref-taken')), false);

  const remote = join(root, 'pusher');
  sh(root, 'clone', '-q', url, 'pusher');
  sh(remote, 'push', '-q', 'origin', `main:refs/heads/agent-hub/delegation-remote`);
  const remoteTaken = await git.prepareDelegationWorktree!({
    repoPath: repo,
    path: join(root, 'trees', 'remote-taken'),
    branch: 'agent-hub/delegation-remote',
    baseBranch: 'main',
    expectedUrl: url
  });
  assert.equal(remoteTaken.ok, false);
  assert.equal(remoteTaken.ok ? '' : remoteTaken.error.code, 'conflict');
  assert.match(remoteTaken.ok ? '' : remoteTaken.error.message, /远端已经有分支/);
  assert.equal(existsSync(join(root, 'trees', 'remote-taken')), false);

  assert.equal(sh(repo, 'status', '--porcelain').trim(), before.status);
});

test('prepareDelegationWorktree：远端 base 缺失时不用本地过期 ref，目的地 / 路径 / 分支名一律失败关闭', async () => {
  const { root, url, repo, before, git } = await delegationFixture();
  const destination = join(root, 'trees', 'never');
  const input = { repoPath: repo, path: destination, branch: 'agent-hub/delegation-y', expectedUrl: url };

  const missingBase = await git.prepareDelegationWorktree!({ ...input, baseBranch: 'release' });
  assert.equal(missingBase.ok, false);
  assert.equal(missingBase.ok ? '' : missingBase.error.code, 'conflict');
  assert.match(missingBase.ok ? '' : missingBase.error.message, /base 分支/);
  assert.equal(existsSync(destination), false);

  const wrongUrl = await git.prepareDelegationWorktree!({ ...input, baseBranch: 'main', expectedUrl: join(root, 'mirror.git') });
  assert.equal(wrongUrl.ok, false);
  assert.match(wrongUrl.ok ? '' : wrongUrl.error.message, /不一致|HTTPS/);

  const badBranch = await git.prepareDelegationWorktree!({ ...input, baseBranch: 'main', branch: '--force' });
  assert.equal(badBranch.ok, false);
  assert.match(badBranch.ok ? '' : badBranch.error.message, /分支名不合法/);

  const sameBranch = await git.prepareDelegationWorktree!({ ...input, baseBranch: 'main', branch: 'main' });
  assert.equal(sameBranch.ok, false); // 默认分支 / base 同名都拒绝

  const insideRepo = await git.prepareDelegationWorktree!({ ...input, baseBranch: 'main', path: join(repo, '.delegation') });
  assert.equal(insideRepo.ok, false);
  assert.match(insideRepo.ok ? '' : insideRepo.error.message, /源仓库/);
  assert.equal(existsSync(join(repo, '.delegation')), false);

  const missingParent = await git.prepareDelegationWorktree!({ ...input, baseBranch: 'main', path: join(root, 'nope', 'deep') });
  assert.equal(missingParent.ok, false);
  assert.match(missingParent.ok ? '' : missingParent.error.message, /父目录/);

  await mkdir(join(root, 'plain'));
  const notRoot = await git.prepareDelegationWorktree!({ ...input, baseBranch: 'main', repoPath: join(root, 'plain') });
  assert.equal(notRoot.ok, false);
  assert.match(notRoot.ok ? '' : notRoot.error.message, /不是 git 仓库根目录/);

  assert.equal(sh(repo, 'status', '--porcelain').trim(), before.status);
});

/**
 * importCommit 的两份独立 clone（都从同一个 bare origin 克隆）：
 * 源 clone 在 feat 上有一个尚未推送的提交；other 分支上另有一个不在 feat 历史里的提交。
 */
async function importFixture() {
  const { root, url } = await origin();
  const source = join(root, 'source');
  const target = join(root, 'target');
  sh(root, 'clone', '-q', url, 'source');
  sh(root, 'clone', '-q', url, 'target');
  for (const repo of [source, target]) {
    sh(repo, 'config', 'user.name', 't');
    sh(repo, 'config', 'user.email', 't@t');
  }
  sh(source, 'checkout', '-q', '-b', 'feat');
  await writeFile(join(source, 'feat.txt'), 'feat\n');
  sh(source, 'add', '.');
  sh(source, 'commit', '-qm', 'unpublished');
  const sha = sh(source, 'rev-parse', 'HEAD').trim();
  sh(source, 'checkout', '-q', '-b', 'other');
  await writeFile(join(source, 'other.txt'), 'other\n');
  sh(source, 'add', '.');
  sh(source, 'commit', '-qm', 'other only');
  const otherSha = sh(source, 'rev-parse', 'HEAD').trim();
  sh(source, 'checkout', '-q', 'feat');

  const state = (repo: string) => ({
    head: rev(repo, 'HEAD'),
    branch: sh(repo, 'branch', '--show-current').trim(),
    status: sh(repo, 'status', '--porcelain').trim(),
    index: sh(repo, 'ls-files', '-s').trim()
  });
  const remoteRefs = () => sh(root, '--git-dir', url, 'for-each-ref', '--format=%(refname) %(objectname)').trim();
  const git = createGitWorkspace(undefined, { allowLocalPublishOrigin: true });
  return { root, url, source, target, sha, otherSha, state, remoteRefs, git };
}

test('importCommit：本地导入未推送提交到专用 ref，create-only、重复幂等，两侧状态与远端不变', async () => {
  const { url, source, target, sha, state, remoteRefs, git } = await importFixture();
  const ref = `refs/agent-hub/imports/delegation-1/${sha}`;
  const before = state(target);
  const sourceBefore = state(source);
  const remoteBefore = remoteRefs();
  assert.equal(rev(target, ref), '');

  const imported = await git.importCommit!({ sourcePath: source, targetPath: target, sourceBranch: 'feat', sha, ref, expectedUrl: url });
  assert.ok(imported.ok, imported.ok ? '' : imported.error.message);
  assert.deepEqual(imported.value, { ref, sha, alreadyPresent: false });
  assert.equal(rev(target, ref), sha);
  assert.equal(rev(target, `${sha}^{commit}`), sha);
  // 目标仓库只多了这个专用 ref：没有 checkout、没动 index / HEAD / 分支 / FETCH_HEAD
  assert.deepEqual(state(target), before);
  assert.equal(existsSync(join(target, '.git', 'FETCH_HEAD')), false);
  assert.equal(sh(target, 'branch', '--list', 'feat').trim(), '');
  // 源仓库与远端都没有被写入
  assert.deepEqual(state(source), sourceBefore);
  assert.equal(remoteRefs(), remoteBefore);

  const again = await git.importCommit!({ sourcePath: source, targetPath: target, sourceBranch: 'feat', sha, ref, expectedUrl: url });
  assert.ok(again.ok, again.ok ? '' : again.error.message);
  assert.deepEqual(again.value, { ref, sha, alreadyPresent: true });
  assert.deepEqual(state(target), before);
  assert.equal(remoteRefs(), remoteBefore);
});

test('importCommit：分支 / 提交 / ref / 仓库不一致都失败关闭，不留下任何 ref', async () => {
  const { root, url, source, target, sha, otherSha, state, remoteRefs, git } = await importFixture();
  const ref = `refs/agent-hub/imports/delegation-2/${sha}`;
  const base = { sourcePath: source, targetPath: target, sourceBranch: 'feat', sha, ref, expectedUrl: url };
  const zero = '0'.repeat(40);
  const before = state(target);
  const remoteBefore = remoteRefs();

  // ref 预先指向另一个对象：同名 ref 不能被覆盖，也不产生写入
  const headBefore = rev(target, 'HEAD');
  sh(target, 'update-ref', ref, headBefore);
  const occupied = await git.importCommit!(base);
  assert.equal(occupied.ok, false);
  assert.equal(occupied.ok ? '' : occupied.error.code, 'conflict', occupied.ok ? '' : occupied.error.message);
  assert.match(occupied.ok ? '' : occupied.error.message, /另一个提交/);
  assert.equal(rev(target, ref), headBefore);
  assert.deepEqual(state(target), before);
  sh(target, 'update-ref', '-d', ref);

  const first = await git.importCommit!(base);
  assert.ok(first.ok, first.ok ? '' : first.error.message);
  assert.equal(rev(target, ref), sha);

  // 源 HEAD 不在记录的分支上（不猜、不退回别的分支）
  sh(source, 'checkout', '-q', 'main');
  const wrongHead = await git.importCommit!({ ...base, ref: `refs/agent-hub/imports/delegation-3/${sha}` });
  assert.equal(wrongHead.ok, false);
  assert.match(wrongHead.ok ? '' : wrongHead.error.message, /当前分支/);
  sh(source, 'checkout', '-q', 'feat');

  // 提交只存在于别的分支：不在记录分支历史上，拒绝
  const foreignRef = `refs/agent-hub/imports/delegation-4/${otherSha}`;
  const foreign = await git.importCommit!({ ...base, ref: foreignRef, sha: otherSha });
  assert.equal(foreign.ok, false);
  assert.match(foreign.ok ? '' : foreign.error.message, /历史/);
  assert.equal(rev(target, foreignRef), '');

  // 源仓库里没有这个提交
  const missing = await git.importCommit!({ ...base, ref: `refs/agent-hub/imports/delegation-5/${zero}`, sha: zero });
  assert.equal(missing.ok, false);
  assert.match(missing.ok ? '' : missing.error.message, /不是源仓库里的提交/);

  // 目标是另一个项目的 clone：origin 对不上
  const { url: otherUrl } = await origin();
  const foreignTarget = join(root, 'foreign-target');
  sh(root, 'clone', '-q', otherUrl, 'foreign-target');
  const wrongRepoRef = `refs/agent-hub/imports/delegation-6/${sha}`;
  const wrongRepo = await git.importCommit!({ ...base, targetPath: foreignTarget, ref: wrongRepoRef });
  assert.equal(wrongRepo.ok, false);
  assert.match(wrongRepo.ok ? '' : wrongRepo.error.message, /不一致/);
  assert.equal(rev(foreignTarget, wrongRepoRef), '');

  const wrongUrl = await git.importCommit!({ ...base, ref: `refs/agent-hub/imports/delegation-7/${sha}`, expectedUrl: otherUrl });
  assert.equal(wrongUrl.ok, false);
  assert.match(wrongUrl.ok ? '' : wrongUrl.error.message, /不一致|HTTPS/);

  // 目标不是 git 仓库根目录 / 和源是同一个目录
  await mkdir(join(root, 'plain'));
  const notRoot = await git.importCommit!({ ...base, targetPath: join(root, 'plain'), ref: `refs/agent-hub/imports/delegation-8/${sha}` });
  assert.equal(notRoot.ok, false);
  assert.match(notRoot.ok ? '' : notRoot.error.message, /不是 git 仓库根目录/);
  const samePath = await git.importCommit!({ ...base, targetPath: source, ref: `refs/agent-hub/imports/delegation-9/${sha}` });
  assert.equal(samePath.ok, false);
  assert.match(samePath.ok ? '' : samePath.error.message, /同一个目录/);

  // ref 只接受 refs/agent-hub/imports/<id>/<sha>：越界命名空间 / 多段 id / 分支 / 裸名都拒绝
  const outsideNamespace = `refs/agent-hub/imported/${sha}`;
  const nestedId = `refs/agent-hub/imports/a/b/${sha}`;
  const branchRef = 'refs/heads/imported';
  for (const bad of [outsideNamespace, nestedId, branchRef, 'imported']) {
    const rejected = await git.importCommit!({ ...base, ref: bad });
    assert.equal(rejected.ok, false);
    assert.match(rejected.ok ? '' : rejected.error.message, /refs\/agent-hub\/imports/);
    assert.equal(rev(target, bad), '');
  }

  // 命名空间正确但末尾 SHA 与 sha 不一致：也拒绝，防止 ref 名伪造别的提交
  const mismatched = `refs/agent-hub/imports/delegation-2/${zero}`;
  const mismatchedRef = await git.importCommit!({ ...base, ref: mismatched });
  assert.equal(mismatchedRef.ok, false);
  assert.match(mismatchedRef.ok ? '' : mismatchedRef.error.message, /SHA 必须/);
  assert.equal(rev(target, mismatched), '');

  assert.deepEqual(state(target), before);
  assert.equal(remoteRefs(), remoteBefore);
});
