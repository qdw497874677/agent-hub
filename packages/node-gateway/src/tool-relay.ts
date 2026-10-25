import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ToolRequestFrame, ToolResponseCommand } from '@agent-hub/contract';

export type ToolRelayRequest = Omit<ToolRequestFrame, 'type' | 'requestId'>;
export type ToolRelayReply = Omit<ToolResponseCommand, 'kind' | 'requestId'>;

export interface ToolRelay {
  /** 本地 MCP 入口（只听 127.0.0.1，随机端口），第一次调用时才起。 */
  url(): Promise<string>;
  close(): Promise<void>;
}

/**
 * Worker 本地的 MCP 入口（stdio-shim 模式，P4）。agent 连不到 hub 的 HTTP 时，
 * 它（或替它跑的 stdio 垫片）连这里；这里不懂任何工具，只把 list / call 原样
 * 交给 `forward`——worker 再经已有的 WebSocket 发给 hub，hub 按令牌认人、执行、答复。
 *
 * 只听回环地址；令牌只从 Authorization 头里取，转发出去，不打日志。
 */
export function createToolRelay(forward: (request: ToolRelayRequest) => Promise<ToolRelayReply>): ToolRelay {
  let server: HttpServer | null = null;
  let listening: Promise<string> | null = null;

  const bearer = (request: IncomingMessage): string => {
    const header = request.headers.authorization ?? '';
    return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  };

  async function handle(request: IncomingMessage, response: import('node:http').ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/mcp') {
      response.writeHead(404).end();
      return;
    }
    const token = bearer(request);
    if (token === '') {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: '缺少工具令牌' }, id: null }));
      return;
    }
    const mcp = new Server({ name: 'agent-hub', version: '1.0.0' }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => {
      const reply = await forward({ token, op: 'list' });
      if (!reply.ok) throw new Error(reply.error ?? '列工具失败');
      return { tools: (reply.tools ?? []).map((tool) => ({ ...tool, inputSchema: tool.inputSchema as { type: 'object' } })) };
    });
    mcp.setRequestHandler(CallToolRequestSchema, async (call) => {
      const reply = await forward({ token, op: 'call', name: call.params.name, args: call.params.arguments ?? {} });
      if (!reply.ok) return { isError: true, content: [{ type: 'text' as const, text: reply.error ?? '工具调用失败' }] };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(reply.value ?? null, null, 2) }],
        ...(reply.value !== null && typeof reply.value === 'object' && !Array.isArray(reply.value)
          ? { structuredContent: reply.value as Record<string, unknown> }
          : {})
      };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(request, response);
  }

  return {
    url(): Promise<string> {
      if (listening) return listening;
      listening = new Promise<string>((resolve, reject) => {
        const created = createServer((request, response) => {
          handle(request, response).catch(() => {
            if (!response.headersSent) response.writeHead(500);
            response.end();
          });
        });
        created.once('error', reject);
        created.listen(0, '127.0.0.1', () => {
          server = created;
          created.unref();
          resolve(`http://127.0.0.1:${(created.address() as AddressInfo).port}/mcp`);
        });
      });
      return listening;
    },
    async close(): Promise<void> {
      const current = server;
      server = null;
      listening = null;
      if (current) await new Promise<void>((resolve) => current.close(() => resolve()));
    }
  };
}
