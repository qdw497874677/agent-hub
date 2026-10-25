import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AgentDescriptor } from '@agent-hub/domain';
import {
  asAgentId,
  createProjectUseCase,
  createTaskToolProvider,
  createTaskUseCase,
  createToolGateway,
  deriveSessionUseCase,
  withToolAccess
} from '@agent-hub/domain';
import { fakeToolGrants, inMemoryDeps } from '@agent-hub/domain/testing';
import { installMcp } from './mcp.ts';

const fake = {
  id: asAgentId('fake'),
  label: 'Fake',
  capabilities: Object.fromEntries(
    ['prompt', 'interrupt', 'fork', 'resume', 'tool_calls', 'artifacts', 'structured_events', 'attachments'].map((k) => [k, { state: 'available' }])
  ),
  models: ['m1'],
  defaultModel: 'm1',
  options: []
} as unknown as AgentDescriptor;

async function setup() {
  const w = inMemoryDeps();
  w.agents.push(fake);
  const project = await createProjectUseCase(w.deps, { name: 'demo', rootPath: '/tmp/demo' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: '接通能力层', ownerId: 'u1' });
  assert.ok(task.ok);
  const session = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  assert.ok(session.ok);
  let n = 0;
  const gateway = createToolGateway({
    now: w.deps.now,
    toolGrants: fakeToolGrants(),
    tokens: { issue: () => ({ token: `tok-${++n}`, hash: `h-tok-${n}` }), hashOf: (t: string) => `h-${t}` },
    providers: [createTaskToolProvider(w.deps)]
  });
  const app = new Hono();
  installMcp(app, gateway);
  const fetchApp = (async (input: string | URL | Request, init?: RequestInit) =>
    app.request(new Request(input, init))) as typeof fetch;
  return { w, session: session.value, task: task.value, gateway, fetchApp };
}

async function connect(fetchApp: typeof fetch, token: string) {
  const client = new Client({ name: 'test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1/mcp'), {
    fetch: fetchApp,
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  });
  await client.connect(transport);
  return client;
}

test('/mcp：官方 SDK 客户端用工具令牌列工具、读任务、写交接', async () => {
  const s = await setup();
  const command = await withToolAccess(s.gateway, { url: 'http://127.0.0.1/mcp' }, {
    kind: 'start_session',
    sessionId: s.session.id,
    taskId: s.task.id,
    workerId: 'local'
  } as never);
  assert.equal(command.kind, 'start_session');
  const tools = (command as { tools?: { token: string; transport: string } }).tools;
  assert.ok(tools);
  assert.equal(tools.transport, 'http');

  const client = await connect(s.fetchApp, tools.token);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((t) => t.name).sort(), ['task_get', 'task_log_append', 'task_log_list', 'task_update_status']);
  const got = await client.callTool({ name: 'task_get', arguments: {} });
  assert.match(JSON.stringify(got.content), /接通能力层/);
  const appended = await client.callTool({ name: 'task_log_append', arguments: { body: '做完了一半，下一步接 UI' } });
  assert.notEqual(appended.isError, true);
  const again = await client.callTool({ name: 'task_get', arguments: {} });
  assert.match(JSON.stringify(again.structuredContent), /下一步接 UI/);
  await client.close();

  // dispose 作废令牌
  await withToolAccess(s.gateway, { url: 'x' }, { kind: 'dispose', sessionId: s.session.id, workerId: 'local' } as never);
  const res = await s.fetchApp('http://127.0.0.1/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${tools.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  });
  assert.equal(res.status, 401);
});

test('/mcp：没令牌 401', async () => {
  const s = await setup();
  const res = await s.fetchApp('http://127.0.0.1/mcp', { method: 'POST', body: '{}' });
  assert.equal(res.status, 401);
});
