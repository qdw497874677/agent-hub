import type { Hono } from 'hono';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ToolGateway } from '@agent-hub/domain';

/**
 * 能力层的 MCP 入口（Streamable HTTP，无状态）。
 *
 * 每个请求：Bearer 工具令牌 → ToolGrant → 新建一个 SDK Server + transport 处理这一条 JSON-RPC。
 * 无状态意味着 hub 重启、多副本都不用记 MCP 会话；身份全在令牌里。
 * 工具名对外用下划线（task_get），不少客户端不认点号；进来再映射回 task.get。
 * 令牌只在 Authorization 头里，这里不打日志。
 */
export const toWireName = (name: string): string => name.replaceAll('.', '_');

export function installMcp(app: Hono, gateway: ToolGateway): void {
  app.all('/mcp', async (c) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const grant = token ? await gateway.authenticate(token) : null;
    if (!grant) {
      return c.json({ jsonrpc: '2.0', error: { code: -32001, message: '工具令牌无效或已过期' }, id: null }, 401);
    }
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
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });
}
