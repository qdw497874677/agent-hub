/**
 * 回合收尾总闸。
 *
 * 一轮结束有三条入口，以前各写一遍、各自兜底：
 * - worker 的 `ended` 事件（回合结束，进程保活）；
 * - worker 的 `status idle / ended`（`idle` 也是「这一轮结束了」，只是进程还活着）；
 * - 卡顿巡检（长时间没新输出，主动结束这一轮）；
 * - 送达回收（送出去却一直没下文）。
 *
 * 它们必须走同一套钩子，否则某条路上漏掉收尾，后面排队的消息就永远等着。
 * `idle` 与 `ended` 帧可能先后都到（帧与事件是两条路），所以这里按「会话 journal
 * 的最后 seq」去重：同一回合只跑一次钩子，新回合（seq 前进）照常收。
 *
 * 各钩子自己也是幂等的（`SessionInbox.end` 的约定），这里去重只是少做无用功，
 * 不把正确性押在去重上。
 */
import type { Deps, SessionId } from '@agent-hub/domain';
import { recordEvent } from '@agent-hub/domain';

export type TurnOutcome = 'done' | 'stopped' | 'interrupted' | 'failed';

export interface TurnFinishHooks {
  /** 收件箱：各来源收这一轮（约定幂等）。 */
  readonly inbox: { end(sessionId: string, outcome: TurnOutcome, reason?: string): Promise<void> };
  /** 回合检查点：拍「之后」那张。 */
  readonly files: { endTurn(sessionId: string): Promise<void> };
  /** 假渠道回程（只在 HUB_FAKE_CHANNEL=1 时有）。 */
  readonly fakeReplies?: { finish(sessionId: string): Promise<string | null> };
  /** 飞书回程。 */
  readonly feishuReplies?: { finish(sessionId: string): Promise<string | null> };
}

export interface TurnFinishDeps extends TurnFinishHooks {
  readonly sessions: { byId(id: SessionId): Promise<{ lastSeq: number } | null> };
  readonly log: (message: string) => void;
}

export interface TurnFinisher {
  /**
   * 收尾一轮。同一会话、同一 journal 末尾重复调用时直接返回 false（钩子没再跑）。
   * 钩子失败只记日志，不影响其它钩子，也不向调用方抛。
   */
  finish(sessionId: SessionId, outcome: TurnOutcome, reason?: string): Promise<boolean>;
  /** 测试用：忘掉去重标记。 */
  forget(sessionId?: SessionId): void;
}

export function createTurnFinisher(deps: TurnFinishDeps): TurnFinisher {  // key = `${sessionId}:${lastSeq}`：同一回合的多条结束信号只认第一条。
  const finished = new Set<string>();

  return {
    async finish(sessionId, outcome, reason) {
      const session = await deps.sessions.byId(sessionId).catch(() => null);
      const key = `${sessionId}:${session?.lastSeq ?? -1}`;
      if (finished.has(key)) return false;
      finished.add(key);

      const steps: Array<readonly [string, () => Promise<unknown>]> = [
        ['回合收尾', () => deps.inbox.end(sessionId, outcome, reason)],
        ['回合检查点', () => deps.files.endTurn(sessionId)],
        ...(deps.fakeReplies ? [['假渠道回程', () => deps.fakeReplies!.finish(sessionId)] as const] : []),
        ...(deps.feishuReplies ? [['飞书回程', () => deps.feishuReplies!.finish(sessionId)] as const] : [])
      ];
      // 并发跑、各自兜底：一个来源卡住不该拖住其它来源。
      await Promise.all(
        steps.map(([label, run]) =>
          run().catch((error: unknown) => deps.log(`${label}失败：${String(error)}`))
        )
      );
      return true;
    },
    forget(sessionId) {
      if (sessionId === undefined) {
        finished.clear();
        return;
      }
      for (const key of finished) if (key.startsWith(`${sessionId}:`)) finished.delete(key);
    }
  };
}

/**
 * 卡顿巡检的收尾：先补一条 `ended{interrupted}`（否则 journal 还停在 prompt，
 * `turnInProgress` 继续把这个会话当成「在跑」，后面的消息永远排队），再走总闸。
 * 收尾在会话队列里做，和正常事件落盘同一条串行链。
 * 返回 false 表示这一轮已经不在了（正常结束或别人先收了）。
 */
export async function endStalledTurn(
  deps: Pick<Deps, 'artifacts' | 'now' | 'queue' | 'sessions' | 'stream'>,
  finisher: TurnFinisher,
  sessionId: SessionId,
  reason: string
): Promise<boolean> {
  const ended = await deps.queue.run(sessionId, async () => {
    const last = (await deps.sessions.tail(sessionId, 1))[0];
    if (!last || last.event.kind === 'ended') return false;
    const result = await recordEvent(deps, { sessionId, event: { kind: 'ended', outcome: 'interrupted', reason } });
    return result.ok;
  });
  if (!ended) return false;
  await finisher.finish(sessionId, 'interrupted', reason);
  return true;
}
