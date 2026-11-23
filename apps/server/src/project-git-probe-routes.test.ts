import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import {
  asLoginId,
  asProjectId,
  asTeamId,
  asUserId,
  createAccessPolicy,
  createProject,
  type Principal,
  type Project,
  type RepoCheckProbe,
  type Role,
  type Subject,
  type TokenVia
} from '@agent-hub/domain';
import { inMemoryAccounts, inMemoryDeps } from '@agent-hub/domain/testing';
import type { SubjectOf } from './auth.ts';
import { authHeaderFor } from './repo-auth.ts';
import {
  installProjectGitProbeRoutes,
  isolatedRepoTokenKey,
  type ProjectGitProbe,
  type ProjectGitProbeRouteOptions
} from './project-git-probe-routes.ts';

const PROJECT_ID = 'p1';
const REPO_ONE = 'repo_aaaaaaaa';
const REPO_TWO = 'repo_bbbbbbbb';
const URL_ONE = 'https://git.test/one.git';
const URL_TWO = 'https://git.test/two.git';

function principal(role: Role = 'member', via?: TokenVia): Principal {
  return {
    user: {
      id: asUserId('u1'),
      email: 'u1@example.test',
      displayName: 'U1',
      role,
      passwordHash: null,
      emailVerifiedAt: 1,
      disabledAt: null,
      createdAt: 1,
      teamId: asTeamId('t1'),
      clusterAdmin: false,
      deletedAt: null
    },
    loginId: asLoginId('login-1'),
    ...(via ? { via } : {})
  };
}

const TOKEN_VIA: TokenVia = { tokenId: 'tok-1', name: 'cli', kind: 'personal', permissions: ['project.update'] };

interface Harness {
  readonly project: Project;
  readonly app: Hono;
  readonly probeCalls: { url: string; branch: string | null; authorization: string }[];
  readonly revealCalls: string[][];
  readonly putCalls: string[];
  readonly removeCalls: string[];
  readonly allowsCalls: { projectId: string; repoId: string; url: string }[];
  readonly secretsRows: Map<string, string>;
  setActor(actor: Subject | null): void;
  setAllows(value: boolean): void;
  saveProject(project: Project): Promise<void>;
  setProbeResult(result: RepoCheckProbe | Error): void;
}

async function harness(options: {
  actor?: Subject | null;
  allow?: boolean | ((projectId: string, repoId: string, url: string) => boolean);
  repos?: readonly { id: string; name: string; url: string; defaultBranch: string | null }[];
} = {}): Promise<Harness> {
  const world = inMemoryDeps();
  const accounts = inMemoryAccounts();
  const access = createAccessPolicy({
    users: accounts.users,
    settings: accounts.settings,
    enrollment: { credentialFor: async () => null },
    gateway: world.deps.gateway
  });

  const created = createProject({
    name: 'project',
    now: 1,
    id: asProjectId(PROJECT_ID),
    teamId: 't1',
    createdBy: 'u1',
    repos: options.repos ?? [
      { id: REPO_ONE, name: 'one', url: URL_ONE, defaultBranch: 'main' },
      { id: REPO_TWO, name: 'two', url: URL_TWO, defaultBranch: 'trunk' }
    ]
  });
  assert.ok(created.ok);
  await world.deps.projects.save(created.value);

  const probeCalls: Harness['probeCalls'] = [];
  let probeResult: RepoCheckProbe | Error = { reachable: true, defaultBranch: 'main', branchExists: true, message: null };
  const probe: ProjectGitProbe = {
    async check(input) {
      probeCalls.push({ ...input });
      if (probeResult instanceof Error) throw probeResult;
      return probeResult;
    }
  };

  const revealCalls: string[][] = [];
  const putCalls: string[] = [];
  const removeCalls: string[] = [];
  const base = world.deps.secrets;
  const secrets = {
    list: () => base.list(),
    async put(name: string, value: string, at: number) {
      putCalls.push(name);
      await base.put(name, value, at);
    },
    async remove(name: string) {
      removeCalls.push(name);
      return base.remove(name);
    },
    async reveal(names: readonly string[]) {
      revealCalls.push([...names]);
      return base.reveal(names);
    }
  };

  const allowsCalls: Harness['allowsCalls'] = [];
  let allows = options.allow ?? true;
  let actor: Subject | null = options.actor === undefined ? principal() : options.actor;
  const routeOptions: ProjectGitProbeRouteOptions = {
    probe,
    allows(projectId, repoId, url) {
      allowsCalls.push({ projectId, repoId, url });
      return typeof allows === 'function' ? allows(projectId, repoId, url) : allows;
    },
    projects: world.deps.projects,
    secrets,
    access,
    now: () => 1_000
  };
  const subjectOf: SubjectOf = () => actor;
  const app = new Hono();
  installProjectGitProbeRoutes(app, routeOptions, subjectOf);

  return {
    project: created.value,
    app,
    probeCalls,
    revealCalls,
    putCalls,
    removeCalls,
    allowsCalls,
    secretsRows: (base as typeof base & { rows: Map<string, string> }).rows,
    setActor(next) {
      actor = next;
    },
    setAllows(value) {
      allows = value;
    },
    async saveProject(project) {
      await world.deps.projects.save(project);
    },
    setProbeResult(result) {
      probeResult = result;
    }
  };
}

