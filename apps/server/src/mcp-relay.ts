import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { RpcFailure, mcpMessage, type RpcPort } from '@agent-hub/contract';
import type { DomainError, Result, ToolGateway } from '@agent-hub/domain';
import { createMcpServer } from './mcp-server.ts';

export interface McpRelayDeps {
  readonly gateway: ToolGateway;
  /** 会话此刻托管在哪台 Worker（来自 worker 网关的路由表）。 */
  readonly hostOf: (sessionId: string) => string | null;
  /** 远端 MCP 资产（http）：装在这台 Worker 上才给；url / headers 里的密钥已在 hub 上展开。 */
  readonly remote?: (workerId: string, server: string) => Promise<Result<{ url: string; headers: Record<string, string> }, DomainError>>;
  /** 连远端的客户端缓存（测试可注入）。 */
  readonly remoteClients?: RemoteClients;
}

/**
 * hub → 远端 MCP 的客户端：按「地址 + 头」的哈希复用（换了密钥或版本就是新连接）。
 * 远端会话失效时丢掉重连一次。头里有密钥：只在内存里，不打日志。
 */
export interface RemoteClients {
  get(target: { url: string; headers: Record<string, string> }): Promise<Client>;
  drop(target: { url: string; headers: Record<string, string> }): Promise<void>;
  close(): Promise<void>;
}

export function createRemoteClients(): RemoteClients {
  const clients = new Map<string, Promise<Client>>();
  const keyOf = (target: { url: string; headers: Record<string, string> }) =>
    createHash('sha256').update(JSON.stringify([target.url, Object.entries(target.headers).sort()])).digest('hex');
  return {
    get(target) {
      const key = keyOf(target);
      let client = clients.get(key);
      if (!client) {
        client = (async () => {
          const created = new Client({ name: 'agent-hub-proxy', version: '1.0.0' });
          await created.connect(new StreamableHTTPClientTransport(new URL(target.url), { requestInit: { headers: target.headers } }));
          return created;
        })();
        clients.set(key, client);
        client.catch(() => clients.delete(key));
      }
      return client;
    },
    async drop(target) {
      const key = keyOf(target);
      const client = clients.get(key);
      clients.delete(key);
      await client?.then((created) => created.close()).catch(() => undefined);
    },
    async close() {
      const all = [...clients.values()];
      clients.clear();
      await Promise.all(all.map((client) => client.then((created) => created.close()).catch(() => undefined)));
    }
  };
}

/** 远端失败的原因：只给人看得懂的一句，不带头（里面可能有密钥）。 */
function remoteFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `远端 MCP 不可用：${message.replace(/Bearer\s+\S+/gi, 'Bearer ***').slice(0, 200)}`;
}

/** 把一个远端客户端包成 SDK Server：只代理 tools（list / call），和 hub 工具同一套交换逻辑。 */
function proxyServer(remote: RemoteClients, target: { url: string; headers: Record<string, string> }): Server {
  const server = new Server({ name: 'agent-hub-proxy', version: '1.0.0' }, { capabilities: { tools: {} } });
  const withRetry = async <T>(run: (client: Client) => Promise<T>): Promise<T> => {
    try {
      return await run(await remote.get(target));
    } catch {
      await remote.drop(target);
      return await run(await remote.get(target));
    }
  };
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    try {
      return await withRetry((client) => client.listTools(request.params));
    } catch (error) {
      throw new Error(remoteFailure(error));
    }
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return (await withRetry((client) =>
        client.callTool({ name: request.params.name, arguments: request.params.arguments ?? {} })
      )) as Awaited<ReturnType<Client['callTool']>> & { content: [] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: remoteFailure(error) }] };
    }
  });
  return server;
}

/**
 * hub 侧 MCP 中转适配器：RPC 端口（mcp.message）→ 既有的 MCP 服务端（mcp-server.ts）→ 领域 ToolGateway。
 *
 * 每条消息：令牌 → 授权；核对授权绑定的 Worker、以及会话此刻确实托管在这台上——
 * 别的机器拿到令牌也不能借道。再经 SDK 的内存传输交给一个新的 Server，拿回那条回复。
 * 无状态（同 /mcp）：hub 重启不用记 MCP 会话。令牌不进日志。
 */
export function serveMcpRelay(port: RpcPort, workerId: string, deps: McpRelayDeps): void {
  port.handle(mcpMessage, async ({ token, server, message }, { signal }) => {
    const grant = await deps.gateway.authenticate(token);
    if (!grant) throw new RpcFailure('forbidden', '工具令牌无效或已过期');
    if (grant.workerId !== null && grant.workerId !== workerId) throw new RpcFailure('forbidden', '这个令牌不属于这台 Worker');
    if (deps.hostOf(grant.sessionId) !== workerId) throw new RpcFailure('forbidden', '这条会话不在这台 Worker 上');
    if (server !== undefined) {
      if (!deps.remote || !deps.remoteClients) throw new RpcFailure('unavailable', '这个 hub 没开远端 MCP 代理');
      const target = await deps.remote(workerId, server);
      if (!target.ok) throw new RpcFailure('forbidden', target.error.message);
      const remote = deps.remoteClients;
      const reply = await exchangeWith(() => proxyServer(remote, target.value), message as JSONRPCMessage, signal);
      return { message: reply as Record<string, unknown> | null };
    }
    return { message: (await exchange(deps.gateway, grant, message as JSONRPCMessage, signal)) as Record<string, unknown> | null };
  });
}

function exchange(
  gateway: ToolGateway,
  grant: Parameters<typeof createMcpServer>[1],
  message: JSONRPCMessage,
  signal: AbortSignal
): Promise<JSONRPCMessage | null> {
  return exchangeWith(() => createMcpServer(gateway, grant), message, signal);
}

async function exchangeWith(make: () => Server, message: JSONRPCMessage, signal: AbortSignal): Promise<JSONRPCMessage | null> {
  if (!('id' in message) || !('method' in message)) return null; // 通知 / 回复：无状态，没有可答的
  const [client, server] = InMemoryTransport.createLinkedPair();
  const mcp = make();
  try {
    await mcp.connect(server);
    const reply = new Promise<JSONRPCMessage>((resolve, reject) => {
      client.onmessage = (incoming) => {
        if ('id' in incoming && incoming.id === message.id) resolve(incoming);
      };
      signal.addEventListener('abort', () => reject(new RpcFailure('cancelled', '对端取消了')), { once: true });
    });
    await client.start();
    await client.send(message);
    return await reply;
  } finally {
    await mcp.close().catch(() => undefined);
  }
}
