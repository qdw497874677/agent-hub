import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createProjectGitFetcher } from './project-git-fetch.ts';
import type { ProjectGitFetchOptions, ProjectGitFetchOutcome, ProjectGitFetchResult } from './project-git-fetch.ts';

const REPO_URL = 'https://git.example.com/org/repo.git';
const AUTHORIZATION = 'Basic ' + Buffer.from('x-access-token:fixture-token').toString('base64');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0'
    }
  }).trim();
}

interface CgiResult {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

/** 最小的 `git http-backend` CGI 适配器：只用于测试，不写任何真实上游。 */
function runCgi(input: {
  root: string;
  method: string;
  pathInfo: string;
  query: string;
  contentType: string;
  body: Buffer;
}): Promise<CgiResult> {
  return new Promise<CgiResult>((resolve, reject) => {
    const child = spawn('git', ['http-backend'], {
      env: {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        GIT_PROJECT_ROOT: input.root,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: input.pathInfo,
        QUERY_STRING: input.query,
        REQUEST_METHOD: input.method,
        CONTENT_TYPE: input.contentType,
        CONTENT_LENGTH: String(input.body.length),
        GATEWAY_INTERFACE: 'CGI/1.1',
        SERVER_PROTOCOL: 'HTTP/1.1'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.once('error', reject);
    child.once('exit', (code) => {
      const stdout = Buffer.concat(out);
      const boundary = stdout.indexOf('\r\n\r\n');
      if (code !== 0 || boundary === -1) {
        reject(new Error(`git http-backend failed (${code}): ${Buffer.concat(err).toString('utf8')}`));
        return;
      }
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of stdout.subarray(0, boundary).toString('utf8').split('\r\n')) {
        const index = line.indexOf(':');
        if (index <= 0) continue;
        const name = line.slice(0, index).trim().toLowerCase();
        const value = line.slice(index + 1).trim();
        if (name === 'status') status = Number(value.split(' ')[0]);
        else headers[name] = value;
      }
      resolve({ status, headers, body: stdout.subarray(boundary + 4) });
    });
    child.stdin.end(input.body);
  });
}

interface UpstreamCall {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
}

interface UpstreamFixture {
  readonly base: string;
  readonly serveRoot: string;
  readonly mainTip: string;
  readonly devTip: string;
  readonly calls: UpstreamCall[];
  readonly fetchImpl: typeof fetch;
}

async function createUpstreamFixture(base: string): Promise<UpstreamFixture> {
  const serveRoot = join(base, 'serve');
  const repoPath = join(serveRoot, 'org', 'repo.git');
  const work = join(base, 'work');
  await mkdir(join(serveRoot, 'org'), { recursive: true });
  await mkdir(work);
  git(work, 'init', '--quiet', '--initial-branch=main');
  await writeFile(join(work, 'a.txt'), 'one\n');
  git(work, 'add', '.');
  git(work, 'commit', '--quiet', '-m', 'one');
  git(base, 'init', '--bare', '--quiet', '--initial-branch=main', repoPath);
  git(work, 'remote', 'add', 'origin', repoPath);
  git(work, 'push', '--quiet', 'origin', 'main');

  git(work, 'checkout', '--quiet', '-b', 'dev');
  await writeFile(join(work, 'dev.txt'), 'dev\n');
  git(work, 'add', '.');
  git(work, 'commit', '--quiet', '-m', 'dev only');
  git(work, 'push', '--quiet', 'origin', 'dev');

  git(work, 'checkout', '--quiet', 'main');
  await writeFile(join(work, 'a.txt'), 'two\n');
  git(work, 'commit', '--quiet', '-am', 'two');
  git(work, 'push', '--quiet', 'origin', 'main');
  git(work, 'tag', 'v1');
  git(work, 'push', '--quiet', 'origin', 'v1');

  const calls: UpstreamCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input instanceof URL ? input.href : input);
    assert.equal(url.origin, 'https://git.example.com');
    const headers = new Headers(init?.headers);
    calls.push({
      url: url.href,
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization')
    });
    const body =
      init?.body === undefined || init.body === null
        ? Buffer.alloc(0)
        : Buffer.isBuffer(init.body)
          ? init.body
          : Buffer.from(init.body as Uint8Array);
    const cgi = await runCgi({
      root: serveRoot,
      method: init?.method ?? 'GET',
      pathInfo: url.pathname,
      query: url.search.replace(/^\?/u, ''),
      contentType: headers.get('content-type') ?? '',
      body
    });
    const responseHeaders: Record<string, string> = {};
    for (const name of ['content-type', 'content-encoding', 'content-length']) {
      const value = cgi.headers[name];
      if (value !== undefined) responseHeaders[name] = value;
    }
    return new Response(cgi.body, { status: cgi.status, headers: responseHeaders });
  };

  return {
    base,
    serveRoot,
    mainTip: git(repoPath, 'rev-parse', 'refs/heads/main'),
    devTip: git(repoPath, 'rev-parse', 'refs/heads/dev'),
    calls,
    fetchImpl
  };
}

function fetcherOptions(base: string, fixture: UpstreamFixture, extra: Partial<ProjectGitFetchOptions> = {}): ProjectGitFetchOptions {
  return {
    allowedOrigins: ['https://git.example.com'],
    outputDir: join(base, 'out'),
    scratchRoot: join(base, 'scratch'),
    fetchImpl: fixture.fetchImpl,
    timeoutMs: 20_000,
    ...extra
  };
}

function expectOk(outcome: ProjectGitFetchOutcome): ProjectGitFetchResult {
  if (!outcome.ok) assert.fail(`expected success, got ${outcome.code}: ${outcome.message}`);
  return outcome.result;
}

function expectFailure(outcome: ProjectGitFetchOutcome, code: string): void {
  if (outcome.ok) assert.fail(`expected failure ${code}, got success`);
  assert.equal(outcome.code, code);
}

function localRequest(input: {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer;
}): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: input.port,
        path: input.path,
        method: input.method ?? 'GET',
        headers: input.headers
      },
      (res) => {
        res.resume();
        res.once('end', () => resolve(res.statusCode ?? 0));
      }
    );
    req.once('error', reject);
    req.end(input.body);
  });
}

