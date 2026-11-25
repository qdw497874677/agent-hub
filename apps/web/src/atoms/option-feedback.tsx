import { useSyncExternalStore } from 'react';

export type OptionFeedback = {
  readonly state: 'pending' | 'confirmed' | 'saved' | 'unconfirmed' | 'rejected';
  readonly target: string | boolean;
  readonly original: string | boolean;
  readonly observed?: string | boolean;
  readonly recheck?: () => void;
  readonly requestToken?: symbol;
};

const entries = new Map<string, Readonly<Record<string, OptionFeedback>>>();
const listeners = new Set<() => void>();
const empty: Readonly<Record<string, OptionFeedback>> = {};
const MAX_SESSIONS = 192;
export function getOptionFeedback(sessionId: string, optionId: string): OptionFeedback | undefined {
  return entries.get(sessionId)?.[optionId];
}
export function setOptionFeedback(sessionId: string, optionId: string, feedback: OptionFeedback): void {
  const next = { ...entries.get(sessionId), [optionId]: feedback };
  entries.delete(sessionId);
  entries.set(sessionId, next);
  // Never evict an in-flight setting. Temporary overflow is trimmed as requests settle.
  for (const [id, value] of entries) {
    if (entries.size <= MAX_SESSIONS) break;
    if (id !== sessionId && !Object.values(value).some((item) => item.state === 'pending')) entries.delete(id);
  }
  listeners.forEach((listener) => listener());
}
export function optionFeedbackIsCurrent(sessionId: string, optionId: string, token: symbol): boolean {
  return entries.get(sessionId)?.[optionId]?.requestToken === token;
}
export function clearOptionFeedback(): void {
  if (entries.size === 0) return;
  entries.clear();
  listeners.forEach((listener) => listener());
}
export function useOptionFeedback(sessionId: string): Readonly<Record<string, OptionFeedback>> {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => entries.get(sessionId) ?? empty,
    () => empty
  );
}
