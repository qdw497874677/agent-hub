/**
 * 回合收尾总闸（#269 第 5 项）。
 *
 * 一轮结束有几条入口：
 * - worker 的 `ended` 事件：流帧带着**落盘时**的 seq / outcome / reason；
 * - worker 的 `status idle / ended`：只是「进程那边说这一轮结束了」的提示，
 *   outcome 必须回 journal 末尾看那条 ended，不能从 session.status 猜；
 * - 卡顿巡检：只记诊断，不补 ended、不经过本闸；
 * - 送达回收（`recoverOrphanedTurns`）：只在托管进程还在时请求一次运行时 `interrupt`，
 *   或对无法确认的会话记诊断；**不写 ended、不放行队首**。
 *
 * 身份 = `(sessionId, ended 事件的 journal seq)`。seq 由平台在落盘时分配、同一会话内单增，
 * 所以 `idle` 与事件帧先后到达、帧重放、并发调用都归到同一个 key；不再看
 * `session.lastSeq`（它会被后来的事件推走，导致同一回合被收两次），也不从快照推断 outcome。
 *
 * 各钩子自身仍是幂等的（`SessionInbox.end` 的约定）；这里的去重是少做无用功，
 * 正确性不押在去重上。
 */
import type { Deps, SessionId } from '@agent-hub/domain';

export type TurnOutcome = 'done' | 'stopped' | 'interrupted' | 'failed';

/** 一次收尾的身份：必须是**已落盘**的 ended 事件。 */
export interface TurnEnd {
  readonly sessionId: SessionId;
  /** 那条 ended 事件在会话 journal 里的 seq（不是 session.lastSeq 的快照）。 */
  readonly seq: number;
  readonly outcome: TurnOutcome;
  readonly reason?: string;
  /** 这条 ended 对应的 prompt 投递 id；旧协议 / 平台补写的 ended 没有。 */
  readonly deliveryId?: string;
}

export interface TurnFinishHooks {
  /** 收件箱：各来源收这一轮（约定幂等）。 */
  readonly inbox: { end(sessionId: string, outcome: TurnOutcome, reason?: string): Promise<void> };
  /** 回合检查点：拍「之后」那张。 */
  readonly files: { endTurn(sessionId: string): Promise<void> };
  /** 假渠道回程（只在 HUB_FAKE_CHANNEL=1 时有）。 */
  readonly fakeReplies?: { finish(sessionId: string, end: TurnEnd): Promise<string | null> };
  /** 飞书回程。 */
  readonly feishuReplies?: { finish(sessionId: string, end: TurnEnd): Promise<string | null> };
}

export interface TurnFinishDeps extends TurnFinishHooks {
  readonly log: (message: string) => void;
  /**
   * 当前的 durable `sending` 投递。提供时，ended 必须与它同会话、同 deliveryId 才收尾；
   * 没有 in-flight 时才接受旧协议的无 key ended。未提供则保持旧行为（测试 / 轻量装配）。
   */
  readonly inFlight?: (sessionId: SessionId) => Promise<{ readonly id: string; readonly sessionId: string } | null>;
  /**
   * 送达队列的收尾（`releaseAfterTurn`）。放在现有收件箱钩子之后单独调用：
   * 收件箱的 delivery 来源只保留 occupancy 注册，不在这里放行，避免用「当前 inFlight」猜身份。
   * 传入的是本条 ended 自己的 `deliveryId`；旧协议无 key 时为 undefined。
   */
  readonly releaseDelivery?: (sessionId: SessionId, deliveryId?: string) => Promise<unknown>;
}

export interface TurnFinisher {
  /**
   * 收尾一轮。同一会话、同一个 ended seq 的并发 / 重放调用只认第一条，返回 false 表示钩子没再跑。
   * 同一会话的不同 seq 按到达顺序串行跑钩子。钩子失败只记日志，不影响其它钩子，也不向调用方抛。
   */
  finish(end: TurnEnd): Promise<boolean>;
  /** 测试用：忘掉去重水位与排队链。 */
  forget(sessionId?: SessionId): void;
}

/**
 * 去重水位的保留上限（按会话计）。水位每个会话只存一条，所以内存有界；
 * 超出后淘汰最久没再收尾的会话——**保证**是「最近收尾过的这些会话内的重复 ended 不会再跑钩子」；
 * 更老的会话若再收到旧帧会重跑（钩子都按幂等实现，收件箱 / 回程可安全重入）。
 */
export const MAX_TRACKED_SESSIONS = 1_024;

