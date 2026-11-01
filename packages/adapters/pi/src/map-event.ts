import { clipToolOutput, type SessionEvent } from '@agent-hub/domain';

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
  const turn: TurnState = { error: null };
  return { map: (record) => mapRecord(record, writePaths, turn) };
}

/** 一次性映射（不跨事件）：看不到前面那条 start 的入参，因此永远不会产出 artifact。 */
export function mapPiEvent(record: unknown): SessionEvent[] {
  return mapRecord(record, new Map(), { error: null });
}

/**
 * 这一轮里模型调用失败的原因。Pi 把它放在 assistant 消息的 `stopReason: 'error'` + `errorMessage` 上，
 * 最后照样发 `agent_settled`（没有 aborted）——只看 settled 就会把失败记成「完成」，用户看到的是发了没回。
 */
interface TurnState {
  error: string | null;
}

function mapRecord(record: unknown, writePaths: Map<string, string>, turn: TurnState): SessionEvent[] {
  if (typeof record !== 'object' || record === null) return [];
  const r = record as Record<string, unknown>;
  const type = r['type'];

  switch (type) {
    case 'message_update': {
      const inner = r['assistantMessageEvent'] as Record<string, unknown> | undefined;
      if (inner?.['type'] === 'text_delta' && typeof inner['delta'] === 'string') {
        return inner['delta'] === '' ? [] : [{ kind: 'text', delta: inner['delta'] }];
      }
      if (inner?.['type'] === 'thinking_delta' && typeof inner['delta'] === 'string') {
        return inner['delta'] === '' ? [] : [{ kind: 'thinking', delta: inner['delta'] }];
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
          durationMs: typeof r['durationMs'] === 'number' ? Math.max(0, Math.round(r['durationMs'])) : 0,
          ...outputOf(r['result'])
        }
      ];
      const key = callKey(r);
      const path = writePaths.get(key);
      writePaths.delete(key);
      // 失败的写不算产出物：文件可能只写了一半，或者根本没落地。
      if (path && r['isError'] !== true) events.push({ kind: 'artifact', path, bytes: 0 });
      return events;
    }
    case 'agent_start':
      turn.error = null;
      return [];
    case 'message_end': {
      const message = r['message'] as Record<string, unknown> | undefined;
      if (message?.['role'] === 'assistant' && message['stopReason'] === 'error') {
        turn.error = typeof message['errorMessage'] === 'string' ? message['errorMessage'] : '';
      }
      return [];
    }
    case 'agent_settled': {
      const error = turn.error;
      turn.error = null;
      if (r['aborted'] === true) return [{ kind: 'ended', outcome: 'stopped' }];
      if (error !== null) return [{ kind: 'ended', outcome: 'failed', reason: modelFailure(error) }];
      return [{ kind: 'ended', outcome: 'done' }];
    }
    case 'session_info_changed':
      return [];
    case 'compaction_start':
      return [{ kind: 'compaction', phase: 'start', reason: compactionReason(r['reason']) }];
    case 'compaction_end':
      return [compactionEnd(r)];
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

/**
 * 把 Pi 的 `errorMessage` 说成人话。它通常长这样：
 * `OpenAI API error (401): {"type":"authentication_error","code":"api_key_expired","message":"…"}`。
 * 认得的几种给出该做什么；其余原样带上服务商的 message，不吞。
 */
export function modelFailure(raw: string): string {
  const status = /\((\d{3})\)/.exec(raw)?.[1];
  let code = '';
  let message = raw.trim();
  const json = raw.indexOf('{');
  if (json >= 0) {
    try {
      const body = JSON.parse(raw.slice(json)) as Record<string, unknown>;
      const inner = (typeof body['error'] === 'object' && body['error'] !== null ? body['error'] : body) as Record<string, unknown>;
      code = String(inner['code'] ?? inner['type'] ?? '');
      if (typeof inner['message'] === 'string') message = inner['message'];
    } catch {
      // 不是 JSON：用原文
    }
  }
  const head = '模型调用失败';
  if (code === 'api_key_expired') return `${head}：API key 已过期。到服务商控制台新建一个 key，更新到这台机器上 Pi 的配置里再试。（${message}）`;
  if (status === '401' || status === '403' || /authentication|unauthorized|invalid.?api.?key/i.test(code))
    return `${head}：认证没通过（${status ?? code}），检查这台机器上 Pi 配的 API key。（${message}）`;
  if (status === '429') return `${head}：被限流或额度用完（429），稍后再试或换个模型。（${message}）`;
  if (message === '') return `${head}：服务商没有给出原因`;
  return `${head}：${status ? `(${status}) ` : ''}${message}`;
}

/** Pi 的工具结果：`{ content: [{ type: 'text', text }], structuredContent? }`。只取文字，截断后进 journal。 */
function outputOf(result: unknown): { output?: string } {
  if (typeof result === 'string') return result === '' ? {} : { output: clipToolOutput(result) };
  if (typeof result !== 'object' || result === null) return {};
  const content = (result as Record<string, unknown>)['content'];
  if (!Array.isArray(content)) return {};
  const text = content
    .map((part) => (typeof part === 'object' && part !== null && (part as Record<string, unknown>)['type'] === 'text' ? String((part as Record<string, unknown>)['text'] ?? '') : ''))
    .join('');
  return text === '' ? {} : { output: clipToolOutput(text) };
}

function compactionReason(raw: unknown): 'manual' | 'threshold' | 'overflow' {
  return raw === 'manual' || raw === 'overflow' ? raw : 'threshold';
}

const nonNegInt = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined);

