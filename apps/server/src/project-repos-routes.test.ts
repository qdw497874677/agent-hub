import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addTeamMember, inMemoryAccounts, inMemoryDeps } from '@agent-hub/domain/testing';
import { createAccessPolicy, repoTokenKey } from '@agent-hub/domain';
import { createApp } from './http.ts';
import { createStreamHub } from './stream-hub.ts';
import { authHeaderFor } from './repo-auth.ts';
import { projectDto } from './project-dto.ts';

const PASSWORD = 'long enough pw';

test('项目出站只把自己的标准密钥名标为已配置', () => {
  const one = { id: 'repo_12345678', name: 'api', url: 'https://example.test/api.git', defaultBranch: null };
  for (const tokenSecret of ['repo-git:repo_12345678', repoTokenKey('other', one.id), repoTokenKey('mine', one.id)]) {
    const dto = projectDto({ id: 'mine', repos: [{ ...one, tokenSecret }] }).repos[0]!;
    assert.equal(dto.hasToken, tokenSecret === repoTokenKey('mine', one.id));
    assert.equal('tokenSecret' in dto, false);
    assert.equal('tokenHint' in dto, !dto.hasToken);
  }
});

/** 和 access.test.ts 同一个 harness：真的 createAccessPolicy + cookie jar，外加审计记录。 */
function harness() {
  const accounts = inMemoryAccounts();
  const world = inMemoryDeps();
  const access = createAccessPolicy({
    users: accounts.users,
    settings: accounts.settings,
    enrollment: { credentialFor: async () => null },
    gateway: world.deps.gateway
  });
  const deps = { ...world.deps, access };
  const app = createApp({
    deps,
    hub: createStreamHub(),
    token: null,
    auth: { accounts },
    activity: { audit: accounts.audit!, users: accounts.users }
  });
  const browser = () => {
    const jar = new Map<string, string>();
    return async (path: string, init: RequestInit = {}) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      if (jar.get('hub_csrf')) headers['x-hub-csrf'] = jar.get('hub_csrf')!;
      const response = await app.fetch(new Request(`http://hub${path}`, { ...init, headers }));
      for (const line of response.headers.getSetCookie()) {
        const [name, value] = line.split(';')[0]!.split('=');
        if (value === '' || /Max-Age=0/.test(line)) jar.delete(name!);
        else jar.set(name!, value!);
      }
      return { status: response.status, body: (await response.json().catch(() => null)) as any };
    };
  };
  return { accounts, browser, world };
}

const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) });
const patch = (body: unknown) => ({ method: 'PATCH', body: JSON.stringify(body) });
const put = (body: unknown) => ({ method: 'PUT', body: JSON.stringify(body) });

async function setup() {
  const h = harness();
  const david = h.browser();
  assert.equal((await david('/api/auth/register', post({ email: 'david@b.co', password: PASSWORD }))).status, 200);
  await addTeamMember(h.accounts, 'viewer@b.co', PASSWORD);
  const viewerUser = await h.accounts.users.byEmail('viewer@b.co');
  assert.ok(viewerUser);
  await h.accounts.users.save({ ...viewerUser, role: 'viewer' });
  const viewer = h.browser();
  assert.equal((await viewer('/api/auth/login', post({ email: 'viewer@b.co', password: PASSWORD }))).status, 200);
  return { ...h, david, viewer };
}

