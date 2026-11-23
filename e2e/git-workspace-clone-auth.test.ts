import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createGitWorkspace } from '@agent-hub/node-gateway';
import { startDirectGitOrigin } from './workspace-delegation-origin.ts';

/**
 * 真 git clone 的回归：`createGitWorkspace().clone` 带逐次 HTTPS 令牌时，
 * 锁定版 simple-git 4.0.2 会拒绝代码内部构造的 `GIT_CONFIG_COUNT`（环境守卫），
 * clone 在真正联网前就失败。这里用本机直连的 HTTPS smart-HTTP origin 证明：
 * - clone 成功并检出已知提交；
 * - 令牌只以 `http.<预期地址>.extraHeader` 到达预期 origin。
 *
 * 令牌是合成的，仅存在于本次进程环境变量与断言里；TLS 校验保持开启（现场生成的自签 CA
 * 只写进本次测试的隔离 HOME，不碰系统 / 全局信任库），也不发外部请求。
 */

const SYNTHETIC_HEADER = `Authorization: Basic ${Buffer.from('x-access-token:synthetic-regression-token').toString('base64')}`;
const WIRE_AUTH = SYNTHETIC_HEADER.slice('Authorization: '.length);

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
  });

test('clone：内部构造的 GIT_CONFIG_COUNT 不被 simple-git 守卫拒绝，令牌到达预期 HTTPS origin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ws-clone-auth-'));
  const previousHome = process.env.HOME;
  try {
    // 真实远端内容：一份有提交的 bare 仓库。
    const seed = join(root, 'seed');
    await mkdir(seed);
    git(seed, 'init', '-q', '-b', 'main');
    await writeFile(join(seed, 'README.md'), 'clone-auth\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-qm', 'init');
    const head = git(seed, 'rev-parse', 'HEAD').trim();
    const bare = join(root, 'origin', 'demo.git');
    await mkdir(join(root, 'origin'));
    git(root, 'clone', '-q', '--bare', seed, bare);

    const origin = await startDirectGitOrigin({ bare, workDir: join(root, 'tls'), requiredAuthorization: WIRE_AUTH });
    try {
      // 隔离 HOME：只让本次测试的 git 信任这张现场生成的 CA；repo URL 是唯一目标。
      const home = join(root, 'home');
      await mkdir(home);
      await writeFile(
        join(home, '.gitconfig'),
        [`[http "${origin.url}"]`, `\tsslCAInfo = ${origin.caFile}`, ''].join('\n')
      );
      process.env.HOME = home;

      const workspace = createGitWorkspace(async () => null);
      const auth = { header: SYNTHETIC_HEADER, url: origin.url };
      const valid = await workspace.checkRepo(origin.url, 'main', auth);
      assert.deepEqual(valid, { ok: true, value: { reachable: true, defaultBranch: 'main', branchExists: true, message: null } });
      const missing = await workspace.checkRepo(origin.url, 'not-a-branch', auth);
      assert.deepEqual(missing, { ok: true, value: { reachable: true, defaultBranch: 'main', branchExists: false, message: null } });
      const wrong = await workspace.checkRepo(origin.url, 'main', { ...auth, header: 'Authorization: Basic c3ludGhldGljLXdyb25n' });
      assert.ok(wrong.ok && !wrong.value.reachable);
      const unauthenticated = await workspace.checkRepo(origin.url, 'main');
      assert.ok(unauthenticated.ok && !unauthenticated.value.reachable);
      assert.ok(origin.requests.length > 0);
      assert.ok(origin.requests.every((line) =>
        line === 'GET /demo.git/info/refs?service=git-upload-pack' || line === 'POST /demo.git/git-upload-pack'
      ), JSON.stringify(origin.requests));
      assert.equal(git(bare, 'rev-parse', 'refs/heads/main').trim(), head);
      origin.requests.length = 0;
      origin.authorization.length = 0;

      const cloned = await workspace.clone({
        repoUrl: origin.url,
        parent: join(root, 'dest'),
        name: 'demo',
        auth
      });
      assert.ok(cloned.ok, cloned.ok ? '' : cloned.error.message);

      // 检出的是远端 HEAD，内容完整。
      assert.equal(git(cloned.value.path, 'rev-parse', 'HEAD').trim(), head);
      assert.equal(git(cloned.value.path, 'branch', '--show-current').trim(), 'main');
      assert.equal((await readFile(join(cloned.value.path, 'README.md'), 'utf8')).trim(), 'clone-auth');

      // 已知令牌确实到达预期 origin：至少一次 upload-pack 请求带同一个头，且没有别的头。
      const authorized = origin.authorization.filter((value) => value !== '');
      assert.ok(authorized.length > 0, `origin 没收到 Authorization 头，请求：${origin.requests.join(', ')}`);
      // Node 的 request.headers.authorization 只是头的值（不含 "Authorization:"）。
      assert.deepEqual(new Set(authorized), new Set([WIRE_AUTH]));
      assert.ok(
        origin.requests.some((line) => line === 'GET /demo.git/info/refs?service=git-upload-pack'),
        `没看到预期的 upload-pack 请求：${origin.requests.join(', ')}`
      );

      const redirect = await startDirectGitOrigin({ bare, workDir: join(root, 'redirect-tls'), redirect: true });
      try {
        await writeFile(join(home, '.gitconfig'), `[http "${redirect.url}"]\n\tsslCAInfo = ${redirect.caFile}\n`);
        const redirected = await workspace.clone({
          repoUrl: redirect.url, parent: join(root, 'dest'), name: 'redirected',
          auth: { header: SYNTHETIC_HEADER, url: redirect.url }
        });
        assert.equal(redirected.ok, false);
        assert.deepEqual(redirect.requests, ['GET /demo.git/info/refs?service=git-upload-pack']);
      } finally {
        await redirect.close();
      }
    } finally {
      await origin.close();
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});
