import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Agent } from 'undici';
import { createProjectGitHttpsProbe } from '../apps/server/src/project-git-https-probe.ts';
import { startDirectGitOrigin } from './workspace-delegation-origin.ts';

const authorization = `Basic ${Buffer.from('x-access-token:fixture-only').toString('base64')}`;

test('隔离仓库探测：在真实 TLS 的 Git 广告里读取精确分支，不运行其他 Git 操作', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'project-git-probe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Probe Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Probe Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }
  }).trim();
  const seed = join(root, 'seed');
  await mkdir(seed);
  git(seed, 'init', '-q', '-b', 'main');
  await writeFile(join(seed, 'README.md'), 'fixture\n');
  git(seed, 'add', 'README.md');
  git(seed, 'commit', '-qm', 'fixture');
  git(seed, 'branch', 'team/other');
  const bare = join(root, 'example.git');
  git(root, 'clone', '-q', '--bare', seed, bare);
  const before = git(bare, 'show-ref');
  const origin = await startDirectGitOrigin({ bare, workDir: join(root, 'tls'), requiredAuthorization: authorization });
  const dispatcher = new Agent({ connect: { ca: await readFile(origin.caFile, 'utf8') } });
  const fetchWithFixtureCa: typeof fetch = (input, init) => fetch(input, { ...init, dispatcher } as RequestInit & { dispatcher: Agent });
  const probe = createProjectGitHttpsProbe({
    allowedOrigins: [new URL(origin.url).origin],
    testOnlyAllowLoopback: true,
    fetchImpl: fetchWithFixtureCa
  });
  try {
    assert.deepEqual(await probe.check({ url: origin.url, branch: 'team/other', authorization }), {
      reachable: true, defaultBranch: 'main', branchExists: true, message: null
    });
    const missing = await probe.check({ url: origin.url, branch: 'other', authorization });
    assert.equal(missing.reachable, true);
    assert.equal(missing.branchExists, false);
    assert.equal(git(bare, 'show-ref'), before);
    assert.deepEqual(origin.requests, Array(2).fill('GET /example.git/info/refs?service=git-upload-pack'));
    assert.deepEqual(origin.authorization, Array(2).fill(authorization));
  } finally {
    await Promise.all([probe.close(), dispatcher.close()]);
    await origin.close();
  }
});
