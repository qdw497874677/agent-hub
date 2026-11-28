import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { asLoginId, asUserId, type Principal, type User } from '@agent-hub/domain';
import { openSqliteStore } from '@agent-hub/storage-sqlite';
import { createWorkdirTerminalAdminStore, installWorkdirTerminalAdmin, type WorkdirTerminalReadiness } from './workdir-terminal-admin.ts';

const user = (id: string, patch: Partial<User> = {}): User => ({ id: asUserId(id), email: `${id}@example.com`, displayName: id, role: 'member', passwordHash: null, emailVerifiedAt: 1, disabledAt: null, deletedAt: null, createdAt: 1, teamId: null, clusterAdmin: false, ...patch });
const admin = user('admin', { role: 'owner', clusterAdmin: true });

function setup() {
  const sqlite = openSqliteStore(':memory:');
  const db = sqlite.db;
  const store = createWorkdirTerminalAdminStore(db);
  const people = new Map<string, User>([[admin.id, admin], ['alice', user('alice')]]);
  let principal: Principal | null = { user: admin, loginId: asLoginId('login') };
  let secure = true;
  let state: WorkdirTerminalReadiness = { mode: 'managed', enabled: false, blockedReason: null, workers: [{ id: 'w1', label: 'One' }] };
  const app = new Hono();
  // Simulate the installed auth CSRF gate, which runs before the admin installer.
  app.use('/api/*', async (c, next) => c.req.method === 'PUT' && c.req.header('x-hub-csrf') !== 'csrf' ? c.json({ error: 'csrf' }, 403) : next());
  installWorkdirTerminalAdmin(app, { store, users: { async byId(id) { return people.get(id) ?? null; }, async list() { return [...people.values()]; } }, now: () => 123, protectedTransport: () => secure, readiness: () => state }, () => principal);
  const request = (body?: unknown, csrf = true) => app.request('/api/admin/workdir-terminal-settings', body === undefined ? {} : { method: 'PUT', headers: { 'content-type': 'application/json', ...(csrf ? { 'x-hub-csrf': 'csrf' } : {}) }, body: JSON.stringify(body) });
  return { db, sqlite, store, people, request, setPrincipal: (p: Principal | null) => { principal = p; }, setSecure: (v: boolean) => { secure = v; }, setState: (v: WorkdirTerminalReadiness) => { state = v; } };
}

test('human fresh verified cluster admin, CSRF, and protected ingress are required', async () => {
  const f = setup();
  const actors: (Principal | null)[] = [null, { user: user('alice'), loginId: asLoginId('l') }, { user: admin, loginId: asLoginId('l'), via: { tokenId: 'token', name: 'token', kind: 'personal', permissions: [] } }];
  for (const principal of actors) {
    f.setPrincipal(principal);
    assert.equal((await f.request()).status, 403);
  }
  f.setPrincipal({ user: admin, loginId: asLoginId('l') });
  f.people.set('admin', { ...admin, emailVerifiedAt: null });
  assert.equal((await f.request()).status, 403);
  f.people.set('admin', { ...admin, disabledAt: 1 });
  assert.equal((await f.request()).status, 403);
  f.people.set('admin', admin);
  assert.equal((await f.request({ action: 'set-enabled', enabled: true }, false)).status, 403);
  assert.equal((await f.request({ action: 'grant', userId: 'alice', workerId: 'w1' })).status, 200);
  f.setSecure(false);
  const response = await f.request();
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json();
  assert.ok(result && typeof result === 'object' && !Array.isArray(result));
  assert.ok('mode' in result && 'workers' in result && 'users' in result && 'grants' in result);
  assert.equal(result.mode, 'unavailable');
  assert.deepEqual([result.workers, result.users, result.grants], [[], [], []]);
  assert.equal((await f.request({ action: 'set-enabled', enabled: true })).status, 403);
  f.db.close();
});

test('exact grants, readiness, read-only modes, persistence and audited transactions', async () => {
  const f = setup();
  assert.equal((await f.request({ action: 'grant', userId: 'alice', workerId: 'w1', extra: 1 })).status, 400);
  assert.equal((await f.request({ action: 'grant', userId: ' alice', workerId: 'w1' })).status, 400);
  f.people.set('alice', user('alice', { disabledAt: 1 }));
  assert.equal((await f.request({ action: 'grant', userId: 'alice', workerId: 'w1' })).status, 400);
  f.people.set('alice', user('alice'));
  assert.equal((await f.request({ action: 'grant', userId: 'alice', workerId: 'missing' })).status, 400);
  assert.equal((await f.request({ action: 'grant', userId: 'alice', workerId: 'w1' })).status, 200);
  assert.equal(f.store.hasGrant('alice', 'w1'), true);
  assert.equal(f.store.hasGrant('alice', 'w10'), false);
  assert.equal((await f.request({ action: 'set-enabled', enabled: true })).status, 200);
  const reopened = createWorkdirTerminalAdminStore(f.db);
  assert.equal(reopened.isEnabled(), true);
  assert.equal(reopened.hasGrant('alice', 'w1'), true);
  f.setState({ mode: 'managed', enabled: false, blockedReason: 'incompatible worker', workers: [] });
  assert.equal((await f.request({ action: 'set-enabled', enabled: true })).status, 409);
  assert.equal((await f.request({ action: 'grant', userId: 'alice', workerId: 'w1' })).status, 400);
  f.people.delete('alice');
  assert.equal((await f.request({ action: 'revoke', userId: 'alice', workerId: 'w1' })).status, 200);
  assert.equal((await f.request({ action: 'set-enabled', enabled: false })).status, 200);
  f.setState({ mode: 'deployment', enabled: true, blockedReason: null, workers: [] });
  assert.equal((await f.request({ action: 'set-enabled', enabled: true })).status, 503);
  f.setSecure(false);
  const deploymentResult = await (await f.request()).json();
  assert.ok(deploymentResult && typeof deploymentResult === 'object' && 'enabled' in deploymentResult);
  assert.equal(deploymentResult.enabled, true);
  assert.equal(f.store.isEnabled(), false);
  assert.deepEqual(f.db.prepare('SELECT action, actor_id, detail, at FROM audit_log ORDER BY rowid').all().map((r) => [r.action, r.actor_id, r.detail, r.at]), [
    ['workdir_terminal.grant', 'admin', '{"userId":"alice","workerId":"w1"}', 123],
    ['workdir_terminal.enabled', 'admin', '{"enabled":true}', 123],
    ['workdir_terminal.revoke', 'admin', '{"userId":"alice","workerId":"w1"}', 123],
    ['workdir_terminal.enabled', 'admin', '{"enabled":false}', 123]
  ]);
  f.db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit failed'); END");
  assert.throws(() => f.store.change({ action: 'set-enabled', enabled: true }, admin, 124), /audit failed/);
  assert.equal(f.store.isEnabled(), false);
  assert.throws(() => f.store.change({ action: 'grant', userId: 'alice', workerId: 'w1' }, admin, 124), /audit failed/);
  assert.equal(f.store.hasGrant('alice', 'w1'), false);
  f.db.close();
});

