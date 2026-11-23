import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceBrowser } from './workspace-browser.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' });

async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'wsb-'));
  git(root, 'init', '-q', '-b', 'main');
  await writeFile(join(root, '.gitignore'), 'out/\n');
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'README.md'), '# hi\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'init');
  return root;
}

test('list：目录在前、.git 不列、忽略灰显、敏感标记、git 状态向上汇总', async () => {
  const root = await repo();
  try {
    await mkdir(join(root, 'out'));
    await writeFile(join(root, 'out/x.js'), '1');
    await writeFile(join(root, '.env'), 'SECRET=1');
    await writeFile(join(root, 'src/a.ts'), 'export const a = 2;\n');
    const b = createWorkspaceBrowser();
    const page = await b.list(root, '', { limit: 1000 });
    assert.ok(page.ok);
    const names = page.value.entries.map((e) => e.name);
    assert.ok(!names.includes('.git'));
    assert.deepEqual(names.slice(0, 2), ['out', 'src']);
    assert.equal(page.value.entries.find((e) => e.name === 'out')?.ignored, true);
    assert.equal(page.value.entries.find((e) => e.name === '.env')?.sensitive, true);
    assert.equal(page.value.entries.find((e) => e.name === 'src')?.git, 'modified');
    const sub = await b.list(root, 'src', { limit: 1000 });
    assert.ok(sub.ok);
    assert.equal(sub.value.entries[0]?.git, 'modified');
    assert.equal(sub.value.entries[0]?.path, 'src/a.ts');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('边界：..、绝对路径、.git、符号链接逃逸都拒绝', async () => {
  const root = await repo();
  const outside = await mkdtemp(join(tmpdir(), 'wsb-out-'));
  try {
    await writeFile(join(outside, 'secret'), 'x');
    await symlink(outside, join(root, 'escape'));
    const b = createWorkspaceBrowser();
    for (const bad of ['../x', '/etc/passwd', '.git/config', 'src/../../x', 'escape/secret']) {
      const r = await b.read(root, bad, 100);
      assert.equal(r.ok, false, bad);
    }
    const guarded = createWorkspaceBrowser({ guard: async () => '不在允许范围' });
    assert.equal((await guarded.list(root, '', { limit: 10 })).ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('read：截断、二进制不回内容', async () => {
  const root = await repo();
  try {
    await writeFile(join(root, 'big.txt'), 'a'.repeat(5000));
    await writeFile(join(root, 'bin.dat'), Buffer.from([1, 0, 2, 3]));
    const b = createWorkspaceBrowser();
    const big = await b.read(root, 'big.txt', 1000);
    assert.ok(big.ok);
    assert.equal(big.value.truncated, true);
    assert.equal(big.value.bytes.length, 1000);
    const bin = await b.read(root, 'bin.dat', 1000);
    assert.ok(bin.ok);
    assert.equal(bin.value.binary, true);
    assert.equal(bin.value.bytes.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('find：模糊匹配、尊重 .gitignore', async () => {
  const root = await repo();
  try {
    await mkdir(join(root, 'out'));
    await writeFile(join(root, 'out/a-ignored.ts'), '1');
    const b = createWorkspaceBrowser();
    const r = await b.find(root, 'srca', 50);
    assert.ok(r.ok);
    assert.deepEqual(r.value, ['src/a.ts']);
    const all = await b.find(root, '', 50);
    assert.ok(all.ok && !all.value.some((p) => p.startsWith('out/')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('changes / diff / head：相对会话开始的提交，未跟踪文件也算', async () => {
  const root = await repo();
  try {
    const b = createWorkspaceBrowser();
    const head = await b.head(root);
    assert.ok(head.ok && head.value);
    await writeFile(join(root, 'src/a.ts'), 'export const a = 2;\n');
    git(root, 'commit', '-qam', 'second');
    await writeFile(join(root, 'new.txt'), 'n\nm');
    await writeFile(join(root, 'blob.bin'), Buffer.from([1, 0, 2, 10]));
    const vsHead = await b.changes(root, null);
    assert.ok(vsHead.ok);
    assert.deepEqual(vsHead.value.map((f) => [f.path, f.status]), [['blob.bin', 'untracked'], ['new.txt', 'untracked']]);
    const vsStart = await b.changes(root, head.value);
    assert.ok(vsStart.ok);
    assert.deepEqual(vsStart.value.map((f) => [f.path, f.status, f.additions, f.deletions]), [['blob.bin', 'untracked', 0, 0], ['new.txt', 'untracked', 2, 0], ['src/a.ts', 'modified', 1, 1]]);
    const d = await b.diff(root, 'src/a.ts', head.value, 512 * 1024);
    assert.ok(d.ok && d.value.patch.includes('+export const a = 2;'));
    const u = await b.diff(root, 'new.txt', null, 512 * 1024);
    assert.ok(u.ok && u.value.patch.includes('+n'));
    assert.equal((await b.changes(root, 'HEAD;rm')).ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('branchBase：只算这条分支自己的提交（merge-base，不含默认分支后来前进的部分）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wsb-branch-'));
  try {
    git(root, 'init', '-q', '-b', 'main');
    await writeFile(join(root, 'base.txt'), 'base\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'init');
    const fork = git(root, 'rev-parse', 'HEAD').toString().trim();
    git(root, 'checkout', '-qb', 'feature');
    await writeFile(join(root, 'feature.txt'), 'f\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'feature work');
    git(root, 'checkout', '-q', 'main');
    await writeFile(join(root, 'later.txt'), 'l\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'main moved on');
    git(root, 'checkout', '-q', 'feature');
    await writeFile(join(root, 'wip.txt'), 'w\n'); // 未跟踪也算
    const b = createWorkspaceBrowser();
    const base = await b.branchBase(root);
    assert.ok(base.ok);
    assert.equal(base.value.branch, 'main'); // 没有 origin，退到本地 main
    assert.equal(base.value.commit, fork);
    const files = await b.changes(root, base.value.commit);
    assert.ok(files.ok);
    assert.deepEqual(files.value.map((f) => [f.path, f.status]), [['feature.txt', 'added'], ['wip.txt', 'untracked']]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('branchBase：没有远端 / 本地默认分支时退化，不报错', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wsb-nobase-'));
  try {
    git(root, 'init', '-q', '-b', 'feature');
    await writeFile(join(root, 'a.txt'), 'a\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'only feature');
    const b = createWorkspaceBrowser();
    const r = await b.branchBase(root);
    assert.ok(r.ok);
    assert.deepEqual(r.value, { branch: null, commit: null });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('branchBase：非 git 目录返回空而不是错误', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wsb-plain-'));
  try {
    const b = createWorkspaceBrowser();
    const r = await b.branchBase(dir);
    assert.ok(r.ok);
    assert.deepEqual(r.value, { branch: null, commit: null });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('watch：防抖后报变化的目录，取消后不再报', async () => {
  const root = await repo();
  try {
    const b = createWorkspaceBrowser({ debounceMs: 50 });
    const seen: string[][] = [];
    const w = await b.watch(root, ['src'], (n) => seen.push([...n.paths]));
    assert.ok(w.ok);
    await new Promise((r) => setTimeout(r, 300));
    await writeFile(join(root, 'src/b.ts'), 'b');
    for (let i = 0; i < 40 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(seen.flat().includes('src'), JSON.stringify(seen));
    w.value();
    const over = await b.watch(root, Array.from({ length: 201 }, (_, i) => `d${i}`), () => undefined);
    assert.equal(over.ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('checkpoint：临时 index 拍工作区（含未跟踪、不含忽略），不碰真 index；两张之间的 changes / diff；dropRefs', async () => {
  const root = await repo();
  try {
    const b = createWorkspaceBrowser();
    await writeFile(join(root, 'staged.txt'), 'keep me staged\n');
    git(root, 'add', 'staged.txt');
    const before = await b.checkpoint(root, 'refs/agent-hub/checkpoints/s1/1');
    assert.ok(before.ok && before.value);
    await writeFile(join(root, 'src/a.ts'), 'export const a = 2;\nexport const b = 3;\n');
    await writeFile(join(root, 'new.md'), 'one\ntwo\n');
    await mkdir(join(root, 'out'));
    await writeFile(join(root, 'out/ignored.js'), 'x');
    const after = await b.checkpoint(root, 'refs/agent-hub/checkpoints/s1/2');
    assert.ok(after.ok && after.value);
    // 真 index 原样：staged.txt 还是暂存的新增，别的没被 add
    assert.equal(execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' }).trim(), 'staged.txt');
    const changed = await b.changes(root, before.value, after.value);
    assert.ok(changed.ok);
    assert.deepEqual(changed.value.map((f) => [f.path, f.status, f.additions, f.deletions]), [['new.md', 'added', 2, 0], ['src/a.ts', 'modified', 2, 1]]);
    const patch = await b.diff(root, 'src/a.ts', before.value, 1 << 20, after.value);
    assert.ok(patch.ok && patch.value.patch.includes('+export const b = 3;'));
    // 进行中：前 → 工作区
    await writeFile(join(root, 'later.txt'), 'z\n');
    const live = await b.changes(root, before.value);
    assert.ok(live.ok && live.value.some((f) => f.path === 'later.txt'));
    assert.equal((await b.checkpoint(root, 'refs/heads/main')).ok, false);
    const dropped = await b.dropRefs(root, 'refs/agent-hub/checkpoints/s1/');
    assert.ok(dropped.ok);
    assert.equal(dropped.value, 2);
    assert.equal(execFileSync('git', ['for-each-ref', 'refs/agent-hub/'], { cwd: root, encoding: 'utf8' }).trim(), '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('checkpoint：还没有提交的仓库也能拍；不是仓库 = null', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wsb-empty-'));
  try {
    const b = createWorkspaceBrowser();
    git(root, 'init', '-q');
    await writeFile(join(root, 'a.txt'), 'a\n');
    const shot = await b.checkpoint(root, 'refs/agent-hub/checkpoints/s2/1');
    assert.ok(shot.ok && shot.value);
    const all = await b.changes(root, null, shot.value);
    assert.ok(all.ok);
    assert.deepEqual(all.value.map((f) => f.path), ['a.txt']);
    const plain = await mkdtemp(join(tmpdir(), 'wsb-plain-'));
    const none = await b.checkpoint(plain, 'refs/agent-hub/checkpoints/s2/1');
    assert.ok(none.ok);
    assert.equal(none.value, null);
    await rm(plain, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('restore：回到检查点（改的写回、删的恢复、新增的删掉），忽略文件不动，先拍安全检查点；推送过的新提交拒绝', async () => {
  const root = await repo();
  const remote = await mkdtemp(join(tmpdir(), 'wsb-remote-'));
  try {
    const b = createWorkspaceBrowser();
    await writeFile(join(root, 'notes.txt'), 'untracked before\n');
    const before = await b.checkpoint(root, 'refs/agent-hub/checkpoints/s1/1');
    assert.ok(before.ok && before.value);
    await writeFile(join(root, 'src/a.ts'), 'export const a = 99;\n');
    await rm(join(root, 'README.md'));
    await mkdir(join(root, 'src/deep'));
    await writeFile(join(root, 'src/deep/new.ts'), 'new\n');
    await mkdir(join(root, 'out'));
    await writeFile(join(root, 'out/build.js'), 'ignored\n');
    const done = await b.restore(root, before.value, 'refs/agent-hub/checkpoints/s1/3');
    assert.ok(done.ok, JSON.stringify(done));
    assert.deepEqual([done.value.restored, done.value.removed], [2, 1]);
    const { readFileSync, existsSync } = await import('node:fs');
    assert.equal(readFileSync(join(root, 'src/a.ts'), 'utf8'), 'export const a = 1;\n');
    assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), '# hi\n');
    assert.equal(readFileSync(join(root, 'notes.txt'), 'utf8'), 'untracked before\n');
    assert.equal(existsSync(join(root, 'src/deep/new.ts')), false);
    assert.equal(existsSync(join(root, 'out/build.js')), true);
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(), '?? notes.txt');
    // 安全检查点里还有回滚前的样子（可撤销）
    assert.equal(execFileSync('git', ['show', `${done.value.safety}:src/a.ts`], { cwd: root, encoding: 'utf8' }), 'export const a = 99;\n');
    // 之后的提交推送过 → 拒绝
    git(remote, 'init', '-q', '--bare');
    git(root, 'remote', 'add', 'origin', remote);
    await writeFile(join(root, 'src/a.ts'), 'export const a = 2;\n');
    git(root, 'commit', '-qam', 'later');
    git(root, 'push', '-q', 'origin', 'main');
    const refused = await b.restore(root, before.value, 'refs/agent-hub/checkpoints/s1/5');
    assert.ok(!refused.ok && refused.error.code === 'conflict');
    assert.equal((await b.restore(root, 'zzz', 'refs/agent-hub/checkpoints/s1/7')).ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
  }
});

test('diff：目录不展开；文件名里的 glob / 字符类按字面量处理，不夹带别的文件', async () => {
  const root = await repo();
  try {
    await mkdir(join(root, 'docs'));
    await writeFile(join(root, 'docs/a.txt'), 'doc a v1\n');
    await writeFile(join(root, 'docs/b.txt'), 'doc b v1\n');
    await writeFile(join(root, 'report[1].md'), 'report v1\n');
    await writeFile(join(root, 'report1.md'), 'report plain v1\n');
    await writeFile(join(root, 'star*.txt'), 'star v1\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'fixtures');
    await writeFile(join(root, 'docs/a.txt'), 'doc a v2\n');
    await writeFile(join(root, 'docs/b.txt'), 'doc b v2\n');
    await writeFile(join(root, 'report[1].md'), 'report v2\n');
    await writeFile(join(root, 'report1.md'), 'report plain v2\n');
    await writeFile(join(root, 'star*.txt'), 'star v2\n');
    const b = createWorkspaceBrowser();

    const bracket = await b.diff(root, 'report[1].md', null, 64 * 1024);
    assert.ok(bracket.ok, JSON.stringify(bracket));
    assert.equal(bracket.value.path, 'report[1].md');
    assert.ok(bracket.value.patch.includes('+report v2'));
    assert.ok(!bracket.value.patch.includes('report1.md'), '字符类不能被当模式去匹配 report1.md');
    assert.ok(!bracket.value.patch.includes('docs/'), '不能顺带别的文件');

    const star = await b.diff(root, 'star*.txt', null, 64 * 1024);
    assert.ok(star.ok, JSON.stringify(star));
    assert.ok(star.value.patch.includes('+star v2'));
    assert.ok(!star.value.patch.includes('docs/'), '星号只匹配这一个文件');

    const dir = await b.diff(root, 'docs', null, 64 * 1024);
    assert.equal(dir.ok, false, '目录不能当单文件 diff');
    if (!dir.ok) assert.equal(dir.error.code, 'invalid');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('diff：带空格 / 制表符的真实文件名照常返回，头是裸写也对得上', async () => {
  const root = await repo();
  try {
    await mkdir(join(root, 'my docs'));
    await writeFile(join(root, 'my docs/has space.txt'), 'space v1\n');
    await writeFile(join(root, 'my docs/other.txt'), 'other v1\n');
    await writeFile(join(root, 'tab\tname.txt'), 'tab v1\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'fixtures');
    await writeFile(join(root, 'my docs/has space.txt'), 'space v2\n');
    await writeFile(join(root, 'my docs/other.txt'), 'other v2\n');
    await writeFile(join(root, 'tab\tname.txt'), 'tab v2\n');
    const b = createWorkspaceBrowser();

    const spaced = await b.diff(root, 'my docs/has space.txt', null, 64 * 1024);
    assert.ok(spaced.ok, JSON.stringify(spaced));
    assert.equal(spaced.value.path, 'my docs/has space.txt');
    assert.ok(spaced.value.patch.startsWith('diff --git a/my docs/has space.txt b/my docs/has space.txt\n'), spaced.value.patch);
    assert.ok(spaced.value.patch.includes('+space v2'));
    assert.ok(!spaced.value.patch.includes('other.txt'), '同目录的别的文件不能被夹带');

    const tabbed = await b.diff(root, 'tab\tname.txt', null, 64 * 1024);
    assert.ok(tabbed.ok, JSON.stringify(tabbed));
    assert.ok(tabbed.value.patch.includes('+tab v2'));
    assert.ok(!tabbed.value.patch.includes('space v2'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('diff：删除 / 未跟踪的文件照常返回；检查点之间也只给请求的那一个文件', async () => {
  const root = await repo();
  try {
    const b = createWorkspaceBrowser();
    await writeFile(join(root, 'src/a.ts'), 'export const a = 2;\n');
    git(root, 'commit', '-qam', 'edit');
    const first = await b.checkpoint(root, 'refs/agent-hub/checkpoints/s3/1');
    assert.ok(first.ok && first.value);
    await rm(join(root, 'README.md')); // 删掉已跟踪文件
    await writeFile(join(root, 'draft[1].txt'), 'draft\n'); // 未跟踪，名字带字符类
    const second = await b.checkpoint(root, 'refs/agent-hub/checkpoints/s3/2');
    assert.ok(second.ok && second.value);

    const gone = await b.diff(root, 'README.md', null, 64 * 1024);
    assert.ok(gone.ok, JSON.stringify(gone));
    assert.ok(gone.value.patch.includes('+++ /dev/null'));
    assert.ok(gone.value.patch.includes('-# hi'));

    const untracked = await b.diff(root, 'draft[1].txt', null, 64 * 1024);
    assert.ok(untracked.ok, JSON.stringify(untracked));
    assert.ok(untracked.value.patch.includes('+draft'));

    const range = await b.diff(root, 'README.md', first.value, 64 * 1024, second.value);
    assert.ok(range.ok, JSON.stringify(range));
    assert.ok(range.value.patch.includes('-# hi'));
    assert.ok(!range.value.patch.includes('src/a.ts'));

    // 检查点会把未跟踪文件一起拍进去：两个提交之间它是「新增」，但只给这一个文件。
    const inRange = await b.diff(root, 'draft[1].txt', first.value, 64 * 1024, second.value);
    assert.ok(inRange.ok, JSON.stringify(inRange));
    assert.ok(inRange.value.patch.includes('+draft'));
    assert.ok(!inRange.value.patch.includes('src/a.ts'));

    const absent = await b.diff(root, 'never-there.txt', first.value, 64 * 1024, second.value);
    assert.ok(absent.ok, JSON.stringify(absent));
    assert.equal(absent.value.patch, '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('diff：不执行仓库配置的外部 diff / textconv，patch 头锁死在这个文件上', async () => {
  const root = await repo();
  try {
    await writeFile(join(root, '.gitattributes'), '*.ts diff=agenthub\n');
    git(root, 'add', '.gitattributes');
    git(root, 'commit', '-qm', 'attrs');
    // 仓库本地配置：外部 diff 会直接替换 patch 文本，textconv 会让 git 拿转换结果当文件内容。
    git(root, 'config', 'diff.agenthub.textconv', 'printf "converted\\n"');
    git(root, 'config', 'diff.external', 'printf "not a patch\\n"');
    await writeFile(join(root, 'src/a.ts'), 'export const a = 2;\n');
    const b = createWorkspaceBrowser();
    const d = await b.diff(root, 'src/a.ts', null, 64 * 1024);
    assert.ok(d.ok, JSON.stringify(d));
    assert.ok(d.value.patch.startsWith('diff --git a/src/a.ts b/src/a.ts\n'), d.value.patch);
    assert.ok(d.value.patch.includes('+export const a = 2;'), '要的是 git 自己的 patch，不是外部命令 / 转换后的内容');
    assert.ok(!d.value.patch.includes('not a patch'));
    assert.ok(!d.value.patch.includes('converted'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('diff：只存在于检查点里的目录不能展开成多文件 diff（fail closed）', async () => {
  const root = await repo();
  try {
    const b = createWorkspaceBrowser();
    await mkdir(join(root, 'bundle'));
    await writeFile(join(root, 'bundle/one.txt'), 'one\n');
    await writeFile(join(root, 'bundle/two.txt'), 'two\n');
    const before = await b.checkpoint(root, 'refs/agent-hub/checkpoints/s4/1');
    assert.ok(before.ok && before.value);
    await rm(join(root, 'bundle'), { recursive: true, force: true });
    const after = await b.checkpoint(root, 'refs/agent-hub/checkpoints/s4/2');
    assert.ok(after.ok && after.value);
    const dir = await b.diff(root, 'bundle', before.value, 64 * 1024, after.value);
    assert.equal(dir.ok, false);
    if (!dir.ok) assert.equal(dir.error.code, 'invalid');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
