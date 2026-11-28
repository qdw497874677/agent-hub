import test from 'node:test';
import assert from 'node:assert/strict';
import type { Principal, ProcessInfo, Workspace } from '@agent-hub/domain';
import { createDevelopmentServices, type DevelopmentServicesOptions } from './development-services.ts';

const actor = { user: { id: 'user', teamId: 'team', role: 'member', emailVerifiedAt: 1, disabledAt: null, deletedAt: null, clusterAdmin: false }, loginId: 'login' } as Principal;
const viewer = { ...actor, user: { ...actor.user, role: 'viewer' } } as Principal;
const ws = (id: string, path: string, projectId = 'mine') => ({ id, path, projectId, workerId: 'machine', teamId: 'team', kind: 'long_lived', state: 'ready', label: id }) as Workspace;
const proc = (cwd: string, port: number, identity?: string): ProcessInfo => ({ pid: port, ppid: 1, cwd, cwdVerified: true, cmd: 'SECRET', ports: [port], ...(identity ? { listeners: [{ port, identity }] } : {}) } as ProcessInfo);

function setup() {
  let rows = [ws('outer', '/repo')];
  let processes = [proc('/repo/app', 3000, 'a'.repeat(64))];
  let online = true;
  let calls = 0;
  let channel = true;
  let resolveRoots: (paths: readonly string[]) => readonly (string | null)[] = (paths) => paths.map((path) => path.replace(/\/+$/, '') || '/');
  let rootCalls = 0;
  let beforeScan: (() => void) | undefined;
  let onLinks: ((id: string) => void) | undefined;
  const options = {
    canOpen: () => channel,
    deps: {
      gateway: { status: async () => [{ workerId: 'machine', label: 'Machine', origin: 'remote', state: online ? 'online' : 'offline' }], processes: async () => { calls++; beforeScan?.(); return { ok: true, value: processes }; }, developmentRoots: async (_id: string, paths: readonly string[]) => { rootCalls++; return { ok: true, value: resolveRoots(paths) }; } },
      workspaces: { onMachine: async (id: string | null) => rows.filter((w) => w.workerId === id), byId: async (id: string) => rows.find((w) => w.id === id) ?? null, linksOf: async (id: string) => { onLinks?.(id); const w = rows.find((r) => r.id === id); return w ? [{ projectId: w.projectId }] : []; } },
      projects: { byId: async (id: string) => ({ id, teamId: 'team', createdBy: id === 'mine' ? 'user' : 'other', deletedAt: null }) },
      tasks: { byId: async () => null },
      access: { context: async () => ({ hubTeamId: 'team', settings: {} }), worker: async () => ({ kind: 'worker', id: 'machine', teamId: 'team' }) }
    }
  } as unknown as DevelopmentServicesOptions;
  return { service: createDevelopmentServices(options), setRows: (value: Workspace[]) => { rows = value; }, setProcesses: (value: ProcessInfo[]) => { processes = value; }, setOnline: (value: boolean) => { online = value; }, setChannel: (value: boolean) => { channel = value; }, setBeforeScan: (fn: () => void) => { beforeScan = fn; }, setOnLinks: (fn: ((id: string) => void) | undefined) => { onLinks = fn; }, setRoots: (fn: typeof resolveRoots) => { resolveRoots = fn; }, disableRoots: () => { delete (options.deps.gateway as { developmentRoots?: unknown }).developmentRoots; }, get calls() { return calls; }, get rootCalls() { return rootCalls; } };
}

test('visible grouping hides raw process details and avoids discovery for summary', async () => {
  const h = setup();
  assert.deepEqual(await h.service.workers(actor), [{ id: 'machine', name: 'Machine', state: 'online' }]);
  assert.equal(h.calls, 0);
  const view = await h.service.worker(actor, 'machine');
  assert.equal(view?.state, 'ready');
  const group = view?.groups[0];
  assert.equal(group?.workspaceId, 'outer');
  assert.equal(group?.services[0]?.openable, true);
  assert.match(group!.services[0]!.id!, /^ds_[a-f0-9]{64}\./);
  assert.doesNotMatch(JSON.stringify(view), /SECRET|\/repo|aaaaaaaa/);
});

test('hidden nested registration and equal roots are never reassigned to visible parent', async () => {
  const h = setup();
  h.setRows([ws('outer', '/repo'), ws('hidden', '/repo/private', 'hidden')]);
  h.setProcesses([proc('/repo/private/app', 3000, 'a'.repeat(64)), proc('/repo/public', 3001, 'b'.repeat(64))]);
  const result = await h.service.worker(actor, 'machine');
  assert.deepEqual(result?.groups.flatMap((g) => g.services.map((s) => s.port)), [3001]);
  h.setRows([ws('outer', '/repo'), ws('duplicate', '/repo/', 'hidden')]);
  assert.deepEqual((await h.service.worker(actor, 'machine'))?.groups, []);
});

