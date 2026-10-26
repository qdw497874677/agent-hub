

/**
 * 一个圆点，两种身份：能发时是 ↑，在跑时是 ■。
 *
 * 不并排放两个按钮——运行中同时摆着「↑ 发送」和「■ 中断」，人得先读字才知道按哪个；
 * 而这两件事本来就互斥（参考 opencode web 的做法）。
 */
export function ActionDot({
  running,
  canSend,
  onSend,
  onInterrupt,
  size
}: {
  running: boolean;
  canSend: boolean;
  onSend: () => void;
  onInterrupt: () => void;
  size: 'sm' | 'md';
}) {
  const box = size === 'sm' ? 'size-6 text-meta' : 'size-9 text-sub md:size-7';
  if (running) {
    return (
      <button
        aria-label="中断"
        className={`grid ${box} shrink-0 place-items-center rounded-full border border-rust text-rust hover:bg-rust/15`}
        title="中断"
        onClick={onInterrupt}
      >
        ■
      </button>
    );
  }
  return (
    <button
      aria-label="发送"
      className={`grid ${box} shrink-0 place-items-center rounded-full bg-accent text-canvas hover:brightness-110 disabled:opacity-30`}
      title="发送（⌘↵）"
      disabled={!canSend}
      onClick={onSend}
    >
      ↑
    </button>
  );
}

/** 机器离线时压在输入框上方的一行：说清楚为什么发不了，而不是让圆点默默变灰。 */
export function OfflineNotice({ text, compact = false }: { text: string | null; compact?: boolean }) {
  if (text === null) return null;
  return (
    <p role="status" className={`mb-1 flex items-center gap-1.5 text-meta text-rust ${compact ? 'truncate' : ''}`} title={text}>
      <span aria-hidden className="block size-[7px] shrink-0 rounded-full bg-rust" />
      <span className={compact ? 'truncate' : ''}>{text}</span>
    </p>
  );
}
