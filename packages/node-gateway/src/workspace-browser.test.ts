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
    await writeFile(join(root, 'new.txt'), 'n\n');
    const vsHead = await b.changes(root, null);
    assert.ok(vsHead.ok);
    assert.deepEqual(vsHead.value.map((f) => [f.path, f.status]), [['new.txt', 'untracked']]);
    const vsStart = await b.changes(root, head.value);
    assert.ok(vsStart.ok);
    assert.deepEqual(vsStart.value.map((f) => [f.path, f.status, f.additions, f.deletions]), [['new.txt', 'untracked', 0, 0], ['src/a.ts', 'modified', 1, 1]]);
    const d = await b.diff(root, 'src/a.ts', head.value, 512 * 1024);
    assert.ok(d.ok && d.value.patch.includes('+export const a = 2;'));
    const u = await b.diff(root, 'new.txt', null, 512 * 1024);
    assert.ok(u.ok && u.value.patch.includes('+n'));
    assert.equal((await b.changes(root, 'HEAD;rm')).ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
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