test('legacy listeners and viewers are display-only; token principals are rejected', async () => {
  const h = setup();
  h.setProcesses([proc('/repo/app', 3000), proc('/repo/app', 3001, 'a'.repeat(64))]);
  const legacy = (await h.service.worker(actor, 'machine'))!.groups[0]!.services[0]!;
  assert.deepEqual(legacy, { id: null, port: 3000, name: '端口 3000', openable: false });
  const viewerEntries = (await h.service.worker(viewer, 'machine'))!.groups[0]!.services;
  assert.ok(viewerEntries.every((s) => !s.openable));
  assert.ok(viewerEntries[1]!.id);
  assert.equal((await h.service.service(viewer, viewerEntries[1]!.id!))?.openable, false);
  assert.equal(await h.service.selectOpen(viewer, viewerEntries[1]!.id!), null);
  assert.equal(await h.service.manual(viewer, { workerId: 'machine', workspaceId: 'outer', port: 3001 }), null);
  assert.equal(await h.service.worker({ ...actor, via: {} } as Principal, 'machine'), null);
});

test('reference is live-bound to listener, manual requires exact workspace, authorizer rechecks', async () => {
  const h = setup();
  const selected = await h.service.manual(actor, { workerId: 'machine', workspaceId: 'outer', port: 3000 });
  assert.ok(selected);
  assert.equal((await h.service.service(actor, selected.id))?.id, selected.id);
  assert.equal((await h.service.selectOpen(actor, selected.id))?.id, selected.id);
  assert.equal(await h.service.authorizeDestination(actor, selected), true);
  assert.equal(await h.service.manual(actor, { workerId: 'machine', workspaceId: 'other', port: 3000 }), null);
  h.setProcesses([proc('/repo/app', 3000, 'b'.repeat(64))]);
  assert.equal(await h.service.service(actor, selected.id), null);
  assert.notEqual((await h.service.manual(actor, { workerId: 'machine', workspaceId: 'outer', port: 3000 }))?.id, selected.id);
  h.setRows([ws('outer', '/repo'), ws('duplicate', '/repo')]);
  assert.equal(await h.service.authorizeDestination(actor, selected), false);
  assert.equal(await h.service.service(actor, selected.id), null);
  h.setOnline(false);
  assert.equal((await h.service.worker(actor, 'machine'))?.state, 'offline');
});

test('privileged ports and unassigned processes remain hidden', async () => {
  const h = setup();
  h.setProcesses([proc('/repo', 80, 'a'.repeat(64)), proc('/unknown', 4321, 'b'.repeat(64))]);
  assert.deepEqual((await h.service.worker(actor, 'machine'))?.groups, []);
  assert.equal(await h.service.manual(actor, { workerId: 'machine', workspaceId: 'outer', port: 80 }), null);
});

test('identity survives an unavailable opening channel as read-only', async () => {
  const h = setup();
  h.setChannel(false);
  const entry = (await h.service.worker(actor, 'machine'))!.groups[0]!.services[0]!;
  assert.ok(entry.id);
  assert.equal(entry.openable, false);
  assert.equal((await h.service.service(actor, entry.id))?.openable, false);
  assert.equal(await h.service.selectOpen(actor, entry.id), null);
  assert.equal(await h.service.manual(actor, { workerId: 'machine', workspaceId: 'outer', port: 3000 }), null);
  h.setChannel(true);
  assert.equal((await h.service.selectOpen(actor, entry.id))?.id, entry.id);
});

test('destination rejects nested, duplicate, moved, removed and malformed paths, including changes during ACL checks', async () => {
  const h = setup();
  const selected = (await h.service.manual(actor, { workerId: 'machine', workspaceId: 'outer', port: 3000 }))!;
  assert.equal(selected.cwd, '/repo/app');
  assert.equal(await h.service.authorizeDestination(actor, { ...selected, cwd: '/other' }), false);
  assert.equal(await h.service.authorizeDestination(actor, { ...selected, cwd: '/repo/./app' }), false);
  h.setRows([ws('outer', '/repo'), ws('hidden', '/repo/app', 'hidden')]);
  assert.equal(await h.service.authorizeDestination(actor, selected), false);
  h.setRows([ws('outer', '/repo'), ws('duplicate', '/repo')]);
  assert.equal(await h.service.authorizeDestination(actor, selected), false);
  h.setRows([ws('outer', '/moved')]);
  assert.equal(await h.service.authorizeDestination(actor, selected), false);
  h.setRows([{ ...ws('outer', '/repo'), state: 'removed' }]);
  assert.equal(await h.service.authorizeDestination(actor, selected), false);
  h.setRows([ws('outer', '/repo')]);
  h.setOnLinks(() => h.setRows([ws('outer', '/repo'), ws('hidden', '/repo/app', 'hidden')]));
  assert.equal(await h.service.authorizeDestination(actor, selected), false);
});

