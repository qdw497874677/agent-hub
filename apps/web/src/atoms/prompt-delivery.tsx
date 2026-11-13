import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AttachmentInputDto, PromptAckDto } from '../shell/api.ts';
import {
  expirePending,
  newClientMessageId,
  pendingLabel,
  reconcilePending,
  type PendingPrompt
} from './pending-prompt.ts';
import { ACK_GRACE_MS, nextAckDelay, pendingBubbles } from './prompt-delivery.ts';

/**
 * 发送回执这一层：乐观气泡、8 秒超时、重试/放弃、和 journal 回显对账。
 *
 * 专注对话和画布卡片走同一套：卡片不该再有一份「点了禁用一下」的简化版。
 * 纯逻辑在 prompt-delivery.ts（可单测），这里只管状态和展示。
 */

/** 真正把消息发出去的那一下；clientMessageId 由 hook 生成，重试沿用同一个。 */
export interface PromptSend {
  (
    text: string,
    attachments: readonly AttachmentInputDto[],
    clientMessageId: string
  ): Promise<PromptAckDto>;
}

export interface UsePromptDeliveryOptions {
  /** 换会话就丢掉上一条会话的 pending：挂在别的会话的输入框上会误导人。 */
  readonly sessionId: string;
  /** 这条会话的对话块；带 clientMessageId 的 prompt 块出现时，对应气泡让位。 */
  readonly blocks: readonly { readonly kind: string; readonly clientMessageId?: string }[];
  readonly send: PromptSend;
}

export interface PromptDelivery {
  /** 还没写进对话的消息，按发送顺序。 */
  readonly pending: readonly PendingPrompt[];
  /** 发一条：先插气泡，回执到了标 queued，出错就撤掉气泡并把错误抛给调用方。 */
  readonly deliver: (text: string, attachments?: readonly AttachmentInputDto[]) => Promise<PromptAckDto>;
  /** 未送达重发：沿用同一个 clientMessageId，服务端幂等，不会变成两条。 */
  readonly retry: (prompt: PendingPrompt) => Promise<PromptAckDto>;
  /** 只撤本地气泡：服务端要是其实收到了，它已经在对话里了。 */
  readonly discard: (id: string) => void;
}

export function usePromptDelivery({ sessionId, blocks, send }: UsePromptDeliveryOptions): PromptDelivery {
  const [pending, setPending] = useState<readonly PendingPrompt[]>([]);
  // 调用方一般写成内联箭头函数，每次渲染都换身份；用 ref 拿最新那份，别让它触发 effect。
  const sendRef = useRef(send);
  sendRef.current = send;

  useEffect(() => {
    setPending([]);
  }, [sessionId]);

  // journal 里出现同 id 的 prompt 后，乐观气泡让位给真实事件；同文的另一条不受影响。
  useEffect(() => {
    setPending((previous) => reconcilePending(previous, blocks));
  }, [blocks]);

  // 回执迟迟不来就是「未送达」：宁可让人点一次重试，也别让气泡一直装作在发。
  useEffect(() => {
    const delay = nextAckDelay(pending, Date.now());
    if (delay === null) return;
    const timer = setTimeout(() => {
      setPending((previous) => expirePending(previous, Date.now()));
    }, delay + ACK_GRACE_MS);
    return () => clearTimeout(timer);
  }, [pending]);

  const deliver = useCallback(
    async (text: string, attachments: readonly AttachmentInputDto[] = []): Promise<PromptAckDto> => {
      const id = newClientMessageId();
      const sentAt = Date.now();
      setPending((previous) => [
        ...previous,
        { id, text, attachments: [...attachments], state: 'sending', sentAt }
      ]);
      try {
        const ack = await sendRef.current(text, attachments, id);
        setPending((previous) =>
          previous.map((item) => (item.id === id ? { ...item, state: ack.state, seq: ack.seq } : item))
        );
        return ack;
      } catch (failure) {
        setPending((previous) => previous.filter((item) => item.id !== id));
        throw failure;
      }
    },
    []
  );

  const retry = useCallback(async (prompt: PendingPrompt): Promise<PromptAckDto> => {
    setPending((previous) =>
      previous.map((item) =>
        item.id === prompt.id ? { ...item, state: 'sending', sentAt: Date.now() } : item
      )
    );
    try {
      const ack = await sendRef.current(prompt.text, prompt.attachments, prompt.id);
      setPending((previous) =>
        previous.map((item) => (item.id === prompt.id ? { ...item, state: ack.state, seq: ack.seq } : item))
      );
      return ack;
    } catch (failure) {
      setPending((previous) => previous.filter((item) => item.id !== prompt.id));
      throw failure;
    }
  }, []);

  const discard = useCallback((id: string) => {
    setPending((previous) => previous.filter((item) => item.id !== id));
  }, []);

  return { pending, deliver, retry, discard };
}