let base: string;
let fixture: UpstreamFixture;

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'agent-hub-git-fetch-test-'));
  fixture = await createUpstreamFixture(base);
});

after(async () => {
  await rm(base, { recursive: true, force: true });
});

test('fetches only the exact branch with full history and produces a verified bundle', async () => {
  fixture.calls.length = 0;
  const fetcher = createProjectGitFetcher(fetcherOptions(base, fixture));
  try {
    const result = expectOk(
      await fetcher.fetch({ repoUrl: REPO_URL, branch: 'main', authorization: AUTHORIZATION })
    );
    assert.equal(result.branch, 'main');
    assert.equal(result.ref, 'refs/heads/main');
    assert.equal(result.tip, fixture.mainTip);
    assert.match(result.bundlePath, /\/git-fetch-[0-9a-f]{24}\.bundle$/u);
    assert.equal(result.bundlePath.startsWith(join(base, 'out') + '/'), true);

    const bytes = await readFile(result.bundlePath);
    assert.equal(result.bundleBytes, bytes.length);
    assert.equal(result.bundleSha256, createHash('sha256').update(bytes).digest('hex'));

    const heads = git(base, 'bundle', 'list-heads', result.bundlePath)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    assert.deepEqual(heads, [`${fixture.mainTip} refs/heads/main`]);

    const clone = join(base, 'import');
    await mkdir(clone);
    git(clone, 'init', '--quiet');
    git(clone, 'bundle', 'verify', result.bundlePath);
    git(clone, 'fetch', '--quiet', result.bundlePath, 'refs/heads/main:refs/heads/imported');
    assert.equal(git(clone, 'rev-parse', 'refs/heads/imported'), fixture.mainTip);
    // 完整历史：main 上两个提交都在，不能是 depth=1。
    assert.equal(git(clone, 'rev-list', '--count', 'refs/heads/imported'), '2');
    assert.throws(() => git(clone, 'cat-file', '-e', fixture.devTip));
    assert.equal(git(clone, 'tag', '--list'), '');

    assert.equal(fixture.calls.length, 2);
    assert.deepEqual(
      fixture.calls.map((call) => [call.method, call.url, call.authorization]),
      [
        ['GET', `${REPO_URL}/info/refs?service=git-upload-pack`, AUTHORIZATION],
        ['POST', `${REPO_URL}/git-upload-pack`, AUTHORIZATION]
      ]
    );
  } finally {
    await fetcher.close();
  }
});