test('revoke atomically closes only exact non-ended terminals and regrant never reopens them', async () => {
  const f = setup();
  const insert = f.db.prepare('INSERT INTO workdir_terminals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const seed = (id: string, owner: string, worker: string, state: string, epoch: string | null) => insert.run(id, id, owner, 'p', 'ws', worker, '/tmp/test', epoch, state, 1, 1);
  seed('pending', 'alice', 'w1', 'pending', null);
  seed('bound', 'alice', 'w1', 'pending', 'epoch');
  seed('running', 'alice', 'w1', 'running', 'epoch');
  seed('closing', 'alice', 'w1', 'closing', 'epoch');
  seed('ended', 'alice', 'w1', 'ended', 'epoch');
  seed('other-worker', 'alice', 'w2', 'running', 'epoch');
  seed('other-owner', 'bob', 'w1', 'running', 'epoch');
  assert.equal((await f.request({ action: 'grant', userId: 'alice', workerId: 'w1' })).status, 200);
  assert.equal((await f.request({ action: 'set-enabled', enabled: false })).status, 200);
  assert.equal(f.sqlite.workdirTerminals.get('running')?.state, 'running');
  f.db.exec("CREATE TRIGGER reject_revoke BEFORE INSERT ON audit_log WHEN NEW.action = 'workdir_terminal.revoke' BEGIN SELECT RAISE(ABORT, 'audit failed'); END");
  assert.throws(() => f.store.change({ action: 'revoke', userId: 'alice', workerId: 'w1' }, admin, 122), /audit failed/);
  assert.equal(f.store.hasGrant('alice', 'w1'), true);
  assert.equal(f.sqlite.workdirTerminals.get('pending')?.state, 'pending');
  assert.equal(f.sqlite.workdirTerminals.get('running')?.state, 'running');
  f.db.exec('DROP TRIGGER reject_revoke');
  assert.equal((await f.request({ action: 'revoke', userId: 'alice', workerId: 'w1' })).status, 200);
  assert.equal((await f.request({ action: 'grant', userId: 'alice', workerId: 'w1' })).status, 200);
  for (const [id, epoch] of [['pending', null], ['bound', 'epoch'], ['running', 'epoch'], ['closing', 'epoch']] as const) {
    const row = f.sqlite.workdirTerminals.get(id);
    assert.equal(row?.state, 'closing');
    assert.equal(row?.epoch, epoch);
    assert.equal(row?.updatedAt, 123);
  }
  assert.equal(f.sqlite.workdirTerminals.get('ended')?.state, 'ended');
  assert.equal(f.sqlite.workdirTerminals.get('ended')?.updatedAt, 1);
  assert.equal(f.sqlite.workdirTerminals.get('other-worker')?.state, 'running');
  assert.equal(f.sqlite.workdirTerminals.get('other-owner')?.state, 'running');
  f.sqlite.close();
});

test('worker readiness is read after the last asynchronous user lookup', async () => {
  const f = setup();
  const app = new Hono();
  let state: WorkdirTerminalReadiness = { mode: 'managed', enabled: false, blockedReason: null, workers: [{ id: 'w1', label: 'One' }] };
  let lookups = 0;
  installWorkdirTerminalAdmin(app, {
    store: f.store,
    users: { async list() { return [admin, user('alice')]; }, async byId(id) { if (++lookups === 3) state = { ...state, blockedReason: 'worker disconnected', workers: [] }; return id === 'admin' ? admin : user('alice'); } },
    now: () => 1, protectedTransport: () => true, readiness: () => state
  }, () => ({ user: admin, loginId: asLoginId('l') }));
  const response = await app.request('/api/admin/workdir-terminal-settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'grant', userId: 'alice', workerId: 'w1' }) });
  assert.equal(response.status, 400);
  assert.equal(f.store.hasGrant('alice', 'w1'), false);
  f.sqlite.close();
});
