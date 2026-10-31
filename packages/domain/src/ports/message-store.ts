import type { ProjectId, SessionId } from '../ids.ts';
import type { AgentMessage, MessageAuditEntry, MessagingConfig, SpawnRecord } from '../messaging.ts';

/** agent 间通信的持久化（ADR 0018）：消息（含排队状态）、派生记录、项目配置、按 traceId 的审计。 */
export interface MessageStore {
  save(message: AgentMessage): Promise<void>;
  byId(id: string): Promise<AgentMessage | null>;
  byIdempotencyKey(fromSessionId: SessionId, key: string): Promise<AgentMessage | null>;
  /** 投给这个会话、还在排队的（先来先投）。 */
  queuedFor(sessionId: SessionId): Promise<AgentMessage[]>;
  /** 已投进这个会话、它这一轮正在处理的。 */
  deliveredTo(sessionId: SessionId): Promise<AgentMessage[]>;
  /** 一条链上所有消息（时间正序）。 */
  byTrace(traceId: string): Promise<AgentMessage[]>;
  /** 进出这个会话的消息（新的在前）。 */
  forSession(sessionId: SessionId, limit: number): Promise<AgentMessage[]>;
  /** 项目里等人批的派生请求。 */
  awaitingApproval(projectId: ProjectId): Promise<AgentMessage[]>;
  /** 到点了还没回的 ask（queued / delivered，deadlineAt ≤ now）。 */
  overdue(now: number): Promise<AgentMessage[]>;

  config(projectId: ProjectId): Promise<MessagingConfig | null>;
  saveConfig(config: MessagingConfig): Promise<void>;

  saveSpawn(record: SpawnRecord): Promise<void>;
  spawnOf(sessionId: SessionId): Promise<SpawnRecord | null>;
  spawnsForRole(projectId: ProjectId, role: string): Promise<SpawnRecord[]>;

  audit(entry: MessageAuditEntry): Promise<void>;
  auditByTrace(traceId: string): Promise<MessageAuditEntry[]>;
}