test('accepts refs/heads/ form and never exposes the remote or credentials to Git', async () => {
  const spawns: Array<{ args: readonly string[]; env: Readonly<Record<string, string>> }> = [];
  const fetcher = createProjectGitFetcher(
    fetcherOptions(base, fixture, {
      testOnlyOnGitSpawn: (info) => spawns.push(info)
    })
  );
  try {
    const result = expectOk(
      await fetcher.fetch({ repoUrl: REPO_URL, branch: 'refs/heads/main', authorization: AUTHORIZATION })
    );
    assert.equal(result.branch, 'main');
    assert.equal(result.tip, fixture.mainTip);
  } finally {
    await fetcher.close();
  }

  const token = AUTHORIZATION.slice('Basic '.length);
  for (const spawn of spawns) {
    const argv = spawn.args.join(' ');
    assert.equal(argv.includes('git.example.com'), false);
    assert.equal(argv.includes(token), false);
    assert.equal(argv.includes('fixture-token'), false);
    assert.equal(spawn.env['HTTP_PROXY'], '');
    assert.equal(spawn.env['HTTPS_PROXY'], '');
    assert.equal(spawn.env['ALL_PROXY'], '');
    assert.equal(spawn.env['NO_PROXY'], '*');
    assert.equal(spawn.env['GIT_TERMINAL_PROMPT'], '0');
    assert.equal(spawn.env['GIT_ASKPASS'], '/bin/false');
    assert.equal(spawn.env['SSH_ASKPASS'], '/bin/false');
    assert.equal(spawn.env['GIT_CONFIG_NOSYSTEM'], '1');
    assert.equal(spawn.env['GIT_CONFIG_PARAMETERS'], undefined);
    assert.equal(spawn.env['SSH_AUTH_SOCK'], undefined);
    assert.equal(spawn.env['GIT_SSH_COMMAND'], undefined);
    assert.equal(spawn.env['GIT_DIR'], undefined);
    assert.equal(spawn.env['HOME']?.startsWith(join(base, 'scratch')), true);
    assert.equal(spawn.env['GIT_CONFIG_GLOBAL']?.startsWith(join(base, 'scratch')), true);
    assert.equal(spawn.env['GIT_CONFIG_SYSTEM'], spawn.env['GIT_CONFIG_GLOBAL']);
  }

  const fetchSpawn = spawns.find((spawn) => spawn.args.includes('fetch'));
  assert.ok(fetchSpawn);
  assert.equal(fetchSpawn.args.includes('--depth'), false);
  assert.equal(fetchSpawn.args.includes('--tags'), false);
  assert.equal(fetchSpawn.args.includes('--recurse-submodules'), false);
  assert.equal(fetchSpawn.args.includes('--no-tags'), true);
  assert.equal(fetchSpawn.args.includes('--no-recurse-submodules'), true);
  assert.equal(fetchSpawn.args.includes('+refs/heads/main:refs/heads/main'), true);
  const fetchArgv = fetchSpawn.args.join(' ');
  assert.match(fetchArgv, /http:\/\/127\.0\.0\.1:\d+\/r\/[^/]+\/repo\.git /u);
  assert.equal(fetchArgv.endsWith('+refs/heads/main:refs/heads/main'), true);
  assert.equal(fetchSpawn.env['GIT_ALLOW_PROTOCOL'], 'http');

  // 第二个空 bare 仓库：只对这一次 bundle 导入放开 file 协议。
  const importSpawn = spawns.find(
    (spawn) => spawn.args.includes('fetch') && spawn.args.some((arg) => arg.endsWith('/out.bundle'))
  );
  assert.ok(importSpawn);
  assert.equal(importSpawn.args.includes('fetch'), true);
  assert.equal(importSpawn.args.includes('+refs/heads/main:refs/heads/main'), true);
  assert.equal(importSpawn.args.includes('--no-tags'), true);
  assert.equal(importSpawn.args.includes('--no-recurse-submodules'), true);
  assert.equal(importSpawn.args.includes('protocol.file.allow=always'), true);
  assert.equal(importSpawn.args.some((arg) => arg.endsWith('/verify.git')), true);
  assert.equal(importSpawn.env['GIT_ALLOW_PROTOCOL'], 'file');

  const fsckSpawn = spawns.find((spawn) => spawn.args.includes('fsck'));
  assert.ok(fsckSpawn);
  assert.equal(fsckSpawn.args.includes('--connectivity-only'), true);
  assert.equal(fsckSpawn.args.includes('--no-dangling'), true);
  assert.equal(fsckSpawn.args.some((arg) => arg.endsWith('/verify.git')), true);
  assert.equal(fsckSpawn.env['GIT_ALLOW_PROTOCOL'], 'http');
});

