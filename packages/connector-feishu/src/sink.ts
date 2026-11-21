import {
  isTransient,
  newOutboxMessage,
  type ChannelOutboxMessage,
  type ConnectorStore,
  type OutboxDeliverResult,
  type OutboxStore
} from '@agent-hub/domain';
import { FeishuError, type FeishuClient } from './client.ts';
import { clipText, feishuChatOf, feishuTargetId, parseFeishuExternalId } from './rules.ts';

/**
 * 渠道出站口：回合结束把回复写进 channel_outbox（`enqueueReply`），
 * pump 认领 `feishu:<chatId>` 行后真正调用平台（`deliver`）。不另起发送队列。
 */
export interface ConnectorSink {
  readonly id: string;
  deliver(message: ChannelOutboxMessage): Promise<OutboxDeliverResult>;
}

export interface FeishuSink extends ConnectorSink {
  readonly id: 'feishu';
  enqueueReply(input: {
    readonly chatId: string;
    readonly body: string;
    readonly replyToExternalId?: string | null;
    readonly sessionId?: string | null;
    /**
     * 确定性出站行 id（直聊回合回复用 `feishuReplyOutboxId(run.id)`）。
     * 不填则生成随机 id。同一个 id 重放时保留已存在行（含已 `sent` 状态）。
     */
    readonly outboxId?: string | null;
  }): Promise<ChannelOutboxMessage>;
}

/**
 * 直聊回合回复的确定性出站身份：一个 run 只对应一行。
 * 回合结束被重复触发、或 pump 重放时，不会把已发出的回复重新排队。
 */
export const feishuReplyOutboxId = (runId: string | null | undefined): string | null =>
  runId ? `feishu-reply:${runId}` : null;

