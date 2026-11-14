import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addTeamMember, inMemoryAccounts, inMemoryDeps } from '@agent-hub/domain/testing';
import { createAccessPolicy } from '@agent-hub/domain';
import { createApp } from './http.ts';
import { createStreamHub } from './stream-hub.ts';

const PASSWORD = 'long enough pw';

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
