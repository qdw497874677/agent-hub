import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryAdmin, inMemoryAssets, inMemoryDeps } from '@agent-hub/domain/testing';
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
  const app = createApp({
    deps,
    hub: createStreamHub(),
    token: null,
    auth: { accounts: admin.accounts, hubToken: null },
    admin: { deps: admin.deps },
    assets: { deps: assets.deps, audit: admin.deps.audit }
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
  return { admin, assets, browser };
}

test('资产 API：主人上传 → 装到机器 → 传新版本看 diff → 确认升级；成员 403；审计留痕', async () => {
  const h = harness();
  const owner = h.browser();
  const member = h.browser();
  const register = (email: string) => ({ method: 'POST', body: JSON.stringify({ email, password: PASSWORD }) });
  assert.equal((await owner('/api/auth/register', register('boss@b.co'))).status, 200);
  assert.equal((await member('/api/auth/register', register('m@b.co'))).status, 200);
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

test('会话资产清单 API：成员也能读（只读）；没记过的返回空清单', async () => {
  const h = harness();
  const owner = h.browser();
  const member = h.browser();
  const register = (email: string) => ({ method: 'POST', body: JSON.stringify({ email, password: PASSWORD }) });
  assert.equal((await owner('/api/auth/register', register('boss@b.co'))).status, 200);
  assert.equal((await member('/api/auth/register', register('m@b.co'))).status, 200);
  const empty = await member('/api/sessions/s1/assets');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, { sessionId: 's1', workerId: null, entries: [], at: null });
  const entry = { assetId: 'a1', kind: 'skill' as const, name: 'greeter', digest: 'd1', scope: 'global' as const };
  await h.assets.deps.assets.recordSessionAssets({ sessionId: 's1', workerId: 'w1', entries: [entry], at: 5 });
  assert.deepEqual((await member('/api/sessions/s1/assets')).body.entries, [entry]);
  assert.equal((await h.browser()('/api/sessions/s1/assets')).status, 401);
});
