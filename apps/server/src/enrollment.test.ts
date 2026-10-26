import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { inMemoryAdmin, inMemoryDeps, inMemoryEnrollment } from '@agent-hub/domain/testing';
import type { WorkerStatus } from '@agent-hub/domain';
import { createApp } from './http.ts';
import { createStreamHub } from './stream-hub.ts';

const bootstrapScript = fileURLToPath(new URL('../../../scripts/bootstrap-worker.sh', import.meta.url));

function harness() {
  const admin = inMemoryAdmin();
  const enrollment = inMemoryEnrollment(admin);
  const { deps } = inMemoryDeps();
  const app = createApp({
    deps,
    hub: createStreamHub(),
    token: null,
    auth: { accounts: admin.accounts, hubToken: null },
    admin: { deps: admin.deps, enrollment: enrollment.deps },
    enrollment: { deps: enrollment.deps, bootstrapScript, commit: 'abc1234', enrollRateMax: 3 }
  });
  const raw = (path: string, init: RequestInit = {}) => app.fetch(new Request(`http://hub:7878${path}`, init));
  const browser = () => {
    const jar = new Map<string, string>();
    return async (path: string, init: RequestInit = {}) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      if (jar.get('hub_csrf')) headers['x-hub-csrf'] = jar.get('hub_csrf')!;
      const response = await raw(path, { ...init, headers });
      for (const line of response.headers.getSetCookie()) {
        const [name, value] = line.split(';')[0]!.split('=');
        jar.set(name!, value!);
      }
      return { status: response.status, body: (await response.json().catch(() => null)) as any };
    };
  };
  const enroll = async (code: string) => {
    const response = await raw('/api/workers/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, label: '书房' })
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  return { admin, enrollment, raw, browser, enroll };
}

async function signedIn(h: ReturnType<typeof harness>) {
  const owner = h.browser();
  const member = h.browser();
  const register = (email: string) => ({ method: 'POST', body: JSON.stringify({ email, password: 'long enough pw' }) });
  await owner('/api/auth/register', register('boss@b.co'));
  await member('/api/auth/register', register('m@b.co'));
  return { owner, member };
}

test('添加机器：登录的人拿到一行命令；新机器不登录也能凭码换凭据；码只能用一次', async () => {
  const h = harness();
  const { member } = await signedIn(h);
  assert.equal((await h.browser()('/api/workers/pairing', { method: 'POST' })).status, 401);

  const pairing = await member('/api/workers/pairing', { method: 'POST' });
  assert.equal(pairing.status, 200);
  assert.equal(pairing.body.command, `curl -fsSL http://hub:7878/install-worker.sh | HUB_PAIR=${pairing.body.code} bash`);

  const enrolled = await h.enroll(pairing.body.code);
  assert.equal(enrolled.status, 200);
  assert.match(enrolled.body.credential, /^ahw_/);
  assert.equal((await h.enroll(pairing.body.code)).status, 400);
});

test('兑换按 IP 限流；乱写的码 400', async () => {
  const h = harness();
  assert.equal((await h.enroll('ahw_pair_x')).status, 400);
  await h.enroll('ahw_pair_x');
  await h.enroll('ahw_pair_x');
  assert.equal((await h.enroll('ahw_pair_x')).status, 429);
});

test('机器列表标出谁接入的；成员不能吊销别人的机器，主人可以；审计留痕', async () => {
  const h = harness();
  const { owner, member } = await signedIn(h);
  const pairing = await member('/api/workers/pairing', { method: 'POST' });
  const { workerId } = (await h.enroll(pairing.body.code)).body;
  h.admin.workerList.push({ workerId, label: '书房', origin: 'remote', state: 'online', sessionCount: 0 } as unknown as WorkerStatus);

  const listed = (await owner('/api/admin/workers')).body.workers as { workerId: string; enrolledBy: string; dedicated: boolean }[];
  assert.deepEqual(listed.map((w) => [w.workerId, w.enrolledBy, w.dedicated]), [[workerId, 'm@b.co', true]]);

  const pairing2 = await owner('/api/workers/pairing', { method: 'POST' });
  const second = (await h.enroll(pairing2.body.code)).body.workerId as string;
  assert.equal((await member(`/api/workers/${second}`, { method: 'DELETE' })).status, 403);
  assert.equal((await member(`/api/workers/${workerId}`, { method: 'DELETE' })).status, 200);
  assert.deepEqual(h.admin.disconnected, [workerId]);
  const audit = (await owner('/api/admin/audit')).body as { action: string }[];
  assert.equal(audit[0]?.action, 'worker.revoke');
  assert.ok(audit.some((a) => a.action === 'worker.enroll'));
});

test('引导脚本：填好 hub 地址和提交号；Host 头里塞 shell 字符就拒绝', async () => {
  const h = harness();
  const response = await h.raw('/install-worker.sh');
  assert.equal(response.status, 200);
  const script = await response.text();
  assert.match(script, /HUB_HTTP="\$\{HUB_HTTP:-http:\/\/hub:7878\}"/);
  assert.match(script, /HUB_COMMIT="\$\{HUB_COMMIT:-abc1234\}"/);
  const evil = await h.raw('/install-worker.sh', { headers: { host: 'x$(id)' } });
  assert.equal(evil.status, 400);
});
