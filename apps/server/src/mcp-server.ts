import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ToolGateway, ToolGrant } from '@agent-hub/domain';

/**
 * 工具名对外用下划线（task_get），不少客户端不认点号；进来再映射回 task.get。
 */
export const toWireName = (name: string): string => name.replaceAll('.', '_');

/**
 * 能力层的 MCP 服务端：一个授权 → 一个 SDK Server，背后是领域的 ToolGateway。
 * 不认识任何传输——HTTP 入口（mcp.ts）和长连接中转（mcp-relay.ts）各自把它接到自己的 SDK 传输上。
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
      content: [{ type: 'text' as const, text: JSON.stringify(result.value, null, 2) }],
      structuredContent: result.value as Record<string, unknown>
    };
  });
  return server;
}
