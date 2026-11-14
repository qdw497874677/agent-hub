import { clipToolOutput, type SessionEvent } from '@agent-hub/domain';

/**
 * Codex app-server 通知 → 平台归一化事件。纯函数：没有 IO，但 有记忆——
 * `turn/completed` 要看这一轮里有没有已经因为 `error` 发过 ended，避免同一轮两条 ended。
 *
 * `item/completed` 是唯一的「工具结果」来源：app-server 的 `item/started` 和
 * `item/completed` 都带完整 item，不需要像 Pi 那样按 id 记住入参。
 */
export interface CodexEventMapper {
  map(notification: unknown): SessionEvent[];
}

export function createCodexEventMapper(): CodexEventMapper {
  const state: MapperState = { turnId: null, endedThisTurn: false, errorReason: null };
  return { map: (notification) => mapRecord(notification, state) };
}

/** 一次性映射（不跨事件）：只看这一条，不记得本轮是否已经结束。 */
export function mapCodexEvent(notification: unknown): SessionEvent[] {
  return mapRecord(notification, { turnId: null, endedThisTurn: false, errorReason: null });
}

interface MapperState {
  turnId: string | null;
  endedThisTurn: boolean;
  errorReason: string | null;
}

function mapRecord(notification: unknown, state: MapperState): SessionEvent[] {
  const record = asRecord(notification);
  const method = textOf(record['method']);
  const params = asRecord(record['params']);
  switch (method) {
    case 'turn/started': {
      const turn = asRecord(params['turn']);
      const turnId = textOf(turn['id']);
      if (turnId !== '') state.turnId = turnId;
      state.endedThisTurn = false;
      state.errorReason = null;
      return [];
    }
    case 'turn/completed':
      return finishTurn(params, state);
    case 'error':
      return mapError(params, state);
    case 'item/agentMessage/delta': {
      const delta = textOf(params['delta']);
      return delta === '' ? [] : [{ kind: 'text', delta }];
    }
    case 'item/reasoning/textDelta':
    case 'item/reasoning/summaryTextDelta': {
      const delta = textOf(params['delta']);
      return delta === '' ? [] : [{ kind: 'thinking', delta }];
    }
    case 'item/started':
      return mapItem(params, 'started');
    case 'item/completed':
      return mapItem(params, 'completed');
    case 'thread/tokenUsage/updated':
      return mapTokenUsage(params);
    default:
      return [];
  }
}

function finishTurn(params: Record<string, unknown>, state: MapperState): SessionEvent[] {
  const turn = asRecord(params['turn']);
  const status = textOf(turn['status']);
  state.turnId = null;
  if (state.endedThisTurn) {
    // error 已经发过 failed，这一轮的 turn/completed 只用来收尾。
    state.errorReason = null;
    return [];
  }
  state.endedThisTurn = true;
  if (status === 'interrupted') {
    state.errorReason = null;
    return [{ kind: 'ended', outcome: 'stopped' }];
  }
  if (status === 'failed') {
    const reason = state.errorReason ?? errorText(turn['error']) ?? 'Codex 这一轮失败了';
    state.errorReason = null;
    return [{ kind: 'ended', outcome: 'failed', reason }];
  }
  state.errorReason = null;
  return [{ kind: 'ended', outcome: 'done' }];
}

function mapError(params: Record<string, unknown>, state: MapperState): SessionEvent[] {
  const error = asRecord(params['error']);
  const message = textOf(error['message']) || 'Codex 报了个错';
  const events: SessionEvent[] = [{ kind: 'diagnostic', level: 'error', text: message }];
  state.errorReason = message;
  // willRetry=true 表示 Codex 自己会重试，这一轮还没结束；否则本轮已经废了。
  if (params['willRetry'] !== true && state.turnId !== null && !state.endedThisTurn) {
    state.endedThisTurn = true;
    state.turnId = null;
    events.push({ kind: 'ended', outcome: 'failed', reason: message });
  }
  return events;
}