export interface PendingPromptsProps {
  readonly pending: readonly PendingPrompt[];
  readonly onRetry: (prompt: PendingPrompt) => void;
  readonly onDiscard: (id: string) => void;
  /** 气泡本体由调用方画：专注对话用完整 ChatBlock，卡片用一行省略的气泡。 */
  readonly renderPrompt: (prompt: PendingPrompt, index: number, seq: number) => ReactNode;
  /** 同一页有多条会话时用前缀分开（卡片用 `card-`）。 */
  readonly testIdPrefix?: string;
  /** 卡片上收紧：单行、小间距、限高滚动。 */
  readonly compact?: boolean;
}

/** 输入框上方的「还没写进对话的消息」。文案和 testid 两边一致（只看前缀）。 */
export function PendingPrompts({
  pending,
  onRetry,
  onDiscard,
  renderPrompt,
  testIdPrefix = '',
  compact = false
}: PendingPromptsProps) {
  if (pending.length === 0) return null;
  return (
    <section
      aria-label="还没写进对话的消息"
      aria-live="polite"
      data-testid={`${testIdPrefix}pending-prompts`}
      className={
        compact
          ? 'nowheel nopan nodrag mt-1 max-h-[120px] shrink-0 overflow-y-auto overscroll-contain border-t border-dashed border-hair pt-1'
          : 'mb-2 border-t border-dashed border-hair pt-2'
      }
    >
      <div className={compact ? 'flex flex-col gap-1' : 'flex flex-col gap-2'}>
        {pendingBubbles(pending).map(({ prompt, seq }, index) => (
          <div key={prompt.id} className="flex min-w-0 flex-col gap-1">
            {renderPrompt(prompt, index, seq)}
            {prompt.state === 'unknown' ? (
              <div
                className="flex flex-wrap items-center gap-1 text-meta text-tertiary"
                data-testid={`${testIdPrefix}pending-unknown`}
              >
                <span className="mr-1 text-rust">未送达</span>
                <button
                  type="button"
                  data-testid={`${testIdPrefix}pending-retry`}
                  onClick={() => onRetry(prompt)}
                  className="inline-flex min-h-8 items-center rounded-sm border border-hair px-2.5 text-meta text-secondary hover:border-strong hover:text-primary active:bg-card"
                >
                  重试
                </button>
                <button
                  type="button"
                  data-testid={`${testIdPrefix}pending-discard`}
                  onClick={() => onDiscard(prompt.id)}
                  className="inline-flex min-h-8 items-center rounded-sm px-2.5 text-meta text-tertiary hover:text-primary active:bg-card"
                >
                  放弃
                </button>
              </div>
            ) : (
              <p className="truncate text-meta text-tertiary">{pendingLabel(prompt.state)}</p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/** 至少带 kind / seq 的 prompt 块；真实 Block 结构化兼容。 */
export interface QueuedPromptLike {
  readonly kind: 'prompt';
  readonly seq: number;
}

export interface QueuedPromptsProps<B extends QueuedPromptLike> {
  /** 从时间线里拆出来的 prompt 块（见 prompt-delivery.ts 的 splitTimeline）。 */
  readonly blocks: readonly B[];
  readonly renderPrompt: (block: B, index: number) => ReactNode;
  readonly testIdPrefix?: string;
  readonly compact?: boolean;
}

/** 贴在输入框上方的「排队中的消息」。卡片的滚动区在这里限高，别把整张卡撑大。 */
export function QueuedPrompts<B extends QueuedPromptLike>({
  blocks,
  renderPrompt,
  testIdPrefix = '',
  compact = false
}: QueuedPromptsProps<B>) {
  if (blocks.length === 0) return null;
  return (
    <section
      aria-label="排队中的消息"
      aria-live="polite"
      data-testid={`${testIdPrefix}queued-prompts`}
      className={
        compact
          ? 'nowheel nopan nodrag mt-1 max-h-[120px] shrink-0 overflow-y-auto overscroll-contain border-t border-dashed border-hair pt-1'
          : 'mb-2 max-h-[40vh] overflow-y-auto border-t border-dashed border-hair pt-2'
      }
    >
      <p className="mb-1 truncate text-meta text-tertiary">待发送 · 当前回复结束后自动发出</p>
      <div className={compact ? 'flex flex-col gap-1' : 'flex flex-col gap-2'}>
        {blocks.map((block, index) => (
          <div key={`queued-${block.seq}`} className="min-w-0">
            {renderPrompt(block, index)}
          </div>
        ))}
      </div>
    </section>
  );
}
