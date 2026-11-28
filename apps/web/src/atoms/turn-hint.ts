import type { DeliveryDto } from '@agent-hub/contract';
import type { PendingPrompt } from './pending-prompt.ts';
import type { TurnPhase, TurnProgress } from './turn-progress.ts';

/**
 * 专注对话两端共用的那**一条**进度：现在到底到哪一步了。
 *
 * 原来同一件事有三处说法：气泡下面的「发送中…」、输入框上方的「正在启动 …」、还有一个「⋯」，
 * 手机上三条叠在一起，读起来像三件不同的事。这里只挑一条，而且只挑有证据的：
 *
 * 1. 还只在本机、或刚拿到回执还没写进对话的那一条（`pending`）才是「当前这一句」——
 *    上一句的运行时进度不能算到它头上；
 * 2. 服务器收下了（`DeliveryDto` 的 queued / sending）——排队 / 投递在途，仍是送达层的事实；
 * 3. 只有**看到这一轮的输出或工具**（`writing` / `tool` / `tool-wait`）才说运行时；
 *    工具结束后只说等待后续，不再说工具正在执行。
 *    「还没有块」（`starting`）和「只有登记块」（`waiting`）都只是没有证据，不等于 agent 在动。
 *
 * 两条硬约束：
 * - 不看时钟推断成败：状态只由服务端/运行时的事实推进，等再久也不会自己变成「失败」；
 * - 不因为「在发 / 服务器收下了」就说「已发送」或「已启动」：这两句要等真正的事实。
 *
 * 有动作要人做的那几种（未送达、重试倒计时、撤回）不在这里说：那几行自带按钮，
 * 留在气泡下面更近，见 `deliveryNeedsAction`。
 */

/** 还没送到的送达状态：气泡留在原位，只是样子淡一点。 */
export const HELD_DELIVERY_STATES: ReadonlySet<DeliveryDto['state']> = new Set(['queued', 'sending', 'undelivered']);

/** 这一条前面还有没送到的消息吗（那它就是在排队，不是在投递）。 */
export function queuedBehind(delivery: Pick<DeliveryDto, 'seq'>, all: Iterable<DeliveryDto>): boolean {
  for (const other of all) {
    if (other.seq < delivery.seq && HELD_DELIVERY_STATES.has(other.state)) return true;
  }
  return false;
}

export function uncertainSending(delivery: DeliveryDto, ids: readonly string[]): boolean {
  return delivery.state === 'sending' && ids.includes(delivery.id);
}

export function queuedBehindUncertain(delivery: Pick<DeliveryDto, 'seq' | 'state'>, all: Iterable<DeliveryDto>, ids: readonly string[]): boolean {
  if (delivery.state !== 'queued') return false;
  for (const other of all) {
    if (other.seq < delivery.seq && uncertainSending(other, ids)) return true;
  }
  return false;
}

export type QueueReason = 'offline' | 'starting' | 'blocked';

/** 回执里的 queued 不代表前面一定有消息；只在有前序或受阻证据时称为排队。 */
export function queuedDeliveryText(seq: number | undefined, deliveries: Iterable<DeliveryDto>, uncertainDeliveryIds: readonly string[] = [], reason?: QueueReason): string {
  if (seq !== undefined) {
    const all = Array.isArray(deliveries) ? deliveries : [...deliveries];
    const current = { seq, state: 'queued' as const };
    if (queuedBehindUncertain(current, all, uncertainDeliveryIds)) return '已排队 · 等待上一轮状态确认';
    if (queuedBehind(current, all)) return '已排队 · 前面还有消息';
  }
  if (reason === 'offline') return '已排队 · 等待机器上线';
  if (reason === 'starting') return '已排队 · 等待运行时就绪';
  return reason === 'blocked' ? '已排队 · 等待投递' : '发送中…';
}

/**
 * 气泡下面那行是不是「要人动手」：报错、重试倒计时、撤回。
 *
 * 是的话它就是这件事唯一的说法，对话末尾不再重复一条进度；不是的话（纯等待）
 * 由 `turnHint` 那一条承担，气泡下面保持安静。
 */
export function deliveryNeedsAction(delivery: DeliveryDto, all: Iterable<DeliveryDto>, withdrawQueued = false): boolean {
  if (delivery.state === 'undelivered' || (delivery.state === 'queued' && delivery.attempt > 0)) return true;
  // 排在别人后面时只写「等上一条送达」，没有按钮；轮到它自己才有「撤回」。
  return delivery.state === 'queued' && (withdrawQueued || !queuedBehind(delivery, all));
}

/** 这一条进度说的是哪一层的事：送达（服务端）还是运行时（agent 进程）。 */
export type TurnHintStage = 'delivery' | 'runtime';

