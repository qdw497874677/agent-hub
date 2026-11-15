/**
 * 会话收件箱（#221 步骤 5）。
 *
 * 一条会话同一时刻只该有一件事在等它回话：人在输入框发的、另一个 agent 发来的、
 * 群里的投递、连接器触发出来的、调度通知——现在这些队列各自判断「占用」、
 * 各自在回合结束时收尾，规则重复且容易互相饿死或叠投。
 *
 * 这里只收两件共性：**占用**与**回合结束归属**。每个来源仍然自己决定投什么、
 * 怎么记状态；本模块不存数据、不调度、不认识具体队列。
 */

export type TurnOutcome = 'done' | 'stopped' | 'interrupted' | 'failed';

/** 一个能把消息投进会话、并在回合结束时收尾的来源。 */
export interface InboxSource {
  /** 日志与排障用的稳定名字（`p2p` / `group` / `delivery` …）。 */
  readonly id: string;
  /** 还有没等到结果的投递？有就说明这条会话被占着，别的来源先别投。 */
  open(sessionId: string): Promise<boolean>;
  /** 这一轮结束了。实现必须幂等：`idle` 与 `ended` 都会调到这里。 */
  end(sessionId: string, outcome: TurnOutcome, reason: string | undefined): Promise<void>;
}

export interface SessionInboxDeps {
  readonly sources: readonly InboxSource[];
  /** 收尾失败不打断其它来源；默认打到 stderr。 */
  readonly onError?: (source: string, error: unknown) => void;
}

export interface SessionInbox {
  readonly sources: readonly string[];
  /** 任一来源还在等这条会话的回话。 */
  occupied(sessionId: string): Promise<boolean>;
  /** 回合结束：按注册顺序让各来源收尾（各自幂等）。 */
  end(sessionId: string, outcome: TurnOutcome, reason?: string): Promise<void>;
}

export function createSessionInbox(deps: SessionInboxDeps): SessionInbox {
  const report = deps.onError ?? ((source: string, error: unknown) => console.warn(`会话收件箱：${source} 收尾失败：${String(error)}`));
  return {
    sources: deps.sources.map((source) => source.id),
    async occupied(sessionId) {
      // 顺序问而不是并发：来源少（≤5），顺序更好排障，也避免同一时刻读两份 SQLite。
      for (const source of deps.sources) {
        try {
          if (await source.open(sessionId)) return true;
        } catch (error) {
          report(source.id, error);
        }
      }
      return false;
    },
    async end(sessionId, outcome, reason) {
      for (const source of deps.sources) {
        try {
          await source.end(sessionId, outcome, reason);
        } catch (error) {
          report(source.id, error);
        }
      }
    }
  };
}