test('PATCH /api/projects/:id：写仓库清单、双写 repo、记审计', async () => {
  const { david, accounts } = await setup();
  const project = (await david('/api/projects', post({ name: 'multi', repoUrl: 'https://example.test/me/api.git', defaultBranch: 'main' }))).body;
  assert.equal(project.repos.length, 1);
  assert.equal(project.repo.url, 'https://example.test/me/api.git');

  const res = await david(
    `/api/projects/${project.id}`,
    patch({
      repos: [
        { name: 'api', url: 'https://example.test/me/api.git', defaultBranch: 'main' },
        { name: 'web', url: 'git@example.test:me/web.git' }
      ]
    })
  );
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.repos.map((repo: { name: string }) => repo.name), ['api', 'web']);
  assert.deepEqual(res.body.repo, { url: 'https://example.test/me/api.git', defaultBranch: 'main' });
  assert.ok(res.body.repos.every((repo: { id: string }) => /^repo_[0-9a-f]{8}$/.test(repo.id)));
  assert.ok(accounts.auditRows.some((row) => row.action === 'project.repos' && row.target === project.id));

  // 只改 worktree 的老路径不能被新字段带坏
  const worktree = await david(`/api/projects/${project.id}`, patch({ worktree: { mode: 'isolated' } }));
  assert.equal(worktree.status, 200, JSON.stringify(worktree.body));
  assert.equal(worktree.body.worktree.mode, 'isolated');
  assert.equal(worktree.body.repos.length, 2);

  // 旧接口 PUT /repo = 改 primary，不能顺手清掉其他仓库；name / id 保持稳定
  const replaced = await david(`/api/projects/${project.id}/repo`, put({ repoUrl: 'https://example.test/me/api-v2.git' }));
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
  assert.deepEqual(replaced.body.repos.map((repo: { name: string }) => repo.name), ['api', 'web']);
  assert.equal(replaced.body.repos[0].id, res.body.repos[0].id);
  assert.equal(replaced.body.repos[1].id, res.body.repos[1].id);
  assert.equal(replaced.body.repo.url, 'https://example.test/me/api-v2.git');

  const cleared = await david(`/api/projects/${project.id}`, patch({ repos: [] }));
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.repo, null);
  assert.deepEqual(cleared.body.repos, []);
});

test('PATCH /api/projects/:id：viewer（非 admin）403', async () => {
  const { david, viewer } = await setup();
  const project = (await david('/api/projects', post({ name: 'p' }))).body;
  const res = await viewer(`/api/projects/${project.id}`, patch({ repos: [{ name: 'api', url: 'https://x.test/a.git' }] }));
  assert.equal(res.status, 403, JSON.stringify(res.body));
});

test('PATCH /api/projects/:id：超上限 / 重名 / 非法名 → 400', async () => {  const { david } = await setup();
  const project = (await david('/api/projects', post({ name: 'p' }))).body;
  const tooMany = await david(
    `/api/projects/${project.id}`,
    patch({ repos: Array.from({ length: 9 }, (_, i) => ({ name: `repo-${i}`, url: `https://x.test/${i}.git` })) })
  );
  assert.equal(tooMany.status, 400);
  const dup = await david(
    `/api/projects/${project.id}`,
    patch({ repos: [{ name: 'api', url: 'https://x.test/a.git' }, { name: 'api', url: 'https://x.test/b.git' }] })
  );
  assert.equal(dup.status, 400);
  const badName = await david(`/api/projects/${project.id}`, patch({ repos: [{ name: 'API', url: 'https://x.test/a.git' }] }));
  assert.equal(badName.status, 400);
});

test('POST /api/projects/:id/repos/check：没有在线机器 → 200 + unavailable，不报错', async () => {
  const { david, world } = await setup();
  const project = (await david('/api/projects', post({ name: 'p' }))).body;
  world.workers.length = 0;

  const res = await david(`/api/projects/${project.id}/repos/check`, post({ repos: [{ name: 'api', url: 'https://x.test/a.git', defaultBranch: 'main' }] }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.workerId, null);
  assert.equal(res.body.workerLabel, null);
  assert.deepEqual(res.body.results, []);
  assert.match(res.body.unavailable, /没有在线的机器/);
});

test('POST /api/projects/:id/repos/check：指定离线的机器 → 409', async () => {
  const { david, world } = await setup();
  const project = (await david('/api/projects', post({ name: 'p' }))).body;
  world.workers.push({ workerId: 'gone', label: '远端', origin: 'remote', state: 'offline' });

  const res = await david(
    `/api/projects/${project.id}/repos/check`,
    post({ repos: [{ name: 'api', url: 'https://x.test/a.git', defaultBranch: 'main' }], workerId: 'gone' })
  );
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.match(res.body.error.message, /不在线/);
});

test('POST /api/projects/:id/repos/check：正常检查走本机 git，返回结果并记审计', async () => {
  const { david, accounts, world } = await setup();
  const project = (await david('/api/projects', post({ name: 'p' }))).body;

  const res = await david(
    `/api/projects/${project.id}/repos/check`,
    post({ repos: [{ name: 'api', url: 'https://x.test/a.git', defaultBranch: 'main' }, { name: 'web', url: 'git@x.test:me/web.git' }] })
  );
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.workerId, null);
  assert.equal(res.body.workerLabel, '本机');
  assert.equal(res.body.unavailable, null);
  assert.deepEqual(
    res.body.results.map((row: { name: string; branch: string | null; ok: boolean }) => [row.name, row.branch, row.ok]),
    [['api', 'main', true], ['web', null, true]]
  );
  assert.ok(world.git.calls.some((call) => call === 'local:check_repo:https://x.test/a.git@main'));
  assert.ok(accounts.auditRows.some((row) => row.action === 'project.repos_check' && row.target === project.id));
});

