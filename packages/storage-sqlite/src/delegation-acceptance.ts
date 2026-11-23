import type { DatabaseSync } from 'node:sqlite';
import type {
  DelegationAcceptance,
  DelegationAcceptanceInput,
  DelegationAcceptanceResult,
  DelegationAcceptanceStore
} from '@agent-hub/domain';
import {
  DELEGATION_ACCEPTANCE_HISTORY_LIMIT,
  delegationAcceptanceHistoryLimit,
  delegationAcceptanceMatches,
  normalizeDelegationAcceptanceInput
} from '@agent-hub/domain';

/**
 * 人工验收追加存储（docs/design/vibex-borrowing.md，第二期「V7 验收精确绑定 SHA」）。
 *
 * - 只建 `delegation_acceptance` 新表，用 `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`
 *   补全；不读取、不迁移、不推断任何旧表或旧行，也不改任务相关的表。
 * - 一行就是一次验收，没有 UPDATE / DELETE 入口；`created_at` 是内容，`seq` 才是稳定顺序。
 * - 唯一约束 `(delegation_id, request_key)` 是幂等域；插入用单条
 *   `INSERT ... ON CONFLICT DO NOTHING`，不先读后写。同步连接上单条语句原子；换连接 / 重开库
 *   时由 SQLite 唯一约束串行化，后来者只能读到胜出的那条。
 * - 同键内容（SHA / 验收人 / 备注）相同即重放，任一不同即 conflict；任何分支都不覆盖原记录。
 * - 这里不碰 `task` / 派工状态，也不把记录当成「已发布」或「测试通过」的证据。
 */

interface AcceptanceRow {
  readonly seq: number;
  readonly delegation_id: string;
  readonly request_key: string;
  readonly sha: string;
  readonly actor_id: string;
  readonly note: string | null;
  readonly created_at: number;
}

/**
 * 只增表，不改旧结构。`sha` 的 CHECK 是最后一道闸：完整 40 位、只含小写十六进制；
 * 应用层仍会先校验并抛 `TypeError`，不会把非法值交给数据库静默丢弃。
 */
export function migrateDelegationAcceptanceSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS delegation_acceptance (
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,
    delegation_id TEXT NOT NULL CHECK (delegation_id <> ''),
    request_key   TEXT NOT NULL CHECK (request_key <> ''),
    sha           TEXT NOT NULL CHECK (length(sha) = 40 AND sha NOT GLOB '*[^0-9a-f]*'),
    actor_id      TEXT NOT NULL CHECK (actor_id <> ''),
    note          TEXT,
    created_at    INTEGER NOT NULL CHECK (created_at >= 0),
    UNIQUE (delegation_id, request_key))`);
  db.exec(
    'CREATE INDEX IF NOT EXISTS delegation_acceptance_history ON delegation_acceptance(delegation_id, seq)'
  );
  // 精确 SHA 的当前性查询独立于 history 的 50 条窗口；没有这个索引时，较早的验收记录
  // 会在「先取最近 N 条再过滤」的实现里被漏掉。
  db.exec(
    'CREATE INDEX IF NOT EXISTS delegation_acceptance_sha ON delegation_acceptance(delegation_id, sha, seq)'
  );
}

const toAcceptance = (row: AcceptanceRow): DelegationAcceptance => ({
  delegationId: row.delegation_id,
  requestKey: row.request_key,
  sha: row.sha,
  actorId: row.actor_id,
  createdAt: row.created_at,
  note: row.note
});

export function createSqliteDelegationAcceptances(db: DatabaseSync): DelegationAcceptanceStore {
  migrateDelegationAcceptanceSchema(db);

  const byRequestStmt = db.prepare(
    'SELECT * FROM delegation_acceptance WHERE delegation_id = ? AND request_key = ?'
  );
  // 直接按 (delegation_id, sha) 索引取最后一条，不受 history 条数上限影响。
  const latestForShaStmt = db.prepare(`SELECT * FROM delegation_acceptance
    WHERE delegation_id = ? AND sha = ?
    ORDER BY seq DESC
    LIMIT 1`);
  // 先按 seq 降序取最近 N 条，再翻回旧 -> 新；不用 createdAt 排序，避免时钟回拨改变历史顺序。
  const historyStmt = db.prepare(`SELECT * FROM (
      SELECT * FROM delegation_acceptance
      WHERE delegation_id = ?
      ORDER BY seq DESC
      LIMIT ?
    ) ORDER BY seq ASC`);
  const insertStmt = db.prepare(`INSERT INTO delegation_acceptance
      (delegation_id, request_key, sha, actor_id, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (delegation_id, request_key) DO NOTHING`);

  const read = (delegationId: string, requestKey: string): DelegationAcceptance | null => {
    const row = byRequestStmt.get(delegationId, requestKey) as AcceptanceRow | undefined;
    return row ? toAcceptance(row) : null;
  };

  return {
    async append(input: DelegationAcceptanceInput): Promise<DelegationAcceptanceResult> {
      // 先校验，非法输入不进入写语句。
      const wanted = normalizeDelegationAcceptanceInput(input);
      const result = insertStmt.run(
        wanted.delegationId,
        wanted.requestKey,
        wanted.sha,
        wanted.actorId,
        wanted.note,
        wanted.createdAt
      );
      const stored = read(wanted.delegationId, wanted.requestKey);
      if (!stored) {
        // 只可能是 CHECK 拒绝或表被外部改坏；如实报错，不假装写入成功。
        throw new Error(`验收记录未能落库：${wanted.delegationId}/${wanted.requestKey}`);
      }
      if (Number(result.changes) > 0) return { outcome: 'created', record: stored };
      return {
        outcome: delegationAcceptanceMatches(stored, wanted) ? 'replayed' : 'conflict',
        record: stored
      };
    },

    async byRequest(delegationId: string, requestKey: string) {
      return read(delegationId, requestKey);
    },

    async latestForSha(delegationId: string, sha: string) {
      const row = latestForShaStmt.get(delegationId, sha) as AcceptanceRow | undefined;
      return row ? toAcceptance(row) : null;
    },

    async history(delegationId: string, limit: number = DELEGATION_ACCEPTANCE_HISTORY_LIMIT) {
      const bounded = delegationAcceptanceHistoryLimit(limit);
      return (historyStmt.all(delegationId, bounded) as unknown as AcceptanceRow[]).map(toAcceptance);
    }
  };
}
