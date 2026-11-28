import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Hono } from 'hono';
import { WebSocket } from 'ws';
import type { Principal, WorkdirSafety, WorkdirTerminal, WorkdirTerminalStore } from '@agent-hub/domain';
import { createWorkdirTerminalService, type WorkdirTerminalServiceOptions } from './workdir-terminal-service.ts';
import { workDirShellGranted, type WorkDirTerminalAccessOptions } from './workdir-terminal-access.ts';

const principal = { user: { id: 'u1', teamId: 'team', role: 'owner', emailVerifiedAt: 1, disabledAt: null, deletedAt: null, clusterAdmin: true }, loginId: 'login' } as Principal;
const workspace = { id: 'w1', projectId: 'p1', workerId: 'worker1', path: '/safe/path', kind: 'long_lived', state: 'ready', groupId: null };
const base = '/api/projects/p1/workdir-tabs/w1/terminals';

function setup(attachGate?: { started: () => void; release: Promise<void> }, enabled = true) {
  const rows = new Map<string, WorkdirTerminal>();
  const store: WorkdirTerminalStore = {
    create(row) { assert.equal(row.epoch, null); rows.set(row.id, row); return row; },
    get: (id) => rows.get(id) ?? null,
    getByRequest: (owner, request) => [...rows.values()].find((r) => r.ownerId === owner && r.requestId === request) ?? null,
    listNonEnded: () => [...rows.values()].filter((r) => r.state !== 'ended'),
    listByOwner: (id) => [...rows.values()].filter((r) => r.ownerId === id),
    listByWorkspace: (id) => [...rows.values()].filter((r) => r.workspaceId === id),
    listByProject: (id) => [...rows.values()].filter((r) => r.projectId === id),
    transition(id, state, epoch, next, nextEpoch, updatedAt) {
      const old = rows.get(id);
      if (!old || old.state !== state || old.epoch !== epoch) return null;
      const row = { ...old, state: next, epoch: nextEpoch, updatedAt }; rows.set(id, row); return row;
    }
  };
  const safety: WorkdirSafety = {
    hasOutstanding: () => false,
    async runExclusive(fn) { return fn(); }, assertNoRemoval() {}, assertUnoccupied() {}, assertProjectUnoccupied() {}, beginRemoval() { return 'f'; }, finishRemoval() {}
  };
  let grant = '[{"userId":"u1","workerId":"worker1"}]';
  let authenticated = true;
  let epoch = 'epoch1';
  let closed = false;
  let createCalls = 0;
  let closeCalls = 0;
  let detachCalls = 0;
  let gatewayCalls = 0;
  let offline = false;
  let createFails = false;
  let closeExits = true;
  let createState: 'running' | 'closing' | 'ended' = 'running';
  const live = new Map<string, string>();
  const access = {
    deps: {
      projects: { byId: async () => ({ id: 'p1', teamId: 'team', createdBy: 'u1', deletedAt: null }) },
      tasks: { byId: async () => null },
      workspaces: { byId: async () => workspace, linksOf: async () => [{ projectId: 'p1' }], onMachine: async () => [workspace] },
      access: { context: async () => ({ hubTeamId: 'team', settings: { membersCanAddMachines: true } }), worker: async () => ({ kind: 'worker', id: 'worker1', teamId: 'team' }) }
    }, localWorkerId: () => null, hasGrant: (userId: string, workerId: string) => workDirShellGranted(grant, userId, workerId)
  } as unknown as WorkDirTerminalAccessOptions;
  const gateway: ReturnType<WorkdirTerminalServiceOptions['gateway']> = {
    async inventory() { return { ok: true, value: { epoch, terminals: [...live].map(([terminalId, workspaceId]) => ({ terminalId, workspaceId, state: 'running' as const })) } }; },
    async create(input) { createCalls++; if (createFails) throw Error('lost'); if (createState !== 'ended') live.set(input.terminalId, input.workspaceId); return { ok: true, value: { state: createState } }; },
    async attach() { if (attachGate) { attachGate.started(); await attachGate.release; } return { ok: true, value: { scrollback: attachGate ? 'c2VjcmV0' : 'aGVsbG8=' } }; },
    async resize() { return { ok: true, value: { ok: true } }; },
    async close(input) { closeCalls++; if (closeExits) live.delete(input.terminalId); return { ok: true, value: { exited: closeExits } }; },
    detach() { detachCalls++; }, input() { return true; }
  };
  const service = createWorkdirTerminalService({ enabled: () => enabled, access, terminals: store, safety, gateway: () => { gatewayCalls++; if (offline) throw Error('worker offline'); return gateway; }, authenticate: async (token) => authenticated && token === 'good' ? principal : null, owner: async () => principal, hostAllowed: () => true });
  const app = new Hono(); service.install(app);
  const request = (method: string, url = base, body?: unknown, cookie = 'hub_login=good; hub_csrf=csrf') => app.request(url, { method, headers: { cookie, 'x-hub-csrf': 'csrf', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { service, request, rows, live, setOffline: (value: boolean) => { offline = value; }, setGrant: (value: string) => { grant = value; }, setEpoch: (value: string) => { epoch = value; }, setAuth: (value: boolean) => { authenticated = value; }, setCreateFails: (value: boolean) => { createFails = value; }, setCreateState: (value: typeof createState) => { createState = value; }, setCloseExits: (value: boolean) => { closeExits = value; }, get gatewayCalls() { return gatewayCalls; }, get createCalls() { return createCalls; }, get closeCalls() { return closeCalls; }, get detachCalls() { return detachCalls; }, close() { if (!closed) { closed = true; service.close(); } } };
}

test('shell grants are exact, opt-in and malformed config fails closed', () => {
  assert.equal(workDirShellGranted(undefined, 'u1', 'worker1'), false);
  assert.equal(workDirShellGranted('[{"userId":"u1","workerId":"worker1"}]', 'u1', 'worker1'), true);
  assert.equal(workDirShellGranted('[{"userId":"*","workerId":"worker1"}]', 'u1', 'worker1'), false);
  assert.equal(workDirShellGranted('[{"userId":"u1","workerId":"worker1"},{}]', 'u1', 'worker1'), false);
});

test('rollout disabled reports unavailable, rejects new shells and still reconciles existing reservations', async () => {
  const h = setup(undefined, false);
  try {
    h.rows.set('held', { id: 'held', requestId: 'old', ownerId: 'u1', projectId: 'p1', workspaceId: 'w1', workerId: 'worker1', cwd: '/safe/path', epoch: 'epoch1', state: 'running', createdAt: 1, updatedAt: 1 });
    h.live.set('held', 'w1');
    const list = await (await h.request('GET')).json() as { available: boolean; terminals: { id: string }[] };
    assert.equal(list.available, false);
    assert.equal(list.terminals[0]?.id, 'held');
    assert.equal((await h.request('POST', base, { requestId: 'new' })).status, 503);
    assert.equal(h.gatewayCalls, 0);
    h.setGrant('[]');
    await h.service.reconcile();
    assert.equal(h.closeCalls, 1);
    assert.equal(h.rows.get('held')?.state, 'ended');
  } finally { h.close(); }
});

test('cookie-only creation is idempotent, scoped, and confirmed close ends', async () => {
  const h = setup();
  try {
    assert.equal((await h.request('GET', base, undefined, '')).status, 401);
    assert.equal((await h.request('POST', base, { requestId: 'a', cwd: '/evil' })).status, 400);
    assert.equal((await h.request('POST', base, { requestId: 'a' }, 'hub_login=good')).status, 403);
    const first = await h.request('POST', base, { requestId: 'a' });
    assert.equal(first.status, 202);
    const row = await first.json() as { id: string; state: string; title: string };
    assert.equal(row.state, 'running'); assert.equal(row.title, '终端');
    assert.deepEqual(await (await h.request('POST', base, { requestId: 'a' })).json(), row);
    assert.equal(h.createCalls, 1);
    const list = await (await h.request('GET')).json() as { available: boolean; terminals: unknown[] };
    assert.equal(list.available, true); assert.equal(list.terminals.length, 1);
    assert.equal((await (await h.request('DELETE', `${base}/${row.id}`)).json() as { state: string }).state, 'ended');
  } finally { h.close(); }
});

test('ambiguous create is never retried; old epoch never releases reservation', async () => {
  const h = setup();
  try {
    h.setCreateFails(true);
    const row = await (await h.request('POST', base, { requestId: 'b' })).json() as { id: string; state: string };
    assert.equal(row.state, 'pending');
    await h.request('POST', base, { requestId: 'b' }); assert.equal(h.createCalls, 1);
    h.setEpoch('epoch2');
    assert.equal((await (await h.request('DELETE', `${base}/${row.id}`)).json() as { state: string }).state, 'closing');
    await h.service.reconcile(); assert.equal(h.rows.get(row.id)?.state, 'closing'); assert.equal(h.closeCalls, 0);
  } finally { h.close(); }
});

test('crash before epoch binding ends locally even when worker is offline', async () => {
  const h = setup();
  try {
    const intent = (id: string, state: 'pending' | 'closing'): WorkdirTerminal => ({ id, requestId: id, ownerId: 'u1', projectId: 'p1', workspaceId: 'w1', workerId: 'worker1', cwd: '/safe/path', epoch: null, state, createdAt: 1, updatedAt: 1 });
    h.rows.set('pending', intent('pending', 'pending'));
    h.rows.set('closing', intent('closing', 'closing'));
    h.rows.set('delete', intent('delete', 'pending'));
    h.setOffline(true);
    const closed = await h.request('DELETE', `${base}/delete`);
    assert.equal(closed.status, 202);
    assert.equal((await closed.json() as { state: string }).state, 'ended');
    assert.equal((await (await h.request('DELETE', `${base}/delete`)).json() as { state: string }).state, 'ended');
    await h.service.reconcile();
    assert.equal(h.rows.get('pending')?.state, 'ended');
    assert.equal(h.rows.get('closing')?.state, 'ended');
    assert.equal(h.gatewayCalls, 0);
  } finally { h.close(); }
});

test('create ended response alone cannot release occupancy without close fence', async () => {
  const h = setup();
  try {
    h.setCreateState('ended'); h.setCloseExits(false);
    const row = await (await h.request('POST', base, { requestId: 'ended' })).json() as { id: string; state: string };
    assert.equal(row.state, 'pending');
    await h.service.reconcile(); assert.equal(h.rows.get(row.id)?.state, 'closing');
    h.setCloseExits(true); await h.service.reconcile(); assert.equal(h.rows.get(row.id)?.state, 'ended');
  } finally { h.close(); }
});

test('revocation closes detached shell but keeps occupancy without exit confirmation', async () => {
  const h = setup();
  try {
    const row = await (await h.request('POST', base, { requestId: 'c' })).json() as { id: string };
    h.setCloseExits(false); h.setGrant('[]');
    await h.service.reconcile();
    assert.equal(h.rows.get(row.id)?.state, 'closing'); assert.equal(h.closeCalls, 1);
    h.setCloseExits(true); await h.service.reconcile(); assert.equal(h.rows.get(row.id)?.state, 'ended');
  } finally { h.close(); }
});

test('socket attaches existing terminal, rejects second writer and rechecks login on output', async () => {
  const h = setup();
  const server = createServer();
  server.on('upgrade', (req, socket, head) => h.service.attach(req, socket, head));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const row = await (await h.request('POST', base, { requestId: 'd' })).json() as { id: string };
    const url = `ws://127.0.0.1:${port}${base}/${row.id}/socket`;
    const ws = new WebSocket(url, { headers: { cookie: 'hub_login=good' } });
    const frames: { t: string; d?: string }[] = [];
    ws.on('message', (data) => frames.push(JSON.parse(data.toString()) as { t: string; d?: string }));
    await new Promise<void>((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
    for (let i = 0; frames.length < 2 && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(frames.map((f) => f.t), ['ready', 'data']);
    const second = new WebSocket(url, { headers: { cookie: 'hub_login=good' } });
    const rejected = await new Promise<boolean>((resolve) => { second.once('error', () => resolve(true)); second.once('open', () => resolve(false)); });
    assert.equal(rejected, true);
    const ended = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    h.setAuth(false); h.service.onData('worker1', 'epoch1', row.id, 'c2VjcmV0');
    await ended;
    assert.equal(frames.length, 2); assert.equal(h.detachCalls, 1);
  } finally { h.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('grant revoked while worker attach waits prevents ready and replay and closes shell', async () => {
  let release!: () => void;
  let started!: () => void;
  const attaching = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const h = setup({ started, release: gate });
  const server = createServer();
  server.on('upgrade', (req, socket, head) => h.service.attach(req, socket, head));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const row = await (await h.request('POST', base, { requestId: 'attach-revoke' })).json() as { id: string };
    const ws = new WebSocket(`ws://127.0.0.1:${port}${base}/${row.id}/socket`, { headers: { cookie: 'hub_login=good' } });
    const frames: string[] = [];
    ws.on('message', (data) => frames.push(data.toString()));
    const ended = new Promise<void>((resolve, reject) => { ws.once('close', () => resolve()); ws.once('error', reject); });
    await attaching;
    h.setGrant('[]');
    release();
    await ended;
    assert.deepEqual(frames, [], 'neither ready nor secret replay may reach the revoked user');
    assert.equal(h.detachCalls, 1);
    await h.service.reconcile();
    assert.equal(h.closeCalls, 1);
    assert.equal(h.rows.get(row.id)?.state, 'ended');
  } finally { release(); h.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
