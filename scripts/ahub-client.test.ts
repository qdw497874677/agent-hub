import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, lstatSync, readFileSync, symlinkSync, linkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHubClient, HubClientError, parseHubBase, readProfile, removeProfile, resolveConnection, writeProfile } from './ahub-client.ts';

const token = 'ahp_synthetic_only';
const profile = { hubUrl: 'https://hub.example/proxy/', token };
const ok: typeof fetch = async () => new Response('{"user":{"id":"synthetic"},"token":{"id":"synthetic"}}', { status: 200 });
const kind = (expected: string) => (error: unknown) => error instanceof HubClientError && error.kind === expected;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ahub-client-test-'));
  return { root, dir: join(root, 'private'), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('base URL policy preserves prefix and rejects unsafe forms', () => {
  assert.equal(parseHubBase('https://EXAMPLE.com:443/proxy/').href, 'https://example.com/proxy');
  for (const url of ['http://127.0.0.1', 'http://example.com', 'https://u:p@host/', 'https://host/?x', 'https://host/#x', 'https://host/a/../b', 'https://host/a/%2f/b', 'https://host/a/%252e%252e/b', 'https://host\\evil']) {
    assert.throws(() => parseHubBase(url), kind('configuration'), url);
  }
  assert.equal(parseHubBase('http://127.0.0.1:9000/x', true).href, 'http://127.0.0.1:9000/x');
  assert.equal(parseHubBase('http://[::1]:9000', true).hostname, '[::1]');
  assert.throws(() => parseHubBase('http://192.168.1.1', true), kind('configuration'));
  assert.throws(() => parseHubBase('http://127.example.invalid', true), kind('configuration'));
});

test('environment credentials must be paired and never mixed with profile', () => {
  assert.deepEqual(resolveConnection({}, profile), { hubUrl: 'https://hub.example/proxy', token });
  assert.deepEqual(resolveConnection({ AHUB_HUB_URL: 'https://other.example', AHUB_API_TOKEN: 'ahp_other' }, profile), { hubUrl: 'https://other.example', token: 'ahp_other' });
  for (const env of [{ AHUB_API_TOKEN: token }, { AHUB_HUB_URL: 'https://host' }, { AHUB_HUB_URL: '', AHUB_API_TOKEN: token }, { AHUB_HUB_URL: 'https://host', AHUB_API_TOKEN: 'legacy' }]) assert.throws(() => resolveConnection(env, profile), kind('configuration'));
});

test('profile verifies /me before atomic private storage, supports separate names and removal', async () => {
  const f = fixture();
  try {
    let called = 0;
    const fetcher: typeof fetch = async (url, init) => {
      called++;
      assert.equal(String(url), 'https://hub.example/proxy/openapi/v1/me');
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${token}`);
      return ok(url, init);
    };
    const opts = { directory: f.dir, fetch: fetcher };
    await writeProfile('one', profile, opts);
    assert.equal(called, 1);
    assert.equal(lstatSync(f.dir).mode & 0o777, 0o700);
    assert.equal(lstatSync(join(f.dir, 'one.json')).mode & 0o777, 0o600);
    assert.deepEqual(await readProfile('one', opts), { hubUrl: 'https://hub.example/proxy', token });
    await writeProfile('two', profile, opts);
    await removeProfile('one', opts);
    assert.equal(await readProfile('one', opts), undefined);
    assert.ok(await readProfile('two', opts));
    await removeProfile('one', opts);
    await assert.rejects(writeProfile('../escape', profile, opts), kind('configuration'));
  } finally { f.cleanup(); }
});

test('profile write fails closed on authentication failure and unrelated files', async () => {
  const f = fixture();
  try {
    const opts = { directory: f.dir, fetch: ok };
    await writeProfile('one', profile, opts);
    const before = readFileSync(join(f.dir, 'one.json'), 'utf8');
    await assert.rejects(writeProfile('one', { ...profile, token: 'ahp_bad' }, { ...opts, fetch: async () => new Response('sensitive', { status: 401 }) }), kind('http'));
    assert.equal(readFileSync(join(f.dir, 'one.json'), 'utf8'), before);
    await assert.rejects(writeProfile('one', profile, { ...opts, fetch: async () => new Response('{}') }), kind('protocol'));
    assert.equal(readFileSync(join(f.dir, 'one.json'), 'utf8'), before);
    writeFileSync(join(f.dir, 'other.json'), 'unrelated', { mode: 0o600 });
    await assert.rejects(writeProfile('other', profile, opts), kind('storage'));
    await assert.rejects(removeProfile('other', opts), kind('storage'));
    assert.equal(readFileSync(join(f.dir, 'other.json'), 'utf8'), 'unrelated');
  } finally { f.cleanup(); }
});

test('profiles reject unsafe permissions, symlinks and hard links', async () => {
  const f = fixture();
  try {
    mkdirSync(f.dir, { mode: 0o700 });
    const opts = { directory: f.dir, fetch: ok };
    await writeProfile('one', profile, opts);
    chmodSync(join(f.dir, 'one.json'), 0o644);
    await assert.rejects(readProfile('one', opts), kind('storage'));
    chmodSync(join(f.dir, 'one.json'), 0o600);
    symlinkSync(join(f.dir, 'one.json'), join(f.dir, 'link.json'));
    await assert.rejects(readProfile('link', opts), kind('storage'));
    await assert.rejects(writeProfile('link', profile, opts), kind('storage'));
    linkSync(join(f.dir, 'one.json'), join(f.dir, 'hard.json'));
    await assert.rejects(readProfile('one', opts), kind('storage'));
    chmodSync(f.dir, 0o755);
    await assert.rejects(readProfile('one', opts), kind('storage'));
    chmodSync(f.dir, 0o700);
    symlinkSync(f.dir, join(f.root, 'alias'));
    await assert.rejects(readProfile('one', { directory: join(f.root, 'alias') }), kind('storage'));
  } finally { f.cleanup(); }
});

test('requests preserve prefix, isolate authorization and forbid escape/redirect', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = createHubClient(profile, { fetch: async (url, init) => { requests.push({ url: String(url), init }); return new Response('{"value":1}'); } });
  assert.deepEqual(await client.request('/tasks?cursor=x'), { value: 1 });
  assert.equal(requests[0].url, 'https://hub.example/proxy/openapi/v1/tasks?cursor=x');
  assert.equal(requests[0].init?.redirect, 'manual');
  assert.equal(new Headers(requests[0].init?.headers).get('authorization'), `Bearer ${token}`);
  for (const path of ['//evil/x', '/../evil', '/%2e%2e/evil', '/%252e%252e/evil', '/foo%2fbar', '/foo\\bar', 'https://evil', '/x#frag']) await assert.rejects(client.request(path), kind('configuration'));
  await assert.rejects(client.request('/me', { headers: { Authorization: 'other' } }), kind('configuration'));
  const redirect = createHubClient(profile, { fetch: async () => new Response(null, { status: 302, headers: { location: 'https://other.example/' } }) });
  await assert.rejects(redirect.request('/me'), kind('redirect'));
  assert.equal(requests.length, 1);
});

test('errors sanitize server content and bearer, include bounded retry metadata, never retry mutations', async () => {
  let calls = 0;
  const client = createHubClient(profile, { fetch: async () => { calls++; return new Response(`secret ${token}`, { status: 503, headers: { 'retry-after': '3' } }); } });
  await assert.rejects(client.request('/tasks', { method: 'POST', body: { prompt: 'private' } }), (e: HubClientError) => {
    assert.equal(e.kind, 'http'); assert.equal(e.status, 503); assert.equal(e.retryAfterMs, 3000); assert.equal(e.retryable, false);
    assert.ok(!JSON.stringify(e).includes(token)); assert.ok(!String(e).includes('secret')); return true;
  });
  assert.equal(calls, 1);
  await assert.rejects(client.request('/tasks'), (e: HubClientError) => e.retryable && e.status === 503);
  const network = createHubClient(profile, { fetch: async () => { throw new Error(`bad ${token}`); } });
  await assert.rejects(network.request('/me'), (e: HubClientError) => e.kind === 'network' && !String(e).includes(token));
});

test('bounds response bytes and total time even if fetch ignores abort', async () => {
  const large = createHubClient(profile, { maxResponseBytes: 3, fetch: async () => new Response('1234') });
  await assert.rejects(large.request('/me'), kind('protocol'));
  const stalled = createHubClient(profile, { timeoutMs: 10, fetch: async () => new Promise(() => {}) });
  await assert.rejects(stalled.request('/me'), kind('timeout'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(stalled.request('/me', { signal: controller.signal }), kind('aborted'));
});
