import type { SessionEvent } from '@agent-hub/domain';

/**
 * Pi RPC 事件 → 平台归一化事件。
 *
 * 没有 IO，但**有记忆**：产出物要看工具入参里的路径，而 Pi 只在
 * `tool_execution_start` 里给 `args`，`tool_execution_end` 只有 `toolCallId`
 * 和结果。所以按 `toolCallId` 记住「这次调用在写哪个文件」，等它成功结束后
 * 才发 artifact——按 `tool_execution_end` 的 args 找路径永远找不到，而那是
 * 这条链一开始的写法，结果是产出物一直静默为空。
 *
 * conformance fixtures 喂的就是一串事件，所以它们用的是同一个 mapper 实例。
 */
export interface PiEventMapper {
  map(record: unknown): SessionEvent[];
}

export function createPiEventMapper(): PiEventMapper {
  const writePaths = new Map<string, string>();
  return { map: (record) => mapRecord(record, writePaths) };
}

/** 一次性映射（不跨事件）：看不到前面那条 start 的入参，因此永远不会产出 artifact。 */
export function mapPiEvent(record: unknown): SessionEvent[] {
  return mapRecord(record, new Map());
}

function mapRecord(record: unknown, writePaths: Map<string, string>): SessionEvent[] {
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
    case 'tool_execution_start': {
      const path = artifactPath(r['toolName'], r['args']);
      if (path) writePaths.set(callKey(r), path);
      return [
        {
          kind: 'tool_call',
          name: String(r['toolName'] ?? 'unknown'),
          input: safeJson(r['args'])
        }
      ];
    }
    case 'tool_execution_end': {
      const events: SessionEvent[] = [
        {
          kind: 'tool_result',
          name: String(r['toolName'] ?? 'unknown'),
          ok: r['isError'] !== true,
          durationMs: typeof r['durationMs'] === 'number' ? Math.max(0, Math.round(r['durationMs'])) : 0
        }
      ];
      const key = callKey(r);
      const path = writePaths.get(key);
      writePaths.delete(key);
      // 失败的写不算产出物：文件可能只写了一半，或者根本没落地。
      if (path && r['isError'] !== true) events.push({ kind: 'artifact', path, bytes: 0 });
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
function artifactPath(toolName: unknown, args: unknown): string | null {
  if (typeof toolName !== 'string' || !WRITE_TOOLS.has(toolName)) return null;
  if (typeof args !== 'object' || args === null) return null;
  const record = args as Record<string, unknown>;
  const path = record['path'] ?? record['file_path'];
  return typeof path === 'string' && path !== '' ? path : null;
}

/** 按 toolCallId 关联；没有 id 的录制数据退化成按工具名关联，至少不会张冠李戴到别的文件。 */
function callKey(record: Record<string, unknown>): string {
  const id = record['toolCallId'];
  return typeof id === 'string' && id !== '' ? `id:${id}` : `name:${String(record['toolName'] ?? '')}`;
}

function safeJson(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}
