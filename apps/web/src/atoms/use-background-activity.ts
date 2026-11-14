import { useEffect, useRef, useState } from 'react';
import type { SessionDto } from '../shell/api.ts';
import type { Block } from './live-core.ts';
import {
  backgroundActivity,
  BACKGROUND_QUIET_MS,
  type ActivityBlock,
  type BackgroundActivity
} from './background-activity.ts';

/**
 * 把「块 + 回合在哪结束 + 每块什么时候到」攒成 backgroundActivity 要的形状。
 *
 * 为什么要在前端打时间戳：journal 里有 `at`，但 SSE 帧只带 seq，块上也没有时间；
 * 前端能确定的就是「这一块是我什么时候看见的」。刷新后重新播种的块一律没有时间戳，
 * 于是那一段只可能得到「可能已结束」，不会假装刚刚还在动。
 *
 * 为什么记「回合结束时的 seq」：块序列里没有 ended 块（失败那一轮才有 error 块），
 * 所以结束位置得自己记——状态从 running 变成别的、或者一开始就已经结束，
 * 就在当时的 lastSeq 处插一个标记；此后 seq 更大的块才算回合结束之后的。
 */
export function useBackgroundActivity(
  sessionId: string,
  blocks: readonly Block[],
  status: SessionDto['status'],
  lastSeq: number,
  quietMs: number = BACKGROUND_QUIET_MS
): BackgroundActivity {
  const now = Date.now();
  const stored = useRef<Trace | null>(null);
  if (stored.current === null || stored.current.sessionId !== sessionId) {
    // 第一次进来：已经结束的会话先把当下的位置当地标，之后新来的块才算后台活动。
    stored.current = {
      sessionId,
      arrivals: new Map(),
      ended: status === 'running' || lastSeq === 0 ? null : { seq: lastSeq, at: now },
      status
    };
  }
  const trace = stored.current;

  // 每块只打一次时间：流式 delta 每帧都改 seq，重打会把「多久没动静」永远抹成「刚刚」。
  for (const block of blocks) if (!trace.arrivals.has(block.seq)) trace.arrivals.set(block.seq, now);

  // 回合结束的那一刻：把当时的 lastSeq 记成地标。再开一轮就撤掉，交给下一次结束。
  if (trace.status === 'running' && status !== 'running' && lastSeq > 0) {
    trace.ended = { seq: lastSeq, at: now };
  }
  if (status === 'running') trace.ended = null;
  trace.status = status;

  const activity = backgroundActivity(buildTrace(blocks, trace), status, now, quietMs);

  // 「12 秒前」得自己往前走一步：只在真有活动时走，安静下来就停（不是轮询，是给文字走的钟）。
  const [, bump] = useState(0);
  const ticking = activity.active && !activity.quiet;
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => bump((value) => value + 1), 10_000);
    return () => clearInterval(timer);
  }, [ticking, lastSeq, sessionId]);

  return activity;
}

interface Trace {
  readonly sessionId: string;
  /** seq → 前端第一次看见它的时间。 */
  readonly arrivals: Map<number, number>;
  /** 这一轮在哪个 seq 结束、什么时候发现的。null = 还没结束过（或正在跑）。 */
  ended: { readonly seq: number; readonly at: number } | null;
  status: SessionDto['status'];
}

/** 按 seq 顺序把结束标记插进块序列：它和普通块一样参与「之后还有没有东西」。 */
function buildTrace(blocks: readonly Block[], trace: Trace): readonly ActivityBlock[] {
  const boundary = trace.ended !== null && trace.ended.seq > 0 ? trace.ended.seq : null;
  const list: ActivityBlock[] = [];
  let placed = false;
  for (const block of blocks) {
    list.push({ kind: block.kind, at: trace.arrivals.get(block.seq) });
    if (!placed && boundary !== null && block.seq >= boundary) {
      list.push({ kind: 'ended', at: trace.ended?.at });
      placed = true;
    }
  }
  // 没有任何块和地标对得上（比如历史还没载入）：标记摆到最后，当作「都已经过去了」。
  if (!placed && trace.ended !== null) list.push({ kind: 'ended', at: trace.ended.at });
  return list;
}
