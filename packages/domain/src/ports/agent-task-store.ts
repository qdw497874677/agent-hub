/** 智能体建任务的记录（ADR 0032 R2）：去重键、配额计数、超额待批。 */
export type AgentTaskApproval = 'none' | 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface AgentTaskRequest {
  readonly id: string;
  readonly taskId: string | null;
  readonly accountId: string;
  readonly agent: string | null;
  readonly sessionId: string;
  readonly projectId: string;
  readonly title: string;
  readonly goal: string;
  readonly originConnector: string | null;
  readonly originExternalId: string | null;
  /** 触发那次运行的 id；人发起的回合是 null（不计配额）。 */
  readonly wakeKey: string | null;
  readonly counted: boolean;
  readonly approval: AgentTaskApproval;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface AgentTaskStore {
  /** 插入；同 project + 来源 + externalId 已有就返回已有的那条。 */
  insert(r: AgentTaskRequest): Promise<AgentTaskRequest>;
  save(r: AgentTaskRequest): Promise<void>;
  byId(id: string): Promise<AgentTaskRequest | null>;
  countWake(wakeKey: string): Promise<number>;
  countSince(accountId: string, since: number): Promise<number>;
  bySession(sessionIds: readonly string[], limit: number): Promise<AgentTaskRequest[]>;
  pendingFor(accountId: string): Promise<AgentTaskRequest[]>;
}
