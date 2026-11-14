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
 * 一条消息从头到尾只占一个位置：乐观气泡先挂在消息列表末尾，回执到了原地换行小字，
 * 进了 journal 再由那条真实消息接管——不搬到别的区块去。
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
  /** 还没写进对话的消息，按发送顺序。它们画在消息列表末尾（不是独立区块）。 */
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

  // 同 id 的 prompt 已经在 journal 里了：这一帧就别画气泡。只靠上面的 effect 对账，
  // 会多出一帧「气泡和真实消息同时在」，看着像闪了一下。
  return { pending: reconcilePending(pending, blocks), deliver, retry, discard };
}

export interface PendingPromptsProps {
  readonly pending: readonly PendingPrompt[];
  readonly onRetry: (prompt: PendingPrompt) => void;
  readonly onDiscard: (id: string) => void;
  /** 气泡本体由调用方画：专注对话用完整 ChatBlock，卡片用一行省略的气泡。 */
  readonly renderPrompt: (prompt: PendingPrompt, index: number, seq: number) => ReactNode;
  /** 同一页有多条会话时用前缀分开（卡片用 `card-`）。 */
  readonly testIdPrefix?: string;
  /** 卡片上收紧：单行、小间距。 */
  readonly compact?: boolean;
  /**
   * 调用方控制间距：要贴在同一份消息列表里，就得和列表用同一个 gap。
   * 传了就以它为准（不再叠默认 gap，Tailwind 的同类工具类谁排在后面谁赢，不能靠拼接顺序）。
   */
  readonly className?: string;
}

/**
 * 「还没写进对话的消息」。它不是一个独立的区块，而是消息列表末尾的正常气泡：
 * 里面的人马上会变成 journal 里的那条 prompt，所以这里只补一行状态字，不换外壳、不换位置。
 */
export function PendingPrompts({
  pending,
  onRetry,
  onDiscard,
  renderPrompt,
  testIdPrefix = '',
  compact = false,
  className = ''
}: PendingPromptsProps) {
  if (pending.length === 0) return null;
  return (
    <section
      aria-label="还没写进对话的消息"
      aria-live="polite"
      data-testid={`${testIdPrefix}pending-prompts`}
      className={`flex min-w-0 flex-col ${className || (compact ? 'gap-1.5' : 'gap-3')}`}
    >
      {pendingBubbles(pending).map(({ prompt, seq }, index) => (
        <div
          key={prompt.id}
          data-testid={`${testIdPrefix}pending-msg`}
          data-state={prompt.state}
          className={`flex min-w-0 flex-col ${compact ? 'gap-0.5' : 'gap-1.5'}`}
        >
          {renderPrompt(prompt, index, seq)}
          <PendingStateLine
            prompt={prompt}
            onRetry={onRetry}
            onDiscard={onDiscard}
            testIdPrefix={testIdPrefix}
          />
        </div>
      ))}
    </section>
  );
}

/**
 * 气泡下面那行 11px 的小字。和 journal 里真实消息的送达说明同一套写法
 * （右对齐、`text-meta`、`data-state`），所以气泡从「正在发送」变成「排队中」只是换字，不换形。
 */
function PendingStateLine({
  prompt,
  onRetry,
  onDiscard,
  testIdPrefix
}: {
  readonly prompt: PendingPrompt;
  readonly onRetry: (prompt: PendingPrompt) => void;
  readonly onDiscard: (id: string) => void;
  readonly testIdPrefix: string;
}) {
  if (prompt.state === 'unknown') {
    return (
      <div
        className="flex max-w-[85%] flex-wrap items-center justify-end gap-1 self-end text-meta text-tertiary"
        data-testid={`${testIdPrefix}pending-unknown`}
        data-state="unknown"
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
    );
  }
  return (
    <p
      className="max-w-[85%] self-end truncate text-right text-meta text-tertiary transition-opacity duration-150"
      data-testid={`${testIdPrefix}pending-state`}
      data-state={prompt.state}
    >
      {pendingLabel(prompt.state)}
    </p>
  );
}