test('final projection rechecks workspace visibility after other entries are evaluated', async () => {
  const h = setup();
  h.setRows([ws('outer', '/repo'), ws('second', '/another')]);
  h.setProcesses([proc('/repo/app', 3000, 'a'.repeat(64)), proc('/another/app', 3001, 'b'.repeat(64))]);
  h.setOnLinks((id) => {
    if (id === 'second') h.setRows([ws('outer', '/repo', 'hidden'), ws('second', '/another')]);
  });
  const groups = (await h.service.worker(actor, 'machine'))!.groups;
  assert.deepEqual(groups.map((g) => g.workspaceId), ['second']);
});

test('workspace visibility is re-evaluated after the process scan', async () => {
  const h = setup();
  h.setBeforeScan(() => h.setRows([ws('outer', '/repo', 'hidden')]));
  assert.deepEqual((await h.service.worker(actor, 'machine'))?.groups, []);
});

test('physical deepest hidden registration and canonical aliases block attribution', async () => {
  const h = setup();
  h.setRows([ws('outer', '/repo'), ws('hidden', '/alias', 'hidden')]);
  h.setRoots((paths) => paths.map((p) => p === '/alias' ? '/repo/app' : p));
  assert.deepEqual((await h.service.worker(actor, 'machine'))?.groups, []);
  h.setRoots((paths) => paths.map((p) => p === '/alias' ? '/repo' : p));
  assert.deepEqual((await h.service.worker(actor, 'machine'))?.groups, []);
});

test('unresolved or unsupported roots, overflow, and unverified cwd fail closed', async () => {
  const h = setup();
  h.setRows([ws('outer', '/repo'), ws('hidden', '/hidden', 'hidden')]);
  h.setRoots((paths) => paths.map((p) => p === '/hidden' ? null : p));
  assert.equal((await h.service.worker(actor, 'machine'))?.state, 'unavailable');
  h.setRoots((paths) => paths);
  h.setRows(Array.from({ length: 257 }, (_, i) => ws(`w${i}`, `/root${i}`)));
  const calls = h.rootCalls;
  assert.equal((await h.service.worker(actor, 'machine'))?.state, 'unavailable');
  assert.equal(h.rootCalls, calls);
  h.setRows([ws('outer', '/repo')]);
  h.setProcesses([{ ...proc('/repo/app', 3000, 'a'.repeat(64)), cwdVerified: undefined } as ProcessInfo]);
  assert.deepEqual((await h.service.worker(actor, 'machine'))?.groups, []);
  h.disableRoots();
  assert.equal((await h.service.worker(actor, 'machine'))?.state, 'unavailable');
});

test('canonical roots are resolved again after ACL and for selection and destination', async () => {
  const h = setup();
  h.setRows([ws('outer', '/alias')]);
  h.setRoots((paths) => paths.map((p) => p === '/alias' ? '/repo' : p));
  const selected = await h.service.manual(actor, { workerId: 'machine', workspaceId: 'outer', port: 3000 });
  assert.equal(selected?.root, '/repo');
  assert.ok(selected);
  assert.equal(await h.service.authorizeDestination(actor, selected), true);
  h.setRoots((paths) => paths.map((p) => p === '/alias' ? '/elsewhere' : p));
  assert.equal(await h.service.selectOpen(actor, selected.id), null);
  assert.equal(await h.service.authorizeDestination(actor, selected), false);
  h.setRoots((paths) => paths.map((p) => p === '/alias' ? '/repo' : p === '/repo/app' ? '/moved' : p));
  assert.equal(await h.service.authorizeDestination(actor, selected), false);
  let n = 0;
  h.setRoots((paths) => { n++; return paths.map((p) => p === '/alias' ? (n === 1 ? '/repo' : '/elsewhere') : p); });
  assert.deepEqual((await h.service.worker(actor, 'machine'))?.groups, []);
});

test('registration mutation during root resolution withholds the response', async () => {
  const h = setup();
  h.setRoots((paths) => { h.setRows([ws('outer', '/repo'), ws('hidden', '/repo/app', 'hidden')]); return paths; });
  assert.equal((await h.service.worker(actor, 'machine'))?.state, 'unavailable');
});
