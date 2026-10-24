import type { Seq } from './ids.ts';

/**
 * 归一化事件。六个变体，加变体要改这份文件并过 ADR：
 * 变体数就是新 agent 的映射成本，它直接决定「新增 agent 零内核改动」的成本。
 */
export const SESSION_EVENT_KINDS = [
  'text',
  'tool_call',
  'tool_result',
  'artifact',
  'ended',
  'diagnostic'
] as const;

export type SessionEvent =
  | { readonly kind: 'text'; readonly delta: string }
  | { readonly kind: 'tool_call'; readonly name: string; readonly input: string }
  | {
      readonly kind: 'tool_result';
      readonly name: string;
      readonly ok: boolean;
      readonly durationMs: number;
    }
  | { readonly kind: 'artifact'; readonly path: string; readonly bytes: number }
  | {
      readonly kind: 'ended';
      readonly outcome: 'done' | 'stopped' | 'interrupted' | 'failed';
      readonly reason?: string;
    }
  | { readonly kind: 'diagnostic'; readonly level: 'info' | 'warn' | 'error'; readonly text: string };

/** 画布卡片默认渲染的事件。diagnostic 只进事件流抽屉。 */
export const CARD_EVENT_KINDS = ['text', 'tool_call', 'tool_result', 'artifact'] as const;

export function showsOnCard(event: SessionEvent): boolean {
  return event.kind !== 'diagnostic' && event.kind !== 'ended';
}

export interface JournalEntry {
  readonly seq: Seq;
  readonly event: SessionEvent;
  readonly at: number;
}