/** `compaction_end`：有 result 就是成功；没有 = 中止（aborted）或失败（errorMessage）。摘要截断后进 journal。 */
export function compactionEnd(r: Record<string, unknown>): SessionEvent {
  const reason = compactionReason(r['reason']);
  const result = typeof r['result'] === 'object' && r['result'] !== null ? (r['result'] as Record<string, unknown>) : null;
  if (!result) {
    const error = r['aborted'] === true ? '被中止' : typeof r['errorMessage'] === 'string' ? r['errorMessage'].slice(0, 2000) : '没有说原因';
    return { kind: 'compaction', phase: 'end', reason, ok: false, error };
  }
  return compactionResult(result, reason);
}

export function compactionResult(result: Record<string, unknown>, reason: 'manual' | 'threshold' | 'overflow'): SessionEvent {
  const before = nonNegInt(result['tokensBefore']);
  const after = nonNegInt(result['estimatedTokensAfter']);
  return {
    kind: 'compaction',
    phase: 'end',
    reason,
    ok: true,
    ...(before !== undefined ? { tokensBefore: before } : {}),
    ...(after !== undefined ? { tokensAfter: after } : {}),
    ...(typeof result['summary'] === 'string' ? { summary: result['summary'].slice(0, 20000) } : {})
  };
}

/** `get_session_stats` 的 data → context_usage；没有 contextUsage（没模型 / 没窗口）就不报。 */
export function usageFromStats(data: unknown): SessionEvent | null {
  if (typeof data !== 'object' || data === null) return null;
  const usage = (data as Record<string, unknown>)['contextUsage'];
  if (typeof usage !== 'object' || usage === null) return null;
  const u = usage as Record<string, unknown>;
  const windowTokens = nonNegInt(u['contextWindow']);
  if (windowTokens === undefined || windowTokens === 0) return null;
  const used = nonNegInt(u['tokens']);
  const percent = typeof u['percent'] === 'number' && Number.isFinite(u['percent']) && u['percent'] >= 0 ? u['percent'] : null;
  return { kind: 'context_usage', usedTokens: used ?? null, windowTokens, percent: used === undefined ? null : percent };
}
