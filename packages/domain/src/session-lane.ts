import type { SessionId } from './ids.ts';

/**
 * 一条会话一次只接一轮外来投递（ADR 0018）：P2P 消息总线和群聊各有自己的队列，
 * 但投进同一条会话前要过同一道闸——「查对方有没有在等回复 → 标记已投 → 发」整段在闸里串行，
 * 不然两边都看见空闲，同一轮里交错投进两段话，回合结束时两边都把同一段回复算成自己的。
 */
export interface SessionLane {
  run<T>(sessionId: SessionId, work: () => Promise<T>): Promise<T>;
}

export function createSessionLane(): SessionLane {
  const locks = new Map<string, Promise<unknown>>();
  return {
    run(sessionId, work) {
      const previous = locks.get(sessionId) ?? Promise.resolve();
      const next = previous.then(work, work);
      const tail = next.catch(() => undefined);
      locks.set(sessionId, tail);
      void tail.then(() => {
        if (locks.get(sessionId) === tail) locks.delete(sessionId);
      });
      return next;
    }
  };
}
