import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryAdmin, inMemoryAssetReviewDeps, inMemoryAssets, inMemoryDeps, addTeamMember } from '@agent-hub/domain/testing';
import { createApp } from './http.ts';
import { createStreamHub } from './stream-hub.ts';

const PASSWORD = 'long enough pw';
const b64 = (text: string) => Buffer.from(text).toString('base64');
const skillFiles = (body: string) => [
  { path: 'SKILL.md', data: b64(`---\nname: greeter\ndescription: Greets people\n---\n${body}\n`) }
];
const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness() {
  const admin = inMemoryAdmin();
  const assets = inMemoryAssets();
  const { deps } = inMemoryDeps();
  const review = inMemoryAssetReviewDeps(admin, assets);
  const app = createApp({
    deps,
    hub: createStreamHub(),
    token: null,
    auth: { accounts: admin.accounts, hubToken: null },
    admin: { deps: admin.deps },
    assets: { deps: review.deps, audit: admin.deps.audit }
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
        jar.set(name!, value!);
      }
      return { status: response.status, body: (await response.json().catch(() => null)) as any };
    };
  };
  return { admin, assets, review, browser, app };
}

test('资产 API：主人上传 → 装到机器 → 传新版本看 diff → 确认升级；成员 403；审计留痕', async () => {
  const h = harness();
  const owner = h.browser();
  const member = h.browser();
  const register = (email: string) => ({ method: 'POST', body: JSON.stringify({ email, password: PASSWORD }) });
  assert.equal((await owner('/api/auth/register', register('boss@b.co'))).status, 200);
  await addTeamMember(h.admin.accounts, 'm@b.co', PASSWORD);
  assert.equal((await member('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'm@b.co', password: PASSWORD }) })).status, 200);
  assert.equal((await member('/api/admin/assets')).status, 403);

  const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) });
  const made = await owner('/api/admin/assets/upload', post({ kind: 'skill', files: skillFiles('v1') }));
  assert.equal(made.status, 201);
  const id = made.body.id as string;
  assert.equal((await owner('/api/admin/assets/upload', post({ kind: 'skill', files: skillFiles('dup') }))).status, 409);
  assert.equal((await owner('/api/admin/assets/upload', post({ kind: 'skill', files: [{ path: '../x', data: '' }] }))).status, 400);

  assert.equal((await owner(`/api/admin/assets/${id}/workers/w1`, { method: 'PUT', body: JSON.stringify({ installed: true }) })).status, 200);
  await flush();
  let overview = (await owner('/api/admin/assets')).body;
  assert.equal(overview.assets[0].name, 'greeter');
  assert.deepEqual(overview.assets[0].workerIds, ['w1']);
  assert.equal(overview.workers[0].sync.state, 'synced');

  const next = await owner(`/api/admin/assets/${id}/revisions`, post({ files: skillFiles('v2') }));
  assert.equal(next.body.changed, true);
  overview = (await owner('/api/admin/assets')).body;
  const { pinned, latest } = overview.assets[0];
  assert.notEqual(pinned, latest);
  const diff = await owner(`/api/admin/assets/${id}/diff?from=${pinned}&to=${latest}`);
  assert.equal(diff.body.files[0].change, 'modified');
  assert.equal((await owner(`/api/admin/assets/${id}/revisions`)).body.length, 2);
  const file = await owner(`/api/admin/assets/${id}/file?digest=${latest}&path=SKILL.md`);
  assert.match(file.body.text, /v2/);

  assert.equal((await owner(`/api/admin/assets/${id}/pin`, post({ digest: latest }))).status, 200);
  await flush();
  assert.equal(h.assets.pushes.at(-1)?.manifest[0]?.digest, latest);
  assert.equal((await owner(`/api/admin/assets/${id}/check`, { method: 'POST' })).status, 400, '上传来的没有来源可查');

  assert.equal((await owner(`/api/admin/assets/${id}`, { method: 'DELETE' })).status, 200);
  assert.deepEqual((await owner('/api/admin/assets')).body.assets, []);
  const actions = (await owner('/api/admin/audit')).body.map((entry: { action: string }) => entry.action);
  for (const action of ['asset.create', 'asset.install', 'asset.revision', 'asset.pin', 'asset.delete']) assert.ok(actions.includes(action), action);
});

