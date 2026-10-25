import type { SessionQueue } from '@agent-hub/domain';

/**
 * 同一个会话的事件必须排队落盘。
 *
 * 为什么：`recordEvent` 是「读会话 → 算下一个 seq → 写」的读改写，而网关那条路上
 * 每个事件都是独立的 async 任务。worker 一秒能推几十条 delta，两条同时读到同一个
 * `lastSeq` 就会算出同一个 seq，journal 的 `INSERT OR IGNORE` 于是把后一条**静默丢掉**。
 * 真发现它的时候，卡片上少了一句话，而库里没有任何痕迹。
 *
 * 换 session 并行、同 session 串行——这只在「只有一个写者进程」时成立，
 * 也正是我们选 SQLite 单写者的前提。
 */
export function createSessionQueue(): SessionQueue {
  const tails = new Map<string, Promise<unknown>>();

  return {
    run<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
      const previous = tails.get(sessionId) ?? Promise.resolve();
      // 上一条失败了也要接着跑下一条，否则一个坏事件能把这个会话永久卡死
      const next = previous.then(work, work);
      const tail = next.catch(() => undefined);
      tails.set(sessionId, tail);
      void tail.then(() => {
        // 只有队尾还是自己时才清掉，别把后来者的链头删了
        if (tails.get(sessionId) === tail) tails.delete(sessionId);
      });
      return next;
    }
  };
}