export interface TurnHint {
  /** 一行主文案。窄屏会截断，控制在十几个字以内。 */
  readonly text: string;
  /** 完整说明：不悬停、不展开也能读懂（`title` / `aria-label`）。 */
  readonly detail: string;
  readonly stage: TurnHintStage;
  readonly phase: 'sending' | 'queued' | 'starting' | 'waiting' | 'writing' | 'tool' | 'tool-wait';
}

export interface TurnHintInput {
  /** 还没写进对话的消息（本地乐观气泡）。 */
  readonly pending: readonly PendingPrompt[];
  /** 最后一条问话的送达状态；还没查到就是 undefined。 */
  readonly delivery: DeliveryDto | undefined;
  /** 这条会话全部送达状态：判断「是不是排在别人后面」要用。 */
  readonly deliveries: Iterable<DeliveryDto>;
  /** 这一轮的运行时进度（`turnProgress`）；回合没在跑时是 null。 */
  readonly progress: TurnProgress | null;
  readonly withdrawQueued?: boolean;
  readonly uncertainDeliveryIds?: readonly string[];
  /** 已确认的运行时状态，不从回执推测。 */
  readonly queueReason?: QueueReason | undefined;
}

/** 能算作「agent 真的在动」的相位：要么有输出，要么在等工具。空窗和只有登记块都不算。 */
const RUNTIME_ACTIVITY: ReadonlySet<TurnPhase> = new Set<TurnPhase>(['writing', 'tool']);

export function turnHint({ pending, delivery, deliveries, progress, withdrawQueued = false, uncertainDeliveryIds = [], queueReason }: TurnHintInput): TurnHint | null {
  const allDeliveries = [...deliveries];
  // 1. 本地还有一条比 `delivery` 更晚的消息（没回执，或已有回执但还没写进对话）：
  //    当前这一句是它，运行时进度属于上一句，不能借来说它。
  const newest = pending[pending.length - 1];
  if (newest !== undefined && (newest.seq === undefined || delivery === undefined || newest.seq > delivery.seq)) {
    // 超时只是「不确定」，不是失败：重试 / 放弃两个按钮在那行上，别在这里再说一遍。
    if (newest.state === 'unknown') return null;
    if (newest.state === 'queued') {
      const text = queuedDeliveryText(newest.seq, allDeliveries, uncertainDeliveryIds, queueReason);
      return {
        text,
        detail: text === '发送中…' ? '服务器已经收下这条消息，等待投递' : text,
        stage: 'delivery',
        phase: text === '发送中…' ? 'sending' : 'queued'
      };
    }
    return {
      text: '正在发送…',
      detail: newest.seq === undefined ? '消息已经发出，还没收到服务器的回执' : '服务器已经收下这条消息，正在交给 agent',
      stage: 'delivery',
      phase: 'sending'
    };
  }

  // 2. 服务端已经收下（或正在投递）：这是持久化的事实，不是运行时。
  //    `sending` 会一直占到这一轮真的结束（结束证据才写 delivered，ADR 0031 D2），
  //    所以它压不住**有证据**的运行时；但「还没有块」只是没证据，送达层怎么说就怎么说。
  if (delivery !== undefined && HELD_DELIVERY_STATES.has(delivery.state)) {
    if (deliveryNeedsAction(delivery, allDeliveries, withdrawQueued)) return null;
    if (delivery.state === 'sending') {
      if (uncertainSending(delivery, uncertainDeliveryIds)) {
        return { text: '暂未确认这一轮的结果', detail: '暂未确认这一轮的结果', stage: 'delivery', phase: 'sending' };
      }
      if (progress !== null && (RUNTIME_ACTIVITY.has(progress.phase) || progress.phase === 'tool-wait')) {
        return { text: progress.label, detail: progress.detail, stage: 'runtime', phase: progress.phase };
      }
      return {
        text: '等待模型首次回应',
        detail: '服务器正在投递这条消息，还没有看到本轮输出',
        stage: 'delivery',
        phase: 'sending'
      };
    }
    const text = queuedDeliveryText(delivery.seq, allDeliveries, uncertainDeliveryIds, queueReason);
    return {
      text,
      detail: text === '发送中…' ? '服务器已经收下这条消息，等待投递' : text,
      stage: 'delivery',
      phase: text === '发送中…' ? 'sending' : 'queued'
    };
  }
  if (delivery?.state === 'cancelled') return null;

  // 3. 运行时：只认输出 / 工具及工具结束后的等待。「还没有块」和「只有登记块」都不算 agent 在动。
  if (progress !== null && (RUNTIME_ACTIVITY.has(progress.phase) || progress.phase === 'tool-wait')) {
    return { text: progress.label, detail: progress.detail, stage: 'runtime', phase: progress.phase };
  }
  return null;
}
