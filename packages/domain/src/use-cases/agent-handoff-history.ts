import type { JournalEntry } from '../event.ts';
import type { AgentHandoffDeliveryEvidence } from '../ports/agent-handoff-store.ts';
import { isUnknownOutcomeEnded } from '../attention.ts';
import { HANDOFF_TOKEN_CAP, renderHandoffDocument, type HandoffDocument, type HandoffItem } from '../handoff.ts';
import { estimateTokens } from '../memory.ts';

/** The caller must fetch an already bounded, ascending slice for this exact session. */
export const AGENT_HANDOFF_MAX_ENTRIES = 2_000;
export const AGENT_HANDOFF_MAX_SOURCE_BYTES = 2 * 1024 * 1024;
export const AGENT_HANDOFF_MAX_DELIVERIES = 2_000;
export const AGENT_HANDOFF_MAX_CURRENT_TEXT_BYTES = 2 * 1024 * 1024;

export type { AgentHandoffDeliveryEvidence } from '../ports/agent-handoff-store.ts';

export interface AgentHandoffHistoryInput {
  readonly sourceSessionId: string;
  /** Inclusive, fixed source boundary. */
  readonly cursor: number;
  readonly entries: readonly JournalEntry[];
  readonly deliveries: readonly AgentHandoffDeliveryEvidence[];
  /** Target window, never inferred from source. */
  readonly windowTokens: number;
  /** Exact first user text, reserved but never included in the history. */
  readonly currentText: string;
  readonly cap?: number;
}

export interface AgentHandoffHistory {
  readonly document: HandoffDocument;
  readonly text: string;
  /** Actual payload to deliver. With history, the new prompt is a lossless JSON string. */
  readonly deliveryText: string;
  /** Estimated whole-payload limit after the window's response and overhead reserves. */
  readonly deliveryTokenLimit: number;
  /** Counts only observed, in-slice omissions; the slice may itself be incomplete. */
  readonly omissions: {
    /** No claim is made that the supplied slice contains the complete source. */
    readonly sourceSliceCompleteness: 'unknown';
    readonly unprovedOrIneligiblePrompts: number;
    readonly unprovedOrIneligibleTextEvents: number;
    readonly budgetItems: number;
  };
}

// Bound work and allocation before stringifying or inspecting arbitrary journal payloads.
function boundedBytes(value: unknown, limit: number): void {
  const stack: unknown[] = [value];
  const seen = new WeakSet<object>();
  const encoder = new TextEncoder();
  let bytes = 0;
  let nodes = 0;
  while (stack.length) {
    if (++nodes > limit) throw new RangeError('source exceeds node limit');
    const next = stack.pop();
    if (typeof next === 'string') {
      if (next.length > limit - bytes) throw new RangeError('source exceeds byte limit');
      bytes += encoder.encode(next).length;
    } else if (next !== null && typeof next === 'object') {
      if (seen.has(next)) throw new RangeError('source contains repeated or cyclic object');
      seen.add(next);
      for (const key in next) {
        if (!Object.hasOwn(next, key)) continue;
        bytes += key.length;
        if (bytes > limit || stack.length >= limit) throw new RangeError('source exceeds byte limit');
        stack.push(Reflect.get(next, key));
      }
    } else bytes += 8;
    if (bytes > limit) throw new RangeError('source exceeds byte limit');
  }
}

/**
 * Projection only, not an occupancy/reservation guard: omitted prompts may still occupy the session.
 * Reserves 25% of the explicitly supplied target window for response and 400 tokens
 * for other context. Throws RangeError if the raw new text alone exceeds the
 * remainder; text is never cut. Estimates are not a model-tokenizer guarantee.
 * JSON string literals make line boundaries unambiguous, not prompt-injection-proof.
 */