function path(repoId: string, tail: string): string {
  return `/api/projects/${PROJECT_ID}/repos/${repoId}/isolated-${tail}`;
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function putCredential(app: Hono, repoId: string, credential: string): Promise<Response> {
  return app.request(path(repoId, 'credential'), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential })
  });
}

test('按 repoId 精确取仓库：各自独立的凭据和配置分支，请求体不接受 URL', async () => {
  const h = await harness();

  assert.equal((await putCredential(h.app, REPO_ONE, 'tok-one')).status, 200);
  assert.equal((await putCredential(h.app, REPO_TWO, 'tok-two')).status, 200);
  assert.deepEqual(h.putCalls, [isolatedRepoTokenKey(PROJECT_ID, REPO_ONE), isolatedRepoTokenKey(PROJECT_ID, REPO_TWO)]);
  assert.deepEqual(JSON.parse(h.secretsRows.get(isolatedRepoTokenKey(PROJECT_ID, REPO_ONE))!), {
    url: URL_ONE,
    token: 'tok-one'
  });

  const one = await h.app.request(path(REPO_ONE, 'check'), { method: 'POST' });
  assert.equal(one.status, 200);
  assert.equal(one.headers.get('cache-control'), 'no-store');
  const oneBody = await json(one);
  assert.deepEqual(oneBody, {
    repoId: REPO_ONE,
    status: 'ok',
    readable: true,
    defaultBranch: 'main',
    branch: 'main',
    branchExists: true,
    executor: 'hub'
  });
  assert.equal('url' in oneBody, false);
  assert.equal('message' in oneBody, false);

  const two = await h.app.request(path(REPO_TWO, 'check'), { method: 'POST' });
  assert.equal(two.status, 200);
  assert.equal((await json(two)).branch, 'trunk');

  assert.equal(h.probeCalls.length, 2);
  assert.deepEqual(h.probeCalls[0], {
    url: URL_ONE,
    branch: 'main',
    authorization: authHeaderFor('tok-one', URL_ONE).header
  });
  assert.deepEqual(h.probeCalls[1], {
    url: URL_TWO,
    branch: 'trunk',
    authorization: authHeaderFor('tok-two', URL_TWO).header
  });
  assert.deepEqual(
    h.allowsCalls,
    [
      { projectId: PROJECT_ID, repoId: REPO_ONE, url: URL_ONE },
      { projectId: PROJECT_ID, repoId: REPO_TWO, url: URL_TWO },
      { projectId: PROJECT_ID, repoId: REPO_ONE, url: URL_ONE },
      { projectId: PROJECT_ID, repoId: REPO_TWO, url: URL_TWO }
    ],
    '两次写入和两次检查都绑定到当前项目里精确登记的 repoId + URL'
  );
});

test('缺失凭据 / 轮换凭据：不会回退 legacy repo-git 键，轮换后只用新值', async () => {
  const h = await harness();
  const legacyKey = `repo-git:${PROJECT_ID}:${REPO_ONE}`;
  await h.secretsRows.set(legacyKey, 'legacy-clone-token');

  const missing = await h.app.request(path(REPO_ONE, 'check'), { method: 'POST' });
  assert.equal(missing.status, 200);
  assert.equal((await json(missing)).status, 'credential_unavailable');
  assert.equal(h.probeCalls.length, 0, '没有隔离凭据时不能拿 legacy 值探测');
  assert.deepEqual(h.revealCalls, [[isolatedRepoTokenKey(PROJECT_ID, REPO_ONE)]]);

  assert.equal((await putCredential(h.app, REPO_ONE, 'first')).status, 200);
  assert.equal((await h.app.request(path(REPO_ONE, 'check'), { method: 'POST' })).status, 200);
  assert.equal(h.probeCalls[0]!.authorization, authHeaderFor('first', URL_ONE).header);

  assert.equal((await putCredential(h.app, REPO_ONE, 'rotated')).status, 200);
  assert.equal((await h.app.request(path(REPO_ONE, 'check'), { method: 'POST' })).status, 200);
  assert.equal(h.probeCalls[1]!.authorization, authHeaderFor('rotated', URL_ONE).header);
  assert.equal(h.secretsRows.get(legacyKey), 'legacy-clone-token', 'legacy 键不能被读写');
});

