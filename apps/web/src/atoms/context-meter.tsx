import type { ContextUsage } from './live-core.ts';

/** 12_345 → 12.3K；给窄地方用的短数字。 */
export function shortTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(tokens);
}

/**
 * 当前会话的上下文占用（运行时 `context_usage` 事件）。
 * 参考 opencode web：贴着输入框显示，不打断对话；手机上只留百分比。
 */
export function ContextMeter({ usage }: { usage: ContextUsage }) {
  const rawPercent =
    usage.percent ??
    (usage.usedTokens === null || usage.windowTokens <= 0 ? null : (usage.usedTokens / usage.windowTokens) * 100);
  const percent = rawPercent === null ? null : Math.max(0, Math.min(100, Math.round(rawPercent)));
  const used = usage.usedTokens === null ? '—' : shortTokens(usage.usedTokens);
  const window = shortTokens(usage.windowTokens);
  const title = `上下文：${usage.usedTokens?.toLocaleString() ?? '—'} / ${usage.windowTokens.toLocaleString()} token${percent === null ? '' : `（${percent}%）`}`;
  const tone = percent !== null && percent >= 95 ? 'text-rust' : percent !== null && percent >= 70 ? 'text-accent' : 'text-tertiary';
  return (
    <span
      data-testid="context-meter"
      title={title}
      aria-label={title}
      className={`shrink-0 font-mono text-meta ${tone}`}
    >
      <span className="hidden sm:inline">上下文 {used}/{window}</span>
      <span className="sm:hidden">{percent === null ? '…' : `${percent}%`}</span>
      {percent !== null ? <span className="hidden sm:inline"> · {percent}%</span> : null}
    </span>
  );
}
