import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createRpcChannel, mcpMessage, type RpcChannel } from '@agent-hub/contract';
import { createMcpEndpoint } from '@agent-hub/node-gateway';

const shim = join(dirname(fileURLToPath(import.meta.url)), 'mcp-shim.ts');

/** 一对直连的 RPC 通道：测试里代替 /worker 长连接。 */
function linkedChannels(): [RpcChannel, RpcChannel] {
  const pair: RpcChannel[] = [];
  pair.push(createRpcChannel({ idPrefix: 'w', timeoutMs: 5000, send: (frame) => (queueMicrotask(() => pair[1]!.receive(frame)), true) }));
  pair.push(createRpcChannel({ idPrefix: 'h', timeoutMs: 5000, send: (frame) => (queueMicrotask(() => pair[0]!.receive(frame)), true) }));
  return [pair[0]!, pair[1]!];
}

test('stdio 垫片：stdio MCP → worker 本地入口 → RPC 端口；令牌走环境变量', async () => {
  const [worker, hub] = linkedChannels();
  const seen: { token: string; method: unknown; params: unknown }[] = [];
  hub.handle(mcpMessage, async ({ token, message }) => {
    seen.push({ token, method: message['method'], params: message['params'] });
    const id = message['id'];
    if (id === undefined) return { message: null };
    const params = (message['params'] ?? {}) as Record<string, unknown>;
    if (message['method'] === 'initialize') {
      return { message: { jsonrpc: '2.0', id, result: { protocolVersion: params['protocolVersion'], capabilities: { tools: {} }, serverInfo: { name: 'f', version: '1' } } } };
    }
    if (message['method'] === 'tools/list') {
      return { message: { jsonrpc: '2.0', id, result: { tools: [{ name: 'task_log_append', description: '写日志', inputSchema: { type: 'object' } }] } } };
    }
    return { message: { jsonrpc: '2.0', id, result: { content: [], structuredContent: { seq: 7 } } } };
  });
  const relay = createMcpEndpoint(worker);
  const url = await relay.url();
  const client = new Client({ name: 'agent', version: '1' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [...process.execArgv, shim],
      env: { PATH: process.env['PATH'] ?? '', AGENT_HUB_TOOL_URL: url, AGENT_HUB_TOOL_TOKEN: 'grant-9' },
      stderr: 'pipe'
    })
  );
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name), ['task_log_append']);
  const called = await client.callTool({ name: 'task_log_append', arguments: { body: 'hi' } });
  assert.deepEqual(called.structuredContent, { seq: 7 });
  await client.close();
  await relay.close();
  assert.ok(seen.length >= 2);
  assert.ok(seen.every((request) => request.token === 'grant-9'));
  assert.deepEqual((seen.find((request) => request.method === 'tools/call')?.params as { arguments?: unknown })?.arguments, { body: 'hi' });
});
