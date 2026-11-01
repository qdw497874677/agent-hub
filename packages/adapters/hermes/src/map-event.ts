import type { SessionEvent } from '@agent-hub/domain';

/** Hermes Runs API 的一条 SSE 事件（设计文档 §5.3，2026-11-01 在 v0.22.5 上实测）。 */
export type HermesEvent = Readonly<Record<string, unknown>> & { readonly event?: unknown };

/** 需要 hub 回话的控制事件：批准 / 澄清。映射器只认出来，怎么回由运行时决定。 */
export interface HermesControl {
  readonly kind: 'approval' | 'clarify';
  readonly requestId: string;
  readonly generation: number | null;
  readonly summary: string;
}

export interface MappedHermes {
  readonly events: readonly SessionEvent[];
  readonly control?: HermesControl;
  /** 这一轮结束了（终态）。 */
  readonly terminal?: boolean;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

function preview(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

/**
 * 把一条 Hermes 事件变成 hub 事件。有状态：tool.completed 不一定带工具名、要算耗时，所以记住 tool.started。
 * 事件里的文本一律当不可信内容，只原样搬运，不解释。
 */
export function createHermesEventMapper(now: () => number = Date.now) {
  const started = new Map<string, { name: string; at: number }>();
  return (raw: HermesEvent): MappedHermes => {
    const type = str(raw.event);
    switch (type) {
      case 'message.delta': {
        const delta = str(raw['delta']);
        return { events: delta ? [{ kind: 'text', delta }] : [] };
      }
      case 'reasoning.available':
      case 'reasoning.delta': {
        const delta = str(raw['delta']) || str(raw['text']);
        return { events: delta ? [{ kind: 'thinking', delta }] : [] };
      }
      case 'message.interim': {
        if (raw['already_streamed'] === true) return { events: [] };
        const text = str(raw['text']) || str(raw['message']) || str(raw['delta']);
        return { events: text ? [{ kind: 'text', delta: text }] : [] };
      }
      case 'tool.started': {
        const name = str(raw['tool']) || str(raw['name']) || 'tool';
        const id = str(raw['tool_call_id']);
        if (id) started.set(id, { name, at: now() });
        return { events: [{ kind: 'tool_call', name, input: preview(raw['preview'] ?? raw['args']) }] };
      }
      case 'tool.completed':
      case 'tool.failed': {
        const id = str(raw['tool_call_id']);
        const begin = id ? started.get(id) : undefined;
        if (id) started.delete(id);
        const name = str(raw['tool']) || str(raw['name']) || begin?.name || 'tool';
        const failed = type === 'tool.failed' || raw['error'] === true || raw['is_error'] === true;
        const output = str(raw['preview']) || str(raw['result']);
        return {
          events: [
            {
              kind: 'tool_result',
              name,
              ok: !failed,
              durationMs: typeof raw['duration'] === 'number' ? Math.round(raw['duration'] * 1000) : begin ? Math.max(0, Math.round(now() - begin.at)) : 0,
              ...(output ? { output } : {})
            }
          ]
        };
      }
      case 'subagent.start':
        return { events: [{ kind: 'diagnostic', level: 'info', text: `Hermes 开了子任务：${str(raw['goal']) || str(raw['child_session_id']) || '（无说明）'}` }] };
      case 'subagent.complete':
        return { events: [{ kind: 'diagnostic', level: 'info', text: `Hermes 子任务结束：${str(raw['child_session_id']) || '（无 id）'}` }] };
      case 'approval.request':
      case 'clarify.request': {
        const requestId = str(raw['request_id']) || str(raw['prompt_id']);
        const generation = typeof raw['execution_generation'] === 'number' ? raw['execution_generation'] : null;
        const summary = str(raw['command']) || str(raw['description']) || str(raw['question']) || str(raw['prompt']);
        return { events: [], control: { kind: type === 'approval.request' ? 'approval' : 'clarify', requestId, generation, summary } };
      }
      case 'run.completed': {
        const usage = raw['usage'] as { input_tokens?: unknown; output_tokens?: unknown } | undefined;
        const runtime = raw['runtime'] as { provider?: unknown; model?: unknown; requested?: { provider?: unknown; model?: unknown } } | undefined;
        const model = str(runtime?.model) || str(runtime?.requested?.model);
        const events: SessionEvent[] = [];
        if (usage) {
          events.push({
            kind: 'diagnostic',
            level: 'info',
            text: `Hermes 用量：输入 ${Number(usage.input_tokens ?? 0)}，输出 ${Number(usage.output_tokens ?? 0)}${model ? `（模型 ${model}）` : ''}`
          });
        }
        events.push({ kind: 'ended', outcome: 'done' });
        return { events, terminal: true };
      }
      case 'run.failed': {
        // Hermes 把「没做完就停了」（迭代预算用完、partial）也记成 failed（terminal_run_status）
        const partial = raw['partial'] === true || raw['completed'] === false;
        const reason = str(raw['error']) || (partial ? 'Hermes 没做完就停了（迭代预算用完或中途出错）' : 'Hermes 报告失败');
        return { events: [{ kind: 'ended', outcome: 'failed', reason }], terminal: true };
      }
      case 'run.cancelled':
        return { events: [{ kind: 'ended', outcome: 'stopped' }], terminal: true };
      case 'run.interrupted':
        return { events: [{ kind: 'ended', outcome: 'interrupted', reason: str(raw['reason']) || 'Hermes 中断了这一轮（可能在重启）' }], terminal: true };
      default:
        return { events: [] };
    }
  };
}
