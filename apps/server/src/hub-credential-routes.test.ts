import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { asLoginId, asTeamId, asUserId, type Principal, type Subject } from '@agent-hub/domain';
import { createHubCredentialBroker } from './hub-credential-broker.ts';
import { installHubCredentialRoutes } from './hub-credential-routes.ts';

test('management routes enforce browser and delegated management, never echo secrets', async () => {
  const db = new DatabaseSync(':memory:'); let actor: Subject | null = {
    user: { id: asUserId('u'), email: 'u@example.test', displayName: 'u', role: 'owner', passwordHash: null, emailVerifiedAt: 1, disabledAt: null, createdAt: 1, teamId: asTeamId('t'), clusterAdmin: false, deletedAt: null }, loginId: asLoginId('l')
  } satisfies Principal;
  let allowed = true;
  const broker = createHubCredentialBroker({ db, key: Buffer.alloc(32, 3), allowedOrigins: ['https://git.example'], resolveTarget: async () => ({ teamId: 't', repoUrl: 'https://git.example/repo', branch: 'main' }), allows: () => true,
    check: async () => ({ reachable: true, branchExists: true, defaultBranch: 'main', message: null }), read: async () => ({ ok: true, result: { branch: 'main', tip: 'x', kind: 'text', path: '', content: '' } }) });
  const app = new Hono(); installHubCredentialRoutes(app, broker, () => actor, async () => allowed);
  const base = '/api/projects/p/repos/r/hub-credential';
  const request = (method: string, path: string, body?: unknown) => app.request(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
  allowed = false; assert.equal((await request('POST', `${base}/create`, { name: 'x', credential: 'fake-secret' })).status, 403);
  allowed = true; actor = { ...(actor as Principal), via: { tokenId: 'x', name: 'x', kind: 'personal', permissions: ['project.update'] } };
  assert.equal((await request('GET', base)).status, 403);
  actor = { ...(actor as Principal), via: undefined };
  const created = await request('POST', `${base}/create`, { name: 'x', credential: 'fake-secret' });
  assert.equal(created.status, 200); assert.equal(created.headers.get('cache-control'), 'no-store'); assert.equal((await created.text()).includes('fake-secret'), false);
  const listed = await request('GET', base); const body = await listed.text(); assert.equal(body.includes('fake-secret'), false); assert.equal(JSON.parse(body).binding.name, 'x');
  assert.equal((await request('POST', `${base}/check`, { url: 'https://evil', credential: 'fake-secret' })).status, 400);
  const checked = await request('POST', `${base}/check`); assert.deepEqual(await checked.json(), { status: 'ok', branch: 'main' });
  const id = JSON.parse(body).binding.credentialId;
  assert.equal((await request('PUT', `${base}/rotate`, { credential: 'fake-new-secret' })).status, 400);
  assert.equal((await request('PUT', `${base}/rotate`, { credential: 'fake-new-secret', credentialId: id, version: 1 })).status, 200);
  assert.equal((await request('DELETE', `${base}/revoke`, { credentialId: id, version: 1 })).status, 400);
  assert.equal((await request('DELETE', `${base}/revoke`, { credentialId: id, version: 2 })).status, 200); db.close();
});
