import type { ConnectorBinding, InboundEvent } from '../connector.ts';

/** 入站半边（ADR 0032）：一个来源发出规范化事件；硬规则由来源在 emit 前判定，核心再兜底去重和配额。 */
export interface InboundSource {
  readonly id: string;
  readonly kinds: readonly string[];
  /** 建 / 改 Binding 时校验参数；返回问题描述，没问题是 null。 */
  validate(kind: string, params: Readonly<Record<string, unknown>>): string | null;
  /** 显示用：一行说明（如「每 15 分钟」）。 */
  describe(binding: ConnectorBinding): string;
  /** 触发周期（毫秒）；用来定「投进去多久没结束算超时」。没有周期的来源不填。 */
  periodMs?(binding: ConnectorBinding): number | null;
  start(ctx: InboundContext): { stop(): void };
}

export interface InboundContext {
  now(): number;
  /** 这个来源下启用中的 Binding。 */
  bindings(): Promise<readonly ConnectorBinding[]>;
  /** 先推进 next_run 再触发：只有 next_run 还是 expected 时才改成 next，返回是否抢到。 */
  advance(bindingId: string, expected: number | null, next: number): Promise<boolean>;
  emit(bindingId: string, event: InboundEvent): Promise<void>;
  skip(bindingId: string, event: Pick<InboundEvent, 'externalId' | 'plannedAt'>, reason: string): Promise<void>;
}