export function buildAgentHandoffHistory(input: AgentHandoffHistoryInput): AgentHandoffHistory {
  if (!Number.isSafeInteger(input.cursor) || input.cursor < 0) throw new RangeError('cursor must be a non-negative safe integer');
  if (!Number.isSafeInteger(input.windowTokens) || input.windowTokens <= 0) throw new RangeError('windowTokens must be a positive safe integer');
  if (input.cap !== undefined && (!Number.isSafeInteger(input.cap) || input.cap < 0)) throw new RangeError('cap must be a non-negative safe integer');
  if (!input.sourceSessionId) throw new RangeError('sourceSessionId is required');
  if (input.entries.length > AGENT_HANDOFF_MAX_ENTRIES || input.deliveries.length > AGENT_HANDOFF_MAX_DELIVERIES) throw new RangeError('source exceeds count limit');
  boundedBytes([input.sourceSessionId, input.entries, input.deliveries], AGENT_HANDOFF_MAX_SOURCE_BYTES);
  boundedBytes(input.currentText, AGENT_HANDOFF_MAX_CURRENT_TEXT_BYTES);
  const deliveryTokenLimit = Math.max(0, input.windowTokens - Math.ceil(input.windowTokens / 4) - 400);
  if (estimateTokens(input.currentText) > deliveryTokenLimit) throw new RangeError('currentText exceeds target delivery token limit');

  const entries = new Map<number, JournalEntry>();
  let previous = 0;
  for (const entry of input.entries) {
    if (!Number.isSafeInteger(entry.seq) || entry.seq <= previous) throw new RangeError('journal sequence must be positive and strictly ascending');
    previous = entry.seq;
    if (entry.seq <= input.cursor) entries.set(entry.seq, entry);
  }
  const ids = new Set<string>();
  const prompts = new Set<number>();
  const endSeqs = new Set<number>();
  for (const d of input.deliveries) {
    if (d.sessionId !== input.sourceSessionId || !d.deliveryId || !Number.isSafeInteger(d.promptSeq) || d.promptSeq <= 0 || !Number.isSafeInteger(d.ended.seq) || d.ended.seq <= d.promptSeq) throw new RangeError('invalid delivery evidence');
    if (ids.has(d.deliveryId) || prompts.has(d.promptSeq) || endSeqs.has(d.ended.seq)) throw new RangeError('duplicate delivery evidence');
    ids.add(d.deliveryId); prompts.add(d.promptSeq); endSeqs.add(d.ended.seq);
  }
  const endedCounts = new Map<string, number>();
  for (const { event } of entries.values()) {
    if (event.kind === 'ended' && event.deliveryId && ids.has(event.deliveryId)) endedCounts.set(event.deliveryId, (endedCounts.get(event.deliveryId) ?? 0) + 1);
  }
  if ([...endedCounts.values()].some((count) => count > 1)) throw new RangeError('duplicate keyed ended event');

  const eligible = new Map<string, AgentHandoffDeliveryEvidence>();
  const humanSeqs = new Set<number>();
  for (const d of input.deliveries) {
    const prompt = entries.get(d.promptSeq)?.event;
    const end = entries.get(d.ended.seq)?.event;
    if (prompt?.kind !== 'prompt' || prompt.promptActor !== 'account' || prompt.messageSource !== undefined || prompt.handoff !== undefined || !prompt.text.trim()) continue;
    if (d.ended.outcome === 'unknown' || end?.kind !== 'ended' || isUnknownOutcomeEnded(end) || end.deliveryId !== d.deliveryId || end.outcome !== d.ended.outcome) continue;
    eligible.set(d.deliveryId, d);
    humanSeqs.add(d.promptSeq);
  }

  const items: HandoffItem[] = [];
  const excerptPromptSeq = new Map<number, number>();
  const excerpted = new Set<string>();
  let turn = 0;
  let omittedPrompts = 0;
  let omittedText = 0;
  for (const { seq, event } of entries.values()) {
    if (event.kind === 'prompt') {
      if (!humanSeqs.has(seq)) { omittedPrompts++; continue; }
      turn++;
      items.push({ seq, lastSeq: seq, turn, role: 'user', kind: 'user', text: `用户（历史 #${seq}，JSON 字符串）：${quoteText(event.text)}` });
    } else if (event.kind === 'text') {
      const d = event.firstOutputDeliveryId ? eligible.get(event.firstOutputDeliveryId) : undefined;
      if (!d || d.ended.outcome !== 'done' || seq <= d.promptSeq || seq >= d.ended.seq || event.textOrigin !== 'main_assistant' || event.subagentId !== undefined || !event.delta.trim() || excerpted.has(d.deliveryId)) { omittedText++; continue; }
      excerpted.add(d.deliveryId);
      // A single tagged event is evidence of an excerpt, never of the complete reply.
      items.push({ seq, lastSeq: seq, turn: 0, role: 'assistant', kind: 'assistant', text: `助手（对应用户历史 #${d.promptSeq} 的摘录，非完整回复，JSON 字符串）：${quoteText(event.delta)}` });
      excerptPromptSeq.set(seq, d.promptSeq);
    }
  }

  const budget = Math.max(0, Math.min(input.cap ?? HANDOFF_TOKEN_CAP, deliveryTokenLimit - estimateTokens(input.currentText)));
  // Whole entries only: no trimming or synthetic partial text. Reserve a token per
  // character; this upper bounds the estimator even across entry boundaries.
  const framing = 512;
  let remaining = Math.max(0, budget - framing);
  const selected = new Set<number>();
  const selectedPrompts = new Set<number>();
  for (const kind of ['user', 'assistant'] as const) {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]!;
      if (item.kind !== kind || (kind === 'assistant' && !selectedPrompts.has(excerptPromptSeq.get(item.seq)!))) continue;
      const cost = item.text.length + 1;
      if (cost <= remaining) {
        selected.add(i); remaining -= cost;
        if (kind === 'user') selectedPrompts.add(item.seq);
      }
    }
  }
  const kept = items.filter((_, i) => selected.has(i));
  const stats = { sourceSessionId: input.sourceSessionId, turns: turn, carriedTurns: kept.filter((i) => i.kind === 'user').length, carried: kept.length, omitted: items.length - kept.length, omittedTurns: [] as [number, number][], tokens: kept.reduce((sum, i) => sum + estimateTokens(i.text), 0), budget };
  let document: HandoffDocument = { version: 1, sourceSessionId: input.sourceSessionId, cursor: input.cursor, parts: kept.map((item) => ({ kind: 'entry', item })), stats };
  let text = renderHandoffDocument(document);
  let deliveryText = text ? `${text}\n\n--- 本次用户请求（JSON 字符串） ---\n${quoteText(input.currentText)}` : input.currentText;
  // Verify both the independent history cap and the actual assembled payload.
  if (estimateTokens(text) > budget || estimateTokens(deliveryText) > deliveryTokenLimit) {
    document = { ...document, parts: [], stats: { ...stats, carried: 0, carriedTurns: 0, omitted: items.length, tokens: 0 } };
    text = '';
    deliveryText = input.currentText;
  }
  return { document, text, deliveryText, deliveryTokenLimit, omissions: { sourceSliceCompleteness: 'unknown', unprovedOrIneligiblePrompts: omittedPrompts, unprovedOrIneligibleTextEvents: omittedText, budgetItems: document.stats.omitted } };
}

// JSON escapes newlines, quotes and backslashes; escape Unicode line separators too.
function quoteText(text: string): string {
  return JSON.stringify(text).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
