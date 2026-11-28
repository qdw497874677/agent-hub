import { checkAdd, type Draft } from './attachments.ts';

export interface DraftEntry {
  readonly text: string;
  readonly items: readonly Draft[];
  readonly revision: number;
  readonly pending: boolean;
  readonly recovery: readonly DraftSnapshot[];
}
export interface DraftSnapshot { readonly text: string; readonly items: readonly Draft[] }
export interface DraftClaim extends DraftSnapshot { readonly sessionId: string; readonly revision: number; readonly token: object }
const empty: DraftEntry = { text: '', items: [], revision: 0, pending: false, recovery: [] };

/** Account-scoped, synchronous transactions; callers must not retain this across accounts. */
export class WorkbenchDraftStore {
  private entries: Record<string, DraftEntry> = {};
  private texts: Record<string, string> = {};
  private locks = new Map<string, object>();
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getTexts = (): Record<string, string> => this.texts;
  getEntry = (id: string): DraftEntry => this.entries[id] ?? empty;
  private update(id: string, entry: DraftEntry): void {
    this.entries = { ...this.entries, [id]: entry };
    this.texts = { ...this.texts, [id]: entry.text };
    this.listeners.forEach((listener) => listener());
  }
  setText(id: string, text: string): void {
    const current = this.getEntry(id);
    if (current.text === text) return;
    this.update(id, { ...current, text, revision: current.revision + 1 });
  }
  setTexts(update: Record<string, string> | ((current: Record<string, string>) => Record<string, string>)): void {
    const next = typeof update === 'function' ? update(this.texts) : update;
    for (const id of new Set([...Object.keys(this.texts), ...Object.keys(next)])) this.setText(id, next[id] ?? '');
  }
  setItems(id: string, update: (items: readonly Draft[]) => readonly Draft[]): void {
    const current = this.getEntry(id);
    const items = update(current.items);
    if (items === current.items) return;
    this.update(id, { ...current, items, revision: current.revision + 1 });
  }
  addItem(id: string, item: Draft): string | null {
    const current = this.getEntry(id);
    if (item.kind === 'mention' && current.items.some((other) => other.kind === 'mention' && other.path === item.path)) return null;
    const reason = item.kind === 'mention' ? (current.items.length >= 8 ? '最多 8 个附件' : null) : checkAdd(current.items, item);
    if (reason) return reason;
    this.setItems(id, (items) => [...items, item]);
    return null;
  }
  claim(id: string): DraftClaim | null {
    const current = this.getEntry(id);
    if (this.locks.has(id) || (current.text.trim() === '' && current.items.length === 0)) return null;
    const token = {};
    this.locks.set(id, token);
    const revision = current.revision + 1;
    this.update(id, { ...current, text: '', items: [], revision, pending: true });
    return { sessionId: id, text: current.text, items: current.items, revision, token };
  }
  finish(claim: DraftClaim, success: boolean): void {
    if (this.locks.get(claim.sessionId) !== claim.token) return;
    this.locks.delete(claim.sessionId);
    const current = this.getEntry(claim.sessionId);
    if (success) this.update(claim.sessionId, { ...current, pending: false });
    else if (current.revision === claim.revision) this.update(claim.sessionId, { ...current, text: claim.text, items: claim.items, revision: current.revision + 1, pending: false });
    else this.update(claim.sessionId, { ...current, pending: false, recovery: [...current.recovery, { text: claim.text, items: claim.items }] });
  }
  recover(id: string): boolean {
    const current = this.getEntry(id);
    const snapshot = current.recovery[0];
    if (!snapshot || current.text !== '' || current.items.length !== 0 || current.pending) return false;
    this.update(id, { ...current, ...snapshot, revision: current.revision + 1, recovery: current.recovery.slice(1) });
    return true;
  }
}