test('POST /api/projects/:id/repos/check：viewer 403；形状不合法 400', async () => {
  const { david, viewer } = await setup();
  const project = (await david('/api/projects', post({ name: 'p' }))).body;

  const denied = await viewer(`/api/projects/${project.id}/repos/check`, post({ repos: [] }));
  assert.equal(denied.status, 403, JSON.stringify(denied.body));

  const invalid = await david(`/api/projects/${project.id}/repos/check`, post({ repos: [{ name: 'api', url: '' }] }));
  assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
});

test('PATCH /api/projects/:id：写检查命令（issue #216 P1），空数组清空，换行 400', async () => {
  const { david, accounts } = await setup();
  const project = (await david('/api/projects', post({ name: 'p' }))).body;
  assert.deepEqual(project.checks, []);

  const written = await david(
    `/api/projects/${project.id}`,
    patch({ checks: ['npm run typecheck', ' npm test '] })
  );
  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.deepEqual(written.body.checks, ['npm run typecheck', 'npm test']);
  assert.ok(accounts.auditRows.some((row) => row.action === 'project.worktree' && row.target === project.id));

  // 只改别的字段不能把 checks 冲掉
  const worktree = await david(`/api/projects/${project.id}`, patch({ worktree: { mode: 'isolated' } }));
  assert.equal(worktree.status, 200, JSON.stringify(worktree.body));
  assert.deepEqual(worktree.body.checks, ['npm run typecheck', 'npm test']);

  const cleared = await david(`/api/projects/${project.id}`, patch({ checks: [] }));
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.deepEqual(cleared.body.checks, []);

  const newline = await david(`/api/projects/${project.id}`, patch({ checks: ['npm test\nnpm run build'] }));
  assert.equal(newline.status, 400, JSON.stringify(newline.body));
  assert.match(newline.body.error.message, /不能换行/);

  const tooMany = await david(`/api/projects/${project.id}`, patch({ checks: Array.from({ length: 6 }, (_, i) => `cmd-${i}`) }));
  assert.equal(tooMany.status, 400, JSON.stringify(tooMany.body));
});

/** 测试里直接看密钥箱（fakeSecrets 暴露了 rows）。 */
const vaultRows = (deps: { secrets: unknown }): Map<string, string> => (deps.secrets as { rows: Map<string, string> }).rows;

test('PATCH /api/projects/:id：credential 进密钥箱，响应只有 hasToken', async () => {
  const { david, world } = await setup();
  const project = (await david('/api/projects', post({ name: 'p' }))).body;
  const res = await david(
    `/api/projects/${project.id}`,
    patch({ repos: [{ name: 'api', url: 'https://gitlab.test/me/api.git', defaultBranch: 'main', credential: '  glpat-abc  ' }] })
  );
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const repo = res.body.repos[0];
  assert.equal(repo.hasToken, true);
  assert.equal('tokenSecret' in repo, false);
  assert.equal(JSON.stringify(res.body).includes('glpat-abc'), false);
  assert.equal(JSON.stringify(res.body).includes('repo-git:'), false, '密钥名也不出去');

  const key = repoTokenKey(project.id, repo.id);
  assert.equal(vaultRows(world.deps).get(key), 'glpat-abc');

  // 清单接口也走同一套投影
  const listed = await david('/api/projects');
  const seen = listed.body.find((row: { id: string }) => row.id === project.id);
  assert.equal(seen.repos[0].hasToken, true);
  assert.equal('tokenSecret' in seen.repos[0], false);
});

