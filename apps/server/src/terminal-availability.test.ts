import test from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryAccounts, inMemoryDeps } from '@agent-hub/domain/testing';
import { createApp } from './http.ts';
import { createStreamHub } from './stream-hub.ts';

test('availability route requires login, prevents cross-origin reads and is never cacheable', async () => {
  const accounts = inMemoryAccounts(() => 1_000_000);
  const { deps } = inMemoryDeps();
  const calls: string[] = [];
  const app = createApp({ deps, hub: createStreamHub(), token: null, auth: { accounts },
    terminalBridge: { async available(_cookie, id) { calls.push(id); return true; } } });
  const path = '/api/sessions/s1/terminal-availability';
  const unauth = await app.request(path, { headers: { authorization: 'Bearer anything' } });
  assert.equal(unauth.status, 401);
  assert.equal(unauth.headers.get('cache-control'), 'no-store');
  const register = await app.request('/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@b.co', password: 'long enough pw' }) });
  const cookie = register.headers.getSetCookie().find((c) => c.startsWith('hub_login='))!.split(';')[0]!;
  const request = (headers: Record<string, string> = {}) => app.request(`http://hub${path}`, { headers: { host: 'hub', cookie, ...headers } });
  const ok = await request({ origin: 'http://hub', 'sec-fetch-site': 'same-origin' });
  assert.equal(ok.status, 200); assert.deepEqual(await ok.json(), { available: true });
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  const deniedHeaders: Record<string, string>[] = [{ origin: 'http://evil' }, { origin: 'https://hub' }, { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'cross-site' }];
  for (const headers of deniedHeaders) {
    const response = await request(headers);
    assert.deepEqual(await response.json(), { available: false });
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.deepEqual(calls, ['s1']);
  const noAuth = createApp({ deps, hub: createStreamHub(), token: null });
  const noAuthResult = await noAuth.request(path);
  assert.deepEqual(await noAuthResult.json(), { available: false });
  assert.equal(noAuthResult.headers.get('cache-control'), 'no-store');
});
