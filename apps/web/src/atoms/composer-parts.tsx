import { Icon } from './icons.tsx';


/**
 * 能发时是 ↑；在跑时是 ■ 中断。在跑时写了字，旁边多一个「排队发送」：
 * 消息进队列，这一轮结束后自动发出（服务端本来就排队，这里只是把键盘之外的入口补上）。
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
  const box = size === 'sm' ? 'size-[44px] md:size-6' : 'size-[44px] md:size-7';
  const icon = size === 'sm' ? 13 : 15;
  if (running) {
    return (
      <span className="flex shrink-0 items-center gap-1.5">
        {/* 在跑时也能接着说：消息排进队列，这一轮结束后自动发出 */}
        {canSend ? (
          <button
            aria-label="排队发送"
            className={`grid ${box} shrink-0 place-items-center rounded-full border border-strong text-primary hover:bg-hover`}
            title="排队发送：先交给服务器等待投递（⌘↵）"
            onClick={onSend}
          >
            <Icon name="queue" size={icon} />
          </button>
        ) : null}
        <button
          aria-label="中断"
          className={`grid ${box} shrink-0 place-items-center rounded-full border border-danger/70 text-danger hover:bg-danger/15`}
          title="中断"
          onClick={onInterrupt}
        >
          <Icon name="stop" size={icon - 2} />
        </button>
      </span>
    );
  }
  return (
    <button
      aria-label="发送"
      className={`grid ${box} shrink-0 place-items-center rounded-full bg-action text-action-fg hover:bg-action/90 disabled:bg-hair disabled:text-tertiary`}
      title="发送（⌘↵）"
      disabled={!canSend}
      onClick={onSend}
    >
      <Icon name="arrow-up" size={icon} />
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
