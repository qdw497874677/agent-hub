/**
 * 对外 MCP 写工具的幂等回放（E4b）。
 *
 * 外部调用方网络重试时，`task_create` / `session_start` 不能重复建任务或重复烧 token。
 * 键由 MCP 层拼：`<令牌哈希>|<工具名>|<clientRequestId>`；值原样存第一次成功的工具结果。
 * 存的是结果而不是「已执行」标记——重放要返回同一份内容，调用方才能安全重试。
 */
export interface McpReplayStore {
  get(key: string): Promise<string | null>;
  put(key: string, body: string, at: number): Promise<void>;
}