function mapItem(params: Record<string, unknown>, phase: 'started' | 'completed'): SessionEvent[] {
  const item = asRecord(params['item']);
  const type = textOf(item['type']);
  switch (type) {
    case 'commandExecution':
      return mapCommandExecution(item, params, phase);
    case 'fileChange':
      return mapFileChange(item, phase);
    case 'mcpToolCall':
      return mapMcpToolCall(item, phase);
    case 'webSearch': {
      if (phase !== 'started') return [];
      const query = textOf(item['query']);
      return [{ kind: 'tool_call', name: 'web_search', input: query }];
    }
    // plan / reasoning / agentMessage / userMessage / contextCompaction 等不单独报事件：
    // 文本走 delta，思考走 reasoning delta。
    default:
      return [];
  }
}

function mapCommandExecution(
  item: Record<string, unknown>,
  params: Record<string, unknown>,
  phase: 'started' | 'completed'
): SessionEvent[] {
  const command = textOf(item['command']);
  const name = command === '' ? 'command' : command;
  if (phase === 'started') return [{ kind: 'tool_call', name, input: command }];
  const status = textOf(item['status']);
  const exitCode = numberOf(item['exitCode']);
  const output = textOf(item['aggregatedOutput']);
  const duration = numberOf(item['durationMs']) ?? elapsed(params);
  return [
    {
      kind: 'tool_result',
      name,
      ok: status === 'completed' && (exitCode === undefined || exitCode === 0),
      durationMs: Math.round(duration),
      ...(output === '' ? {} : { output: clipToolOutput(output) })
    }
  ];
}

function mapFileChange(item: Record<string, unknown>, phase: 'started' | 'completed'): SessionEvent[] {
  const changes = Array.isArray(item['changes']) ? item['changes'] : [];
  const paths = changes.map((change) => textOf(asRecord(change)['path'])).filter((path) => path !== '');
  if (phase === 'started') {
    const input = changes
      .map((change) => {
        const entry = asRecord(change);
        const kind = asRecord(entry['kind']);
        return `${textOf(kind['type']) || 'update'} ${textOf(entry['path'])}`;
      })
      .join('\n');
    return [{ kind: 'tool_call', name: 'apply_patch', input }];
  }
  // 只有整批成功才算产出物：失败/拒绝时文件可能只落了一半。
  if (textOf(item['status']) !== 'completed') return [];
  return paths.map((path) => ({ kind: 'artifact', path, bytes: 0 }));
}

function mapMcpToolCall(item: Record<string, unknown>, phase: 'started' | 'completed'): SessionEvent[] {
  const server = textOf(item['server']);
  const tool = textOf(item['tool']);
  const name = `${server}/${tool}`;
  if (phase === 'started') {
    return [{ kind: 'tool_call', name, input: safeJson(item['arguments']) }];
  }
  const error = asRecord(item['error']);
  const errorMessage = textOf(error['message']);
  const output = errorMessage !== '' ? errorMessage : mcpText(item['result']);
  const duration = numberOf(item['durationMs']) ?? 0;
  return [
    {
      kind: 'tool_result',
      name,
      ok: errorMessage === '',
      durationMs: Math.round(duration),
      ...(output === '' ? {} : { output: clipToolOutput(output) })
    }
  ];
}

function mapTokenUsage(params: Record<string, unknown>): SessionEvent[] {
  const usage = asRecord(params['tokenUsage']);
  const last = asRecord(usage['last']);
  const used = numberOf(last['totalTokens']) ?? null;
  const window = numberOf(usage['modelContextWindow']) ?? 0;
  if (window <= 0) {
    return [{ kind: 'context_usage', usedTokens: used, windowTokens: 0, percent: null }];
  }
  const percent = used === null ? null : Math.round((used / window) * 1000) / 10;
  return [{ kind: 'context_usage', usedTokens: used, windowTokens: window, percent }];
}

function mcpText(result: unknown): string {
  const content = asRecord(result)['content'];
  if (!Array.isArray(content)) return '';
  return content
    .map((entry) => {
      const record = asRecord(entry);
      return record['type'] === 'text' ? textOf(record['text']) : '';
    })
    .filter((text) => text !== '')
    .join('\n');
}

function elapsed(params: Record<string, unknown>): number {
  const started = numberOf(params['startedAtMs']);
  const completed = numberOf(params['completedAtMs']);
  if (started === undefined || completed === undefined) return 0;
  return Math.max(0, completed - started);
}

function errorText(value: unknown): string | null {
  if (typeof value === 'string' && value !== '') return value;
  const message = textOf(asRecord(value)['message']);
  return message === '' ? null : message;
}

function safeJson(value: unknown): string {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