test('审计：上传 MCP 记成「上传MCP 服务器」，不是「上传指令」', async () => {
  const h = harness();
  const owner = h.browser();
  assert.equal((await owner('/api/auth/register', { method: 'POST', body: JSON.stringify({ email: 'boss@b.co', password: PASSWORD }) })).status, 200);
  const files = [{ path: 'mcp.json', data: b64(JSON.stringify({ name: 'docs', transport: 'http', url: 'https://e/mcp' })) }];
  assert.equal((await owner('/api/admin/assets/upload', { method: 'POST', body: JSON.stringify({ kind: 'mcp', files }) })).status, 201);
  const entry = (await owner('/api/admin/audit')).body.find((e: { action: string }) => e.action === 'asset.create');
  assert.match(entry.detail, /^上传MCP 服务器 /);
});

test('会话资产清单 API：成员也能读（只读）；没记过的返回空清单', async () => {
  const h = harness();
  const owner = h.browser();
  const member = h.browser();
  const register = (email: string) => ({ method: 'POST', body: JSON.stringify({ email, password: PASSWORD }) });
  assert.equal((await owner('/api/auth/register', register('boss@b.co'))).status, 200);
  await addTeamMember(h.admin.accounts, 'm@b.co', PASSWORD);
  assert.equal((await member('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'm@b.co', password: PASSWORD }) })).status, 200);
  const empty = await member('/api/sessions/s1/assets');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, { sessionId: 's1', workerId: null, entries: [], at: null });
  const entry = { assetId: 'a1', kind: 'skill' as const, name: 'greeter', digest: 'd1', scope: 'global' as const };
  await h.assets.deps.assets.recordSessionAssets({ sessionId: 's1', workerId: 'w1', entries: [entry], at: 5 });
  assert.deepEqual((await member('/api/sessions/s1/assets')).body.entries, [entry]);
  assert.equal((await h.browser()('/api/sessions/s1/assets')).status, 401);
});

test('资产权限：主人能增删改、分配；成员只能用（所有 /api/admin/assets* 一律 403，没登录 401）', async () => {
  const h = harness();
  const owner = h.browser();
  const member = h.browser();
  const anon = h.browser();
  const register = (email: string) => ({ method: 'POST', body: JSON.stringify({ email, password: PASSWORD }) });
  assert.equal((await owner('/api/auth/register', register('boss@b.co'))).status, 200);
  await addTeamMember(h.admin.accounts, 'm@b.co', PASSWORD);
  assert.equal((await member('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'm@b.co', password: PASSWORD }) })).status, 200);
  const made = await owner('/api/admin/assets/upload', { method: 'POST', body: JSON.stringify({ kind: 'skill', files: skillFiles('v1') }) });
  assert.equal(made.status, 201);
  const id = made.body.id as string;
  const json = (method: string, body: unknown) => ({ method, body: JSON.stringify(body) });
  const routes: [string, RequestInit][] = [
    ['/api/admin/assets', {}],
    ['/api/admin/assets/secrets', {}],
    ['/api/admin/assets/secrets/X_TOKEN', json('PUT', { value: 'v' })],
    ['/api/admin/assets/secrets/X_TOKEN', { method: 'DELETE' }],
    ['/api/admin/assets/projects/p1', {}],
    [`/api/admin/assets/projects/p1/${id}`, json('PUT', { enabled: false })],
    ['/api/admin/assets/upload', json('POST', { kind: 'skill', files: skillFiles('m') })],
    ['/api/admin/assets/git/scan', json('POST', { url: 'https://example.invalid/x.git' })],
    ['/api/admin/assets/git/import', json('POST', { url: 'https://example.invalid/x.git', kind: 'skill', path: '' })],
    [`/api/admin/assets/${id}/revisions`, {}],
    [`/api/admin/assets/${id}/file?path=SKILL.md`, {}],
    [`/api/admin/assets/${id}/diff?from=a&to=b`, {}],
    [`/api/admin/assets/${id}/revisions`, json('POST', { files: skillFiles('v2') })],
    [`/api/admin/assets/${id}/check`, json('POST', {})],
    [`/api/admin/assets/${id}/pin`, json('POST', { digest: 'x' })],
    [`/api/admin/assets/${id}/workers/w1`, json('PUT', { installed: true })],
    [`/api/admin/assets/${id}`, { method: 'DELETE' }]
  ];
  for (const [path, init] of routes) {
    assert.equal((await member(path, init)).status, 403, `成员 ${init.method ?? 'GET'} ${path}`);
    assert.equal((await anon(path, init)).status, 401, `未登录 ${init.method ?? 'GET'} ${path}`);
  }
  // 成员什么都没改动：资产还在、没装到任何机器
  const overview = (await owner('/api/admin/assets')).body;
  assert.deepEqual(overview.assets.map((asset: { id: string }) => asset.id), [id]);
  // 主人照常能分配、能删
  assert.equal((await owner(`/api/admin/assets/${id}/workers/w1`, json('PUT', { installed: true }))).status, 200);
  assert.equal((await owner(`/api/admin/assets/${id}`, { method: 'DELETE' })).status, 200);
  // 成员只读自己会话用了什么
  assert.equal((await member('/api/sessions/s1/assets')).status, 200);
});

test('资产市场 API：成员提交团队资产 → 自己批不了 → 主人看 diff / 评论 / 驳回 → 修改再提 → 批准上架；通知 + 审计；未登录 401', async () => {
  const h = harness();
  const owner = h.browser();
  const member = h.browser();
  const anon = h.browser();
  assert.equal((await anon('/api/assets/catalog')).status, 401);
  assert.equal((await owner('/api/auth/register', { method: 'POST', body: JSON.stringify({ email: 'boss@b.co', password: PASSWORD }) })).status, 200);
  await addTeamMember(h.admin.accounts, 'm@b.co', PASSWORD);
  assert.equal((await member('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'm@b.co', password: PASSWORD }) })).status, 200);
  const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) });

  const made = await member('/api/assets/upload', post({ kind: 'skill', scope: 'team', files: skillFiles('v1') }));
  assert.equal(made.status, 201);
  assert.equal(made.body.status, 'pending');
  const sid = made.body.submissionId as string;
  assert.equal((await member('/api/assets/catalog')).body.assets?.length ?? (await member('/api/assets/catalog')).body.length, 0, '没批之前不上架');
  assert.ok([400, 403, 409].includes((await member(`/api/assets/reviews/${sid}/approve`, post({}))).status), '作者不能批自己的');

  const queue = (await owner('/api/assets/reviews')).body;
  assert.ok(JSON.stringify(queue).includes(sid), '主人的待审里有它');
  const detail = await owner(`/api/assets/reviews/${sid}`);
  assert.equal(detail.status, 200);
  const diff = await owner(`/api/assets/reviews/${sid}/diff`);
  assert.equal(diff.status, 200);
  assert.equal((await owner(`/api/assets/reviews/${sid}/comments`, post({ path: 'SKILL.md', line: 4, body: '这行要改' }))).status, 201);
  assert.equal((await owner(`/api/assets/reviews/${sid}/reject`, post({ reason: '再说清楚点', changesRequested: true }))).status, 200);
  const notes = (await member('/api/notifications')).body;
  assert.ok(notes.unread >= 1);
  assert.ok(notes.items.some((n: { body: string; title: string }) => `${n.title}${n.body}`.includes('再说清楚点')));

  const again = await member(`/api/assets/items/${made.body.assetId}/revisions`, post({ files: skillFiles('v2') }));
  assert.equal(again.status, 200);
  const sid2 = again.body.submissionId as string;
  assert.equal((await owner(`/api/assets/reviews/${sid2}/approve`, post({ acknowledgeHigh: true }))).status, 200);
  const catalog = (await member('/api/assets/catalog')).body;
  assert.ok(JSON.stringify(catalog).includes(made.body.assetId), '批准后上架');
  const actions = (await owner('/api/admin/audit')).body.map((e: { action: string }) => e.action);
  for (const a of ['asset.submit', 'asset.comment', 'asset.request_changes', 'asset.approve']) assert.ok(actions.includes(a), a);
});