export interface FeishuSinkDeps {
  readonly outbox: OutboxStore;
  readonly client: FeishuClient;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

/** 飞书业务码里「等会儿再试」的：99991400 = 请求触发频率限制。 */
const RETRYABLE_CODES = new Set([99991400]);

const retryableOf = (error: FeishuError): boolean =>
  error.status !== null ? isTransient({ status: error.status }) : error.code === null || RETRYABLE_CODES.has(error.code);

/** 渠道实现（或测试）自己给出的明确判定优先于按状态码推断。 */
const explicitRetryable = (error: unknown): boolean | null => {
  if (typeof error !== 'object' || error === null) return null;
  const value = (error as { retryable?: unknown }).retryable;
  return typeof value === 'boolean' ? value : null;
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function createFeishuSink(deps: FeishuSinkDeps): FeishuSink {
  const now = deps.now ?? (() => Date.now());
  return {
    id: 'feishu',
    async deliver(message) {
      if (message.target.kind !== 'external') {
        return { ok: false, error: { message: `飞书只发 external 目标，收到 ${message.target.kind}`, retryable: false } };
      }
      const chatId = feishuChatOf(message.target.id);
      if (!chatId) {
        return { ok: false, error: { message: `不是飞书目标：${message.target.id}`, retryable: false } };
      }
      const body = clipText(message.body);
      // 群的出站镜像把根帖的 `<chatId>:<messageId>` 整个记在 replyToExternalId 上；
      // 私聊回合写的是裸 messageId。两种都收，发给平台前只留 messageId。
      const parent = message.replyToExternalId
        ? (parseFeishuExternalId(message.replyToExternalId)?.messageId ?? message.replyToExternalId)
        : '';
      try {
        const sent = parent !== ''
          ? await deps.client.replyText(parent, body)
          : await deps.client.sendText({ chatId }, body);
        return { ok: true, externalMessageId: sent.messageId };
      } catch (error) {
        const failure = error instanceof FeishuError
          ? error
          : new FeishuError(`飞书发送失败：${errorText(error)}`);
        deps.log?.(`[feishu] 发送失败 ${message.target.id}：${failure.message}`);
        return { ok: false, error: { message: failure.message, retryable: explicitRetryable(error) ?? retryableOf(failure) } };
      }
    },
    async enqueueReply(input) {
      const queued = newOutboxMessage({
        target: { kind: 'external', id: feishuTargetId(input.chatId) },
        body: clipText(input.body),
        author: { kind: 'agent', name: 'agent-hub' },
        origin: 'reply',
        replyToExternalId: input.replyToExternalId ?? null,
        externalConversationId: input.chatId
      }, now(), input.outboxId ?? undefined);
      // 确定性 id 的幂等入队：同一 run 重放不覆盖已存在行（尤其是已 sent 的）。
      const { message, inserted } = await deps.outbox.insertIfAbsent(queued);
      deps.log?.(inserted
        ? `[feishu] 回复入队 ${message.target.id}（outbox ${message.id}）`
        : `[feishu] 回复已存在 ${message.target.id}（outbox ${message.id}，state=${message.state}）`);
      return message;
    }
  };
}

/** journal 里回程要用的最小事件形状；seq 必须是真的落盘序号。 */
export interface TurnReplyEntry {
  readonly seq: number;
  readonly event: { readonly kind: string; readonly delta?: string; readonly deliveryId?: string };
}

/** 回合收尾身份（`TurnEnd` 的结构子集，连接器不认识 server 的收尾类型）。 */
export interface TurnReplyEnd {
  readonly seq: number;
  readonly reason?: string;
  readonly deliveryId?: string;
}

export interface TurnReplyInFlight {
  readonly id: string;
  readonly sessionId: string;
  readonly seq: number;
}

/**
 * 平台补写的「这轮根本没送达」ended 没有 deliveryId，也不属于任何一次真实回程。
 * 旧协议的真实 ended 也没有 deliveryId，所以只按已知 reason 前缀排除，不能一刀切。
 */
export const isKnownSyntheticTurnEnd = (end: TurnReplyEnd): boolean =>
  end.deliveryId === undefined &&
  (end.reason?.startsWith('发送失败：') === true ||
    end.reason?.startsWith('未送达：') === true ||
    end.reason === '还没开始就停止了');

export interface TurnReplyTextWindow {
  /** keyed 回合的 prompt seq；null 表示旧协议里没有投递身份，只能退回「最后一个 prompt」。 */
  readonly anchorSeq: number | null;
  /** 目标 ended 的落盘 seq，窗口不能越过它。 */
  readonly endedSeq: number;
}

const textOf = (entry: TurnReplyEntry): string => (entry.event.kind === 'text' ? entry.event.delta ?? '' : '');

/**
 * 取一条回合窗口里的智能体文字。
 *
 * keyed：从 prompt seq 之后开始，但遇到本轮 ended 之前的**上一条 ended** 就把窗口清空重来。
 * B 的 prompt 可能先于 A 的 ended 落盘（排队时先记 prompt），A 的文字也会插在中间；
 * 只看「最后一个 prompt」会把 A 的尾巴算进 B 的回复。
 *
 * legacy：没有投递身份，保持原来的「最后一个 prompt 之后」算法；end.seq 已知时只看到这里为止。
 */
export function turnReplyText(
  entries: readonly TurnReplyEntry[],
  window: TurnReplyTextWindow
): string {
  const bounded = entries.filter(
    (entry) => entry.seq <= window.endedSeq && (window.anchorSeq === null || entry.seq > window.anchorSeq)
  );
  if (window.anchorSeq === null) {
    let lastPrompt = -1;
    bounded.forEach((entry, index) => {
      if (entry.event.kind === 'prompt') lastPrompt = index;
    });
    return bounded.slice(lastPrompt + 1).map(textOf).join('').trim();
  }
  let previousEnd = -1;
  bounded.forEach((entry, index) => {
    if (entry.event.kind === 'ended' && entry.seq < window.endedSeq) previousEnd = index;
  });
  return bounded.slice(previousEnd + 1).map(textOf).join('').trim();
}

export interface TurnReplyJournalDeps {
  /** keyed 窗口用：只取 anchor 之后的 journal，不受 tail 条数限制。 */
  readonly eventsAfter: (sessionId: string, afterSeq: number) => Promise<readonly TurnReplyEntry[]>;
  /** legacy 窗口用：没有投递身份时仍按原行为只回看最近 500 条。 */
  readonly tail: (sessionId: string, limit: number) => Promise<readonly TurnReplyEntry[]>;
  /** 当前 `sending` 的投递；用来验证 ended 的 deliveryId 与锚点确实属于同一条会话/回合。 */
  readonly inFlight: (sessionId: string) => Promise<TurnReplyInFlight | null>;
}

/**
 * 回程窗口的身份校验：
 * - 带 deliveryId：必须等于当前 inFlight.id，且 inFlight 属于同一会话；否则不回复（不拿 inFlight 硬套）。
 * - 不带 deliveryId 但仍有 inFlight：这是抢跑/平台补写的 ended，不能归因给当前回合。
 * - 不带 deliveryId 且没有 inFlight：旧协议兜底。
 */
export async function turnReplyWindow(
  deps: TurnReplyJournalDeps,
  sessionId: string,
  end: TurnReplyEnd
): Promise<{ readonly entries: readonly TurnReplyEntry[]; readonly anchorSeq: number | null } | null> {
  const inFlight = await deps.inFlight(sessionId);
  if (end.deliveryId !== undefined) {
    if (!inFlight || inFlight.sessionId !== sessionId || inFlight.id !== end.deliveryId) return null;
    return { entries: await deps.eventsAfter(sessionId, inFlight.seq), anchorSeq: inFlight.seq };
  }
  if (inFlight) return null;
  return { entries: await deps.tail(sessionId, 500), anchorSeq: null };
}

export interface FeishuTurnRepliesDeps extends TurnReplyJournalDeps {
  readonly runs: Pick<ConnectorStore, 'deliveredRunFor' | 'binding'>;
  readonly enqueueReply: FeishuSink['enqueueReply'];
}

/**
 * 回合结束 → 找到这条会话上投进去的飞书运行（externalId 是 `<chatId>:<messageId>`），
 * 把本轮回复写进出站队列，并回在原消息下面。
 */
export function createFeishuTurnReplies(deps: FeishuTurnRepliesDeps) {
  return {
    async finish(sessionId: string, end: TurnReplyEnd): Promise<string | null> {
      if (isKnownSyntheticTurnEnd(end)) return null;
      const run = await deps.runs.deliveredRunFor(sessionId);
      if (!run) return null;
      const binding = await deps.runs.binding(run.bindingId);
      if (!binding || binding.connector !== 'feishu') return null;
      // 群目标的回复由群帖镜像回写（每一条 agent 帖都会入出站队列）；
      // 这里再补一份整轮回复会和镜像重复发送（#230）。
      if (binding.targetKind === 'group') return null;
      const at = parseFeishuExternalId(run.externalId);
      if (!at) return null;
      const window = await turnReplyWindow(deps, sessionId, end);
      if (!window) return null;
      const body = turnReplyText(window.entries, { anchorSeq: window.anchorSeq, endedSeq: end.seq });
      if (body === '') return null;
      await deps.enqueueReply({
        chatId: at.chatId,
        body,
        replyToExternalId: at.messageId,
        sessionId,
        outboxId: feishuReplyOutboxId(run.id)
      });
      return body;
    }
  };
}
