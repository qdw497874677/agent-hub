import { useEffect, useRef, useState } from 'react';

import { GROUP_EMOJI, mineOf, type GroupReaction, type MyName } from './group-live.ts';

/**
 * 一条帖子下面的反应条：已有的票 + 一个「＋」。
 *
 * 不碰网络：点一下只告诉外面「哪个表情」，请求和乐观更新都在 messages.tsx。
 * 也不判「我该加还是该撤」——`mineOf` 只用来上色。
 */
export function ReactionBar({
  reactions,
  me,
  error,
  align = 'start',
  onToggle
}: {
  readonly reactions: readonly GroupReaction[];
  readonly me: MyName;
  readonly error?: string | null;
  /** 面板往哪边展开：自己的气泡靠右，面板也得靠右，否则会顶出手机屏。 */
  readonly align?: 'start' | 'end';
  readonly onToggle: (emoji: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // 点面板外面 / 按 Esc 收起：手机上滑一下就走，不用再点一次「＋」
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (emoji: string) => {
    setOpen(false);
    onToggle(emoji);
  };

  return (
    <div className="flex flex-wrap items-center gap-1" data-testid="group-reactions">
      {reactions.map((reaction) => {
        const mine = mineOf(reaction, me);
        const count = reaction.actors.length;
        return (
          <button
            key={reaction.emoji}
            type="button"
            data-testid="group-reaction"
            data-emoji={reaction.emoji}
            data-mine={mine ? 'true' : 'false'}
            aria-pressed={mine}
            aria-label={`${reaction.emoji} ${count} 人${mine ? '，含你' : ''}`}
            className={`flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-meta transition-colors ${
              mine
                ? 'border-fg/40 bg-selected text-primary'
                : 'border-hair bg-card text-tertiary hover:border-strong hover:text-primary'
            }`}
            onClick={() => pick(reaction.emoji)}
          >
            <span aria-hidden>{reaction.emoji}</span>
            <span className="tabular-nums">{count}</span>
          </button>
        );
      })}
      <div className="relative" ref={box}>
        <button
          type="button"
          data-testid="group-react-open"
          aria-label="加表情"
          aria-expanded={open}
          className={`flex h-6 w-6 items-center justify-center rounded-full border text-meta leading-none transition-colors ${
            open ? 'border-fg/40 bg-selected text-primary' : 'border-hair text-tertiary hover:border-strong hover:text-primary'
          }`}
          onClick={() => setOpen((v) => !v)}
        >
          ＋
        </button>
        {open ? (
          <div
            data-testid="group-emoji-panel"
            className={`absolute top-full z-30 mt-1 flex gap-0.5 rounded-lg border border-strong bg-overlay p-1 shadow-overlay ${align === 'end' ? 'right-0' : 'left-0'}`}
          >
            {GROUP_EMOJI.map((emoji) => (
              <button
                key={emoji}
                type="button"
                data-testid="group-emoji"
                data-emoji={emoji}
                aria-label={`回应 ${emoji}`}
                className="flex h-8 w-8 items-center justify-center rounded-sm text-[16px] leading-none hover:bg-card-raised"
                onClick={() => pick(emoji)}
              >
                {emoji}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {error ? (
        <span data-testid="group-react-error" className="text-meta text-rust">
          {error}
        </span>
      ) : null}
    </div>
  );
}