export function createTurnFinisher(deps: TurnFinishDeps): TurnFinisher {
  // key = sessionId，value = 已收尾到的最大 ended seq（同一会话内 seq 单增）。
  const finished = new Map<SessionId, number>();
  // 同一会话的钩子串行：seq 3 还在跑回程时，seq 4 的收件箱不能先放行。
  const chains = new Map<SessionId, Promise<void>>();

  const remember = (sessionId: SessionId, seq: number): void => {
    // 删除再插入 = 移到 Map 尾部，淘汰时先扔最久没动的会话。
    finished.delete(sessionId);
    finished.set(sessionId, seq);
    while (finished.size > MAX_TRACKED_SESSIONS) {
      const oldest = finished.keys().next().value;
      if (oldest === undefined) break;
      finished.delete(oldest);
    }
  };

  const runHooks = async (end: TurnEnd): Promise<void> => {
    const { sessionId, outcome, reason } = end;
    // 一个钩子卡住 / 抛错不拖住其它钩子，也不向调用方抛。
    const isolated = async (label: string, run: () => Promise<unknown>): Promise<void> => {
      try {
        await run();
      } catch (error: unknown) {
        deps.log(`${label}失败：${String(error)}`);
      }
    };

    // 回程先跑：飞书 / 假渠道要从 journal 里取「本轮最后一段文字」，
    // 而收件箱里的 delivery 来源一放行就可能立刻把下一句投进来（换掉 pending 的 run）。
    // 检查点也在放行前拍，避免下一轮开始写文件后再拍「之后」那张。
    const beforeInbox: Array<readonly [string, () => Promise<unknown>]> = [
      ...(deps.fakeReplies ? [['假渠道回程', () => deps.fakeReplies!.finish(sessionId, end)] as const] : []),
      ...(deps.feishuReplies ? [['飞书回程', () => deps.feishuReplies!.finish(sessionId, end)] as const] : []),
      ['回合检查点', () => deps.files.endTurn(sessionId)]
    ];
    await Promise.all(beforeInbox.map(([label, run]) => isolated(label, run)));
    // 收件箱：各来源按注册顺序收尾；delivery 来源只在这里保持占用判断，不再放行队列。
    await isolated('回合收尾', () => deps.inbox.end(sessionId, outcome, reason));
    // 送达队列最后放行，且只认这条 ended 自带的 deliveryId，不拿「当前 inFlight」猜上一轮。
    if (deps.releaseDelivery) {
      await isolated('送达放行', () => deps.releaseDelivery!(sessionId, end.deliveryId));
    }
  };

  /**
   * 身份闸先于去重水位：有 durable in-flight 时，未带 deliveryId 或带错 deliveryId 的 ended
   * 既不能跑钩子，也不能把 seq 记进水位（否则随后真正的 ended 会被挡掉）。
   */
  const admits = async (end: TurnEnd): Promise<boolean> => {
    if (!deps.inFlight) return true;
    let current: Awaited<ReturnType<NonNullable<TurnFinishDeps['inFlight']>>>;
    try {
      current = await deps.inFlight(end.sessionId);
    } catch (error: unknown) {
      // 读不到在途身份时不运行有副作用的钩子，也不推进去重水位。
      deps.log(`送达身份检查失败：${String(error)}`);
      return false;
    }
    if (!current) return end.deliveryId === undefined;
    return current.sessionId === end.sessionId && end.deliveryId === current.id;
  };

  const settle = async (end: TurnEnd): Promise<boolean> => {
    if (!(await admits(end))) return false;
    const { sessionId, seq } = end;
    const high = finished.get(sessionId);
    if (high !== undefined && seq <= high) return false;
    remember(sessionId, seq);
    await runHooks(end);
    return true;
  };

  return {
    finish(end) {
      const { sessionId } = end;
      const previous = chains.get(sessionId) ?? Promise.resolve();
      // 身份检查 + 水位判断 + 钩子都在同一条会话链里串行：并发 replay 不会都通过身份检查，
      // 也不会出现后一轮先放行收件箱。
      const current = previous.then(() => settle(end), () => settle(end));
      const settled = current.then(
        () => undefined,
        () => undefined
      );
      chains.set(sessionId, settled);
      void settled.then(() => {
        if (chains.get(sessionId) === settled) chains.delete(sessionId);
      });
      return current;
    },
    forget(sessionId) {
      if (sessionId === undefined) {
        finished.clear();
        chains.clear();
        return;
      }
      finished.delete(sessionId);
      chains.delete(sessionId);
    }
  };
}

/**
 * `status idle / ended` 的兜底收尾：先排空这条会话的队列（已经到达的 ended 事件先落盘），
 * 再看 journal 末尾。只有末尾真的是 `ended` 才收尾，seq / outcome / reason 全部取自那条事件；
 * 末尾不是 ended 就什么也不做——**不从 session.status 推断 outcome**（进程被杀时库里已经是
 * interrupted，但那一轮并没有 ended 记录，此时没有可收尾的回合身份）。
 */
export async function finishFromJournalTail(
  deps: Pick<Deps, 'queue' | 'sessions'>,
  finisher: TurnFinisher,
  sessionId: SessionId
): Promise<boolean> {
  await deps.queue.run(sessionId, async () => undefined);
  const tail = (await deps.sessions.tail(sessionId, 1))[0];
  if (!tail || tail.event.kind !== 'ended') return false;
  return finisher.finish({
    sessionId,
    seq: tail.seq,
    outcome: tail.event.outcome,
    reason: tail.event.reason,
    ...(tail.event.deliveryId === undefined ? {} : { deliveryId: tail.event.deliveryId })
  });
}