test('运营白名单拒绝时：不 reveal、不探测、不写不删', async () => {
  const h = await harness({ allow: false });

  const check = await h.app.request(path(REPO_ONE, 'check'), { method: 'POST' });
  assert.equal(check.status, 404);
  assert.equal(h.revealCalls.length, 0);
  assert.equal(h.probeCalls.length, 0);

  assert.equal((await putCredential(h.app, REPO_ONE, 'nope')).status, 404);
  assert.equal(h.putCalls.length, 0);
  assert.equal((await h.app.request(path(REPO_ONE, 'credential'), { method: 'DELETE' })).status, 404);
  assert.equal(h.removeCalls.length, 0);
  assert.equal(h.secretsRows.size, 0);
});

test('仓库 URL 不是无凭据 HTTPS 时：在 reveal / probe 前拒绝', async () => {
  const h = await harness({
    repos: [
      { id: REPO_ONE, name: 'one', url: 'http://git.test/one.git', defaultBranch: 'main' },
      { id: REPO_TWO, name: 'two', url: 'https://user:pass@git.test/two.git', defaultBranch: 'main' }
    ]
  });

  const plain = await h.app.request(path(REPO_ONE, 'check'), { method: 'POST' });
  assert.equal(plain.status, 400);
  const withUser = await h.app.request(path(REPO_TWO, 'check'), { method: 'POST' });
  assert.equal(withUser.status, 400);
  assert.equal((await putCredential(h.app, REPO_ONE, 'tok')).status, 400);
  assert.equal(h.revealCalls.length, 0);
  assert.equal(h.probeCalls.length, 0);
  assert.equal(h.putCalls.length, 0);
  assert.equal(h.allowsCalls.length, 0, 'URL 不合法时连运营白名单都不查');
});

test('仓库 URL 带 query / fragment（含空的 ? 和 #）时：在 reveal / probe / 写密钥前拒绝', async () => {
  for (const url of [
    'https://git.test/one.git?ref=main',
    'https://git.test/one.git?',
    'https://git.test/one.git#main',
    'https://git.test/one.git#'
  ]) {
    const h = await harness({ repos: [{ id: REPO_ONE, name: 'one', url, defaultBranch: 'main' }] });
    const check = await h.app.request(path(REPO_ONE, 'check'), { method: 'POST' });
    assert.equal(check.status, 400, url);
    assert.equal((await putCredential(h.app, REPO_ONE, 'tok')).status, 400, url);
    assert.equal(h.revealCalls.length, 0, url);
    assert.equal(h.probeCalls.length, 0, url);
    assert.equal(h.putCalls.length, 0, url);
    assert.equal(h.allowsCalls.length, 0, url);
  }
});

test('运营白名单按 (projectId, repoId, 登记 URL) 精确绑定，不能借别的仓库或请求提示改指向', async () => {
  const h = await harness({
    allow: (projectId, repoId, url) => projectId === PROJECT_ID && repoId === REPO_ONE && url === URL_ONE
  });

  assert.equal((await putCredential(h.app, REPO_ONE, 'allowed')).status, 200);
  assert.equal((await putCredential(h.app, REPO_TWO, 'denied')).status, 404);
  assert.equal(h.putCalls.length, 1, '只有精确命中白名单的仓库能写入');
  assert.equal(h.revealCalls.length, 0);

  const denied = await h.app.request(path(REPO_TWO, 'check'), { method: 'POST' });
  assert.equal(denied.status, 404);
  assert.equal(h.revealCalls.length, 0);
  assert.equal(h.probeCalls.length, 0);

  const allowed = await h.app.request(path(REPO_ONE, 'check'), { method: 'POST' });
  assert.equal(allowed.status, 200);
  assert.deepEqual(h.probeCalls, [
    { url: URL_ONE, branch: 'main', authorization: authHeaderFor('allowed', URL_ONE).header }
  ]);
});

