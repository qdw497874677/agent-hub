import { useId, useState } from 'react';
import type { ContextUsage } from './live-core.ts';
import {
  clampArc,
  contextAriaLabel,
  contextPercent,
  contextTitle,
  contextTone,
  meterValue,
  percentLabel,
  shortTokens,
  type ContextTone
} from './context-meter.ts';

export { shortTokens } from './context-meter.ts';

/* -- 上下文用量 ---------------------------------------------------------------
 * 一行文字太钝：0.4% 和 0% 长得一样，快满了也只是一串数字。
 * 这里是一枚 20px 的环（塞得进输入框上方那一行）+ 悬停 / 点开的一张细条卡片：
 * 环给一眼能读的「还剩多少」，卡片给「已用多少、上限多少」。
 * 环和条都只用原生 SVG / span，没有新依赖。
 * --------------------------------------------------------------------------- */

const RING_SIZE = 20;
const RING_STROKE = 2.5;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/** 环和条用同一套语气的颜色：正常灰、快满琥珀、满了锈红。 */
const ARC: Record<ContextTone, string> = {
  normal: 'stroke-secondary',
  warn: 'stroke-warning',
  danger: 'stroke-rust'
};
const FILL: Record<ContextTone, string> = {
  normal: 'bg-secondary',
  warn: 'bg-warning',
  danger: 'bg-rust'
};
const TEXT: Record<ContextTone, string> = {
  normal: 'text-tertiary',
  warn: 'text-warning',
  danger: 'text-rust'
};

/**
 * 当前会话的上下文占用（运行时 `context_usage` 事件）。
 * 环常驻；hover / 键盘 focus 或点一下展开细条，手机上点按同样可达。
 */
export function ContextMeter({ usage }: { usage: ContextUsage }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const percent = contextPercent(usage);
  const tone = contextTone(percent);
  const arc = clampArc(percent);
  const label = percentLabel(percent);
  const used = usage.usedTokens === null ? '—' : shortTokens(usage.usedTokens);
  const window = shortTokens(usage.windowTokens);
  const remaining = usage.usedTokens === null ? null : shortTokens(Math.max(usage.windowTokens - usage.usedTokens, 0));
  const title = contextTitle(usage, percent);
  const description = contextAriaLabel(usage, percent);

  return (
    <span
      className="group relative inline-flex shrink-0 items-center"
      data-testid="context-meter"
      data-tone={tone}
      title={title}
      onBlur={(event) => {
        // 点别处（或从键盘走开）就收起；面板只是看一眼，不需要常驻。
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        type="button"
        className="flex items-center gap-1.5 rounded-full pr-0.5 text-meta focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        aria-expanded={open}
        aria-controls={panelId}
        data-testid="context-meter-toggle"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          setOpen(false);
          // 键盘 focus 本身也算「展开」（group-has-[:focus-visible]）：不 blur 的话
          // 一按 Escape 就会被 focus-visible 立刻顶回来，看着像没关。
          event.currentTarget.blur();
        }}
      >
        <span
          role="meter"
          aria-label={description}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={meterValue(percent)}
          aria-valuetext={label}
          className="inline-flex shrink-0"
          data-testid="context-ring"
        >
          <svg aria-hidden="true" className="-rotate-90 block" width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}>
            <circle className="stroke-border" cx={RING_SIZE / 2} cy={RING_SIZE / 2} r={RING_RADIUS} fill="none" strokeWidth={RING_STROKE} />
            <circle
              className={`${ARC[tone]} transition-[stroke-dashoffset] duration-300 ease-out motion-reduce:transition-none`}
              cx={RING_SIZE / 2}
              cy={RING_SIZE / 2}
              r={RING_RADIUS}
              fill="none"
              strokeWidth={RING_STROKE}
              strokeLinecap="round"
              strokeDasharray={RING_LENGTH}
              strokeDashoffset={RING_LENGTH * (1 - arc)}
            />
          </svg>
        </span>
        <span className={`hidden font-mono sm:inline ${TEXT[tone]}`}>
          上下文 {used}/{window}
        </span>
        <span className={`font-mono tabular-nums ${TEXT[tone]}`}>
          {percent === null ? '…' : label}
        </span>
      </button>

      {/* 细条：面板本身不吃点击（纯信息），展开与否只看 hover / focus / 点按。 */}
      <span
        id={panelId}
        data-testid="context-bar"
        data-open={open}
        aria-hidden={!open}
        className="pointer-events-none invisible absolute right-0 bottom-full z-20 mb-1.5 w-52 rounded-[var(--radius-overlay)] border border-hair bg-overlay px-2.5 py-2 opacity-0 shadow-overlay transition-opacity duration-150 group-hover:visible group-hover:opacity-100 group-has-[:focus-visible]:visible group-has-[:focus-visible]:opacity-100 data-[open=true]:visible data-[open=true]:opacity-100 motion-reduce:transition-none"
      >
        <span className="flex items-baseline justify-between gap-3 text-meta">
          <span className="text-tertiary">上下文</span>
          <span className={`font-mono tabular-nums ${TEXT[tone]}`}>{percent === null ? '—' : label}</span>
        </span>
        <span className="mt-1.5 block h-1 w-full overflow-hidden rounded-full bg-border">
          <span className={`block h-full rounded-full ${FILL[tone]}`} style={{ width: `${arc * 100}%` }} />
        </span>
        <span className="mt-1.5 flex items-baseline justify-between gap-3 text-meta text-tertiary">
          <span>
            已用 <span className="font-mono tabular-nums text-secondary">{used}</span>
          </span>
          <span>
            上限 <span className="font-mono tabular-nums">{window}</span>
          </span>
        </span>
        {remaining === null ? null : (
          <span className="mt-0.5 block text-meta text-tertiary">
            还剩 <span className="font-mono tabular-nums">{remaining}</span>
          </span>
        )}
      </span>
    </span>
  );
}
