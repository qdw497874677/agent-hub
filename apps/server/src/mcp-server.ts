import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ToolGateway, ToolGrant } from '@agent-hub/domain';

/**
 * 工具名对外用下划线（task_get），不少客户端不认点号；进来再映射回 task.get。
 */
export const toWireName = (name: string): string => name.replaceAll('.', '_');

/**
 * MCP 规范要求 structuredContent 是对象（SDK 客户端按 record 校验，数组会报 -32602）。
 * 领域工具可能返回数组（memory.search / memory.list / agent.directory / agent.inbox）或标量：
 * 普通对象原样给；数组包成 { items }；其余包成 { result }。文本 content 仍是原值的 JSON。
 */
export function toStructured(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return { items: value };
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return value as Record<string, unknown>;
  if (value !== null && typeof value === 'object') return { result: JSON.parse(JSON.stringify(value)) as unknown };
  return { result: value ?? null };
}

/**
 * 能力层的 MCP 服务端：一个授权 → 一个 SDK Server，背后是领域的 ToolGateway。
 * 不认识任何传输——长连接中转（mcp-relay.ts）把它接到 SDK 传输上。
 */
export function createMcpServer(gateway: ToolGateway, grant: ToolGrant): Server {
  const server = new Server({ name: 'agent-hub', version: '1.0.0' }, { capabilities: { tools: {} } });
  const tools = gateway.list(grant);
  const byWire = new Map(tools.map((tool) => [toWireName(tool.name), tool.name]));
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: toWireName(tool.name),
      description: tool.description,
      inputSchema: tool.inputSchema as { type: 'object' }
    }))
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = byWire.get(request.params.name) ?? request.params.name;
    const result = await gateway.call(grant, name, request.params.arguments ?? {});
    if (!result.ok) return { isError: true, content: [{ type: 'text' as const, text: result.error.message }] };
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result.value ?? null, null, 2) }],
      structuredContent: toStructured(result.value)
    };
  });
  return server;
}
