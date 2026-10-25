import type { AuditEntry } from '../account.ts';

export interface AuditLog {
  append(entry: AuditEntry): Promise<void>;
  /** 新的在前。 */
  recent(limit: number): Promise<AuditEntry[]>;
}
