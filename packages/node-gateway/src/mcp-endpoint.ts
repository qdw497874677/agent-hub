import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isJSONRPCRequest, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { mcpMessage, type RpcPort } from '@agent-hub/contract';

export interface McpEndpoint {
  /** 本机 MCP 入口（只听 127.0.0.1，随机端口），第一次调用时才起。 */
  url(): Promise<string>;
  close(): Promise<void>;
}

/**
 * Worker 侧 MCP 中转适配器：本机 Streamable HTTP 入口 → RPC 端口（mcp.message）。
 *
 * 它不懂任何工具，也不起 MCP Server：SDK 的传输层负责 HTTP / JSON-RPC 编解码，
 * 每条请求原样经端口交给 hub，回复原样写回。通知（没有 id）hub 是无状态的，本地吞掉。
 * 只听回环地址；令牌只从 Authorization 头里取，随消息转发，不打日志。
 */
export function createMcpEndpoint(port: RpcPort, options: { readonly timeoutMs?: number } = {}): McpEndpoint {
  let server: HttpServer | null = null;
  let listening: Promise<string> | null = null;

  const bearer = (request: IncomingMessage): string => {
    const header = request.headers.authorization ?? '';
    return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  };

  const failure = (id: string | number, message: string): JSONRPCMessage => ({
    jsonrpc: '2.0',
    id,
    error: { code: -32603, message }
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    // /mcp = hub 自己的工具；/mcp/<名字> = 一个远端 MCP 资产（hub 代连，密钥不下发）
    const matched = /^\/mcp(?:\/([a-z0-9-]{1,64}))?$/.exec(url.pathname);
    if (!matched) {
      response.writeHead(404).end();
      return;
    }
    const server = matched[1];
    const token = bearer(request);
    if (token === '') {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: '缺少工具令牌' }, id: null }));
      return;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const abort = new AbortController();
    response.on('close', () => {
      abort.abort();
      void transport.close();
    });
    transport.onmessage = (message) => {
      if (!isJSONRPCRequest(message)) return;
      void (async () => {
        const reply = await port.request(
          mcpMessage,
          { token, ...(server ? { server } : {}), message: message as unknown as Record<string, unknown> },
          { signal: abort.signal, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) }
        );
        const out = reply.ok
          ? ((reply.value.message as JSONRPCMessage | null) ?? failure(message.id, 'hub 没有回复'))
          : failure(message.id, reply.error.code === 'closed' ? '与 hub 断开了，工具暂不可用' : reply.error.message);
        await transport.send(out, { relatedRequestId: message.id }).catch(() => undefined);
      })();
    };
    await transport.start();
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