test('bridge exposes only the exact advertisement and upload-pack routes', async () => {
  let upstreamCalls = 0;
  const statuses: number[] = [];
  const fetcher = createProjectGitFetcher({
    allowedOrigins: ['https://git.example.com'],
    outputDir: join(base, 'bridge-out'),
    scratchRoot: join(base, 'bridge-scratch'),
    timeoutMs: 5_000,
    fetchImpl: async () => {
      upstreamCalls += 1;
      throw new Error('upstream must not be reached by rejected bridge requests');
    },
    testOnlyOnBridgeReady: async (url) => {
      const parsed = new URL(url);
      const token = parsed.pathname.split('/')[2] ?? '';
      const port = Number(parsed.port);
      const route = `/r/${token}/repo.git`;
      statuses.push(
        await localRequest({ port, path: `${route}/info/refs?service=git-receive-pack` }),
        await localRequest({ port, path: `${route}/HEAD` }),
        await localRequest({ port, path: `/r/not-this-token/repo.git/info/refs?service=git-upload-pack` }),
        await localRequest({ port, path: `${route}/git-upload-pack`, method: 'GET' }),
        await localRequest({ port, path: `${route}/info/refs?service=git-upload-pack`, headers: { host: 'example.com' } })
      );
      throw new Error('stop after bridge assertions');
    }
  });
  try {
    const outcome = await fetcher.fetch({ repoUrl: REPO_URL, branch: 'main', authorization: AUTHORIZATION });
    expectFailure(outcome, 'generic');
  } finally {
    await fetcher.close();
  }
  assert.deepEqual(statuses, [404, 404, 404, 404, 421]);
  assert.equal(upstreamCalls, 0);
});

test('enforces aggregate upstream and upload-pack request byte caps', async () => {
  let upstreamCalls = 0;
  const tooLargeFetcher = createProjectGitFetcher({
    allowedOrigins: ['https://git.example.com'],
    outputDir: join(base, 'cap-out'),
    scratchRoot: join(base, 'cap-scratch'),
    timeoutMs: 5_000,
    maxUpstreamBytes: 1_024,
    fetchImpl: async () => {
      upstreamCalls += 1;
      return new Response('tiny', {
        status: 200,
        headers: {
          'content-type': 'application/x-git-upload-pack-advertisement',
          'content-length': '999999'
        }
      });
    }
  });
  try {
    const outcome = await tooLargeFetcher.fetch({ repoUrl: REPO_URL, branch: 'main', authorization: AUTHORIZATION });
    expectFailure(outcome, 'too_large');
  } finally {
    await tooLargeFetcher.close();
  }
  assert.equal(upstreamCalls, 1);

  let postUpstreamCalls = 0;
  const statuses: number[] = [];
  const postCapFetcher = createProjectGitFetcher({
    allowedOrigins: ['https://git.example.com'],
    outputDir: join(base, 'post-cap-out'),
    scratchRoot: join(base, 'post-cap-scratch'),
    timeoutMs: 5_000,
    maxUploadPackRequestBytes: 32,
    fetchImpl: async () => {
      postUpstreamCalls += 1;
      throw new Error('oversized POST must not reach upstream');
    },
    testOnlyOnBridgeReady: async (url) => {
      const parsed = new URL(url);
      const token = parsed.pathname.split('/')[2] ?? '';
      const port = Number(parsed.port);
      statuses.push(
        await localRequest({
          port,
          path: `/r/${token}/repo.git/git-upload-pack`,
          method: 'POST',
          headers: {
            'content-type': 'application/x-git-upload-pack-request',
            'content-length': '64'
          },
          body: Buffer.alloc(64, 0x61)
        }),
        await localRequest({
          port,
          path: `/r/${token}/repo.git/git-upload-pack`,
          method: 'POST',
          headers: { 'content-length': '0' },
          body: Buffer.alloc(0)
        })
      );
      throw new Error('stop after bridge assertions');
    }
  });
  try {
    const outcome = await postCapFetcher.fetch({ repoUrl: REPO_URL, branch: 'main', authorization: AUTHORIZATION });
    expectFailure(outcome, 'too_large');
  } finally {
    await postCapFetcher.close();
  }
  assert.deepEqual(statuses, [413, 415]);
  assert.equal(postUpstreamCalls, 0);
});

