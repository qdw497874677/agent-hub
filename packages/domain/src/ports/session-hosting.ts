import type { SessionId } from '../ids.ts';

/**
 * 哪些会话此刻在某个 worker 手上跑着。
 *
 * 它是一个被驱动端口：内核只问「在不在」，不关心是内存集合还是将来的多 worker 注册表。
 * 会话跑完 / worker 掉线时由运行状态的回报把它划掉，下次再对它说话就先补一次 resume。
 */
export interface SessionHosting {
  has(sessionId: SessionId): boolean;
  add(sessionId: SessionId): void;
  drop(sessionId: SessionId): void;
  clear(): void;
}
