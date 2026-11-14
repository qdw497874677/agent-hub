import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GROUP_MARKER_FILE,
  createGroupDir,
  defaultGroupsDir,
  insideGroups
} from './group-dir.ts';
import { createGroupWorktrees } from './git-workspace.ts';

/** 全部放行 / 全部拒绝的 roots 边界，形状和 WorkerFiles.check 一样。 */
const allow = async () => null;
const deny = async (path: string) => `不让访问 ${path}`;

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env });

/** 沙箱：base 下的 groups 目录就是 WORKER_GROUPS_DIR。 */
async function sandbox(): Promise<{ base: string; groups: string }> {
  const base = realpathSync(await mkdtemp(join(tmpdir(), 'ws-group-')));
  return { base, groups: join(base, 'groups') };
}

test('insideGroups 按路径段比较：前缀同名的兄弟目录、groups 自己都不算在里面', () => {
  assert.equal(insideGroups('/a/agent-hub-groups', '/a/agent-hub-groups/g1'), true);
  assert.equal(insideGroups('/a/agent-hub-groups', '/a/agent-hub-groups/g1/member'), true);
  assert.equal(insideGroups('/a/agent-hub-groups', '/a/agent-hub-groups'), false);
  assert.equal(insideGroups('/a/agent-hub-groups', '/a/agent-hub-groups/../evil'), false);
  assert.equal(insideGroups('/a/agent-hub-groups', '/a/agent-hub-groups-evil/g1'), false);
  assert.equal(insideGroups('/a/agent-hub-groups', '/a/other'), false);
});

test('defaultGroupsDir 是「第一个 root 下的 agent-hub-groups」', () => {
  assert.equal(defaultGroupsDir(['/home/u/code', '/data']), '/home/u/code/agent-hub-groups');
  assert.equal(defaultGroupsDir([]), '/agent-hub-groups');
});

test('group_init：根由 worker 算成 groupsDir/<slug>/<name>，建 .agent-hub/group.json；重复 init 回 conflict', async () => {
  const { groups } = await sandbox();
  const dir = createGroupDir({ groupsDir: groups, check: allow });
  const root = join(groups, 'team-1', 'demo');

  const created = await dir.init({ slug: 'team-1', name: 'demo', id: 'grp-1' });
  assert.ok(created.ok, created.ok ? '' : created.error.message);
  assert.equal(created.value.root, root);
  assert.equal(existsSync(root), true);
  assert.deepEqual(JSON.parse(await readFile(join(root, GROUP_MARKER_FILE), 'utf8')), { id: 'grp-1' });

  const again = await dir.init({ slug: 'team-1', name: 'demo', id: 'grp-1' });
  assert.equal(again.ok, false);
  assert.equal(again.ok ? '' : again.error.code, 'conflict');
});

test('group_init：slug/name 非法段一律 invalid，且什么都不建', async () => {
  const { base, groups } = await sandbox();
  await mkdir(groups, { recursive: true });
  const dir = createGroupDir({ groupsDir: groups, check: allow });
  const badSegments = ['../evil', 'a/b', '..', '.', '', 'Demo', 'a b', 'a.b', '/'];
  for (const bad of badSegments) {
    const asSlug = await dir.init({ slug: bad, name: 'demo', id: 'g' });
    assert.equal(asSlug.ok, false, `slug=${bad}`);
    assert.equal(asSlug.ok ? '' : asSlug.error.code, 'invalid', `slug=${bad}`);
    const asName = await dir.init({ slug: 'team', name: bad, id: 'g' });
    assert.equal(asName.ok, false, `name=${bad}`);
    assert.equal(asName.ok ? '' : asName.error.code, 'invalid', `name=${bad}`);
  }
  assert.equal(existsSync(join(base, 'evil')), false);
  assert.equal(existsSync(join(groups, 'team')), false);
});

test('group_init：root 已存在但是空的也回 conflict（重试走「继续用已有容器」）', async () => {
  const { groups } = await sandbox();
  const dir = createGroupDir({ groupsDir: groups, check: allow });
  const root = join(groups, 'team', 'demo');
  await mkdir(root, { recursive: true });
  const out = await dir.init({ slug: 'team', name: 'demo', id: 'g' });
  assert.equal(out.ok, false);
  assert.equal(out.ok ? '' : out.error.code, 'conflict');
});

test('group_init：roots 边界拒绝（check 返回原因 → invalid）', async () => {
  const { groups } = await sandbox();
  const dir = createGroupDir({ groupsDir: groups, check: deny });
  const out = await dir.init({ slug: 'team', name: 'demo', id: 'g' });
  assert.equal(out.ok, false);
  assert.equal(out.ok ? '' : out.error.code, 'invalid');
  assert.equal(existsSync(join(groups, 'team')), false);
});

