import type { AgentId, Seq, SessionId, TaskId, WorkspaceId } from './ids.ts';
import { newSessionId } from './ids.ts';
import { conflict, invalid, type DomainError } from './errors.ts';
import { err, ok, type Result } from './result.ts';
import type { SessionEvent } from './event.ts';
import type { Task } from './task.ts';
import type { RuntimeOption } from './option.ts';

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
  /**
   * 这条会话的可调项当前值（模型、思考强度……）。
   * 唯一权威在 agent 那边：平台只是记住「上次我们知道的是什么」，
   * 好让重开浏览器后选择器不会空着。
   */
  readonly options: Readonly<Record<string, string | boolean>>;
  /**
   * agent 报上来的**完整**可调项清单（含候选值）。
   * 只存当前值不够：选择器要列出候选，而候选只有 agent 知道。
   */
  readonly optionSpec: readonly RuntimeOption[];
  /**
   * 落点：这条会话绑在哪台 Worker 上（不透明 id）。agent 自己的会话文件只在那台机器上，
   * 所以 resume / 分叉都必须回到它。null = 多机之前的老会话，下次托管时再落一次点。
   */
  readonly workerId: string | null;
  /** 在哪个工作空间里干活（workspaces.md）。null = 迁移前的老会话，按项目目录推算。 */
  readonly workspaceId: WorkspaceId | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface DeriveSessionInput {
  readonly task: Task;
  readonly agentId: AgentId;
  readonly model: string;
  readonly now: number;
  readonly id?: SessionId;
  readonly workerId?: string | null;
  readonly workspaceId?: WorkspaceId | null;
}

export function deriveSession(input: DeriveSessionInput): Result<Session, DomainError> {
  if (input.task.status === 'abandoned') {
    return err(conflict('不能从已放弃的任务派生新会话——死路不该再长出分支'));
  }
  // 空 model 是合法值：意思是「用这个 agent 自己的默认模型」。
  // 平台不该假装知道每个 agent 有哪些模型（见 packages/adapters/*/descriptor.ts）。
  const model = input.model.trim();
  return ok({
    id: input.id ?? newSessionId(),
    taskId: input.task.id,
    agentId: input.agentId,
    model,
    origin: { kind: 'derive' },
    status: 'running',
    lastSeq: 0,
    agentSessionRef: null,
    options: {},
    optionSpec: [],
    workerId: input.workerId ?? null,
    workspaceId: input.workspaceId ?? null,
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
  readonly workerId?: string | null;
  readonly workspaceId?: WorkspaceId | null;
}

export function forkSession(input: ForkSessionInput): Result<Session, DomainError> {
  if (!Number.isInteger(input.atSeq) || input.atSeq <= 0) {
    return err(invalid('分叉点必须是正整数事件序号'));
  }
  if (input.atSeq > input.source.lastSeq) {
    return err(conflict(`分叉点 ${input.atSeq} 超出该会话已有事件（${input.source.lastSeq}）`));
  }
  const model = input.model.trim();
  return ok({
    id: input.id ?? newSessionId(),
    taskId: input.source.taskId,
    agentId: input.agentId,
    model,
    origin: { kind: 'fork', fromSessionId: input.source.id, atSeq: input.atSeq },
    status: 'running',
    lastSeq: 0,
    agentSessionRef: null,
    options: {},
    optionSpec: [],
    workerId: input.workerId ?? null,
    workspaceId: input.workspaceId === undefined ? input.source.workspaceId : input.workspaceId,
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
 * 还没收到过任何一句话的会话（lastSeq = 0）：进程起来了，但从没开过一轮。
 * 提问会先同步落一条 prompt 事件，所以「发过话」一定有 lastSeq > 0。
 */
export function isNeverPrompted(session: Session): boolean {
  return session.lastSeq === 0;
}

/** 真在干活：状态是 running，且至少开过一轮。从没发过话的空会话不算。 */
export function isBusy(session: Session): boolean {
  return session.status === 'running' && !isNeverPrompted(session);
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

/**
 * 记下 agent 报上来的可调项当前值。
 *
 * 不校验值合不合法——判断权在 agent 那边（它可能因为限流把模型换掉了）。
 * 平台只负责如实保存，好让界面重开后仍然显示「上次是什么」。
 */
export function withOptions(
  session: Session,
  values: Readonly<Record<string, string | boolean>>,
  now: number
): Session {
  return { ...session, options: { ...session.options, ...values }, updatedAt: now };
}
