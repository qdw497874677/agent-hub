/**
 * 对外 MCP 写工具的幂等回放（E4b）。
 *
 * 外部调用方网络重试时，`task_create` / `session_start` 不能重复建任务或重复烧 token。
 * 键由 MCP 层拼：`<令牌哈希>|<方法>|<路径>|<请求体摘要>|<clientRequestId>`；
 * 值原样存第一次成功的工具结果。存的是结果而不是「已执行」标记——重放要返回同一份内容，
 * 调用方才能安全重试。
 */
export interface McpReplayStore {
  /**
   * 读已完成的结果。`now` / `ttlMs` 给出时按 `created_at + ttlMs` 拒绝过期行；
   * 还没完成的占位行返回 null（不能当成结果回放）。
   */
  get(key: string, now?: number, ttlMs?: number): Promise<string | null>;
  /** 写入完成结果（同时清掉占位状态）。 */
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
  /** 释放占位（执行失败 / 结果不可缓存），让重试能立刻再跑。 */
  release?(key: string): Promise<void>;
}