test('group_init：容器落在 git 仓库里面被拒（外层仓库没法安全 add -A）', async () => {
  const { base, groups } = await sandbox();
  sh(base, 'init', '-q', '-b', 'main');
  const dir = createGroupDir({ groupsDir: groups, check: allow });
  const out = await dir.init({ slug: 'team', name: 'demo', id: 'g' });
  assert.equal(out.ok, false);
  assert.equal(out.ok ? '' : out.error.code, 'conflict');
  assert.match(out.ok ? '' : out.error.message, /git 仓库/);
  assert.equal(existsSync(join(groups, 'team')), false);
});

test('group_init：容器上面几层有一项是文件就 invalid', async () => {
  const { groups } = await sandbox();
  await mkdir(groups, { recursive: true });
  await writeFile(join(groups, 'blocker'), 'x');
  const dir = createGroupDir({ groupsDir: groups, check: allow });
  // groups/blocker 是文件：最近存在的祖先是它，建不出目录来
  const out = await dir.init({ slug: 'blocker', name: 'demo', id: 'g' });
  assert.equal(out.ok, false);
  assert.equal(out.ok ? '' : out.error.code, 'invalid');
  assert.match(out.ok ? '' : out.error.message, /不是目录/);
});

test('group_remove：id 对不上 / 不是容器 / 是符号链接都回 conflict，不跟链接删', async () => {
  const { base, groups } = await sandbox();
  const dir = createGroupDir({ groupsDir: groups, check: allow });
  const root = join(groups, 'team-1', 'demo');
  const created = await dir.init({ slug: 'team-1', name: 'demo', id: 'grp-1' });
  assert.ok(created.ok, created.ok ? '' : created.error.message);

  const wrongId = await dir.remove({ root, id: 'someone-else' });
  assert.equal(wrongId.ok, false);
  assert.equal(wrongId.ok ? '' : wrongId.error.code, 'conflict');
  assert.equal(existsSync(root), true, 'id 对不上就不能删');

  const plain = join(groups, 'plain');
  await mkdir(plain, { recursive: true });
  await writeFile(join(plain, 'keep.txt'), 'x');
  const notGroup = await dir.remove({ root: plain, id: 'grp-1' });
  assert.equal(notGroup.ok, false);
  assert.equal(notGroup.ok ? '' : notGroup.error.code, 'conflict');
  assert.equal(existsSync(join(plain, 'keep.txt')), true);

  // 链接指向容器：lstat 看到的是链接，必须拒（不 realpath、不跟过去）
  const link = join(groups, 'link');
  await symlink(root, link);
  const linked = await dir.remove({ root: link, id: 'grp-1' });
  assert.equal(linked.ok, false);
  assert.equal(linked.ok ? '' : linked.error.code, 'conflict');
  assert.equal(existsSync(root), true);
  assert.equal(existsSync(join(base, 'groups', 'team-1', 'demo')), true);
});

test('group_remove：正常删掉；本来就不在算成功', async () => {
  const { groups } = await sandbox();
  const dir = createGroupDir({ groupsDir: groups, check: allow });
  const root = join(groups, 'team', 'demo');
  assert.ok((await dir.init({ slug: 'team', name: 'demo', id: 'grp-1' })).ok);

  const gone = await dir.remove({ root, id: 'grp-1' });
  assert.deepEqual(gone, { ok: true, value: { removed: true } });
  assert.equal(existsSync(root), false);

  const missing = await dir.remove({ root, id: 'grp-1' });
  assert.deepEqual(missing, { ok: true, value: { removed: true } });
});

test('group_remove：前缀外的路径直接 invalid', async () => {
  const { base, groups } = await sandbox();
  const dir = createGroupDir({ groupsDir: groups, check: allow });
  for (const root of [base, `${groups}-evil/x`, groups]) {
    const out = await dir.remove({ root, id: 'g' });
    assert.equal(out.ok, false, root);
    assert.equal(out.ok ? '' : out.error.code, 'invalid', root);
  }
});

