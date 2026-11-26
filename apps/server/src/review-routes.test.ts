import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import type { Deps, DiffReviewStore, Principal, WorkspaceFilesService } from '@agent-hub/domain';
import { installReviewRoutes } from './review-routes.ts';
import { reviewAnchor } from './review-anchor.ts';

const patch = { path: 'a.ts', patch: '@@ -1 +1 @@\n-old\n+new\n', binary: false, truncated: false };
const meta = { member: null, reviewable: true, scopeKey: 'scope', commit: null, target: null, turn: null, branch: null };
const version = reviewAnchor({ sourceSessionId: 'source', path: 'a.ts', base: 'head', ...meta }, patch)!.version;
const note = { id: 'n1', path: 'a.ts', member: null, base: 'head', side: 'new' as const, start: 1, end: 1, version, text: 'please fix', delivery: null };
const principal = { user: { id: 'u1', displayName: 'User' } } as Principal;

function fixture() {
  let lookups = 0;
  let offline = false;
  let currentPrincipal: Principal | null = principal;
  let rows = [note, { ...note, id: 'n2' }];
  let batch: { batchId: string; targetSessionId: string; noteIds: string[]; deliveryId: string; seq: number; turn: number } | null = null;
  let race = false;
  const deps = {
    sessions: { byId: async (id: string) => id === 'source' || id === 'target' ? { id, taskId: 't1', workerId: null, title: id } : null, listByTask: async () => [{ id: 'target', taskId: 't1', workerId: null, title: 'Target' }] },
    tasks: { byId: async () => ({ id: 't1', projectId: 'p1' }) }, projects: { byId: async () => ({ id: 'p1', deletedAt: null }) }
  } as unknown as Deps;
  const files = {
    authorizeReview: async () => ({ ok: true, value: undefined }),
    reviewDiff: async () => { lookups++; return offline ? { ok: false, error: { code: 'unavailable', message: 'offline' } } : { ok: true, value: { diff: patch, ...meta } }; }
  } as unknown as WorkspaceFilesService;
  const store = {
    list: async () => { if (race) { race = false; batch = { batchId: 'b1', targetSessionId: 'target', noteIds: ['n1'], deliveryId: 'd1', seq: 1, turn: 1 }; return [{ ...note, delivery: { batchId: 'b1', targetSessionId: 'target', deliveryId: 'd1', state: 'queued' } }]; } return rows; },
    batch: async () => batch,
    save: async (_scope: unknown, saved: typeof note) => { rows.push({ ...saved, delivery: null }); return true; },
    remove: async () => true
  } as unknown as DiffReviewStore;
  const app = new Hono();
  installReviewRoutes(app, deps, files, store, () => currentPrincipal);
  return { app, lookups: () => lookups, offline: () => { offline = true; }, anonymous: () => { currentPrincipal = null; }, race: () => { race = true; }, setRows: (v: typeof rows) => { rows = v; } };
}

test('review list memoizes per anchor and reports offline as unknown', async () => {
  const f = fixture();
  let res = await f.app.request('/api/sessions/source/git/review');
  assert.equal(res.status, 200);
  const data = await res.json() as { notes: Array<{ anchorState: string }>; targets: Array<{ id: string }> };
  assert.deepEqual(data.notes.map(n => n.anchorState), ['current', 'current']);
  assert.deepEqual(data.targets.map(t => t.id), ['target']);
  assert.equal(f.lookups(), 1);
  f.offline();
  res = await f.app.request('/api/sessions/source/git/review');
  assert.deepEqual((await res.json() as typeof data).notes.map(n => n.anchorState), ['unknown', 'unknown']);
  assert.equal(f.lookups(), 2);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('explicit note subset reaches later drafts and statusOnly avoids worker calls', async () => {
  const f = fixture();
  f.setRows(Array.from({ length: 21 }, (_, i) => ({ ...note, id: `n${i}`, path: i === 20 ? 'a.ts' : `file${i}` })));
  let res = await f.app.request('/api/sessions/source/git/review?note=n20');
  const data = await res.json() as { notes: Array<{ anchorState: string }> };
  assert.equal(data.notes[0]?.anchorState, 'unknown');
  assert.equal(data.notes[20]?.anchorState, 'current');
  assert.equal(f.lookups(), 1);
  res = await f.app.request('/api/sessions/source/git/review?statusOnly=1');
  assert.equal((await res.json() as typeof data).notes.every(n => n.anchorState === 'unknown'), true);
  assert.equal(f.lookups(), 1);
  res = await f.app.request(`/api/sessions/source/git/review?${Array.from({ length: 21 }, (_, i) => `note=n${i}`).join('&')}`);
  assert.equal(res.status, 400);
});

test('review is human-only, validates anchors, and recovers same-key admission race', async () => {
  const f = fixture();
  const request = (path: string, data: unknown) => f.app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  let res = await request('/api/sessions/source/git/review/notes', { ...note, id: undefined, delivery: undefined, start: 2, end: 2 });
  assert.equal(res.status, 409);
  f.race();
  res = await request('/api/sessions/source/git/review/send', { batchId: 'b1', targetSessionId: 'target', noteIds: ['n1'] });
  assert.equal(res.status, 202);
  res = await request('/api/sessions/source/git/review/send', { batchId: 'b1', targetSessionId: 'target', noteIds: ['n2'] });
  assert.equal(res.status, 409);
  f.anonymous();
  assert.equal((await f.app.request('/api/sessions/source/git/review')).status, 404);
});
