import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDevelopmentRoots } from './worker-files.ts';
import { unaliasedMountPath } from './mount-alias.ts';

test('development roots canonicalize ordered aliases and reject unsafe or non-directory paths', async () => {
  const base = await mkdtemp(join(tmpdir(), 'development-roots-'));
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  try {
    await mkdir(root); await mkdir(outside); await mkdir(join(root, 'child'));
    await symlink(join(root, 'child'), join(root, 'alias'));
    await symlink(outside, join(root, 'escape'));
    await writeFile(join(root, 'file'), 'x');
    const child = await realpath(join(root, 'child'));
    assert.deepEqual(await resolveDevelopmentRoots([root], [join(root, 'alias'), join(root, 'child'), join(root, 'escape'), join(root, 'missing'), join(root, 'file'), 'relative', outside, join(root, 'alias')]), [child, child, null, null, null, null, null, child]);
    assert.deepEqual(await resolveDevelopmentRoots([join(base, 'missing')], [root]), [null]);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('mount proof rejects bind aliases and missing or malformed mountinfo', async () => {
  const proc = await mkdtemp(join(tmpdir(), 'mountinfo-'));
  try {
    await mkdir(join(proc, 'self'));
    const info = join(proc, 'self/mountinfo');
    assert.equal(unaliasedMountPath('/workspace/project', proc), false);
    assert.equal(unaliasedMountPath('/workspace', proc), false);
    await writeFile(info, 'bad data\n');
    assert.equal(unaliasedMountPath('/workspace/project', proc), false);
    await writeFile(info, '1 0 8:1 / / rw - ext4 /dev/a rw\n2 1 8:1 /workspace/project /alias rw - ext4 /dev/a rw\n');
    assert.equal(unaliasedMountPath('/workspace/project', proc), false);
    assert.equal(unaliasedMountPath('/alias', proc), false);
    assert.equal(unaliasedMountPath('/workspace/other', proc), true);
  } finally { await rm(proc, { recursive: true, force: true }); }
});
