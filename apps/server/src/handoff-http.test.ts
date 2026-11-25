import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asAgentId, createProject, createTask, deriveSession, ok, recordEvent, type AgentHandoffRecord } from '@agent-hub/domain';
import { inMemoryAccounts, inMemoryApiTokens, inMemoryDeliveries, inMemoryDeps } from '@agent-hub/domain/testing';
import { createApp } from './http.ts';
import { createStreamHub } from './stream-hub.ts';
import type { AgentHandoffService } from './agent-handoff.ts';

test('authenticated browser, v1 and MCP protect unresolved handoff mutations and keep reads available', async () => {
  const accounts = inMemoryAccounts();
  const deliveries = inMemoryDeliveries();
  const world = inMemoryDeps({ deliveries });
  const project = createProject({ name: 'handoff', now: 1 }); assert.ok(project.ok);
  await world.deps.projects.save(project.value);
  const task = createTask({ projectId: project.value.id, title: 'task', now: 1 }); assert.ok(task.ok);
  await world.deps.tasks.save(task.value);
  const target = deriveSession({ task: task.value, agentId: asAgentId('fake'), model: 'm', now: 1 }); assert.ok(target.ok);
  await world.deps.sessions.save(target.value);
  let record = { reservation: { target: target.value }, first: null, startup: { state: 'pending', attemptId: null, workerId: null, connectionId: null } } as unknown as AgentHandoffRecord;
  let broken = false;
  const deps = { ...world.deps, agentHandoffs: { byTarget: async (id: string) => { if (broken) throw Error('private'); return id === target.value.id ? record : null; } } };
  const tokenDeps = { apiTokens: inMemoryApiTokens(), users: accounts.users, projects: deps.projects, tokens: accounts.tokens, audit: accounts.audit, now: () => Date.now() };
  let reserveCalls = 0;
  const agentHandoff = { reserve: async () => { reserveCalls++; return ok({ sessionId: 'next' }); }, metadata: async () => ok({ handoff: null }), first: async () => ok({ seq: 1, deliveryId: 'first', state: 'queued', turn: 1 }) } as AgentHandoffService;
  const app = createApp({ deps, hub: createStreamHub(), token: null, auth: { accounts }, openApi: { tokens: tokenDeps, manage: tokenDeps }, agentHandoff });
  const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const login = await app.request('/api/auth/register', json({ email: 'handoff@example.com', password: 'long enough pw' }));
  assert.equal(login.status, 200);
  const cookies = login.headers.getSetCookie().map(line => line.split(';')[0]!).join('; ');
  const csrf = /hub_csrf=([^;]+)/.exec(cookies)?.[1]; assert.ok(csrf);
  const browser = (path: string, method = 'GET', body?: unknown) => app.request(path, { method, headers: { cookie: cookies, 'x-hub-csrf': csrf, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const id = target.value.id;
  assert.equal((await app.request(`/api/sessions/${id}/agent-handoff`)).status, 401);
  assert.equal((await browser(`/api/sessions/${id}`)).status, 200);
  assert.equal((await browser(`/api/sessions/${id}/agent-handoff`)).status, 200);
  assert.equal((await browser(`/api/sessions/${id}/agent-handoff/first`, 'POST', { text: 'hello', clientMessageId: 'key', withHistory: false })).status, 200);
  for (const [path, method, body] of [
    [`/api/sessions/${id}/options`, 'POST', { optionId: 'model', value: 'other' }],
    [`/api/sessions/${id}/mcp`, 'PATCH', { disabled: [] }],
    [`/api/sessions/${id}/continue`, 'POST', {}],
    [`/api/sessions/${id}/rewind`, 'POST', { promptSeq: 1 }],
    ['/api/sessions/fork', 'POST', { sessionId: id }],
    ['/api/sessions/derive', 'POST', { parentSessionId: id }],
    ['/api/sessions/derive', 'POST', { linkWith: [id] }],
    [`/api/projects/${project.value.id}/session-links`, 'POST', { aSessionId: id, bSessionId: 'other' }],
  ] as const) assert.equal((await browser(path, method, body)).status, 409, path);
  assert.equal((await browser(`/api/sessions/${id}/agent-handoff`, 'POST', { agentId: 'a', model: 'm', requestId: 'r' })).status, 200);
  assert.equal(reserveCalls, 1);
  const minted = await browser('/api/tokens', 'POST', { name: 'test', scopes: ['sessions:read', 'sessions:write'] });
  assert.equal(minted.status, 201); const token = (await minted.json() as { token: string }).token;
  const api = (path: string, body: unknown) => app.request(`/openapi/v1${path}`, { ...json(body), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
  assert.equal((await api(`/sessions/${id}/model`, { model: 'other' })).status, 409);
  assert.equal((await api('/sessions/fork', { sessionId: id })).status, 409);
  const mcp = await app.request('/openapi/v1/mcp', { ...json({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'session_model', arguments: { sessionId: id, model: 'other', clientRequestId: 'mcp-key' } } }), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' } });
  const mcpText = await mcp.text();
  assert.match(mcpText, /HTTP 409/);
  broken = true;
  assert.equal((await browser(`/api/sessions/${id}/options`, 'POST', { optionId: 'model', value: 'x' })).status, 503);
  broken = false;
  const first = { id: 'first', sessionId: id, seq: 1, kind: 'prompt' as const, payload: { text: 'x', parts: [] }, state: 'delivered' as const, attempt: 0, nextAt: 0, lastError: null, createdAt: 1, updatedAt: 1 };
  await deliveries.save(first);
  record = { ...record, first: { requestKey: 'key', semanticHash: 'hash', event: { kind: 'prompt', text: 'x' }, delivery: first } };
  await recordEvent(deps, { sessionId: id, event: { kind: 'prompt', text: 'x' } });
  await recordEvent(deps, { sessionId: id, event: { kind: 'ended', outcome: 'done', deliveryId: 'first' } });
  // Post-completion the gate is transparent; the underlying option validation answers.
  assert.notEqual((await browser(`/api/sessions/${id}/options`, 'POST', { optionId: 'model', value: 'other' })).status, 409);
  assert.deepEqual(world.dispatched, []);
});