test('PATCH /api/projects/:id：不带 credential 不清除，空串清除', async () => {
  const { david, world } = await setup();
  const project = (await david('/api/projects', post({ name: 'p' }))).body;
  const first = await david(
    `/api/projects/${project.id}`,
    patch({ repos: [{ name: 'api', url: 'https://gitlab.test/me/api.git', credential: 'glpat-abc' }] })
  );
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const key = repoTokenKey(project.id, first.body.repos[0].id);

  // 只改别的字段：令牌不动
  const again = await david(`/api/projects/${project.id}`, patch({ repos: [{ id: first.body.repos[0].id, name: 'api', url: 'https://gitlab.test/me/api.git', defaultBranch: 'main' }] }));
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.repos[0].hasToken, true);
  assert.equal(vaultRows(world.deps).get(key), 'glpat-abc');

  // 只改 worktree：同样不动
  const worktree = await david(`/api/projects/${project.id}`, patch({ worktree: { mode: 'isolated' } }));
  assert.equal(worktree.body.repos[0].hasToken, true);

  const cleared = await david(`/api/projects/${project.id}`, patch({ repos: [{ id: first.body.repos[0].id, name: 'api', url: 'https://gitlab.test/me/api.git', credential: '' }] }));
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.equal(cleared.body.repos[0].hasToken, false);
  assert.equal(vaultRows(world.deps).has(key), false);
});

test('PATCH /api/projects/:id：从清单里移除的仓库，密钥一起删', async () => {
  const { david, world } = await setup();
  const project = (await david('/api/projects', post({ name: 'p' }))).body;
  const both = await david(
    `/api/projects/${project.id}`,
    patch({
      repos: [
        { name: 'api', url: 'https://gitlab.test/me/api.git', credential: 'glpat-api' },
        { name: 'web', url: 'https://gitlab.test/me/web.git', credential: 'glpat-web' }
      ]
    })
  );
  assert.equal(both.status, 200, JSON.stringify(both.body));
  const [api, web] = both.body.repos;
  assert.equal(vaultRows(world.deps).has(repoTokenKey(project.id, web.id)), true);

  const removed = await david(`/api/projects/${project.id}`, patch({ repos: [{ id: api.id, name: 'api', url: 'https://gitlab.test/me/api.git' }] }));
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.deepEqual(removed.body.repos.map((repo: { name: string }) => repo.name), ['api']);
  assert.equal(vaultRows(world.deps).has(repoTokenKey(project.id, web.id)), false, '移除的仓库密钥要回收');
  assert.equal(vaultRows(world.deps).get(repoTokenKey(project.id, api.id)), 'glpat-api');
});

test('POST /api/projects/:id/repos/check：credential 透传给 git，响应用已存的令牌时也一样', async () => {
  const { david, world } = await setup();
  const project = (await david('/api/projects', post({ name: 'p' }))).body;
  const target = 'https://gitlab.test/me/api.git';

  // 1）请求里显式带的令牌（还没保存）
  const fresh = await david(
    `/api/projects/${project.id}/repos/check`,
    post({ repos: [{ name: 'api', url: target, defaultBranch: 'main', credential: 'glpat-live' }] })
  );
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  assert.deepEqual(world.git.authCalls, [`local:check_repo:${target}:${authHeaderFor('glpat-live', target).header}`]);

  // 2）已保存的令牌（请求里没带 credential）
  const saved = await david(`/api/projects/${project.id}`, patch({ repos: [{ name: 'api', url: target, credential: 'glpat-saved' }] }));
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  world.git.authCalls.length = 0;
  const check = await david(`/api/projects/${project.id}/repos/check`, post({ repos: [{ name: 'api', url: target, defaultBranch: 'main' }] }));
  assert.equal(check.status, 200, JSON.stringify(check.body));
  assert.deepEqual(world.git.authCalls, [`local:check_repo:${target}:${authHeaderFor('glpat-saved', target).header}`]);
  // 审计与响应里都不该出现令牌
  assert.equal(JSON.stringify(check.body).includes('glpat'), false);

  // 3）SSH 地址不传令牌
  world.git.authCalls.length = 0;
  const ssh = await david(`/api/projects/${project.id}/repos/check`, post({ repos: [{ name: 'web', url: 'git@gitlab.test:me/web.git' }] }));
  assert.equal(ssh.status, 200, JSON.stringify(ssh.body));
  assert.deepEqual(world.git.authCalls, []);
});

async function setupMember() {
  const h = await setup();
  await addTeamMember(h.accounts, 'member@b.co', PASSWORD);
  const member = h.browser();
  assert.equal((await member('/api/auth/login', post({ email: 'member@b.co', password: PASSWORD }))).status, 200);
  return { ...h, member };
}

