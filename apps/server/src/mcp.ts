import type { Hono } from 'hono';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { ToolGateway } from '@agent-hub/domain';
import { createMcpServer } from './mcp-server.ts';

export { toWireName } from './mcp-server.ts';

/**
 * 直连 HTTP 的 MCP 入口（Streamable HTTP，无状态）。**已弃用**：默认不装，
 * Worker 上的 agent 都经 /worker 长连接中转（mcp-relay.ts）。只有 HUB_TOOLS_TRANSPORT=http 才挂上。
 * 令牌只在 Authorization 头里，这里不打日志。
 */
export function installMcp(app: Hono, gateway: ToolGateway): void {
  app.all('/mcp', async (c) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const grant = token ? await gateway.authenticate(token) : null;
    if (!grant) {
      return c.json({ jsonrpc: '2.0', error: { code: -32001, message: '工具令牌无效或已过期' }, id: null }, 401);
    }
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await createMcpServer(gateway, grant).connect(transport);
    return transport.handleRequest(c.req.raw);
  });
}
