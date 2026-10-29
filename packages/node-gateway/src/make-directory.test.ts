import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INSTALL_DIR, makeDirectoryWithin } from './make-directory.ts';
import { createLocalFs } from './local-fs.ts';

async function sandbox() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'mkd-')));
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  await mkdir(root);
  await mkdir(outside);
  return { base, root, outside, done: () => rm(base, { recursive: true, force: true }) };
}

test('新建文件夹：在 root 里建一层；已存在的目录算成功', async () => {
  const box = await sandbox();
  const made = await makeDirectoryWithin(box.root, 'proj', [box.root]);
  assert.deepEqual(made, { ok: true, value: join(box.root, 'proj') });
  assert.ok((await stat(join(box.root, 'proj'))).isDirectory());
  assert.deepEqual(await makeDirectoryWithin(box.root, 'proj', [box.root]), made);
  await box.done();
});

test('新建文件夹：名字只能一段，拒 .. / 斜杠 / 空名', async () => {
  const box = await sandbox();
  for (const name of ['..', '.', 'a/b', '../x', '', ' x']) {
    const result = await makeDirectoryWithin(box.root, name, [box.root]);
    assert.equal(result.ok, false, name);
  }
  await box.done();
});

test('新建文件夹：parent 在 roots 外、经软链接逃出去、目标是软链接或文件，都拒', async () => {
  const box = await sandbox();
  assert.equal((await makeDirectoryWithin(box.outside, 'x', [box.root])).ok, false);
  assert.equal((await makeDirectoryWithin(join(box.root, '..'), 'x', [box.root])).ok, false);
  // root 里一个指向外面的软链接：当 parent 用也不行
  await symlink(box.outside, join(box.root, 'escape'));
  const via = await makeDirectoryWithin(join(box.root, 'escape'), 'x', [box.root]);
  assert.ok(!via.ok && /不在允许/.test(via.error.message));
  await assert.rejects(stat(join(box.outside, 'x')));
  // 目标名本身是软链接：不跟着走
  const target = await makeDirectoryWithin(box.root, 'escape', [box.root]);
  assert.ok(!target.ok && /软链接/.test(target.error.message));
  await writeFile(join(box.root, 'file'), 'x');
  assert.equal((await makeDirectoryWithin(box.root, 'file', [box.root])).ok, false);
  assert.equal((await makeDirectoryWithin(join(box.root, 'missing'), 'x', [box.root])).ok, false);
  await box.done();
});

test('本机目录列表：标出 git 仓库，带修改时间，点目录标 hidden', async () => {
  const box = await sandbox();
  await mkdir(join(box.root, 'repo', '.git'), { recursive: true });
  await mkdir(join(box.root, 'plain'));
  await mkdir(join(box.root, '.hidden'));
  const entries = await createLocalFs().listDirectories(box.root);
  assert.deepEqual(
    entries.map((e) => [e.name, e.isGit, e.hidden]),
    [['.hidden', false, true], ['plain', false, false], ['repo', true, false]]
  );
  assert.ok(entries.every((e) => typeof e.modifiedAt === 'number' && e.modifiedAt > 0));
  await box.done();
});

test('新建文件夹：不在 agent-hub 安装目录里建（安装目录本身也不行），旁边可以', async () => {
  const box = await sandbox();
  const install = join(box.root, 'agent-hub');
  await mkdir(install);
  const inside = await makeDirectoryWithin(install, 'proj', [box.root], [install]);
  assert.equal(inside.ok, false);
  const itself = await makeDirectoryWithin(box.root, 'agent-hub', [box.root], [install]);
  assert.equal(itself.ok, false);
  const beside = await makeDirectoryWithin(box.root, 'agent-hub-workspaces', [box.root], [install]);
  assert.equal(beside.ok, true);
  await box.done();
});

test('安装目录默认是这份代码的根目录', async () => {
  assert.ok((await stat(join(INSTALL_DIR, 'scripts', 'install-worker.sh'))).isFile());
});
