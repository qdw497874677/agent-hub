import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { StatusPill } from './status.tsx';
import type { SessionLinkInfo } from './session-link-info.ts';
import { relativeTime } from '../shell/workers.tsx';

const PANEL_WIDTH = 288;
const GUTTER = 12;
const GAP = 8;
const MAX_HEIGHT = 320;

interface Position {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly maxHeight: number;
}

/**
 * 输入框上方那条「已连接会话」芯片：点名字先看小窗，再决定跳不跳。
 *
 * 小窗是贴着芯片的浮层，而不是 DialogShell 那样的全屏遮罩：
 * 用户此刻在看的是这条会话和输入框的相对位置，铺一层暗色反而把上下文抹掉了。
 * 只有「打开会话」才真正跳走。
 */
export function SessionLinkChip({
  info,
  open,
  onOpenChange,
  unlinkBusy,
  onOpenSession,
  onUnlink
}: {
  readonly info: SessionLinkInfo;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly unlinkBusy: boolean;
  readonly onOpenSession: (sessionId: string) => void;
  readonly onUnlink: (sessionId: string) => void;
}) {
  const trigger = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<Position | null>(null);
  // 首帧进过焦点没有：滚动重排会一直改 pos，不能每次都把人拽回主按钮。
  const entered = useRef(false);
  const panelId = `session-link-popover-${info.id}`;

  const close = (restoreFocus: boolean) => {
    onOpenChange(false);
    // 跳去另一条会话时不回焦：那边整页都换了，回焦只会闪一下。
    if (restoreFocus) trigger.current?.focus();
  };
  // 监听只挂一次，用 ref 取最新闭包，省得每次重渲染重挂。
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      // 触发按钮自己的点击交给 onClick 处理（那是开关），否则会「关掉又打开」。
      if (panel.current?.contains(target) || trigger.current?.contains(target)) return;
      closeRef.current(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current(true);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const anchor = trigger.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      // 手机上贴边不溢出：左右各留 GUTTER，宽度不超过屏宽减去两侧留白。
      const width = Math.min(PANEL_WIDTH, window.innerWidth - GUTTER * 2);
      const left = Math.min(Math.max(GUTTER, rect.left), Math.max(GUTTER, window.innerWidth - width - GUTTER));
      const height = panel.current?.offsetHeight ?? 0;
      const spaceAbove = rect.top - GAP - GUTTER;
      const spaceBelow = window.innerHeight - rect.bottom - GAP - GUTTER;
      // 芯片本来就在输入框上方，默认朝上；上方放不下才翻到下面，下方更挤就还是朝上并限高。
      const below = spaceAbove < Math.min(height, MAX_HEIGHT) && spaceBelow > spaceAbove;
      const room = Math.max(96, below ? spaceBelow : spaceAbove);
      const maxHeight = Math.min(MAX_HEIGHT, room);
      setPos({
        left,
        top: below ? rect.bottom + GAP : Math.max(GUTTER, rect.top - GAP - Math.min(height, maxHeight)),
        width,
        maxHeight
      });
    };
    place();
    window.addEventListener('resize', place);
    // 键盘弹出、聊天区滚动都会让锚点跑位：capture 才能接到内部滚动容器。
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      entered.current = false;
      return;
    }
    if (entered.current || pos === null) return;
    entered.current = true;
    const frame = requestAnimationFrame(() => {
      panel.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, pos]);

  // 浮层是 role=dialog：Tab 在两三个按钮之间打转，别顺着 DOM 走回背后的输入框。
  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab' || !panel.current) return;
    const stops = [...panel.current.querySelectorAll<HTMLElement>('button:not([disabled])')];
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    const inside = panel.current.contains(active);
    if (event.shiftKey && (active === first || !inside)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !inside)) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <span className="inline-flex max-w-full items-center rounded-full border border-hair bg-card-raised text-meta">
      <button
        ref={trigger}
        type="button"
        className="flex min-h-11 max-w-[14rem] items-center px-2.5 text-secondary hover:text-primary md:min-h-0 md:py-0.5"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={`${info.name}：查看会话信息`}
        onClick={() => (open ? close(true) : onOpenChange(true))}
      >
        <span className="min-w-0 truncate">{info.name}</span>
      </button>
      <button
        type="button"
        className="flex h-11 w-9 items-center justify-center rounded-full text-tertiary hover:text-rust disabled:opacity-40 md:h-auto md:w-auto md:px-1.5 md:py-0.5"
        aria-label={`断开 ${info.name}`}
        disabled={unlinkBusy}
        onClick={() => onUnlink(info.id)}
      >
        ×
      </button>
      {open
        ? createPortal(
            <div
              ref={panel}
              id={panelId}
              role="dialog"
              aria-label={`${info.name} 的会话信息`}
              data-testid="session-link-popover"
              onKeyDown={onPanelKeyDown}
              style={{
                left: pos?.left ?? GUTTER,
                top: pos?.top ?? GUTTER,
                width: pos?.width ?? PANEL_WIDTH,
                maxHeight: pos?.maxHeight ?? MAX_HEIGHT,
                // 首帧只用来量高度，量完立刻可见。
                visibility: pos ? 'visible' : 'hidden'
              }}
              className="fixed z-50 flex flex-col gap-1.5 overflow-y-auto overscroll-contain rounded-sm border border-strong bg-panel p-3 shadow"
            >
              <div className="flex items-start gap-1">
                <p className="min-w-0 flex-1 truncate pt-1 pr-1 text-body text-primary" title={info.name}>
                  {info.name}
                </p>
                <button
                  type="button"
                  className="-mr-2 -mt-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-sm text-body text-tertiary hover:text-primary md:h-9 md:w-9"
                  aria-label="关闭会话信息"
                  data-testid="session-link-popover-close"
                  onClick={() => close(true)}
                >
                  ×
                </button>
              </div>
              <div className="flex min-w-0 items-center gap-2 text-meta text-tertiary">
                <StatusPill status={info.status} lastSeq={info.lastSeq} />
                <span aria-hidden>·</span>
                <span className="truncate">最近活动 {relativeTime(info.updatedAt)}</span>
              </div>
              <p className="truncate text-meta text-secondary" title={info.runtime}>
                {info.runtime}
              </p>
              {info.preview ? (
                <p className="truncate text-meta text-tertiary" title={info.preview}>
                  {info.preview}
                </p>
              ) : null}
              {info.forkedFrom ? <p className="truncate text-meta text-sage">{info.forkedFrom}</p> : null}
              <div className="mt-1 flex flex-col gap-1.5 border-t border-hair pt-2">
                <button
                  type="button"
                  data-autofocus
                  data-testid="session-link-open"
                  className="flex min-h-11 w-full items-center justify-center rounded-sm bg-accent px-3 text-sub text-canvas hover:brightness-110"
                  onClick={() => {
                    onOpenChange(false);
                    onOpenSession(info.id);
                  }}
                >
                  打开会话
                </button>
                <button
                  type="button"
                  data-testid="session-link-unlink"
                  className="flex min-h-11 w-full items-center justify-center rounded-sm border border-hair px-3 text-sub text-secondary hover:border-strong hover:text-primary disabled:opacity-40"
                  disabled={unlinkBusy}
                  onClick={() => {
                    close(false);
                    onUnlink(info.id);
                  }}
                >
                  断开连接
                </button>
              </div>
            </div>,
            document.body
          )
        : null}
    </span>
  );
}