test('a deadline during second-repo verification leaves no output bundle and never reports success', async () => {
  const slowGit = join(base, 'slow-git');
  await writeFile(
    slowGit,
    '#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = "fsck" ]; then sleep 5; fi\ndone\nexec git "$@"\n',
    { mode: 0o755 }
  );
  const spawns: Array<{ args: readonly string[]; env: Readonly<Record<string, string>> }> = [];
  const outputDir = join(base, 'timeout-verify-out');
  const fetcher = createProjectGitFetcher(
    fetcherOptions(base, fixture, {
      gitCommand: slowGit,
      timeoutMs: 1_500,
      outputDir,
      testOnlyOnGitSpawn: (info) => spawns.push(info)
    })
  );
  try {
    const started = Date.now();
    const outcome = await fetcher.fetch({ repoUrl: REPO_URL, branch: 'main', authorization: AUTHORIZATION });
    expectFailure(outcome, 'timeout');
    assert.ok(Date.now() - started < 5_000);
  } finally {
    await fetcher.close();
  }
  assert.equal(spawns.some((spawn) => spawn.args.includes('fsck')), true);
  const files = await readdir(outputDir).catch(() => [] as string[]);
  assert.equal(files.some((name) => name.endsWith('.bundle')), false);
});

test('times out a hanging upstream and rejects a concurrent second operation', async () => {
  const hangingFetch: typeof fetch = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        'abort',
        () => reject(new DOMException('aborted', 'AbortError')),
        { once: true }
      );
    });
  const fetcher = createProjectGitFetcher({
    allowedOrigins: ['https://git.example.com'],
    outputDir: join(base, 'timeout-out'),
    scratchRoot: join(base, 'timeout-scratch'),
    timeoutMs: 400,
    fetchImpl: hangingFetch
  });
  try {
    const first = fetcher.fetch({ repoUrl: REPO_URL, branch: 'main', authorization: AUTHORIZATION });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await fetcher.fetch({ repoUrl: REPO_URL, branch: 'main', authorization: AUTHORIZATION });
    expectFailure(second, 'busy');
    const started = Date.now();
    expectFailure(await first, 'timeout');
    assert.ok(Date.now() - started < 5_000);
  } finally {
    await fetcher.close();
  }
});

test('rejects invalid targets, branches and authorization without any upstream call', async () => {
  let calls = 0;
  const fetcher = createProjectGitFetcher(
    fetcherOptions(base, fixture, {
      fetchImpl: async () => {
        calls += 1;
        throw new Error('validation failures must not reach the network');
      }
    })
  );
  try {
    const targets: Array<[string, string]> = [
      ['http://git.example.com/org/repo.git', 'bad_target'],
      ['https://git.example.com/org/repo.git?x=1', 'bad_target'],
      ['https://git.example.com/org/repo.git#main', 'bad_target'],
      ['https://user:pass@git.example.com/org/repo.git', 'bad_target'],
      ['https://git.example.com/org\\repo.git', 'bad_target'],
      ['https://git.example.com/org/%2e%2e/repo.git', 'bad_target'],
      ['https://evil.example.com/org/repo.git', 'blocked']
    ];
    for (const [repoUrl, code] of targets) {
      expectFailure(await fetcher.fetch({ repoUrl, branch: 'main', authorization: '' }), code);
    }

    const branches = [
      '-main',
      '--upload-pack=evil',
      'refs/tags/v1',
      'refs/remotes/origin/main',
      'main..dev',
      'main lock',
      'main~1',
      'main.lock',
      'main.',
      'a//b',
      '@{-1}',
      'refs/heads/'
    ];
    for (const branch of branches) {
      expectFailure(await fetcher.fetch({ repoUrl: REPO_URL, branch, authorization: '' }), 'bad_branch');
    }

    const authorizations = [
      'Bearer token',
      'Basic',
      'Basic ',
      `Basic ${'a'.repeat(9_000)}`,
      'Basic dXNlcjpwYXNz\nInjected: yes'
    ];
    for (const authorization of authorizations) {
      expectFailure(await fetcher.fetch({ repoUrl: REPO_URL, branch: 'main', authorization }), 'bad_authorization');
    }
  } finally {
    await fetcher.close();
  }
  assert.equal(calls, 0);
});

test('fails without a bundle when the declared branch does not exist upstream', async () => {
  fixture.calls.length = 0;
  const fetcher = createProjectGitFetcher(fetcherOptions(base, fixture));
  try {
    const outcome = await fetcher.fetch({ repoUrl: REPO_URL, branch: 'missing', authorization: AUTHORIZATION });
    expectFailure(outcome, 'git_failed');
    if (!outcome.ok) assert.equal(outcome.message, '仓库抓取失败');
    // 广告里没有该分支时 Git 可能在 POST 前就放弃；只要求没有越界请求。
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.calls[0]?.method, 'GET');
  } finally {
    await fetcher.close();
  }
});
