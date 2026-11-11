import type { SessionId, TaskId } from './ids.ts';

/**
 * 能力接入层（tasks-and-capabilities.md §4）：agent 通过「工具」读写平台状态。
 * 工具永远隐式绑定一个任务：参数里没有 taskId，从授权（grant）里取。
 */
/** agent:message = agent 间通信（ADR 0018）；真正能不能发还要过消息总线的权限交集。 */
/** connector = 连接器带的外部工具（ADR 0032 R4），细粒度能力由连接器自己按 Worker 预设再查。 */
/** memory = 记忆工具（ADR 0019）；能读写哪个作用域还要过记忆服务的 can()。 */
export type ToolScope = 'task:read' | 'task:log:write' | 'task:status:write' | 'agent:message' | 'memory' | 'context' | 'task:create' | 'connector';

export const TOOL_SCOPES: readonly ToolScope[] = ['task:read', 'task:log:write', 'task:status:write', 'agent:message', 'memory', 'context', 'task:create', 'connector'];

/** 默认授权：读任务 + 写日志 + 改状态（agent 只能走到 进行中/受阻/待验收，done 仍由人确认）。 */
export const DEFAULT_TOOL_SCOPES: readonly ToolScope[] = ['task:read', 'task:log:write', 'task:status:write', 'agent:message', 'memory', 'context', 'task:create', 'connector'];

/**
 * 授权是滑动有效期：签发后 7 天内没有用就过期；每次认证成功续到「现在 + 7 天」，
 * 但从签发起最长 30 天。
 *
 * 不能按「一轮」回收：ACP 的 MCP 配置只在 session/new|load 时下发给 agent 进程，
 * 后续 prompt 不会重新注入 Authorization；一轮结束就作废会让第二天继续说话时
 * agent_peers / agent_directory 等 Hub 工具全部 401。
 * 授权只在 dispose、会话删除、Worker 离线时作废。
 */
export const TOOL_GRANT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const TOOL_GRANT_MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

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
 * 交给 worker / agent 的连接方式（只是个值，领域不认识任何传输）。
 * relay（默认）= agent 连 worker 本机的 MCP 入口，由 worker 经它与 hub 的长连接中转；url 由 worker 填。
 */
export interface ToolAccess {
  readonly transport: 'relay';
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
