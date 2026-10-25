import type { ToolRequestFrame, ToolResponseCommand } from '@agent-hub/contract';
import type { ToolGateway } from '@agent-hub/domain';
import { toWireName } from './mcp.ts';

type ToolReply = Omit<ToolResponseCommand, 'kind' | 'requestId'>;

/**
 * Worker 链路上的工具调用（stdio-shim 模式）。和 /mcp 走同一个 ToolGateway：
 * 令牌 → 授权 → list / call，规则一处定义。多一条核对：授权绑定了 Worker 的话，
 * 只认那台 Worker 转来的——别的机器拿到令牌也不能借道。令牌不进日志。
 */
export async function answerToolRequest(gateway: ToolGateway, workerId: string, request: ToolRequestFrame): Promise<ToolReply> {
  const grant = await gateway.authenticate(request.token);
  if (!grant) return { ok: false, error: '工具令牌无效或已过期' };
  if (grant.workerId !== null && grant.workerId !== workerId) return { ok: false, error: '这个令牌不属于这台 Worker' };
  const tools = gateway.list(grant);
  if (request.op === 'list') {
    return {
      ok: true,
      tools: tools.map((tool) => ({
        name: toWireName(tool.name),
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown>
      }))
    };
  }
  const wire = request.name ?? '';
  const name = tools.find((tool) => toWireName(tool.name) === wire)?.name ?? wire;
  const result = await gateway.call(grant, name, request.args ?? {});
  return result.ok ? { ok: true, value: result.value } : { ok: false, error: result.error.message };
}
