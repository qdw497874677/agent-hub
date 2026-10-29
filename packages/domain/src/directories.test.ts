import { test } from 'node:test';
import assert from 'node:assert/strict';
import { folderNameProblem, insideRoots, isHiddenName, managedDirectory, projectSlug, sortDirectoryEntries } from './directories.ts';
import { inMemoryDeps } from './testing/in-memory.ts';
import { browseDirectories, createDirectory } from './use-cases/projects.ts';

test('文件夹名：只允许一段', () => {
  assert.equal(folderNameProblem('my-app'), null);
  assert.equal(folderNameProblem('新项目'), null);
  for (const bad of ['', '  ', '.', '..', 'a/b', 'a\\b', ' a', 'a\n', 'x'.repeat(256)]) assert.notEqual(folderNameProblem(bad), null, bad);
});

test('项目名 → slug；托管目录在 roots[0]/agent-hub-workspaces/<slug>', () => {
  assert.equal(projectSlug('My App!'), 'my-app');
  assert.equal(projectSlug('  多机 Hub  '), '多机-hub');
  assert.equal(projectSlug('!!!'), null);
  assert.equal(managedDirectory(['/home/u/', '/srv'], 'my-app'), '/home/u/agent-hub-workspaces/my-app');
  assert.equal(managedDirectory([], 'x'), null);
});

test('insideRoots：按路径段判断，不被前缀骗', () => {
  assert.ok(insideRoots('/home/u', ['/home/u']));
  assert.ok(insideRoots('/home/u/a', ['/home/u/']));
  assert.ok(!insideRoots('/home/user2', ['/home/u']));
  assert.ok(insideRoots('/anything', ['/']));
});

test('浏览：给了项目名就从托管目录开始，没有就退到 agent-hub-workspaces、再退到 root；最近修改的排前面', async () => {
  const world = inMemoryDeps();
  const existing = new Set(['/home/u', '/home/u/agent-hub-workspaces']);
  world.deps.gateway.status = async () => [{ workerId: 'local', label: '本机', origin: 'local', state: 'online', roots: ['/home/u'] }];
  world.deps.fs.directoryExists = async (path) => existing.has(path);
  world.deps.fs.listDirectories = async () => [
    { name: 'old', path: '/x/old', modifiedAt: 1 },
    { name: 'new', path: '/x/new', modifiedAt: 9, isGit: true }
  ];
  const first = await browseDirectories(world.deps, { workerId: 'local', path: '', home: '/home/u', project: 'My App' });
  assert.ok(first.ok);
  assert.equal(first.value.path, '/home/u/agent-hub-workspaces');
  assert.equal(first.value.managed, '/home/u/agent-hub-workspaces/my-app');
  assert.deepEqual(first.value.roots, ['/home/u']);
  assert.deepEqual(first.value.entries.map((e) => e.name), ['new', 'old']);
  existing.add('/home/u/agent-hub-workspaces/my-app');
  const managed = await browseDirectories(world.deps, { workerId: 'local', path: '', home: '/home/u', project: 'My App' });
  assert.ok(managed.ok && managed.value.path === '/home/u/agent-hub-workspaces/my-app');
  const root = await browseDirectories(world.deps, { workerId: 'local', path: '/home/u', home: '/home/u' });
  assert.ok(root.ok && root.value.parent === null && root.value.managed === null);
});

test('新建文件夹：名字和父目录先在领域层挡一遍，本机只能建在 roots 里', async () => {
  const world = inMemoryDeps();
  world.deps.gateway.status = async () => [{ workerId: 'local', label: '本机', origin: 'local', state: 'online', roots: ['/home/u'] }];
  const made = await createDirectory(world.deps, { workerId: 'local', parent: '/home/u/a', name: 'b', home: '/home/u' });
  assert.deepEqual(made, { ok: true, value: { path: '/home/u/a/b' } });
  assert.equal((await createDirectory(world.deps, { workerId: 'local', parent: '/etc', name: 'b', home: '/home/u' })).ok, false);
  assert.equal((await createDirectory(world.deps, { workerId: 'local', parent: '/home/u/../../etc', name: 'b', home: '/home/u' })).ok, false);
  assert.equal((await createDirectory(world.deps, { workerId: 'local', parent: 'rel', name: 'b', home: '/home/u' })).ok, false);
  assert.equal((await createDirectory(world.deps, { workerId: 'local', parent: '/home/u', name: '../x', home: '/home/u' })).ok, false);
  assert.equal((await createDirectory(world.deps, { workerId: 'ghost', parent: '/home/u', name: 'x', home: '/home/u' })).ok, false);
});

test('隐藏目录：只认点开头，不按名字猜噪音', () => {
  assert.equal(isHiddenName('.config'), true);
  assert.equal(isHiddenName('chrome-profile'), false);
  assert.equal(isHiddenName('node_modules'), false);
});

test('目录排序：可见在前、隐藏在后；组内最近修改在前，同时间按名字', () => {
  const sorted = sortDirectoryEntries([
    { name: '.cache', modifiedAt: 9, hidden: true },
    { name: 'old', modifiedAt: 1 },
    { name: 'b', modifiedAt: 5 },
    { name: 'a', modifiedAt: 5 },
    { name: '.git', modifiedAt: 2, hidden: true }
  ]);
  assert.deepEqual(sorted.map((e) => e.name), ['a', 'b', 'old', '.cache', '.git']);
});
