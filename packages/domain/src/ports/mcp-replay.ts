/**
 * 对外 MCP 写工具的幂等回放（E4b）。
 *
 * 外部调用方网络重试时，`task_create` / `session_start` 不能重复建任务或重复烧 token。
 * 键由接入层拼：`<令牌哈希>|<方法>|<路径>|<clientRequestId>`（请求体不参与键，而是记在值里，
 * 同一个 key 换 body 要报冲突而不是重放或重跑）；值原样存第一次成功的工具结果，外加请求体摘要。
 * 存的是结果而不是「已执行」标记——重放要返回同一份内容，调用方才能安全重试。
 */
export interface McpReplayStore {
  /**
   * 读已完成的结果。`now` / `ttlMs` 给出时按 `created_at + ttlMs` 拒绝过期行；
   * 还没完成的占位行返回 null（不能当成结果回放）。
   */
  get(key: string, now?: number, ttlMs?: number): Promise<string | null>;
  /** 写入完成结果（同时清掉占位状态）。无归属校验，老调用方与没有 `commit` 的 store 用它。 */
  put(key: string, body: string, at: number): Promise<void>;
  /**
   * 条件占位：同一 key 只有一次能成功。返回 true 表示拿到执行权；
   * false 表示已有未过期的占位（别人正在执行）。
   * - `staleBefore`：早于它的 `pending` 占位视为超时，可被接管；
   * - `expiredBefore`：早于它的完成结果已过期，可直接覆盖。
   *
   * 可选：老的自定义 store 没实现时，中间件退化成「没有并发占位」的老行为。
   */
  claim?(key: string, at: number, staleBefore: number, expiredBefore: number): Promise<boolean>;
  /**
   * 带归属的条件写入：只有占位仍是 `claimedAt` 那次抢到的，才落档并标成完成。
   * 返回 false 表示占位已被后来的请求接管（本次结果作废，不能覆盖接管者的占位/结果）。
   *
   * 可选：没实现时中间件退化成 `put`，超时接管后可能发生「老请求覆盖新结果」。
   */
  commit?(key: string, body: string, at: number, claimedAt: number): Promise<boolean>;
  /**
   * 释放占位（执行失败 / 结果不可缓存），让重试能立刻再跑。
   * 给了 `claimedAt` 时只释放那一次占位，不误删接管者的占位。
   */
  release?(key: string, claimedAt?: number): Promise<void>;
}
