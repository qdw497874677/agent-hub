/**
 * agent-hub 自带的 Pi 扩展：hub-managed 上下文（ADR 0020 · P3）。
 *
 * 每次调模型前（Pi 的 `context` 事件）把消息的元数据（序号 id / 角色 / token 估算 / 工具调用 id）发给 hub 的
 * 隐藏工具 context.transform，按 hub 的回答删掉旧轮次、把旧工具结果换成占位文字。正文不出这台机器。
 *
 * 失败一律放行（原样发给模型）：hub 连不上、超时、会话不在 hub-managed 模式都不改。
 * 不在 hub-managed 模式时 60 秒内不再问，避免每次调模型都多一次往返。
 * 令牌只从 AGENT_HUB_TOOL_TOKEN 读、只进 Authorization 头；不打日志。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const CLEARED = '旧工具结果已清理，可以重新执行';
const TIMEOUT_MS = 5_000;
const IDLE_RECHECK_MS = 60_000;

type Msg = { role?: string; content?: unknown; toolCallId?: string; toolName?: string };
type Meta = { id: string; role: 'user' | 'assistant' | 'tool'; tokens: number; tool?: string; calls?: string[]; callId?: string };
type Answer = { apply?: boolean; mode?: string; keep?: string[]; clear?: string[]; guidance?: string[] };

export function toMeta(messages: readonly Msg[]): Meta[] {
  return messages.map((m, i) => {
    const tokens = Math.ceil(JSON.stringify(m.content ?? '').length / 4);
    if (m.role === 'toolResult') return { id: `m${i}`, role: 'tool', tokens, ...(m.toolName ? { tool: m.toolName } : {}), ...(m.toolCallId ? { callId: m.toolCallId } : {}) };
    if (m.role === 'assistant') {
      const calls = Array.isArray(m.content) ? m.content.flatMap((c: { type?: string; id?: string }) => (c?.type === 'toolCall' && c.id ? [c.id] : [])) : [];
      return { id: `m${i}`, role: 'assistant', tokens, ...(calls.length ? { calls } : {}) };
    }
    return { id: `m${i}`, role: 'user', tokens };
  });
}

/** 按 hub 的回答改消息；回答不完整（比如 keep 为空）就原样返回。 */
export function applyAnswer<T extends Msg>(messages: readonly T[], answer: Answer): T[] | null {
  if (!answer.apply || !Array.isArray(answer.keep) || answer.keep.length === 0) return null;
  const keep = new Set(answer.keep);
  const clear = new Set(answer.clear ?? []);
  const out: T[] = [];
  messages.forEach((m, i) => {
    const id = `m${i}`;
    if (!keep.has(id)) return;
    out.push(clear.has(id) && m.role === 'toolResult' ? { ...m, content: [{ type: 'text', text: CLEARED }] } : m);
  });
  const guidance = (answer.guidance ?? []).filter((g) => typeof g === 'string' && g.length < 500);
  if (guidance.length > 0) out.unshift({ role: 'user', content: [{ type: 'text', text: `[agent-hub] ${guidance.join(' ')}` }], timestamp: Date.now() } as unknown as T);
  return out;
}

export default function hubContext(pi: { on(event: 'context', handler: (event: { messages: Msg[] }) => Promise<{ messages?: Msg[] } | undefined>): void }): void {
  const url = process.env['AGENT_HUB_TOOL_URL'] ?? '';
  const token = process.env['AGENT_HUB_TOOL_TOKEN'] ?? '';
  if (url === '' || token === '') return;
  let idleUntil = 0;
  // 每次用完就关：常驻连接会让 `pi -p` 这类一次性运行退不出去。
  const callHub = async (messages: Msg[]) => {
    const client = new Client({ name: 'agent-hub-context', version: '1.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }), { timeout: TIMEOUT_MS });
      return await client.callTool({ name: 'context.transform', arguments: { messages: toMeta(messages) } }, undefined, { timeout: TIMEOUT_MS });
    } finally {
      await client.close().catch(() => {});
    }
  };

  pi.on('context', async (event) => {
    if (Date.now() < idleUntil || event.messages.length === 0) return undefined;
    try {
      const result = await callHub(event.messages);
      if (result.isError) {
        idleUntil = Date.now() + IDLE_RECHECK_MS;
        return undefined;
      }
      const answer = (result.structuredContent ?? {}) as Answer;
      if (answer.mode !== 'hub-managed') idleUntil = Date.now() + IDLE_RECHECK_MS;
      const messages = applyAnswer(event.messages, answer);
      return messages ? { messages } : undefined;
    } catch {
      idleUntil = Date.now() + IDLE_RECHECK_MS;
      return undefined;
    }
  });
}
