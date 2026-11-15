import type { DatabaseSync } from 'node:sqlite';

/**
 * 同步事务。
 *
 * 只有一个理由存在：SQLite 的事务是连接级的，`BEGIN IMMEDIATE` 之后如果事务体里
 * 跨了 `await`，别的写方会在这条连接上插进来（或者拿到同一个事务），`COMMIT`
 * 就成了「把别人的半截也提交」。所以这里明确只接受同步函数，返回 thenable 直接
 * 回滚并报错，把问题暴露在开发期，而不是等线上出现半提交。
 */
export function inTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  let out: T;
  try {
    out = work();
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  if (typeof (out as unknown as { then?: unknown } | null)?.then === 'function') {
    db.exec('ROLLBACK');
    throw new Error('事务体不能是异步的：请把 await 移到事务外，或用异步事务（目前没有）');
  }
  db.exec('COMMIT');
  return out;
}
