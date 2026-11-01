import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { CONTEXT_TOOLS, MEMORY_TOOLS, MESSAGE_TOOLS, TASK_TOOLS, type ToolGateway, type ToolGrant } from '@agent-hub/domain';
import { createMcpServer, toStructured, toWireName } from './mcp-server.ts';

/**
 * 契约：hub 的每个 MCP 工具，structuredContent 都必须是普通对象（规范要求；
 * 线上 memory_search 返回数组，Pi 的 MCP 客户端报 -32602 Invalid tools/call result）。
 * 用真 SDK Client（它按 CallToolResultSchema 校验结果，有 outputSchema 还会校验它）。
 */
const ALL = [...TASK_TOOLS, ...MESSAGE_TOOLS, ...MEMORY_TOOLS, ...CONTEXT_TOOLS];
const SHAPES: Record<string, unknown> = {
  array: [{ id: 'm1', title: 't' }],
  empty: [],
  object: { ok: true, entries: [] },
  string: 'hi',
  number: 3,
  null: null,
  date: new Date(0)
};

async function connect(value: () => unknown) {
  const gateway = {
    list: () => ALL,
    call: async () => ({ ok: true, value: value() })
  } as unknown as ToolGateway;
  const server = createMcpServer(gateway, { sessionId: 's1' } as unknown as ToolGrant);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'contract', version: '1' });
  await client.connect(b);
  return client;
}

test('每个 hub MCP 工具、每种返回形状：structuredContent 都是普通对象，过得了 SDK 客户端校验', async () => {
  let current: unknown;
  const client = await connect(() => current);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((t) => t.name).sort(), ALL.map((t) => toWireName(t.name)).sort());
  for (const tool of listed.tools) {
    assert.equal(tool.outputSchema, undefined, `${tool.name} 声明了 outputSchema，要确认它和 structuredContent 一致`);
    for (const [shape, value] of Object.entries(SHAPES)) {
      current = value;
      const result = await client.callTool({ name: tool.name, arguments: {} });
      assert.ok(CallToolResultSchema.safeParse(result).success, `${tool.name}/${shape}`);
      const structured = result.structuredContent;
      assert.ok(structured !== null && typeof structured === 'object' && !Array.isArray(structured), `${tool.name}/${shape} 不是对象`);
      assert.equal(Object.getPrototypeOf(structured), Object.prototype);
      // 文本 content 保留原值
      const text = (result.content as { type: string; text: string }[])[0]!;
      assert.equal(text.type, 'text');
      assert.deepEqual(JSON.parse(text.text), JSON.parse(JSON.stringify(value ?? null)));
    }
  }
  await client.close();
});

test('toStructured：数组 → items，标量 → result，普通对象原样', () => {
  assert.deepEqual(toStructured([1, 2]), { items: [1, 2] });
  assert.deepEqual(toStructured({ a: 1 }), { a: 1 });
  assert.deepEqual(toStructured('x'), { result: 'x' });
  assert.deepEqual(toStructured(undefined), { result: null });
});
