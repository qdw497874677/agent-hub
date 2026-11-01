import { invalid, type DomainError } from '../errors.ts';
import type { ContextMessage } from '../context-strategy.ts';
import type { ToolContext, ToolDescriptor, ToolProvider } from '../ports/tool-provider.ts';
import { err, type Result } from '../result.ts';
import type { ContextService } from '../use-cases/context.ts';

/**
 * hub-managed 上下文（ADR 0020 · P3）：hub 自带的 pi 扩展在每次调模型前调这个工具。
 * 隐藏工具：模型看不到；会话由授权决定，扩展不能替别的会话要改写。
 */
export const CONTEXT_TOOLS: readonly ToolDescriptor[] = [
  {
    name: 'context.transform',
    version: 1,
    scope: 'context',
    perMinute: 600,
    hidden: true,
    description: 'Internal: hub-managed context strategy (runtime extension only).',
    inputSchema: {
      type: 'object',
      properties: {
        messages: {
          type: 'array',
          maxItems: 5000,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              role: { type: 'string', enum: ['system', 'user', 'assistant', 'tool'] },
              tokens: { type: 'integer', minimum: 0 },
              tool: { type: 'string' },
              calls: { type: 'array', items: { type: 'string' } },
              callId: { type: 'string' }
            },
            required: ['id', 'role', 'tokens']
          }
        }
      },
      required: ['messages']
    }
  }
];

const ROLES = new Set(['system', 'user', 'assistant', 'tool']);
const str = (v: unknown, max = 200): string | undefined => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined);

/** 只认元数据字段；正文（content）一律不收。 */
export function parseContextMessages(input: unknown): ContextMessage[] | null {
  const raw = (input as { messages?: unknown })?.messages;
  if (!Array.isArray(raw) || raw.length > 5000) return null;
  const out: ContextMessage[] = [];
  for (const m of raw) {
    const r = m as Record<string, unknown>;
    const id = str(r['id']);
    const tokens = typeof r['tokens'] === 'number' && Number.isFinite(r['tokens']) && r['tokens'] >= 0 ? Math.floor(r['tokens']) : null;
    if (!id || !ROLES.has(String(r['role'])) || tokens === null) return null;
    const calls = Array.isArray(r['calls']) ? r['calls'].flatMap((c) => (str(c) ? [c as string] : [])).slice(0, 100) : undefined;
    const tool = str(r['tool']);
    const callId = str(r['callId']);
    out.push({ id, role: r['role'] as ContextMessage['role'], tokens, content: null, ...(tool ? { tool } : {}), ...(calls?.length ? { calls } : {}), ...(callId ? { callId } : {}) });
  }
  return out;
}

export function createContextToolProvider(context: Pick<ContextService, 'transformFor'>): ToolProvider {
  return {
    id: 'context',
    tools: () => CONTEXT_TOOLS,
    async call(name: string, input: unknown, ctx: ToolContext): Promise<Result<unknown, DomainError>> {
      if (name !== 'context.transform') return err(invalid(`没有这个工具：${name}`));
      const messages = parseContextMessages(input);
      if (!messages) return err(invalid('messages 格式不对'));
      return context.transformFor(String(ctx.grant.sessionId), messages);
    }
  };
}
