import { test } from 'node:test';
import assert from 'node:assert/strict';
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
import { createRpcChannel, mcpMessage, type RpcChannel } from '@agent-hub/contract';
import { serveMcpRelay } from './mcp-relay.ts';

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

function linked(): [RpcChannel, RpcChannel] {
  const ends: RpcChannel[] = [];
  ends.push(createRpcChannel({ idPrefix: 'w', send: (f) => (queueMicrotask(() => ends[1]!.receive(f)), true) }));
  ends.push(createRpcChannel({ idPrefix: 'h', send: (f) => (queueMicrotask(() => ends[0]!.receive(f)), true) }));
  return [ends[0]!, ends[1]!];
}

async function setup() {
  const w = inMemoryDeps();
  w.agents.push(fake);
  const project = await createProjectUseCase(w.deps, { name: 'demo', rootPath: '/tmp/demo' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: '走长链接', ownerId: 'u1' });
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
  const command = await withToolAccess(gateway, { url: '', transport: 'relay' }, {
    kind: 'start_session',
    sessionId: session.value.id,
    taskId: task.value.id,
    workerId: 'w1'
  } as never);
  const token = (command as { tools: { token: string; transport: string } }).tools.token;
  assert.equal((command as { tools: { transport: string } }).tools.transport, 'relay');
  return { gateway, token, sessionId: session.value.id as string };
}

const call = (id: number, method: string, params: Record<string, unknown> = {}) => ({ jsonrpc: '2.0', id, method, params });

test('hub MCP 中转：令牌对、会话在这台 Worker 上 → 交给 MCP 服务端读任务、写日志', async () => {
  const s = await setup();
  const [worker, hub] = linked();
  serveMcpRelay(hub, 'w1', { gateway: s.gateway, hostOf: (id) => (id === s.sessionId ? 'w1' : null) });
  const listed = await worker.request(mcpMessage, { token: s.token, message: call(1, 'tools/list') });
  assert.ok(listed.ok);
  const names = ((listed.value.message?.['result'] as { tools: { name: string }[] }).tools ?? []).map((t) => t.name).sort();
  assert.deepEqual(names, ['task_get', 'task_log_append', 'task_log_list', 'task_update_status']);
  const got = await worker.request(mcpMessage, { token: s.token, message: call(2, 'tools/call', { name: 'task_get', arguments: {} }) });
  assert.ok(got.ok);
  assert.match(JSON.stringify(got.value.message), /走长链接/);
  // 通知：无状态，没有回复
  const note = await worker.request(mcpMessage, { token: s.token, message: { jsonrpc: '2.0', method: 'notifications/initialized' } });
  assert.deepEqual(note, { ok: true, value: { message: null } });
});

test('hub MCP 中转：假令牌、别的 Worker、会话已不在这台上，一律 forbidden；会话结束令牌作废', async () => {
  const s = await setup();
  const [w1, hub1] = linked();
  serveMcpRelay(hub1, 'w1', { gateway: s.gateway, hostOf: () => 'w1' });
  const bogus = await w1.request(mcpMessage, { token: 'nope', message: call(1, 'tools/list') });
  assert.equal(!bogus.ok && bogus.error.code, 'forbidden');

  const [w2, hub2] = linked();
  serveMcpRelay(hub2, 'w2', { gateway: s.gateway, hostOf: () => 'w2' });
  const foreign = await w2.request(mcpMessage, { token: s.token, message: call(1, 'tools/list') });
  assert.equal(!foreign.ok && foreign.error.code, 'forbidden');

  const [w3, hub3] = linked();
  serveMcpRelay(hub3, 'w1', { gateway: s.gateway, hostOf: () => 'w9' });
  const moved = await w3.request(mcpMessage, { token: s.token, message: call(1, 'tools/list') });
  assert.equal(!moved.ok && moved.error.code, 'forbidden');

  await withToolAccess(s.gateway, { url: '', transport: 'relay' }, { kind: 'dispose', sessionId: s.sessionId, workerId: 'w1' } as never);
  const revoked = await w1.request(mcpMessage, { token: s.token, message: call(2, 'tools/list') });
  assert.equal(!revoked.ok && revoked.error.code, 'forbidden');
});
