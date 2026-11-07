import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBuildInfo } from './build-info.ts';

test('没有 git 时读 .agent-hub-commit，不把缺失说成一次提交', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hub-build-'));
  try {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ version: '0.0.0' }));
    assert.equal(readBuildInfo(dir).commit, null);
    const sha = 'c'.repeat(40);
    await writeFile(join(dir, '.agent-hub-commit'), `${sha}\n`);
    assert.equal(readBuildInfo(dir).commit, sha);
    assert.equal(readBuildInfo(dir).version, '0.0.0');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
