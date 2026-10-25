import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AsyncQueue, type ToolRequestFrame } from '@agent-hub/contract';
import {
  CAPABILITY_NAMES,
  available,
  asAgentId,
  asSessionId,
  asTaskId,
  capabilityMatrix,
  type AgentRuntime,
  type Capability,
  type CapabilityName,
  type SessionEvent,
  type StartSpec
} from '@agent-hub/domain';
import { createServerGateway } from './server-gateway.ts';
import { connectWorkerLink } from './worker-link.ts';

function idleRuntime(seen: StartSpec[]): AgentRuntime {
  const all = Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, available])) as Record<CapabilityName, Capability>;
  return {
    descriptor: { id: asAgentId('echo'), label: 'Echo', capabilities: capabilityMatrix(all), models: [], defaultModel: '', options: [] },
    async start(spec) {
      seen.push(spec);
      const queue = new AsyncQueue<SessionEvent>();
      return {
        ok: true,
        value: {
          sessionId: spec.sessionId,
          async prompt() {
            return { ok: true, value: undefined };
          },
          async interrupt() {},
          events: () => queue,
          async adopt() {},
          options: () => [],
          async changeOption() {
            return { ok: true, value: [] };
          },
          async dispose() {
            queue.close();
          }
        }
      };
    }
  };
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('stdio-shim：URL 换成 worker 本地 relay；MCP list/call 经 WebSocket 到 hub，按令牌认人', async () => {
  const requests: { workerId: string; request: ToolRequestFrame }[] = [];
  let online = false;
  const gateway = createServerGateway({
    token: 't0k',
    onHello: () => (online = true),
    onEvent: () => {},
    onAgentSession: () => {},
    onOptions: () => {},
    onStatus: () => {},
    onWorkerGone: () => {},
    async onToolRequest(workerId, request) {
      requests.push({ workerId, request });
      if (request.token !== 'grant-1') return { ok: false, error: '工具令牌无效或已过期' };
      if (request.op === 'list') {
        return { ok: true, tools: [{ name: 'task_get', description: '读任务', inputSchema: { type: 'object', properties: {} } }] };
      }
      return { ok: true, value: { echoed: request.name, args: request.args } };
    }
  });
  const http = createServer();
  http.on('upgrade', (request, socket, head) => gateway.handleUpgrade(request, socket, head));
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const seen: StartSpec[] = [];
  const link = connectWorkerLink({
    url: `ws://127.0.0.1:${(http.address() as AddressInfo).port}`,
    token: 't0k',
    workerId: 'w1',
    label: 'x',
    reconnect: false,
    runtimes: [idleRuntime(seen)]
  });
  await until(() => online);
  gateway.gateway.dispatch({
    kind: 'start_session',
    sessionId: asSessionId('s1'),
    workerId: 'w1',
    taskId: asTaskId('t1'),
    agentId: 'echo',
    workspaceRoot: '/tmp',
    origin: { kind: 'derive' },
    resume: null,
    options: {},
    tools: { transport: 'stdio-shim', url: 'http://unreachable-hub/mcp', token: 'grant-1' }
  } as Parameters<typeof gateway.gateway.dispatch>[0]);
  await until(() => seen.length === 1);
  const tools = seen[0]?.tools;
  assert.equal(tools?.transport, 'stdio-shim');
  assert.match(tools?.url ?? '', /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  assert.equal(tools?.token, 'grant-1');

  const client = new Client({ name: 'test', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(tools?.url ?? ''), { requestInit: { headers: { Authorization: 'Bearer grant-1' } } })
  );
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name), ['task_get']);
  const called = await client.callTool({ name: 'task_get', arguments: { a: 1 } });
  assert.deepEqual(called.structuredContent, { echoed: 'task_get', args: { a: 1 } });
  await client.close();
  assert.ok(requests.every((entry) => entry.workerId === 'w1'));

  const intruder = new Client({ name: 'test', version: '1' });
  await intruder.connect(
    new StreamableHTTPClientTransport(new URL(tools?.url ?? ''), { requestInit: { headers: { Authorization: 'Bearer nope' } } })
  );
  const denied = await intruder.callTool({ name: 'task_get', arguments: {} });
  assert.equal(denied.isError, true);
  await intruder.close();

  const anonymous = await fetch(tools?.url ?? '', { method: 'POST', body: '{}' });
  assert.equal(anonymous.status, 401);

  await link.close();
  gateway.close();
  http.closeAllConnections?.();
  await new Promise((resolve) => http.close(resolve));
});
