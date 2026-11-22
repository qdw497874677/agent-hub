import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  OperationCompleteOutcome,
  OperationReceiptPayload,
  OperationReceiptStore,
  OperationReleaseOutcome,
  OperationReserveOutcome
} from '@agent-hub/domain';
import { inTransaction } from './tx.ts';

/**
 * 中立操作回执的 SQLite 存储（reserve / complete / release）。
 *
 * 与 `task-creations.ts` 的 `request_receipts` 刻意分表：那边的回执是「业务写入 +
 * 回执同事务」，这边的 pending 占位跨越了事务之外的真实副作用。两套语义混在一张表里
 * 会让「已执行」和「正在执行」难以区分。
 *
 * 单独注册 schema，不依赖根 store：测试与新调用方按需打开，老库可幂等补表。
 */

/** 中性回执表。幂等；不引用 projects，方便阶段 2/3 在最小上下文里直接落库。 */
export function migrateOperationReceiptSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS operation_receipts (
    key               TEXT PRIMARY KEY,
    fingerprint       TEXT NOT NULL,
    status            TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
    reservation_id    TEXT NOT NULL,
    actor_id          TEXT NOT NULL,
    source_session_id TEXT,
    project_id        TEXT NOT NULL,
    operation         TEXT NOT NULL,
    payload           TEXT,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    CHECK (status <> 'completed' OR payload IS NOT NULL))`);
  db.exec(
    'CREATE INDEX IF NOT EXISTS operation_receipts_by_project ON operation_receipts(project_id, created_at)'
  );
}

interface ReceiptRow {
  readonly fingerprint: string;
  readonly status: string;
  readonly reservation_id: string;
  readonly payload: string | null;
}

/** 测试可注入时钟与占位 id；生产默认 Date.now / randomUUID。 */
export interface OperationReceiptClock {
  readonly now?: () => number;
  readonly newReservationId?: () => string;
}

function isPlainPayload(value: unknown): value is OperationReceiptPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * 只接受普通 JSON 对象。数组 / 类实例 / 原始值都是调用方编程错误：
 * 直接抛错（complete 是 async，会变成 rejected promise），事务不落任何东西。
 */
function serializePayload(payload: OperationReceiptPayload): string {
  if (!isPlainPayload(payload)) throw new TypeError('操作回执 payload 必须是普通对象');
  const raw = JSON.stringify(payload);
  if (raw === undefined) throw new TypeError('操作回执 payload 必须可 JSON 序列化');
  return raw;
}

function parsePayload(raw: string | null): OperationReceiptPayload {
  if (raw === null) throw new Error('已完成的回执缺少 payload');
  const parsed: unknown = JSON.parse(raw);
  if (!isPlainPayload(parsed)) throw new Error('已完成的回执 payload 不是普通对象');
  return parsed;
}

export function createSqliteOperationReceipts(
  db: DatabaseSync,
  clock: OperationReceiptClock = {}
): OperationReceiptStore {
  migrateOperationReceiptSchema(db);
  const now = clock.now ?? (() => Date.now());
  const newReservationId = clock.newReservationId ?? randomUUID;

  const select = db.prepare(
    'SELECT fingerprint, status, reservation_id, payload FROM operation_receipts WHERE key = ?'
  );
  const insertPending = db.prepare(
    `INSERT INTO operation_receipts
       (key, fingerprint, status, reservation_id, actor_id, source_session_id, project_id, operation, payload, created_at, updated_at)
     VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, NULL, ?, ?)`
  );
  // 完成 CAS：状态、指纹、占位 token 三者同时匹配才允许 pending → completed。
  const completePending = db.prepare(
    `UPDATE operation_receipts
        SET status = 'completed', payload = ?, updated_at = ?
      WHERE key = ? AND status = 'pending' AND fingerprint = ? AND reservation_id = ?`
  );
  // 释放 CAS：只删除匹配的 pending 占位；已完成的行永远不被释放。
  const releasePending = db.prepare(
    "DELETE FROM operation_receipts WHERE key = ? AND status = 'pending' AND fingerprint = ? AND reservation_id = ?"
  );

  return {
    async reserve(intent): Promise<OperationReserveOutcome> {
      // BEGIN IMMEDIATE：查 + 插在同一写事务里，两个并发调用只有一个能插入。
      return inTransaction(db, (): OperationReserveOutcome => {
        const existing = select.get(intent.key) as ReceiptRow | undefined;
        if (existing) {
          if (existing.fingerprint !== intent.fingerprint) return { status: 'conflict' };
          if (existing.status === 'completed') {
            return { status: 'completed', payload: parsePayload(existing.payload) };
          }
          // pending 不看过期时间：可能已经有副作用，绝不由后来者接管。
          return { status: 'pending' };
        }
        const reservationId = newReservationId();
        const at = now();
        insertPending.run(
          intent.key,
          intent.fingerprint,
          reservationId,
          intent.actorId,
          intent.sourceSessionId,
          intent.projectId,
          intent.operation,
          at,
          at
        );
        return { status: 'reserved', reservationId };
      });
    },

    async complete(input): Promise<OperationCompleteOutcome> {
      // 先做载荷校验，避免为一个注定失败的调用浪费写事务。
      const serialized = serializePayload(input.payload);
      const at = now();
      return inTransaction(db, (): OperationCompleteOutcome => {
        const existing = select.get(input.key) as ReceiptRow | undefined;
        if (!existing || existing.fingerprint !== input.fingerprint) return { status: 'conflict' };
        if (existing.status === 'completed') {
          // 同键同参的完成重试：回放原结果，不覆盖。
          return { status: 'replayed', payload: parsePayload(existing.payload) };
        }
        // 走到这里必须是 pending；UPDATE 的 WHERE 再兜一次并发状态变化。
        const wrote =
          Number(completePending.run(serialized, at, input.key, input.fingerprint, input.reservationId).changes) > 0;
        return wrote ? { status: 'completed' } : { status: 'conflict' };
      });
    },

    async release(input): Promise<OperationReleaseOutcome> {
      const removed =
        Number(releasePending.run(input.key, input.fingerprint, input.reservationId).changes) > 0;
      return removed ? { status: 'released' } : { status: 'conflict' };
    }
  };
}
