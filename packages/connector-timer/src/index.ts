import type { ConnectorBinding, InboundContext, InboundSource } from '@agent-hub/domain';

/** 内置 timer 入站连接器（ADR 0032 R1，照 Hermes 的做法）：先推进 next_run 再触发；宽限 = 半个周期，只补跑最近一次。 */
export const TIMER_MIN_EVERY_MIN = 5;
export const TIMER_DEFAULT_EVERY_MIN = 15;
const MIN = 60_000;

export const everyMs = (params: Readonly<Record<string, unknown>>): number => {
  const n = typeof params.everyMin === 'number' ? Math.floor(params.everyMin) : TIMER_DEFAULT_EVERY_MIN;
  return Math.max(TIMER_MIN_EVERY_MIN, n) * MIN;
};

export type TimerPlan =
  | { readonly action: 'claim'; readonly next: number }
  | { readonly action: 'wait' }
  | { readonly action: 'fire' | 'skip'; readonly next: number; readonly slot: number; readonly catchup: boolean; readonly missed: number };

/** 纯函数：给 next_run、周期和当前时刻，决定做什么。 */
export function planFire(nextRunAt: number | null, period: number, now: number): TimerPlan {
  if (nextRunAt === null) return { action: 'claim', next: now + period };
  if (now < nextRunAt) return { action: 'wait' };
  const k = Math.floor((now - nextRunAt) / period);
  const slot = nextRunAt + k * period;
  const next = slot + period;
  const late = now - slot;
  return { action: late <= period / 2 ? 'fire' : 'skip', next, slot, catchup: late > MIN, missed: k };
}

export async function timerTick(ctx: InboundContext): Promise<void> {
  return tick(ctx);
}

const tick = async (ctx: InboundContext) => {
    const now = ctx.now();
    for (const b of await ctx.bindings()) {
      if (!b.enabled || b.pausedReason) continue;
      const prompt = typeof b.params.prompt === 'string' ? b.params.prompt : '';
      const plan = planFire(b.nextRunAt, everyMs(b.params), now);
      if (plan.action === 'wait') continue;
      if (plan.action === 'claim') { await ctx.advance(b.id, null, plan.next); continue; }
      if (!(await ctx.advance(b.id, b.nextRunAt, plan.next))) continue; // 别人抢到了
      if (plan.missed > 0) await ctx.skip(b.id, { externalId: `missed-${b.nextRunAt}`, plannedAt: b.nextRunAt ?? undefined }, `错过 ${plan.missed} 次（hub 不在线），只补最近一次`);
      if (plan.action === 'skip') { await ctx.skip(b.id, { externalId: String(plan.slot), plannedAt: plan.slot }, '超出宽限（半个周期），不补跑'); continue; }
      await ctx.emit(b.id, { kind: 'tick', externalId: String(plan.slot), plannedAt: plan.slot, catchup: plan.catchup, title: b.name, text: prompt || `定时唤醒：${b.name}` });
    }
};

export function createTimerSource(opts: { readonly intervalMs?: number } = {}): InboundSource {
  return {
    id: 'timer',
    kinds: ['tick'],
    validate(kind, params) {
      if (kind !== 'tick') return '定时器只有 tick';
      if (params.everyMin !== undefined && (typeof params.everyMin !== 'number' || !Number.isFinite(params.everyMin))) return 'everyMin 要是数字';
      if (typeof params.everyMin === 'number' && params.everyMin < TIMER_MIN_EVERY_MIN) return `最短 ${TIMER_MIN_EVERY_MIN} 分钟`;
      if (typeof params.everyMin === 'number' && params.everyMin > 7 * 24 * 60) return '最长 7 天';
      if (typeof params.prompt !== 'string' || !params.prompt.trim()) return '要写唤醒时对 bot 说什么';
      if (params.prompt.length > 4000) return '唤醒内容太长（最多 4000 字）';
      return null;
    },
    describe: (b: ConnectorBinding) => `每 ${everyMs(b.params) / MIN} 分钟`,
    periodMs: (b: ConnectorBinding) => everyMs(b.params),
    start(ctx) {
      let busy = false;
      const run = () => {
        if (busy) return;
        busy = true;
        tick(ctx).catch((e) => console.error('[timer] tick 失败', e)).finally(() => { busy = false; });
      };
      const handle = setInterval(run, opts.intervalMs ?? 15_000);
      handle.unref?.();
      run();
      return { stop: () => clearInterval(handle) };
    }
  };
}