test('POST /api/repo-check：viewer 403；member 对只有本机的集群 403（worker.use），不落任何东西', async () => {
  const { viewer, member, world, accounts } = await setupMember();

  const denied = await viewer('/api/repo-check', post({ repos: [{ name: 'api', url: 'https://gitlab.test/me/api.git' }] }));
  assert.equal(denied.status, 403, JSON.stringify(denied.body));

  const localOnly = await member('/api/repo-check', post({ repos: [{ name: 'api', url: 'https://gitlab.test/me/api.git' }] }));
  assert.equal(localOnly.status, 403, JSON.stringify(localOnly.body));
  assert.match(localOnly.body.error.message, /机器权限/);
  assert.deepEqual(world.git.calls, []);
  assert.deepEqual(world.git.authCalls, []);
  assert.equal(accounts.auditRows.some((row) => row.target === 'draft'), false);
});

test('POST /api/repo-check：未登录 401，不触网', async () => {
  const { world, browser } = await setup();
  const anonymous = browser();
  const res = await anonymous('/api/repo-check', post({ repos: [{ name: 'api', url: 'https://gitlab.test/me/api.git' }] }));
  assert.equal(res.status, 401, JSON.stringify(res.body));
  assert.deepEqual(world.git.calls, []);
});

test('POST /api/repo-check：member 自动挑有权限的远端机器，不碰本机', async () => {
  const { member, world } = await setupMember();
  world.workers.push({ workerId: 'remote1', label: '远端一', origin: 'remote', state: 'online', capabilities: ['git'] });

  const res = await member('/api/repo-check', post({ repos: [{ name: 'api', url: 'https://gitlab.test/me/api.git', defaultBranch: 'main' }] }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.workerId, 'remote1');
  assert.equal(res.body.workerLabel, '远端一');
  assert.deepEqual(world.git.calls, ['remote1:check_repo:https://gitlab.test/me/api.git@main']);

  // 明确点名本机：403，不静默换到远端
  world.git.calls.length = 0;
  const local = await member('/api/repo-check', post({ repos: [{ name: 'api', url: 'https://gitlab.test/me/api.git' }], workerId: 'local' }));
  assert.equal(local.status, 403, JSON.stringify(local.body));
  assert.deepEqual(world.git.calls, []);
});

test('POST /api/projects/:id/repos/check：member 改自己项目可以，但用本机仍要 worker.use → 403', async () => {
  const { member, world } = await setupMember();
  const project = (await member('/api/projects', post({ name: 'member-own' }))).body;
  assert.ok(project.id);

  const res = await member(`/api/projects/${project.id}/repos/check`, post({ repos: [{ name: 'api', url: 'https://gitlab.test/me/api.git' }], workerId: 'local' }));
  assert.equal(res.status, 403, JSON.stringify(res.body));
  assert.match(res.body.error.message, /本机 Worker/);
  assert.deepEqual(world.git.calls, []);
});

test('POST /api/repo-check：显式草稿令牌能用，但只用于这次检查；不进密钥箱、不外泄', async () => {
  const { david, world, accounts } = await setup();
  const target = 'https://gitlab.test/me/api.git';

  const res = await david('/api/repo-check', post({ repos: [{ name: 'api', url: target, defaultBranch: 'main', credential: 'glpat-draft' }] }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.results[0].credentialSource, 'draft');
  assert.equal(res.body.results[0].ok, true);
  assert.deepEqual(world.git.authCalls, [`local:check_repo:${target}:${authHeaderFor('glpat-draft', target).header}`]);
  assert.deepEqual([...vaultRows(world.deps).keys()], [], '草稿检查不写密钥箱');
  assert.equal(JSON.stringify(res.body).includes('glpat-draft'), false);
  const draftAudit = accounts.auditRows.filter((row) => row.target === 'draft');
  assert.ok(draftAudit.length > 0);
  assert.equal(JSON.stringify(draftAudit).includes('glpat-draft'), false);
});

test('POST /api/repo-check：永远不读已保存令牌（只有草稿显式给的才算）', async () => {
  const { david, world, accounts } = await setup();
  const target = 'https://gitlab.test/me/api.git';
  const project = (await david('/api/projects', post({ name: 'p' }))).body;
  const saved = await david(`/api/projects/${project.id}`, patch({ repos: [{ name: 'api', url: target, credential: 'glpat-saved' }] }));
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  world.git.authCalls.length = 0;

  // 同一个 URL、甚至带上已存仓库的 id，也不能把项目里的令牌拿到草稿检查里用
  const res = await david(
    '/api/repo-check',
    post({ repos: [{ id: saved.body.repos[0].id, name: 'api', url: target, defaultBranch: 'main' }] })
  );
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.results[0].credentialSource, 'worker');
  assert.deepEqual(world.git.authCalls, []);

  const draft = accounts.auditRows.filter((row) => row.target === 'draft');
  assert.ok(draft.length > 0);
  assert.equal(JSON.stringify(draft).includes('glpat'), false);
});

test('POST /api/projects/:id/repos/check：已存令牌只认同项目 + 同仓库 id/URL；空串不回落', async () => {
  const { david, world } = await setup();
  const target = 'https://gitlab.test/me/api.git';
  const other = 'https://gitlab.test/me/web.git';
  const project = (await david('/api/projects', post({ name: 'p' }))).body;
  const saved = await david(`/api/projects/${project.id}`, patch({ repos: [{ name: 'api', url: target, credential: 'glpat-saved' }] }));
  const repoId = saved.body.repos[0].id as string;
  const check = (repo: Record<string, unknown>) => david(`/api/projects/${project.id}/repos/check`, post({ repos: [repo] }));

  // 显式空串 = 明确不用令牌
  world.git.authCalls.length = 0;
  const cleared = await check({ id: repoId, name: 'api', url: target, defaultBranch: 'main', credential: '' });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.equal(cleared.body.results[0].credentialSource, 'worker');
  assert.deepEqual(world.git.authCalls, []);

  // id 对上、URL 对上 → 用已存的
  world.git.authCalls.length = 0;
  const exact = await check({ id: repoId, name: 'api', url: target, defaultBranch: 'main' });
  assert.equal(exact.body.results[0].credentialSource, 'saved');
  assert.deepEqual(world.git.authCalls, [`local:check_repo:${target}:${authHeaderFor('glpat-saved', target).header}`]);

  // 给了 id 但地址变了 → 不用旧令牌（地址换了不能把凭据带过去）
  world.git.authCalls.length = 0;
  const moved = await check({ id: repoId, name: 'api', url: other, defaultBranch: 'main' });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.results[0].credentialSource, 'worker');
  assert.deepEqual(world.git.authCalls, []);

  // id 对不上 → 即使 URL 一样也不用（没有 id 才按 URL 兼容旧客户端）
  world.git.authCalls.length = 0;
  const wrongId = await check({ id: 'repo_deadbeef', name: 'api', url: target, defaultBranch: 'main' });
  assert.equal(wrongId.body.results[0].credentialSource, 'worker');
  assert.deepEqual(world.git.authCalls, []);

  // 不带 id：保持旧行为，按 URL 匹配
  world.git.authCalls.length = 0;
  const legacy = await check({ name: 'api', url: target, defaultBranch: 'main' });
  assert.equal(legacy.body.results[0].credentialSource, 'saved');
  assert.deepEqual(world.git.authCalls, [`local:check_repo:${target}:${authHeaderFor('glpat-saved', target).header}`]);
});

