import type { Seq, SessionId, TaskId } from '../ids.ts';
import type { SessionEvent } from '../event.ts';
import type { DomainError } from '../errors.ts';
import type { Result } from '../result.ts';
import type { AgentDescriptor } from '../agent.ts';

export interface StartSpec {
  readonly sessionId: SessionId;
  readonly taskId: TaskId;
  readonly workspaceRoot: string;
  readonly model: string;
  /** 双权威：知道 agent 自己的会话 id 和平台已确认的游标，才能接着聊。 */
  readonly resume: { readonly agentSessionRef: string | null; readonly cursor: Seq } | null;
}

export interface RuntimeSession {
  readonly sessionId: SessionId;
  prompt(text: string): Promise<Result<void, DomainError>>;
  interrupt(): Promise<void>;
  events(): AsyncIterable<SessionEvent>;
  adopt(cursor: Seq): Promise<void>;
  dispose(): Promise<void>;
}

/** 新增一个 agent = 实现这一个端口 + 填一张能力矩阵。 */
export interface AgentRuntime {
  readonly descriptor: AgentDescriptor;
  start(spec: StartSpec): Promise<Result<RuntimeSession, DomainError>>;
}
