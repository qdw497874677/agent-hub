import type { AgentId, Seq, SessionId, TaskId } from './ids.ts';
import { newSessionId } from './ids.ts';
import { conflict, invalid, type DomainError } from './errors.ts';
import { err, ok, type Result } from './result.ts';
import type { SessionEvent } from './event.ts';
import type { Task } from './task.ts';

/**
 * 会话状态。`stopped`（人按的停止）与 `interrupted`（进程没了）必须分开：
 * S7.1 要求重开浏览器时把"关闭前还在跑"的会话诚实地标成中断，
 * 如果与人主动停止混成一个状态，那条验收就永远过不了。
 */
export type SessionStatus = 'running' | 'stopped' | 'done' | 'interrupted' | 'failed';

export type SessionOrigin =
  | { readonly kind: 'derive' }
  | { readonly kind: 'fork'; readonly fromSessionId: SessionId; readonly atSeq: Seq };

export interface Session {
  readonly id: SessionId;
  readonly taskId: TaskId;
  readonly agentId: AgentId;
  readonly model: string;
  readonly origin: SessionOrigin;
  readonly status: SessionStatus;
  readonly lastSeq: Seq;
  /** 双权威：平台 journal 管血缘与检索，agent 自己的会话文件管送给模型的上下文。 */
  readonly agentSessionRef: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface DeriveSessionInput {
  readonly task: Task;
  readonly agentId: AgentId;
  readonly model: string;
  readonly now: number;
  readonly id?: SessionId;
}

export function deriveSession(input: DeriveSessionInput): Result<Session, DomainError> {
  if (input.task.status === 'abandoned') {
    return err(conflict('不能从已放弃的任务派生新会话——死路不该再长出分支'));
  }
  const model = input.model.trim();
  if (!model) return err(invalid('必须选择一个模型'));
  return ok({
    id: input.id ?? newSessionId(),
    taskId: input.task.id,
    agentId: input.agentId,
    model,
    origin: { kind: 'derive' },
    status: 'running',
    lastSeq: 0,
    agentSessionRef: null,
    createdAt: input.now,
    updatedAt: input.now
  });
}

export interface ForkSessionInput {
  readonly source: Session;
  readonly atSeq: Seq;
  readonly agentId: AgentId;
  readonly model: string;
  readonly now: number;
  readonly id?: SessionId;
}

export function forkSession(input: ForkSessionInput): Result<Session, DomainError> {
  if (!Number.isInteger(input.atSeq) || input.atSeq <= 0) {
    return err(invalid('分叉点必须是正整数事件序号'));
  }
  if (input.atSeq > input.source.lastSeq) {
    return err(conflict(`分叉点 ${input.atSeq} 超出该会话已有事件（${input.source.lastSeq}）`));
  }
  const model = input.model.trim();
  if (!model) return err(invalid('必须选择一个模型'));
  return ok({
    id: input.id ?? newSessionId(),
    taskId: input.source.taskId,
    agentId: input.agentId,
    model,
    origin: { kind: 'fork', fromSessionId: input.source.id, atSeq: input.atSeq },
    status: 'running',
    lastSeq: 0,
    agentSessionRef: null,
    createdAt: input.now,
    updatedAt: input.now
  });
}

/** 事件推进会话状态。ended 是唯一能改变终态的变体。 */
export function applyEvent(session: Session, event: SessionEvent, now: number): Session {
  const lastSeq = session.lastSeq + 1;
  if (event.kind !== 'ended') return { ...session, lastSeq, updatedAt: now };
  const status: SessionStatus =
    event.outcome === 'done'
      ? 'done'
      : event.outcome === 'stopped'
        ? 'stopped'
        : event.outcome === 'interrupted'
          ? 'interrupted'
          : 'failed';
  return { ...session, lastSeq, status, updatedAt: now };
}

export function isTerminal(session: Session): boolean {
  return session.status !== 'running';
}

/**
 * 进程消失后的判定：仍在 running 的会话一律降级为 interrupted。
 * 不保留"运行中"这个错觉，是 S7.1 的全部要点。
 */
export function markInterrupted(session: Session, now: number): Session {
  return session.status === 'running'
    ? { ...session, status: 'interrupted', updatedAt: now }
    : session;
}