test('POST /api/projects/:id/repos/check：令牌标还在但密钥箱丢了 → 明确报 credential_unavailable，不静默改用机器凭据', async () => {
  const { david, world } = await setup();
  const target = 'https://gitlab.test/me/api.git';
  const project = (await david('/api/projects', post({ name: 'p' }))).body;
  const saved = await david(`/api/projects/${project.id}`, patch({ repos: [{ name: 'api', url: target, credential: 'glpat-gone' }] }));
  const repoId = saved.body.repos[0].id as string;
  vaultRows(world.deps).delete(repoTokenKey(project.id, repoId));
  world.git.calls.length = 0;
  world.git.authCalls.length = 0;

  const res = await david(`/api/projects/${project.id}/repos/check`, post({ repos: [{ id: repoId, name: 'api', url: target, defaultBranch: 'main' }] }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.results[0].ok, false);
  assert.equal(res.body.results[0].credentialSource, 'saved');
  assert.equal(res.body.results[0].failureKind, 'credential_unavailable');
  assert.match(res.body.results[0].message, /密钥箱/);
  assert.deepEqual(world.git.calls, [], '不能退回机器凭据去「碰巧成功」');
  assert.deepEqual(world.git.authCalls, []);
});

test('POST /api/projects/:id/repos/check：failureKind 保守分类，认证失败只给通用话术', async () => {
  const { david, world } = await setup();
  const target = 'https://gitlab.test/me/api.git';
  const project = (await david('/api/projects', post({ name: 'p' }))).body;
  const check = (repo: Record<string, unknown>) => david(`/api/projects/${project.id}/repos/check`, post({ repos: [repo] }));

  world.git.repoChecks.set(`${target}@main`, {
    reachable: false,
    defaultBranch: null,
    branchExists: false,
    message: "fatal: Authentication failed for 'https://x-access-token:ghp_leaked@gitlab.test/me/api.git/'"
  });
  const auth = await check({ name: 'api', url: target, defaultBranch: 'main', credential: 'glpat-live' });
  assert.equal(auth.body.results[0].failureKind, 'authentication');
  assert.equal(auth.body.results[0].credentialSource, 'draft');
  assert.equal(auth.body.results[0].message, '认证失败：请检查仓库地址、令牌，或这台机器上的凭据');
  assert.equal(JSON.stringify(auth.body).includes('ghp_leaked'), false);
  assert.equal(JSON.stringify(auth.body).includes('glpat-live'), false);

  world.git.repoChecks.set(`${target}@dev`, { reachable: true, defaultBranch: 'master', branchExists: false, message: null });
  const missing = await check({ name: 'api', url: target, defaultBranch: 'dev' });
  assert.equal(missing.body.results[0].failureKind, 'branch_missing');
  assert.match(missing.body.results[0].message, /没有分支 dev/);
  assert.equal(missing.body.results[0].credentialSource, 'worker');

  world.git.repoChecks.set(`${target}@main`, { reachable: false, defaultBranch: null, branchExists: false, message: 'Could not resolve host: gitlab.test' });
  const unreachable = await check({ name: 'api', url: target, defaultBranch: 'main' });
  assert.equal(unreachable.body.results[0].failureKind, 'unreachable');
  assert.match(unreachable.body.results[0].message, /Could not resolve host/);

  // 模糊的 not found 不硬说是认证问题
  world.git.repoChecks.set(`${target}@main`, { reachable: false, defaultBranch: null, branchExists: false, message: 'remote: Repository not found.' });
  const vague = await check({ name: 'api', url: target, defaultBranch: 'main' });
  assert.equal(vague.body.results[0].failureKind, 'unreachable');
});

test('仓库检查只接受安全的 HTTPS / SSH 地址（两个端点一致），保存仍走老规则', async () => {
  const { david, world } = await setup();
  const project = (await david('/api/projects', post({ name: 'p' }))).body;
  const bad = [
    'http://gitlab.test/me/api.git',
    'file:///srv/api.git',
    '/srv/api.git',
    'ext::sh -c echo',
    'https://user:pass@gitlab.test/me/api.git',
    'https://user@gitlab.test/me/api.git',
    'ssh://git:pass@gitlab.test/me/api.git',
    '-oProxyCommand=id',
    'gitlab.test/me/api.git',
    'https://gitlab.test/me/ api.git'
  ];
  for (const url of bad) {
    const draft = await david('/api/repo-check', post({ repos: [{ name: 'api', url }] }));
    assert.equal(draft.status, 400, `${url} -> ${JSON.stringify(draft.body)}`);
    const saved = await david(`/api/projects/${project.id}/repos/check`, post({ repos: [{ name: 'api', url }] }));
    assert.equal(saved.status, 400, `${url} -> ${JSON.stringify(saved.body)}`);
  }
  assert.deepEqual(world.git.calls, []);

  // 标准 scp / ssh:// 写法可以用
  const scp = await david('/api/repo-check', post({ repos: [{ name: 'web', url: 'git@gitlab.test:me/web.git' }] }));
  assert.equal(scp.status, 200, JSON.stringify(scp.body));
  const ssh = await david('/api/repo-check', post({ repos: [{ name: 'web', url: 'ssh://git@gitlab.test:22/me/web.git' }] }));
  assert.equal(ssh.status, 200, JSON.stringify(ssh.body));

  // 保存接口保持原有宽松行为（http 仍可存；老项目不能被这次收紧弄坏）
  const legacyPatch = (body: unknown) => ({ method: 'PATCH', body: JSON.stringify(body) });
  const legacy = await david(`/api/projects/${project.id}`, legacyPatch({ repos: [{ name: 'old', url: 'http://gitlab.test/me/old.git' }] }));
  assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
});
