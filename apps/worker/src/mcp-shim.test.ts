import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createToolRelay, type ToolRelayRequest } from '@agent-hub/node-gateway';

const shim = join(dirname(fileURLToPath(import.meta.url)), 'mcp-shim.ts');

test('stdio 垫片：把 stdio MCP 的 list/call 转给 Streamable HTTP 入口，令牌走环境变量', async () => {
  const seen: ToolRelayRequest[] = [];
  const relay = createToolRelay(async (request) => {
    seen.push(request);
    if (request.op === 'list') {
      return { ok: true, tools: [{ name: 'task_log_append', description: '写日志', inputSchema: { type: 'object' } }] };
    }
    return { ok: true, value: { seq: 7 } };
  });
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
  assert.deepEqual(seen.find((request) => request.op === 'call')?.args, { body: 'hi' });
});
