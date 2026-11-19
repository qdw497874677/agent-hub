import type { ContextUsage } from './live-core.ts';

/** 12_345 → 12.3K；给窄地方用的短数字。 */
export function shortTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(tokens);
}

/**
 * 占用的三种语气：正常 / 快满 / 满了。
 * 阈值只有一处（70 / 95），环、条、文字都从这里取。
 */
export type ContextTone = 'normal' | 'warn' | 'danger';

/** 运行时没报 percent 时按 used/window 现算；两者都没有（或窗口为 0）就是 null。 */
export function contextPercent(usage: ContextUsage): number | null {
  const raw =
    usage.percent ??
    (usage.usedTokens === null || usage.windowTokens <= 0 ? null : (usage.usedTokens / usage.windowTokens) * 100);
  if (raw === null || !Number.isFinite(raw)) return null;
  // 超限照实保留（>100），只把负数和 NaN 归零。
  return Math.max(0, raw);
}

/** 超过 95 就是 danger，超过 70 是 warn；还没数据算正常。 */
export function contextTone(percent: number | null): ContextTone {
  if (percent === null) return 'normal';
  if (percent >= 95) return 'danger';
  if (percent >= 70) return 'warn';
  return 'normal';
}

/** 弧只能用一整圈的 0–1：超限时停在整圈，数字继续涨。 */
export function clampArc(percent: number | null): number {
  if (percent === null || !Number.isFinite(percent)) return 0;
  return Math.min(Math.max(percent, 0), 100) / 100;
}

/**
 * 显示用的整数百分比。两条规矩和四舍五入不一样：
 * - 用了但不到一个点，写 `<1%`——写 `0%` 会读成「什么都没带」；
 * - 没满就不许写成 `100%`，99.6 也停在 99。
 */
function displayPercent(percent: number): number {
  const rounded = Math.round(percent);
  return percent < 100 && rounded >= 100 ? 99 : rounded;
}

/** `42%` / `<1%` / `118%`（超限照实涨）；还没数据时是 `—`。 */
export function percentLabel(percent: number | null): string {
  if (percent === null || !Number.isFinite(percent)) return '—';
  if (percent > 0 && percent < 1) return '<1%';
  return `${displayPercent(percent)}%`;
}

/**
 * `aria-valuenow`：和文案里的数字保持一致（0–100，超限封顶 100）。
 * `<1%` 报 1，读屏才不会和「0%」混在一起。
 */
export function meterValue(percent: number | null): number {
  if (percent === null || !Number.isFinite(percent)) return 0;
  if (percent > 0 && percent < 1) return 1;
  return Math.max(0, Math.min(100, displayPercent(percent)));
}

/** 悬停 / 标题里的一行：`上下文：84,000 / 200,000 token（42%）`。 */
export function contextTitle(usage: ContextUsage, percent: number | null): string {
  const used = usage.usedTokens === null ? '—' : usage.usedTokens.toLocaleString();
  const window = usage.windowTokens.toLocaleString();
  return `上下文：${used} / ${window} token${percent === null ? '' : `（${percentLabel(percent)}）`}`;
}

/** 读屏的一句话：`上下文已用 42%，84K / 200K`。 */
export function contextAriaLabel(usage: ContextUsage, percent: number | null): string {
  const window = shortTokens(usage.windowTokens);
  if (percent === null) return `上下文用量未知，上限 ${window}`;
  const used = usage.usedTokens === null ? '—' : shortTokens(usage.usedTokens);
  return `上下文已用 ${percentLabel(percent)}，${used} / ${window}`;
}
