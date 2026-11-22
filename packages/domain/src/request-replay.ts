import type { ProjectId } from './ids.ts';

/**
 * 会话内写工具的持久请求回放（docs/design/project-session-mcp.md「写入必须可追踪、可重试」）。
 *
 * 键只绑**人 + 来源会话 + 项目 + 操作 + 调用方请求键**：
 * - 不绑短期 token，重托管后同一个请求键仍可复用；旧 token 能不能用由每次调用的授权检查决定。
 * - 不同源会话天然落在不同键上，互不占键。
 * - 操作进键，避免「建任务」和「开 worktree」共用一个请求键时串结果。
 *
 * 值是请求参数的稳定指纹（见 requestFingerprint）：同键同参回放原结果，同键异参由调用方拒绝。
 */
export interface ReplayScope {
  readonly actorId: string;
  readonly sourceSessionId: string | null;
  readonly projectId: ProjectId;
  readonly operation: string;
}

/**
 * 复合键。用 JSON 元组而不是分隔符拼接：请求键 / 人 / 会话 ID 里出现任何字符都不会造成歧义。
 */
export function requestReplayKey(scope: ReplayScope, requestKey: string): string {
  return JSON.stringify([scope.operation, scope.actorId, scope.sourceSessionId, scope.projectId, requestKey]);
}

/**
 * 请求参数指纹。调用方按固定顺序传入规范化后的字段（null 表示缺省），
 * 这样同一份输入在重试时得到同一串，顺序不同或字段不同则必然不同。
 */
export function requestFingerprint(values: readonly (string | number | null)[]): string {
  return JSON.stringify(values);
}
