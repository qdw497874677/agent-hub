import type { SessionId, TaskId } from './ids.ts';

/**
 * 能力接入层（tasks-and-capabilities.md §4）：agent 通过「工具」读写平台状态。
 * 工具永远隐式绑定一个任务：参数里没有 taskId，从授权（grant）里取。
 */
export type ToolScope = 'task:read' | 'task:log:write' | 'task:status:write';

export const TOOL_SCOPES: readonly ToolScope[] = ['task:read', 'task:log:write', 'task:status:write'];

/** 默认授权：读任务 + 写日志 + 改状态（agent 只能走到 进行中/受阻/待验收，done 仍由人确认）。 */
export const DEFAULT_TOOL_SCOPES: readonly ToolScope[] = ['task:read', 'task:log:write', 'task:status:write'];

/**
 * 授权是短期的滑动有效期：签发后 1 小时内没有用就过期；每次认证成功续到「现在 + 1 小时」，
 * 但从签发起最长 12 小时（到点必须靠重新托管换新令牌）。
 * 另外：会话跑完（worker 报 ended/gone）立刻作废；hub 启动时作废所有不在运行中的会话的授权。
 */
export const TOOL_GRANT_TTL_MS = 60 * 60 * 1000;
export const TOOL_GRANT_MAX_LIFETIME_MS = 12 * 60 * 60 * 1000;

/** 一次授权：令牌本身只交给 agent 一次，库里只存 hash。 */
export interface ToolGrant {
  readonly id: string;
  readonly tokenHash: string;
  readonly taskId: TaskId;
  readonly sessionId: SessionId;
  readonly workerId: string | null;
  readonly scopes: readonly ToolScope[];
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly revokedAt: number | null;
}

export function grantActive(grant: ToolGrant, now: number): boolean {
  return grant.revokedAt === null && now < grant.expiresAt;
}

/**
 * 交给 worker / agent 的连接方式。http = agent 直连 hub 的 Streamable HTTP MCP；
 * stdio-shim = worker 起一个 stdio MCP 进程，经 WS 链路转发（P4 兜底）。
 */
export interface ToolAccess {
  readonly transport: 'http' | 'stdio-shim';
  readonly url: string;
  readonly token: string;
}

/** 审计：每次工具调用一条；只记参数摘要，不记日志全文。 */
export interface ToolCallRecord {
  readonly id: string;
  readonly grantId: string;
  readonly taskId: TaskId;
  readonly sessionId: SessionId;
  readonly tool: string;
  readonly version: number;
  readonly ok: boolean;
  /** 参数摘要或失败原因（≤200 字）。 */
  readonly detail: string;
  readonly latencyMs: number;
  readonly at: number;
}
