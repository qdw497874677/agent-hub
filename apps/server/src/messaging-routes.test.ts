import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { asAgentId, asLoginId, asProjectId, asSessionId, asTeamId, asUserId, createMessageBus, deriveSession, err, type AgentMessage, type Principal, type Project } from '@agent-hub/domain';
import { inMemoryDeps } from '@agent-hub/domain/testing';
import { openSqliteStore } from '@agent-hub/storage-sqlite';
import { installMessagingRoutes } from './messaging-routes.ts';

test('message source and inbox require recipient access; source metadata and file refs require their own current session access', async (t) => {
  const { deps } = inMemoryDeps();
  const projectId = asProjectId('project');
  const teamId = asTeamId('team');
  const alice = asUserId('alice');
  const bob = asUserId('bob');
  const sourceId = asSessionId('secret-source');
  const targetId = asSessionId('recipient');
  const outsiderId = asSessionId('unrelated');
  const project: Project = { id: projectId, name: 'Fixture', repo: null, repos: [], description: null, createdAt: 0,
    teamId, createdBy: alice, members: [bob], worktree: null, checks: [], assetSetIds: [], deletedAt: null };
  await deps.projects.save(project);
  for (const [id, createdBy] of [[sourceId, bob], [targetId, alice], [outsiderId, alice]] as const) {
    const session = deriveSession({ id, createdBy, originProjectId: projectId, agentId: asAgentId('fake'), model: 'm1', now: 0 });
    assert.ok(session.ok);
    await deps.sessions.save({ ...session.value, title: id === sourceId ? 'Hidden title' : null });
  }
  const message: AgentMessage = {
    id: 'message', traceId: 'trace', projectId, depth: 0, kind: 'send', fromSessionId: sourceId,
    initiator: { kind: 'account', accountId: bob }, onBehalfOf: bob, to: `session:${targetId}`, targetSessionId: targetId,
    role: null, replyTo: null, body: '正文原样保留', status: 'delivered', failure: null, failureDetail: null,
    replyBody: null, replySource: null, idempotencyKey: null, createdAt: 0, updatedAt: 1, deliveredAt: 1, deadlineAt: null,
    parts: [{ type: 'file', session: `session:${sourceId}`, path: 'hidden.txt' }, { type: 'file', session: `session:${targetId}`, path: 'visible.txt' }]
  };
  const person = (id: typeof alice, role: 'member' | 'owner' = 'member'): Principal => ({
    user: { id, email: `${id}@example.com`, displayName: id === bob ? 'Hidden user' : 'Alice', role, passwordHash: null,
      emailVerifiedAt: 1, disabledAt: null, createdAt: 0, teamId, clusterAdmin: false, deletedAt: null }, loginId: asLoginId(id)
  });
  let actor = person(alice);
  let reads = 0;
  const store = openSqliteStore(':memory:');
  t.after(() => store.db.close());
  await store.messages.save(message);
  const messages = { ...store.messages, byId: async (id: string) => { reads++; return store.messages.byId(id); } };
  const unsupported = async () => err({ code: 'unavailable', message: 'read-only fixture' } as const);
  const bus = createMessageBus({ ...deps, messages, principalOf: async () => null, deliver: unsupported, spawn: unsupported });
  const app = new Hono();
  installMessagingRoutes(app, { messages, bus,
    users: { byId: async (id) => person(id).user },
    deps: { ...deps, access: { context: async () => ({ hubTeamId: teamId, settings: { membersCanAddMachines: false } }),
      worker: async () => ({ kind: 'worker', id: 'local', teamId, createdBy: null, local: true }) } }
  }, () => actor);

  const endpoint = `/api/sessions/${targetId}/messages`;
  const details = await app.request(`${endpoint}/message/source`);
  assert.equal(details.status, 200);
  assert.equal(details.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await details.json(), { parts: [message.parts![1]], replyStatus: null, failure: null });

  const inbox = await app.request(endpoint);
  assert.equal(inbox.status, 200);
  assert.equal(inbox.headers.get('cache-control'), 'no-store');
  const body = await inbox.json();
  assert.ok(body && typeof body === 'object' && 'messages' in body && Array.isArray(body.messages));
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].body, message.body);
  assert.equal(body.messages[0].initiatorKind, 'account');
  assert.equal(body.messages[0].senderKind, 'session');
  assert.doesNotMatch(JSON.stringify(body), /secret-source|Hidden title|Hidden user|hidden\.txt/);
  assert.equal((await app.request(`/api/sessions/${outsiderId}/messages/message/source`)).status, 404);

  actor = person(bob);
  const priorReads = reads;
  assert.equal((await app.request(`${endpoint}/message/source`)).status, 404);
  assert.equal((await app.request(endpoint)).status, 404);
  assert.equal(reads, priorReads);

  actor = person(alice, 'owner');
  const visible = await (await app.request(`${endpoint}/message/source`)).json();
  assert.deepEqual(visible, { sourceSession: { id: sourceId, label: 'Hidden title' }, initiatorName: 'Hidden user',
    parts: message.parts, replyStatus: null, failure: null });
});