test('只接受真实浏览器登录：无主体 401、token 主体 403、viewer 403、回收站项目 404', async () => {
  const anonymous = await harness({ actor: null });
  assert.equal((await anonymous.app.request(path(REPO_ONE, 'check'), { method: 'POST' })).status, 401);
  assert.equal(anonymous.revealCalls.length, 0);

  const token = await harness({ actor: principal('owner', TOKEN_VIA) });
  assert.equal((await token.app.request(path(REPO_ONE, 'check'), { method: 'POST' })).status, 403);
  assert.equal(token.revealCalls.length, 0);
  assert.equal(token.probeCalls.length, 0);

  const viewer = await harness({ actor: principal('viewer') });
  assert.equal((await viewer.app.request(path(REPO_ONE, 'check'), { method: 'POST' })).status, 403);
  assert.equal(viewer.revealCalls.length, 0);
  assert.equal(viewer.probeCalls.length, 0);
  assert.equal(viewer.allowsCalls.length, 0);

  const deleted = await harness();
  await deleted.saveProject({ ...deleted.project, deletedAt: 2 });
  assert.equal((await deleted.app.request(path(REPO_ONE, 'check'), { method: 'POST' })).status, 404);
  assert.equal(deleted.revealCalls.length, 0);
  assert.equal(deleted.probeCalls.length, 0);
});

test('下游异常 / 诊断信息全部净化，响应里不出现 message 或凭据', async () => {
  const h = await harness();
  await putCredential(h.app, REPO_ONE, 'do-not-echo-this');
  h.setProbeResult(new Error('boom https://x-access-token:do-not-echo-this@git.test'));

  const failed = await h.app.request(path(REPO_ONE, 'check'), { method: 'POST' });
  assert.equal(failed.status, 200);
  const failedText = await failed.text();
  assert.equal(JSON.parse(failedText).status, 'unreachable');
  assert.equal(failedText.includes('boom'), false);
  assert.equal(failedText.includes('do-not-echo-this'), false);

  const long = 'x'.repeat(300);
  h.setProbeResult({ reachable: true, defaultBranch: long, branchExists: true, message: 'fatal: token do-not-echo-this' });
  const noisy = await h.app.request(path(REPO_ONE, 'check'), { method: 'POST' });
  const noisyText = await noisy.text();
  const noisyBody = JSON.parse(noisyText);
  assert.equal(noisyBody.status, 'ok');
  assert.equal(noisyBody.defaultBranch, null);
  assert.equal(noisyText.includes('do-not-echo-this'), false);
  assert.equal(noisyText.includes('fatal'), false);
  assert.equal('message' in noisyBody, false);
});

test('请求体严格：check 不接受任何目标字段，credential 不接受多余字段 / 空白 / 控制字符', async () => {
  const h = await harness();

  const urlInjection = await h.app.request(path(REPO_ONE, 'check'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://evil.test/repo.git' })
  });
  assert.equal(urlInjection.status, 400);
  const branchInjection = await h.app.request(path(REPO_ONE, 'check'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ branch: 'dev' })
  });
  assert.equal(branchInjection.status, 400);
  assert.equal(h.revealCalls.length, 0);
  assert.equal(h.probeCalls.length, 0);

  const extra = await h.app.request(path(REPO_ONE, 'credential'), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential: 'tok', url: 'https://evil.test/repo.git' })
  });
  assert.equal(extra.status, 400);
  assert.equal((await putCredential(h.app, REPO_ONE, '   ')).status, 400);
  const newline = await h.app.request(path(REPO_ONE, 'credential'), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential: 'tok\nInjected: yes' })
  });
  assert.equal(newline.status, 400);
  assert.equal(h.putCalls.length, 0);

  const empty = await h.app.request(path(REPO_ONE, 'check'), { method: 'POST' });
  assert.equal(empty.status, 200);
  assert.equal((await json(empty)).status, 'credential_unavailable');

  assert.equal((await putCredential(h.app, REPO_ONE, 'tok')).status, 200);
  assert.equal((await h.app.request(path(REPO_ONE, 'credential'), { method: 'DELETE' })).status, 200);
  assert.equal(h.secretsRows.has(isolatedRepoTokenKey(PROJECT_ID, REPO_ONE)), false);
  assert.equal((await h.app.request(path(REPO_ONE, 'credential'), { method: 'DELETE' })).status, 200);
});

test('项目改 URL 后保存的凭据自动失效，不能静默改指向', async () => {
  const h = await harness();
  await putCredential(h.app, REPO_ONE, 'bound-token');

  const moved = { ...h.project, repos: h.project.repos.map((repo) => (repo.id === REPO_ONE ? { ...repo, url: 'https://git.test/moved.git' } : repo)) };
  await h.saveProject(moved);

  const check = await h.app.request(path(REPO_ONE, 'check'), { method: 'POST' });
  assert.equal(check.status, 200);
  assert.equal((await json(check)).status, 'credential_unavailable');
  assert.equal(h.probeCalls.length, 0);
  assert.equal(h.secretsRows.has(isolatedRepoTokenKey(PROJECT_ID, REPO_ONE)), true);
});
