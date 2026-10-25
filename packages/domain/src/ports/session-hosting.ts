import type { SessionId } from '../ids.ts';

/**
 * 哪些会话此刻在某个 worker 手上跑着。
 *
 * 它是一个被驱动端口：内核只问「在不在」，不关心是内存集合还是将来的多 worker 注册表。
 * 会话跑完 / worker 掉线时由运行状态的回报把它划掉，下次再对它说话就先补一次 resume。
 */
export interface SessionHosting {
  has(sessionId: SessionId): boolean;
  /** `workerId`：托管在哪台上。null 只出现在多机之前的老数据里。 */
  add(sessionId: SessionId, workerId: string | null): void;
  drop(sessionId: SessionId): void;
  /** 一台 Worker 掉线：同步划掉托管在它（以及 null 落点）上的会话，返回划掉几条。 */
  dropWorker(workerId: string): number;
  clear(): void;
}
