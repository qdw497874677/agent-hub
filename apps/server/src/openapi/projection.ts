/** 会话事件投影：工具输入/输出、思考、提示词原文都不出去（只留工具名与成败）。 */

export type ProjectedEvent = Record<string, unknown>;

export interface EventList {
  readonly events: ProjectedEvent[];
  /**
   * 下一次轮询应传的 after：本窗扫到的最后一条原始 journal seq
   *（即使这些事件全部被投影丢掉，也要前进，避免客户端卡在同一游标空转）。
   * 窗口里没有任何原始事件时，沿用入参 after 或 0。
   */
  readonly nextAfter: number;
}

/** 对外会投影出来的领域 event.kind。其余（thinking / prompt / commands…）一律不出。 */
const PROJECTABLE_KINDS = new Set(['text', 'tool_call', 'tool_result', 'ended', 'diagnostic']);

export function isProjectableEntry(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const event = (raw as { event?: { kind?: unknown } }).event;
  return typeof event?.kind === 'string' && PROJECTABLE_KINDS.has(event.kind);
}

export function lastJournalSeq(entries: readonly unknown[], fallback = 0): number {
  let last = fallback;
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') continue;
    const seq = (raw as { seq?: unknown }).seq;
    if (typeof seq === 'number' && Number.isFinite(seq) && seq > last) last = seq;
  }
  return last;
}

function projectEventList(value: unknown[]): ProjectedEvent[] {
  const out: ProjectedEvent[] = [];
  for (const raw of value) {
    const entry = raw as { seq?: number; at?: number; turn?: number; event?: Record<string, unknown> };
    const event = entry.event ?? {};
    const kind = typeof event['kind'] === 'string' ? event['kind'] : '';
    // turn 要带上：调用方靠它把「这一句」和「这一轮的事件」对上（events?sinceTurn=）。
    const base = { seq: entry.seq ?? 0, at: entry.at ?? 0, ...(typeof entry.turn === 'number' ? { turn: entry.turn } : {}) };
    if (kind === 'text') {
      // 领域里正文是 `delta`（增量）；老数据 / 其它 codec 可能给 `text`，两个都认。
      const text = typeof event['delta'] === 'string' ? event['delta'] : typeof event['text'] === 'string' ? event['text'] : '';
      out.push({ ...base, event: { kind: 'text', text } });
    } else if (kind === 'tool_call') {
      out.push({ ...base, event: { kind: 'tool', name: String(event['name'] ?? 'tool') } });
    } else if (kind === 'tool_result') {
      out.push({ ...base, event: { kind: 'tool_result', ok: event['ok'] === true } });
    } else if (kind === 'ended') {
      out.push({ ...base, event: { kind: 'ended', outcome: String(event['outcome'] ?? 'done'), ...(typeof event['reason'] === 'string' ? { reason: event['reason'] } : {}) } });
    } else if (kind === 'diagnostic') {
      out.push({ ...base, event: { kind: 'diagnostic', level: String(event['level'] ?? 'info'), text: '诊断细节已省略' } });
    }
    // 其余（thinking / prompt / commands / approval / artifact…）一律不出。
  }
  return out;
}

/**
 * MCP / OpenAPI 的对外形状：`{ events, nextAfter }`。
 * 入参可以是事件数组，也可以已经是这份对象（再投影一次 events）。
 * `scannedUntil` 优先作为 nextAfter（handler 传入本窗最后一条原始 seq）。
 */
export function projectEvents(value: unknown, fallbackAfter = 0, scannedUntil?: number): EventList | unknown {
  const rawList = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { events?: unknown }).events)
      ? ((value as { events: unknown[] }).events)
      : null;
  if (rawList === null) return value;
  const events = projectEventList(rawList);
  const given = value && typeof value === 'object' && !Array.isArray(value) ? (value as { nextAfter?: unknown }).nextAfter : undefined;
  const nextAfter =
    typeof given === 'number'
      ? given
      : typeof scannedUntil === 'number'
        ? scannedUntil
        : lastJournalSeq(rawList, fallbackAfter);
  return { events, nextAfter };
}
