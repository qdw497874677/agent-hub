import type { AuditEntry } from '../account.ts';

/** 审计查询的过滤条件（ADR 0011）：都可选，组合起来是「且」。 */
export interface AuditFilter {
  /** 动作前缀，例如 'auth.' 或完整的 'auth.login_failed'。 */
  readonly action?: string;
  /** 操作人邮箱，子串、不分大小写。 */
  readonly actor?: string;
  /** 来源 IP，精确或前缀（'10.0.'）。 */
  readonly ip?: string;
  readonly since?: number;
  readonly until?: number;
  /** 只看这个团队；团队主人查询时服务端强制填自己的团队。 */
  readonly teamId?: string;
  /** 被操作的对象，精确匹配（例如一条会话的 id）。 */
  readonly target?: string;
  readonly limit: number;
}

export interface AuditLog {
  append(entry: AuditEntry): Promise<void>;
  /** 新的在前。 */
  recent(limit: number): Promise<AuditEntry[]>;
  /** 按条件查，新的在前。 */
  query(filter: AuditFilter): Promise<AuditEntry[]>;
}

/** 纯函数版的过滤，内存实现和测试用；SQLite 实现用 SQL 做同样的事。 */
export function matchesAudit(entry: AuditEntry, filter: AuditFilter): boolean {
  if (filter.action && !entry.action.startsWith(filter.action)) return false;
  if (filter.actor && !entry.actorEmail.toLowerCase().includes(filter.actor.toLowerCase())) return false;
  if (filter.ip && !(entry.ip ?? '').startsWith(filter.ip)) return false;
  if (filter.since !== undefined && entry.at < filter.since) return false;
  if (filter.until !== undefined && entry.at > filter.until) return false;
  if (filter.target !== undefined && entry.target !== filter.target) return false;
  if (filter.teamId !== undefined && (entry.teamId ?? null) !== filter.teamId) return false;
  return true;
}
