import { openApprovals } from './approval.ts';
import type { Delivery } from './delivery.ts';
import type { JournalEntry, SessionEvent } from './event.ts';
import type { Session } from './session.ts';

/**
 * 「等我处理」（ADR 0031 D1）：会话现在处在哪个阶段、要不要人。纯函数，读时由事件尾部派生，不落库。
 */
export type Phase = 'needs_approval' | 'needs_answer' | 'needs_review' | 'failed' | 'undelivered' | 'queued' | 'working' | 'idle';

export interface PhaseView {
  readonly phase: Phase;
  /** 进入这个阶段的时刻；「人已看过」按 (phase, since) 记，阶段变了重新上榜。 */
  readonly since: number;
  readonly reason: string;
  /** 只是启发式（最后一句以问号结尾）：标「可能在等你」。 */
  readonly possible?: boolean;
  /** 等审批：最早那张卡什么时候过期。 */
  readonly expiresAt?: number;
}

export const NEEDS_HUMAN: ReadonlySet<Phase> = new Set(['needs_approval', 'needs_answer', 'needs_review', 'failed', 'undelivered']);
export const needsHuman = (phase: Phase): boolean => NEEDS_HUMAN.has(phase);
/** 收件箱排序：越靠前越急。 */
export const PHASE_RANK: Readonly<Record<Phase, number>> = {
  needs_approval: 0, undelivered: 1, failed: 2, needs_answer: 3, needs_review: 4, queued: 5, working: 6, idle: 7
};

/** agent 显式提问的工具名（ask 类工具 / ACP input-required 落成的 tool_call）。 */
const ASK_TOOL = /(?:^|[^a-z])(ask_?user(?:_?question)?|ask_?human|ask_?followup_?question|request_?user_?input|input_?required)(?:$|[^a-z])/i;
export const isAskTool = (name: string): boolean => ASK_TOOL.test(name.trim());

/** 这一轮里产生了 commit 或 PR 的命令（shell 工具的输入里能看到）。 */
const REVIEW_CMD = /\bgit\s+(-\S+\s+)*commit\b|\bgh\s+pr\s+create\b/;

export interface PhaseInput {
  readonly session: Pick<Session, 'status' | 'updatedAt'>;
  /** 事件尾部（按 seq 升序；够覆盖最后一轮就行）。 */
  readonly events: readonly JournalEntry[];
  /** 这条会话还没送达的（queued/sending/undelivered）。 */
  readonly pending?: readonly Pick<Delivery, 'state' | 'updatedAt'>[];
  /** 这条会话（或它的任务）挂上的 PR 的创建时刻。 */
  readonly prCreatedAt?: readonly number[];
  readonly now: number;
}

const lastIndex = (events: readonly JournalEntry[], pred: (e: SessionEvent) => boolean): number => {
  for (let i = events.length - 1; i >= 0; i--) if (pred(events[i]!.event)) return i;
  return -1;
};

export function derivePhase(input: PhaseInput): PhaseView {
  const { events, now } = input;
  // 1. 等审批
  const open = openApprovals(events.map((e) => e.event), now);
  if (open.size > 0) {
    const ids = new Set(open.keys());
    const first = events.find((e) => e.event.kind === 'approval' && e.event.phase === 'request' && ids.has(e.event.id));
    const card = [...open.values()][0]!;
    const expiries = [...open.values()].map((c) => c.expiresAt).filter((x): x is number => typeof x === 'number');
    return {
      phase: 'needs_approval', since: first?.at ?? input.session.updatedAt, reason: card.title ?? '有动作等你批准',
      ...(expiries.length ? { expiresAt: Math.min(...expiries) } : {})
    };
  }
  // 2. 未送达（自动重试已经停了）
  const stuck = (input.pending ?? []).filter((d) => d.state === 'undelivered');
  if (stuck.length) return { phase: 'undelivered', since: Math.min(...stuck.map((d) => d.updatedAt)), reason: `${stuck.length} 条消息没送到` };

  const lastPrompt = lastIndex(events, (e) => e.kind === 'prompt');
  const lastEnded = lastIndex(events, (e) => e.kind === 'ended');
  const turnOver = lastEnded >= 0 && lastEnded > lastPrompt;
  // 3. 失败 / 中断，且之后没有新话
  if ((input.session.status === 'failed' || input.session.status === 'interrupted') && (turnOver || lastPrompt < 0)) {
    const ended = lastEnded >= 0 ? events[lastEnded]! : null;
    const reason = ended && ended.event.kind === 'ended' && ended.event.reason ? ended.event.reason : input.session.status === 'failed' ? '运行失败' : '进程中断了';
    return { phase: 'failed', since: ended?.at ?? input.session.updatedAt, reason };
  }
  if (turnOver && input.session.status !== 'running') {
    const ended = events[lastEnded]!;
    const turn = events.slice(lastPrompt + 1, lastEnded);
    // 4. 等回答：显式提问优先
    const ask = turn.find((e) => e.event.kind === 'tool_call' && isAskTool(e.event.name));
    if (ask) return { phase: 'needs_answer', since: ended.at, reason: 'agent 在问你' };
    // 5. 等审查：这一轮产生了 PR 或 commit
    const turnStart = lastPrompt >= 0 ? events[lastPrompt]!.at : 0;
    const committed = turn.some((e, i) => e.event.kind === 'tool_call' && REVIEW_CMD.test(`${e.event.name}\n${e.event.input}`)
      && turn.slice(i + 1).some((r) => r.event.kind === 'tool_result' && r.event.ok));
    const pr = (input.prCreatedAt ?? []).some((t) => t >= turnStart && t <= ended.at + 60_000);
    // 启发式：最后一段回复以问号结尾 → 可能在等你（排在审查前面但标明只是可能）
    const lastTool = lastIndex(turn, (e) => e.kind === 'tool_call' || e.kind === 'tool_result');
    const reply = turn.slice(lastTool + 1).map((e) => (e.event.kind === 'text' ? e.event.delta : '')).join('').trim();
    if (/[?？]\s*$/.test(reply)) return { phase: 'needs_answer', since: ended.at, reason: '可能在等你', possible: true };
    if (pr || committed) return { phase: 'needs_review', since: ended.at, reason: pr ? '这一轮开了 PR' : '这一轮有新提交' };
  }
  // 6. 排队 / 工作中 / 空闲
  const queued = (input.pending ?? []).filter((d) => d.state === 'queued' || d.state === 'sending');
  if (queued.length) return { phase: 'queued', since: Math.min(...queued.map((d) => d.updatedAt)), reason: `${queued.length} 条排队中` };
  if (input.session.status === 'running') return { phase: 'working', since: input.session.updatedAt, reason: '工作中' };
  return { phase: 'idle', since: input.session.updatedAt, reason: '' };
}
