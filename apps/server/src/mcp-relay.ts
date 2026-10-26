import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { RpcFailure, mcpMessage, type RpcPort } from '@agent-hub/contract';
import type { ToolGateway } from '@agent-hub/domain';
import { createMcpServer } from './mcp-server.ts';

export interface McpRelayDeps {
  readonly gateway: ToolGateway;
  /** 会话此刻托管在哪台 Worker（来自 worker 网关的路由表）。 */
  readonly hostOf: (sessionId: string) => string | null;
}

/**
 * hub 侧 MCP 中转适配器：RPC 端口（mcp.message）→ 既有的 MCP 服务端（mcp-server.ts）→ 领域 ToolGateway。
 *
 * 每条消息：令牌 → 授权；核对授权绑定的 Worker、以及会话此刻确实托管在这台上——
 * 别的机器拿到令牌也不能借道。再经 SDK 的内存传输交给一个新的 Server，拿回那条回复。
 * 无状态（同 /mcp）：hub 重启不用记 MCP 会话。令牌不进日志。
 */
export function serveMcpRelay(port: RpcPort, workerId: string, deps: McpRelayDeps): void {
  port.handle(mcpMessage, async ({ token, message }, { signal }) => {
    const grant = await deps.gateway.authenticate(token);
    if (!grant) throw new RpcFailure('forbidden', '工具令牌无效或已过期');
    if (grant.workerId !== null && grant.workerId !== workerId) throw new RpcFailure('forbidden', '这个令牌不属于这台 Worker');
    if (deps.hostOf(grant.sessionId) !== workerId) throw new RpcFailure('forbidden', '这条会话不在这台 Worker 上');
    return { message: (await exchange(deps.gateway, grant, message as JSONRPCMessage, signal)) as Record<string, unknown> | null };
  });
}

async function exchange(
  gateway: ToolGateway,
  grant: Parameters<typeof createMcpServer>[1],
  message: JSONRPCMessage,
  signal: AbortSignal
): Promise<JSONRPCMessage | null> {
  if (!('id' in message) || !('method' in message)) return null; // 通知 / 回复：无状态，没有可答的
  const [client, server] = InMemoryTransport.createLinkedPair();
  const mcp = createMcpServer(gateway, grant);
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
