/**
 * 同一会话的写入串行执行（ADR 0004）。
 *
 * `recordEvent` 是「读会话 → 算下一个 seq → 写」的读改写；并发会算出同一个 seq，
 * journal 的 `INSERT OR IGNORE` 于是静默丢一条。所以凡是改会话那一行的用例都走这里。
 */
export interface SessionQueue {
  run<T>(sessionId: string, work: () => Promise<T>): Promise<T>;
}
