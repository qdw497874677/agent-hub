import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { asProjectId, asSessionId, ok } from '@agent-hub/domain';
import { openSqliteStore } from '@agent-hub/storage-sqlite';
import { Agent } from 'undici';
import { createProjectGitFetcher } from '../apps/server/src/project-git-fetch.ts';
import { fetchProjectGitForSession } from '../apps/server/src/project-git-session-fetch.ts';
import { createProjectGitBundleImporter, projectGitBundleRef } from '../packages/node-gateway/src/project-git-bundle-import.ts';
import { createServerGateway } from '../packages/node-gateway/src/server-gateway.ts';
import { connectWorkerLink } from '../packages/node-gateway/src/worker-link.ts';
import { startDirectGitOrigin } from './workspace-delegation-origin.ts';

async function startBundleLink(t: import('node:test').TestContext, importer: ReturnType<typeof createProjectGitBundleImporter>) {
  let markOnline!: () => void;
  const online = new Promise<void>((resolve) => { markOnline = resolve; });
  const gateway = createServerGateway({
    token: 'fixture-link-token',
    onHello: () => markOnline(),
    onEvent: () => {}, onAgentSession: () => {}, onOptions: () => {}, onStatus: () => {}, onWorkerGone: () => {}
  }, { projectGitBundleTimeoutMs: 10_000 });
  const server = createServer();
  server.on('upgrade', (request, socket, head) => gateway.handleUpgrade(request, socket, head));
  let link: ReturnType<typeof connectWorkerLink> | undefined;
  t.after(async () => {
    await link?.close();
    gateway.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const workerId = 'git-bundle-fixture';
  link = connectWorkerLink({
    url: `ws://127.0.0.1:${address.port}`, token: 'fixture-link-token', workerId, label: workerId,
    origin: 'remote', runtimes: [], reconnect: false, gitBundleImport: importer
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([online, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('等待 bundle Worker 握手超时')), 5_000);
    })]);
  } finally {
    clearTimeout(timeout);
  }
  return { gateway, workerId };
}

test('隔离 Git：从真实 HTTPS 抓取完整分支，经 Worker RPC 只增加候选 ref', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'project-git-fetch-import-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Fetch Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fetch Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid'
    }
  }).trim();

  const source = join(root, 'source');
  const target = join(root, 'target');
  await Promise.all([mkdir(source), mkdir(target)]);
  git(source, 'init', '-q', '-b', 'main');
  await writeFile(join(source, 'README.md'), 'first\n');
  git(source, 'add', 'README.md');
  git(source, 'commit', '-qm', 'first');
  const first = git(source, 'rev-parse', 'HEAD');
  git(source, 'switch', '-qc', 'team/candidate');
  await writeFile(join(source, 'README.md'), 'second\n');
  git(source, 'commit', '-qam', 'second');
  const tip = git(source, 'rev-parse', 'HEAD');
  const bare = join(root, 'fixture.git');
  git(root, 'clone', '-q', '--bare', source, bare);
  const remoteRefs = git(bare, 'show-ref');

  const authorization = `Basic ${Buffer.from('fixture-user:fixture-only').toString('base64')}`;
  const origin = await startDirectGitOrigin({ bare, workDir: join(root, 'tls'), requiredAuthorization: authorization });
  const dispatcher = new Agent({ connect: { ca: await readFile(origin.caFile, 'utf8') } });
  const fetchWithFixtureCa: typeof fetch = (input, init) => fetch(input, { ...init, dispatcher } as RequestInit & { dispatcher: Agent });
  const fetcher = createProjectGitFetcher({
    allowedOrigins: [new URL(origin.url).origin],
    outputDir: join(root, 'bundles'),
    scratchRoot: root,
    maxBundleBytes: 8 * 1024 * 1024,
    testOnlyAllowLoopback: true,
    fetchImpl: fetchWithFixtureCa
  });
  try {
    git(target, 'init', '-q', '-b', 'local');
    git(target, 'remote', 'add', 'origin', origin.url);
    await writeFile(join(target, 'local.txt'), 'original\n');
    git(target, 'add', 'local.txt');
    git(target, 'commit', '-qm', 'local');
    await writeFile(join(target, 'local.txt'), 'local changes\n');
    await writeFile(join(target, 'notes.txt'), 'untracked\n');
    const base = git(target, 'rev-parse', 'HEAD');
    const before = git(target, 'status', '--porcelain=v1');
    const index = await readFile(join(target, '.git', 'index'));

    const ref = projectGitBundleRef('fixture-project', tip);
    assert.ok(ref);
    const importer = createProjectGitBundleImporter(async (path) => path === target ? null : '不在测试目录内', { maxBundleBytes: 8 * 1024 * 1024 });
    const { gateway, workerId } = await startBundleLink(t, importer);
    const store = openSqliteStore(':memory:');
    t.after(() => store.close());
    const binding = {
      accountId: 'fixture-owner', sessionId: asSessionId('fixture-session'), projectId: asProjectId('fixture-project'),
      repoId: 'fixture-repo', repoUrl: origin.url, workerId, workspaceId: 'fixture-workspace',
      workspacePath: target, branch: 'team/candidate'
    };
    const command = {
      actorId: binding.accountId, actorVia: 'web' as const, sessionId: binding.sessionId,
      requestKey: 'fetch-candidate', repoId: binding.repoId
    };
    let imports = 0;
    const deps: Parameters<typeof fetchProjectGitForSession>[0] = {
      policy: { enabled: true }, authorize: async () => ok(binding), credential: async () => authorization,
      fetcher, operationReceipts: store.operationReceipts,
      importer: (id, request) => {
        imports++;
        assert.deepEqual(Object.keys(request).sort(), ['bundleBase64', 'bundleSha256', 'expectedUrl', 'path', 'ref', 'tipSha']);
        assert.ok(!JSON.stringify(request).includes(authorization));
        return gateway.importProjectGitBundle(id, request);
      }
    };
    const result = await fetchProjectGitForSession(deps, command);
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.value.ref, ref);
    assert.equal(result.value.tip, tip);
    assert.equal(result.value.alreadyPresent, false);
    const upstreamRequests = origin.requests.length;
    assert.deepEqual(await fetchProjectGitForSession(deps, command), result);
    assert.equal(imports, 1, '同键重试只读回执，不再调用 Worker');
    assert.equal(origin.requests.length, upstreamRequests, '同键重试不再访问远端');
    assert.equal(git(target, 'rev-parse', ref), tip);
    assert.equal(git(target, 'rev-parse', `${ref}^`), first, '独立对象库能读取候选的完整历史');
    assert.equal(git(target, 'show', `${ref}:README.md`), 'second');
    assert.equal(git(target, 'rev-parse', 'HEAD'), base);
    assert.equal(git(target, 'branch', '--show-current'), 'local');
    assert.deepEqual(await readFile(join(target, '.git', 'index')), index);
    assert.equal(git(target, 'status', '--porcelain=v1'), before);
    assert.equal(git(target, 'for-each-ref', '--format=%(refname)', 'refs/remotes'), '');
    assert.equal(git(bare, 'show-ref'), remoteRefs);
    assert.ok(origin.requests.some((request) => request === 'POST /fixture.git/git-upload-pack'));
    assert.ok(origin.requests.every((request) => request === 'GET /fixture.git/info/refs?service=git-upload-pack' || request === 'POST /fixture.git/git-upload-pack'));
    assert.ok(origin.authorization.every((value) => value === authorization));
  } finally {
    await Promise.all([fetcher.close(), dispatcher.close()]);
    await origin.close();
  }
});
