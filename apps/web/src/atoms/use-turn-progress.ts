import { useEffect, useRef, useState } from 'react';
import type { Block } from './live-core.ts';
import { advanceTurnClock, latestPromptSeq, turnProgress, type TurnClock, type TurnProgress } from './turn-progress.ts';

/** 秒数走一步的间隔：提示行只需要「在动」的感觉，不需要更细。 */
const TICK_MS = 1_000;

/**
 * 给 `turnProgress` 备好时间和起点。
 *
 * - 起点在 `awaiting` 从假变真那一刻记下（切会话或看到新的 prompt 就重记）：
 *   所以第二回合起也一样准；
 * - 只在等回复期间每秒推一次 `now`，回合结束 / 卸载立刻清掉——这不是轮询，是给文字走的钟。
 */
export function useTurnProgress(
  sessionId: string,
  blocks: readonly Block[],
  awaiting: boolean,
  agentLabel: string
): TurnProgress | null {
  const [now, setNow] = useState(() => Date.now());
  const started = useRef<TurnClock>({
    sessionId,
    promptSeq: undefined,
    at: null
  });

  // 渲染期只改自己的 ref（和 useBackgroundActivity 同一个做法），不触发额外渲染。
  const promptSeq = latestPromptSeq(blocks);
  started.current = advanceTurnClock(started.current, sessionId, promptSeq, awaiting, Date.now());

  useEffect(() => {
    if (!awaiting) return;
    // 一开轮就把时钟对准：否则长时间没等过回复时，`now` 还停在挂载那一刻。
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [awaiting, sessionId, promptSeq]);

  return turnProgress({
    blocks,
    awaiting,
    startedAt: started.current.at ?? now,
    now,
    agentLabel
  });
}
