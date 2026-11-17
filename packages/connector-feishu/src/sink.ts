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
  }): Promise<ChannelOutboxMessage>;
}

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
      }, now());
      await deps.outbox.save(queued);
      deps.log?.(`[feishu] 回复入队 ${queued.target.id}（outbox ${queued.id}）`);
      return queued;
    }
  };
}

export interface FeishuTurnRepliesDeps {
  readonly runs: Pick<ConnectorStore, 'deliveredRunFor' | 'binding'>;
  readonly tail: (sessionId: string, limit: number) => Promise<readonly { readonly event: { readonly kind: string; readonly delta?: string } }[]>;
  readonly enqueueReply: FeishuSink['enqueueReply'];
}

/** 本轮最后一段智能体文字（最后一个 prompt 之后的所有 text）。 */
function lastTurnText(entries: readonly { readonly event: { readonly kind: string; readonly delta?: string } }[]): string {
  let lastPrompt = -1;
  entries.forEach((entry, index) => {
    if (entry.event.kind === 'prompt') lastPrompt = index;
  });
  return entries.slice(lastPrompt + 1).map((entry) => (entry.event.kind === 'text' ? entry.event.delta ?? '' : '')).join('').trim();
}

/**
 * 回合结束 → 找到这条会话上投进去的飞书运行（externalId 是 `<chatId>:<messageId>`），
 * 把本轮回复写进出站队列，并回在原消息下面。
 */
export function createFeishuTurnReplies(deps: FeishuTurnRepliesDeps) {
  return {
    async finish(sessionId: string): Promise<string | null> {
      const run = await deps.runs.deliveredRunFor(sessionId);
      if (!run) return null;
      const binding = await deps.runs.binding(run.bindingId);
      if (!binding || binding.connector !== 'feishu') return null;
      // 群目标的回复由群帖镜像回写（每一条 agent 帖都会入出站队列）；
      // 这里再补一份整轮回复会和镜像重复发送（#230）。
      if (binding.targetKind === 'group') return null;
      const at = parseFeishuExternalId(run.externalId);
      if (!at) return null;
      const body = lastTurnText(await deps.tail(sessionId, 500));
      if (body === '') return null;
      await deps.enqueueReply({ chatId: at.chatId, body, replyToExternalId: at.messageId, sessionId });
      return body;
    }
  };
}