test('new_worktree：groups 外被拒，groups 内正常建成新分支', async () => {
  const { base, groups } = await sandbox();
  await mkdir(groups, { recursive: true });
  const repo = join(base, 'repo');
  await mkdir(repo);
  sh(repo, 'init', '-q', '-b', 'main');
  // 空仓库没有 main ref：先造一个空提交，worktree add HEAD 才有东西可指
  sh(repo, 'commit', '-q', '--allow-empty', '-m', 'init');

  const trees = createGroupWorktrees(allow, { groupsDir: groups });

  const outside = await trees.newWorktree({ repoPath: repo, path: join(base, 'elsewhere', 'demo'), branch: 'agent-hub/out' });
  assert.equal(outside.ok, false);
  assert.equal(outside.ok ? '' : outside.error.code, 'invalid');
  assert.equal(existsSync(join(base, 'elsewhere')), false);

  const member = join(groups, 'g1', 'demo');
  const made = await trees.newWorktree({ repoPath: repo, path: member, branch: 'agent-hub/one' });
  assert.ok(made.ok, made.ok ? '' : made.error.message);
  assert.deepEqual(made.value, { path: member, branch: 'agent-hub/one' });
  assert.equal(existsSync(member), true);
  assert.equal(sh(member, 'branch', '--show-current').trim(), 'agent-hub/one');
  assert.equal(sh(member, 'rev-parse', 'HEAD').trim(), sh(repo, 'rev-parse', 'main').trim());

  // 路径已存在 → conflict
  const again = await trees.newWorktree({ repoPath: repo, path: member, branch: 'agent-hub/two' });
  assert.equal(again.ok, false);
  assert.equal(again.ok ? '' : again.error.code, 'conflict');

  // 本地同名分支已存在 → conflict
  const dup = await trees.newWorktree({ repoPath: repo, path: join(groups, 'g1', 'demo2'), branch: 'agent-hub/one' });
  assert.equal(dup.ok, false);
  assert.equal(dup.ok ? '' : dup.error.code, 'conflict');

  // base 指定起点
  sh(repo, 'checkout', '-q', '-b', 'topic');
  sh(repo, 'commit', '-q', '--allow-empty', '-m', 'topic');
  sh(repo, 'checkout', '-q', 'main');
  const fromTopic = await trees.newWorktree({ repoPath: repo, path: join(groups, 'g2', 'demo'), branch: 'agent-hub/from-topic', base: 'topic' });
  assert.ok(fromTopic.ok, fromTopic.ok ? '' : fromTopic.error.message);
  assert.equal(sh(join(groups, 'g2', 'demo'), 'rev-parse', 'HEAD').trim(), sh(repo, 'rev-parse', 'topic').trim());

  await writeFile(join(member, 'README.md'), 'hi\n');
  assert.equal(sh(member, 'status', '--porcelain').trim(), '?? README.md');
});

test('new_worktree：repoPath 不是仓库 / 路径不是绝对路径 / 越出 roots 都回 invalid', async () => {
  const { base, groups } = await sandbox();
  await mkdir(groups, { recursive: true });
  const trees = createGroupWorktrees(allow, { groupsDir: groups });

  const plain = join(base, 'plain');
  await mkdir(plain);
  const notRepo = await trees.newWorktree({ repoPath: plain, path: join(groups, 'g', 'demo'), branch: 'b' });
  assert.equal(notRepo.ok, false);
  assert.equal(notRepo.ok ? '' : notRepo.error.code, 'invalid');

  const relative = await trees.newWorktree({ repoPath: plain, path: 'groups/g/demo', branch: 'b' });
  assert.equal(relative.ok, false);
  assert.equal(relative.ok ? '' : relative.error.code, 'invalid');

  const outsideRoots = createGroupWorktrees(deny, { groupsDir: groups });
  const blocked = await outsideRoots.newWorktree({ repoPath: plain, path: join(groups, 'g', 'demo'), branch: 'b' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.ok ? '' : blocked.error.code, 'invalid');
});

test('new_worktree：远端有同名分支时跟踪 origin/<branch>', async () => {
  const { base, groups } = await sandbox();
  await mkdir(groups, { recursive: true });
  const seed = join(base, 'seed');
  await mkdir(seed);
  sh(seed, 'init', '-q', '-b', 'main');
  sh(seed, 'commit', '-q', '--allow-empty', '-m', 'init');
  sh(seed, 'branch', 'agent-hub/remote');
  sh(base, 'clone', '-q', '--bare', seed, 'origin.git');
  const clone = join(base, 'repo');
  sh(base, 'clone', '-q', join(base, 'origin.git'), 'repo');

  const trees = createGroupWorktrees(allow, { groupsDir: groups });
  const member = join(groups, 'g', 'demo');
  const made = await trees.newWorktree({ repoPath: clone, path: member, branch: 'agent-hub/remote' });
  assert.ok(made.ok, made.ok ? '' : made.error.message);
  assert.equal(sh(member, 'rev-parse', '--abbrev-ref', '@{upstream}').trim(), 'origin/agent-hub/remote');
});
