import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkerFiles } from './worker-files.ts';

test('读写过边界：库内软链接可读，指向外面的软链接不能读也不能写穿', async () => {
  const base = await mkdtemp(join(tmpdir(), 'wf-toctou-'));
  try {
    const root = join(base, 'proj');
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'AGENTS.md'), 'agents');
    await symlink(join(root, 'AGENTS.md'), join(root, 'CLAUDE.md'));
    await writeFile(join(base, 'secret.txt'), 'secret');
    await symlink(join(base, 'secret.txt'), join(root, 'leak.txt'));
    await symlink(base, join(root, 'escape'));
    const files = createWorkerFiles({ roots: [root], enforced: true });

    assert.equal(Buffer.from((await files.readFile(join(root, 'CLAUDE.md'), 100)) ?? []).toString(), 'agents');
    await assert.rejects(files.readFile(join(root, 'leak.txt'), 100));
    await assert.rejects(files.writeFile(join(root, 'leak.txt'), Buffer.from('pwn')));
    await assert.rejects(files.writeFile(join(root, 'escape', 'new.txt'), Buffer.from('pwn')));
    assert.equal(await readFile(join(base, 'secret.txt'), 'utf8'), 'secret');

    await files.writeFile(join(root, 'docs', 'deep', 'a.txt'), Buffer.from('ok'));
    assert.equal(await readFile(join(root, 'docs', 'deep', 'a.txt'), 'utf8'), 'ok');
    await files.writeFile(join(root, 'docs', 'deep', 'a.txt'), Buffer.from('k'));
    assert.equal(await readFile(join(root, 'docs', 'deep', 'a.txt'), 'utf8'), 'k', '覆盖写会截断');
    assert.equal(await files.readFile(join(root, 'none.txt'), 100), null);
    await assert.rejects(files.readFile(join(root, 'AGENTS.md'), 2), /太大/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
