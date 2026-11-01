import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inMemoryAdmin, inMemoryDeps, inMemoryEnrollment } from '@agent-hub/domain/testing';
import { createApp } from './http.ts';
import { createStreamHub } from './stream-hub.ts';
import { BUNDLE_REF, createInstallArtifacts } from './install-artifacts.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'ahub-art-'));
  git(dir, 'init', '-q');
  writeFileSync(join(dir, 'package.json'), '{"version":"1.2.3"}\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'one');
  writeFileSync(join(dir, '.env'), 'SECRET=nope\n'); // 没跟踪的文件不能进包
  return { dir, commit: git(dir, 'rev-parse', 'HEAD') };
}

function app(dir: string, commit: string) {
  const admin = inMemoryAdmin();
  const enrollment = inMemoryEnrollment(admin);
  const { deps } = inMemoryDeps();
  const bootstrapScript = fileURLToPath(new URL('../../../scripts/bootstrap-worker.sh', import.meta.url));
  const artifacts = createInstallArtifacts({ repoDir: dir, commit, cacheDir: join(dir, '..', `cache-${commit.slice(0, 8)}`) });
  const built = createApp({
    deps, hub: createStreamHub(), token: null,
    auth: { accounts: admin.accounts, hubToken: null },
    admin: { deps: admin.deps, enrollment: enrollment.deps },
    enrollment: { deps: enrollment.deps, bootstrapScript, commit, artifacts }
  });
  return (path: string) => built.fetch(new Request(`http://hub:7878${path}`));
}

test('安装包：tar.gz 只有跟踪的文件，sha256 对得上；不登录也能下', async () => {
  const { dir, commit } = repo();
  const get = app(dir, commit);
  const response = await get(`/install/worker-${commit}.tar.gz`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-agent-hub-commit'), commit);
  const body = Buffer.from(await response.arrayBuffer());
  const sum = (await (await get(`/install/worker-${commit}.tar.gz.sha256`)).text()).split(' ')[0];
  assert.equal(createHash('sha256').update(body).digest('hex'), sum);
  const out = mkdtempSync(join(tmpdir(), 'ahub-art-x-'));
  writeFileSync(join(out, 'w.tgz'), body);
  const listing = execFileSync('tar', ['-tzf', join(out, 'w.tgz')], { encoding: 'utf8' });
  assert.match(listing, /package\.json/);
  assert.doesNotMatch(listing, /\.env|\.git\//);
  // 不带提交号的别名也是同一个包
  assert.equal((await (await get('/install/worker.tar.gz.sha256')).text()).split(' ')[0], sum);
});

test('安装包：bundle 能 fetch 出同一个提交，临时引用不留在仓库里', async () => {
  const { dir, commit } = repo();
  const get = app(dir, commit);
  const response = await get(`/install/worker-${commit}.bundle`);
  assert.equal(response.status, 200);
  const out = mkdtempSync(join(tmpdir(), 'ahub-art-b-'));
  writeFileSync(join(out, 'w.bundle'), Buffer.from(await response.arrayBuffer()));
  git(out, 'init', '-q', 'r');
  git(join(out, 'r'), 'fetch', '-q', join(out, 'w.bundle'), `${BUNDLE_REF}:${BUNDLE_REF}`);
  assert.equal(git(join(out, 'r'), 'rev-parse', BUNDLE_REF), commit);
  assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), '{"version":"1.2.3"}\n');
  assert.throws(() => git(dir, 'rev-parse', '--verify', '-q', BUNDLE_REF));
});

test('安装包：别的提交、乱写的名字都 404', async () => {
  const { dir, commit } = repo();
  const get = app(dir, commit);
  assert.equal((await get(`/install/worker-${'0'.repeat(40)}.tar.gz`)).status, 404);
  assert.equal((await get('/install/worker-../../etc.tar.gz')).status, 404);
  assert.equal((await get('/install/hub.db')).status, 404);
});
