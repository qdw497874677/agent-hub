import type { SessionEvent } from '@agent-hub/domain';

/**
 * Pi RPC 事件 → 平台归一化事件。
 *
 * 纯函数，没有 IO：conformance fixtures 就是喂它一串录制的事件，
 * 断言吐出的归一化事件序列。这是 X1 的门槛——新增 agent 只要这张表能对上。
 */
export function mapPiEvent(record: unknown): SessionEvent[] {
  if (typeof record !== 'object' || record === null) return [];
  const r = record as Record<string, unknown>;
  const type = r['type'];

  switch (type) {
    case 'message_update': {
      const inner = r['assistantMessageEvent'] as Record<string, unknown> | undefined;
      if (inner?.['type'] === 'text_delta' && typeof inner['delta'] === 'string') {
        return inner['delta'] === '' ? [] : [{ kind: 'text', delta: inner['delta'] }];
      }
      return [];
    }
    case 'tool_execution_start':
      return [
        {
          kind: 'tool_call',
          name: String(r['toolName'] ?? 'unknown'),
          input: safeJson(r['args'])
        }
      ];
    case 'tool_execution_end': {
      const events: SessionEvent[] = [
        {
          kind: 'tool_result',
          name: String(r['toolName'] ?? 'unknown'),
          ok: r['isError'] !== true,
          durationMs: typeof r['durationMs'] === 'number' ? Math.max(0, Math.round(r['durationMs'])) : 0
        }
      ];
      const artifact = artifactOf(r['toolName'], r['args']);
      if (artifact) events.push(artifact);
      return events;
    }
    case 'agent_settled':
      return [{ kind: 'ended', outcome: r['aborted'] === true ? 'stopped' : 'done' }];
    case 'session_info_changed':
      return [];
    case 'response': {
      if (r['success'] === true) return [];
      return [{ kind: 'diagnostic', level: 'error', text: `${String(r['command'])}：${String(r['error'])}` }];
    }
    default:
      return [];
  }
}

const WRITE_TOOLS = new Set(['write', 'edit', 'create', 'apply_patch']);

/** 只有写文件类工具才算产出物。其余工具的入参只是噪音。 */
function artifactOf(toolName: unknown, args: unknown): SessionEvent | null {
  if (typeof toolName !== 'string' || !WRITE_TOOLS.has(toolName)) return null;
  if (typeof args !== 'object' || args === null) return null;
  const path = (args as Record<string, unknown>)['path'] ?? (args as Record<string, unknown>)['file_path'];
  if (typeof path !== 'string' || !path) return null;
  // 字节数由 server 用 WorkspaceFS 补上：worker 手上没有权威的 stat。
  return { kind: 'artifact', path, bytes: 0 };
}

function safeJson(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}
