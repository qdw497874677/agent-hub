import type { SessionId, TaskId } from './ids.ts';

/**
 * 能力接入层（tasks-and-capabilities.md §4）：agent 通过「工具」读写平台状态。
 * 工具永远隐式绑定一个任务：参数里没有 taskId，从授权（grant）里取。
 */
/** agent:message = agent 间通信（ADR 0018）；真正能不能发还要过消息总线的权限交集。 */
/** connector = 连接器带的外部工具（ADR 0032 R4），细粒度能力由连接器自己按 Worker 预设再查。 */
/**
 * memory = 记忆工具（ADR 0019）；能读写哪个作用域还要过记忆服务的 can()。
 * git = 提交 / 推送 / 开 PR（issue #216）；scope 只决定这条会话能不能看到这些工具并把它们列给模型，
 * 实际写入仍由工作流里的 git.push 项目权限与工作流判定（见 docs/design/agent-git-tools.md §4）。
 */
export type ToolScope = 'task:read' | 'task:log:write' | 'task:status:write' | 'agent:message' | 'memory' | 'context' | 'task:create' | 'connector' | 'git';

export const TOOL_SCOPES: readonly ToolScope[] = ['task:read', 'task:log:write', 'task:status:write', 'agent:message', 'memory', 'context', 'task:create', 'connector', 'git'];

/** 默认授权：读任务 + 写日志 + 改状态（agent 只能走到 进行中/受阻/待验收，done 仍由人确认）+ git 工作流入口。 */
export const DEFAULT_TOOL_SCOPES: readonly ToolScope[] = ['task:read', 'task:log:write', 'task:status:write', 'agent:message', 'memory', 'context', 'task:create', 'connector', 'git'];

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

/**
 * 授权时的身份快照（#221 步骤 3）：谁授权、以谁的名义、经哪条渠道进来。
 * 工具调用只读这一份——不再在每次调用时重新猜身份；权限本身仍然实时求值。
 */
export interface GrantActor {
  readonly userId: string | null;
  readonly via: 'web' | 'group' | 'bot' | 'connector' | 'dispatch' | 'tool';
}

/** 一次授权：令牌本身只交给 agent 一次，库里只存 hash。 */
export interface ToolGrant {
  readonly id: string;
  readonly tokenHash: string;
  /** 归属任务；null = 容器会话（群角色 / bot P2P，见 isContainerSession），`task.*` 工具对它一律拒绝。 */
  readonly taskId: TaskId | null;
  readonly sessionId: SessionId;
  readonly workerId: string | null;
  readonly scopes: readonly ToolScope[];
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly revokedAt: number | null;
  /** 旧授权没有这个字段：读不到时调用方回落到按会话推导（见 #221 步骤 3 的迁移说明）。 */
  readonly actor?: GrantActor;
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
  /** null = 容器会话的调用（这条调用不属于任何任务）。 */
  readonly taskId: TaskId | null;
  readonly sessionId: SessionId;
  readonly tool: string;
  readonly version: number;
  readonly ok: boolean;
  /** 参数摘要或失败原因（≤200 字）。 */
  readonly detail: string;
  readonly latencyMs: number;
  readonly at: number;
}
