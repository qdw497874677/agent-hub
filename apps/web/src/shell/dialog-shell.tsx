import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react';
import { createPortal } from 'react-dom';
import { useNarrow } from './device.ts';
import { useModalFocus } from './focus-trap.ts';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
/** 进来稍慢读得出「面板抬起来了」，出去快一点不拖沓。 */
const SHEET_IN_MS = 240;
const SHEET_OUT_MS = 200;
const SHEET_EASE = 'cubic-bezier(0.2,0.8,0.2,1)';
/** 往下拖过这么远就关（或收起）；没到就弹回去。 */
const DISMISS_AFTER_PX = 80;
/** 手指/鼠标抖一两像素不算拖动，否则轻点把手会被当成拖拽。 */
const DRAG_SLOP_PX = 4;
/** 抽屉最高到屏幕的 3/4；再高就顶到刘海了（safe-top 之外再留 16px 喘气）。 */
const SHEET_MAX_H = 'max-h-[min(75dvh,calc(100dvh_-_env(safe-area-inset-top)_-_16px))]';
/** 贴底但仍在流里的内联抽屉：别一口吃掉整个页签。 */
const INLINE_MAX_H = 'max-h-[70dvh]';

/** 抽屉里的左右内边距：落到刘海/圆角屏两侧时也别贴着边。 */
const SAFE_PADDING: CSSProperties = {
  paddingLeft: 'max(0.75rem, env(safe-area-inset-left))',
  paddingRight: 'max(0.75rem, env(safe-area-inset-right))',
  paddingBottom: 'max(1rem, env(safe-area-inset-bottom))'
};

function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(REDUCED_MOTION);
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    },
    () => window.matchMedia(REDUCED_MOTION).matches,
    () => false
  );
}

/**
 * 抽屉的进出、拖拽关闭、Esc、焦点进出都收在这里，Sheet 和内联版共用一套手势阈值。
 * 拖动时直接跟手（关掉 transition），松手要么关、要么弹回。
 */
function useSheetMotion(onClose: () => void, suspended = false) {
  const reduced = useReducedMotion();
  const [entered, setEntered] = useState(false);
  const [closing, setClosing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [offset, setOffset] = useState(0);
  // 入场动画结束后把 transform 去掉：`transform` 会让后代的 `position: fixed` 以抽屉为参照，
  // 目录选择器这类「全屏」浮层就会变成抽屉大小（390×632 而不是 390×844）。
  const [settled, setSettled] = useState(false);
  const offsetRef = useRef(0);
  const dragRef = useRef<{ pointerId: number; from: number } | null>(null);
  const movedRef = useRef(false);
  const closingRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // 定时器和事件监听里用最新的 onClose，别抱着第一帧那个闭包
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (reduced) {
      setEntered(true);
      return;
    }
    // 两帧：先让「在屏幕下面」这一帧真的画出来，再切到 0，transition 才会跑
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setEntered(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [reduced]);

  // 打开时把焦点交给面板（读屏从抽屉开头念），关掉还给触发它的那个按钮
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (panel && !panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(frame);
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (previous?.isConnected === true) previous.focus({ preventScroll: true });
    };
  }, []);

  function requestClose() {
    if (closingRef.current) return;
    closingRef.current = true;
    if (reduced) {
      closeRef.current();
      return;
    }
    offsetRef.current = 0;
    setOffset(0);
    setDragging(false);
    setClosing(true);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      closeRef.current();
    }, SHEET_OUT_MS);
  }

  useEffect(() => {
    if (suspended) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      requestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // requestClose 只读 ref 和 setState，闭包不会过期
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suspended]);

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (closingRef.current) return;
    dragRef.current = { pointerId: event.pointerId, from: event.clientY };
    movedRef.current = false;
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const delta = event.clientY - drag.from;
    if (Math.abs(delta) > DRAG_SLOP_PX) movedRef.current = true;
    // 只跟往下的方向；往上拖没有东西可露出来
    offsetRef.current = Math.max(0, delta);
    setOffset(offsetRef.current);
  };

  const onPointerEnd = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (offsetRef.current > DISMISS_AFTER_PX) {
      requestClose();
      return;
    }
    offsetRef.current = 0;
    setOffset(0);
  };

  const onPointerCancel = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    offsetRef.current = 0;
    setOffset(0);
  };

  // 轻点把手（没拖动）也关；拖动之后浏览器还会补一个 click，得吞掉
  const onGrabberClick = () => {
    if (movedRef.current) {
      movedRef.current = false;
      return;
    }
    requestClose();
  };

  const open = entered && !closing;
  useEffect(() => {
    if (!open) {
      setSettled(false);
      return;
    }
    if (reduced) {
      setSettled(true);
      return;
    }
    const timer = window.setTimeout(() => setSettled(true), SHEET_IN_MS);
    return () => window.clearTimeout(timer);
  }, [open, reduced]);

  const translate = open ? (dragging ? `${offset}px` : '0px') : '100%';
  const style: CSSProperties = {
    transform: open && settled && !dragging ? undefined : `translateY(${translate})`,
    transition: dragging || reduced ? 'none' : `transform ${closing ? SHEET_OUT_MS : SHEET_IN_MS}ms ${SHEET_EASE}`
  };

  return {
    panelRef,
    open,
    style,
    requestClose,
    grabberProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: onPointerEnd,
      onPointerCancel,
      onClick: onGrabberClick
    }
  };
}

/**
 * 模态底部抽屉：窄屏贴底、占满宽度、上圆角、带安全区；遮罩、Esc、拖把手都能关。
 * 内容区默认是唯一会滚的东西，footer 交出去就常驻在底部（和桌面版一个语义）。
 */
export function Sheet({
  title,
  onClose,
  children,
  footer,
  testId,
  scroll = true,
  zClassName = 'z-50',
  maxHeightClassName = SHEET_MAX_H,
  panelClassName = '',
  overlay,
  suspended = false
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** 常驻底栏；给了它内容区才自己滚。 */
  footer?: ReactNode;
  testId?: string;
  /** 内容交给抽屉包一层滚动区（默认），还是内容自己管滚动。 */
  scroll?: boolean;
  /** 抽屉永远在别的浮层之上：模型选择器在对话框里打开时要用 z-[60]。 */
  zClassName?: string;
  maxHeightClassName?: string;
  panelClassName?: string;
  /** 贴在面板右上角的东西，比如宽弹窗的关闭按钮。 */
  overlay?: ReactNode;
  /** 被全屏设置遮住时保留抽屉状态，但不和上层抢焦点或 Esc。 */
  suspended?: boolean;
}) {
  const motion = useSheetMotion(onClose, suspended);
  // 进框和还焦点 useSheetMotion 已经做了；这里只补「Tab 不出框」
  useModalFocus(motion.panelRef, { initial: false, restore: false });
  return createPortal(
    <div className={`fixed inset-0 overflow-hidden ${zClassName}`} hidden={suspended} inert={suspended}>
      <div
        data-testid="dialog-scrim"
        aria-hidden
        className={`absolute inset-0 bg-black/55 transition-opacity duration-[240ms] motion-reduce:transition-none ${
          motion.open ? 'opacity-100' : 'opacity-0'
        }`}
        onClick={motion.requestClose}
      />
      <div
        data-testid="dialog-sheet"
        style={motion.style}
        className={`absolute inset-x-0 bottom-0 flex w-full flex-col overflow-hidden rounded-t-[16px] border-t border-strong bg-overlay shadow-overlay ${maxHeightClassName} ${panelClassName}`}
      >
        <div
          ref={motion.panelRef}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          tabIndex={-1}
          data-testid={testId}
          className="flex min-h-0 flex-1 flex-col outline-none"
        >
          {/* 28px 的把手区：够手指按住，又不抢内容的地方。放在 dialog 里面，读屏和键盘也够得着。 */}
          <button
            type="button"
            data-testid="dialog-grabber"
            aria-label={`收起${title}`}
            className="flex h-[28px] w-full shrink-0 cursor-grab touch-none items-center justify-center active:cursor-grabbing"
            {...motion.grabberProps}
          >
            <span aria-hidden className="h-[4px] w-[32px] rounded-full bg-strong" />
          </button>
          {scroll ? (
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" style={SAFE_PADDING}>
              {children}
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">{children}</div>
          )}
          {footer === undefined ? null : (
            <div
              data-testid={testId === undefined ? undefined : `${testId}-footer`}
              className="shrink-0 border-t border-hair bg-overlay px-4 pt-2 shadow-[0_-10px_18px_-14px_rgba(0,0,0,0.55)] pb-[max(0.75rem,env(safe-area-inset-bottom))]"
            >
              {footer}
            </div>
          )}
        </div>
        {overlay}
      </div>
    </div>,
    document.body
  );
}

/**
 * 内联贴底抽屉：在页签/分栏里面用，没有遮罩、不抢焦点、也不吃会话。
 * 把手点一下或往下拖 80px 就收起，再点一下展开；高度上限 70dvh，剩下的空间留给别的东西。
 */
export function InlineSheet({
  title,
  children,
  testId,
  maxHeightClassName = INLINE_MAX_H
}: {
  title: string;
  children: ReactNode;
  testId?: string;
  maxHeightClassName?: string;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [offset, setOffset] = useState(0);
  const offsetRef = useRef(0);
  const dragRef = useRef<{ pointerId: number; from: number } | null>(null);
  const movedRef = useRef(false);
  const bodyId = useId();

  const collapse = (next: boolean) => {
    offsetRef.current = 0;
    setOffset(0);
    setCollapsed(next);
  };

  return (
    <div data-testid={testId} className="flex min-h-0 flex-1 flex-col justify-end">
      <section
        aria-label={title}
        data-testid="dialog-sheet"
        style={{
          transform: offset === 0 ? undefined : `translateY(${offset}px)`,
          transition: offset === 0 ? `transform ${SHEET_OUT_MS}ms ${SHEET_EASE}` : 'none'
        }}
        className={`flex w-full flex-col overflow-hidden rounded-t-[16px] border-t border-strong bg-overlay shadow-overlay ${
          collapsed ? '' : maxHeightClassName
        }`}
      >
        <button
          type="button"
          data-testid="dialog-grabber"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          aria-label={collapsed ? `展开${title}` : `收起${title}`}
          className="flex h-[28px] w-full shrink-0 touch-none items-center justify-center gap-1.5 text-[11px] text-tertiary"
          onPointerDown={(event) => {
            if (event.pointerType === 'mouse' && event.button !== 0) return;
            dragRef.current = { pointerId: event.pointerId, from: event.clientY };
            movedRef.current = false;
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (drag === null || drag.pointerId !== event.pointerId) return;
            const delta = event.clientY - drag.from;
            if (Math.abs(delta) > DRAG_SLOP_PX) movedRef.current = true;
            offsetRef.current = Math.max(0, delta);
            setOffset(offsetRef.current);
          }}
          onPointerUp={(event) => {
            const drag = dragRef.current;
            if (drag === null || drag.pointerId !== event.pointerId) return;
            dragRef.current = null;
            if (offsetRef.current > DISMISS_AFTER_PX) {
              collapse(true);
              return;
            }
            offsetRef.current = 0;
            setOffset(0);
          }}
          onPointerCancel={() => {
            dragRef.current = null;
            offsetRef.current = 0;
            setOffset(0);
          }}
          onClick={() => {
            if (movedRef.current) {
              movedRef.current = false;
              return;
            }
            collapse(!collapsed);
          }}
        >
          <span aria-hidden className="h-[4px] w-[32px] rounded-full bg-strong" />
          {/* 收起后只剩一条把手太没头没脑，补个名字 */}
          {collapsed ? <span>{title}</span> : null}
        </button>
        <div id={bodyId} className={`flex min-h-0 flex-1 flex-col ${collapsed ? 'hidden' : ''}`}>
          {children}
        </div>
      </section>
    </div>
  );
}

/**
 * 对话框共用的壳：遮罩点一下或按 Esc 就关；窄屏上贴底（拇指够得着），宽屏居中。
 * role=dialog + aria-modal，读屏能知道背后的画布暂时不可操作。
 *
 * 给了 footer 就成了「粘底」结构：标题/内容区自己滚，footer 常驻在面板底部。
 * 手机上内容再长，取消/开始也不会被滚出去或被浏览器工具栏挤掉（安全区由抽屉/遮罩兜住）。
 *
 * `sheet`（默认开）只影响窄屏：走 Sheet，贴底 + 上圆角 + 把手拖拽关闭。
 * 两种形态都是真模态：焦点进框、Tab 不出框、关掉还焦点（见 focus-trap.ts）。
 */
export function DialogShell({
  title,
  onClose,
  children,
  footer,
  wide = false,
  testId,
  sheet = true
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** 常驻底部的操作区（取消/开始这类）。有它时内容区自己滚动，footer 不跟着滚。 */
  footer?: ReactNode;
  /** 放 diff、文件这类宽内容：更宽，且内容区自己滚动。 */
  wide?: boolean;
  /** 面板上的 data-testid：弹窗自己的名字，别拿标题去猜。 */
  testId?: string;
  /** 窄屏是否用底部抽屉。默认开；想保留旧的「浮在中间的卡片」就传 false。 */
  sheet?: boolean;
}) {
  const narrow = useNarrow();
  const sheetMode = sheet && narrow;

  if (sheetMode) {
    return (
      <Sheet
        title={title}
        onClose={onClose}
        testId={testId}
        footer={footer}
        scroll={footer === undefined}
        overlay={
          wide ? (
            <button
              aria-label="关闭"
              className="absolute right-2 top-8 flex h-10 w-10 items-center justify-center rounded-sm text-body text-tertiary hover:text-primary"
              onClick={onClose}
            >
              ×
            </button>
          ) : undefined
        }
      >
        {footer === undefined ? (
          children
        ) : (
          // 唯一会滚的东西：内容。min-h-0 让 flex 子项真的能缩下去，不然它会把 footer 顶出面板。
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" style={SAFE_PADDING}>
            {children}
          </div>
        )}
      </Sheet>
    );
  }

  return (
    <DesktopDialog title={title} onClose={onClose} footer={footer} wide={wide} testId={testId}>
      {children}
    </DesktopDialog>
  );
}

/**
 * 宽屏居中的模态框。焦点规矩见 useModalFocus：打开时焦点进框（面板本身，下一下 Tab 是第一个控件），
 * Tab / Shift+Tab 在框里循环，Esc 只关最上面那一层，关掉后焦点回到打开它的按钮。
 */
function DesktopDialog({
  title,
  onClose,
  children,
  footer,
  wide,
  testId
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide: boolean;
  testId?: string;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const isTop = useModalFocus(panelRef);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isTop()) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, isTop]);

  // portal 到 body：画布里带 transform 的祖先会把 fixed 的参照系换掉，留在原地弹窗就会被裁。
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/55 backdrop-blur-[2px] px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:items-center sm:pb-0"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        data-testid={testId}
        className={`w-full rounded-overlay border border-strong bg-overlay shadow-overlay outline-none ${
          footer === undefined
            ? `p-4 ${wide ? 'relative flex max-h-[88dvh] max-w-[820px] flex-col' : 'max-h-[88dvh] max-w-[420px] overflow-y-auto overscroll-contain'}`
            : `relative flex max-h-[88dvh] flex-col overflow-hidden ${wide ? 'max-w-[820px]' : 'max-w-[420px]'}`
        }`}
        onClick={(event) => event.stopPropagation()}
      >
        {wide ? (
          <button
            aria-label="关闭"
            className="absolute right-2 top-2 flex h-11 w-11 items-center justify-center rounded-sm text-body text-tertiary hover:text-primary"
            onClick={onClose}
          >
            ×
          </button>
        ) : null}
        {footer === undefined ? (
          children
        ) : (
          <>
            {/* 唯一会滚的东西：内容。min-h-0 让 flex 子项真的能缩下去，不然它会把 footer 顶出面板。 */}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">{children}</div>
            <div
              data-testid={testId === undefined ? undefined : `${testId}-footer`}
              className="shrink-0 border-t border-hair bg-overlay px-4 pb-3 pt-2 shadow-[0_-10px_18px_-14px_rgba(0,0,0,0.55)]"
            >
              {footer}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}

export const INPUT =
  'min-h-11 w-full rounded-control border border-hair bg-card px-2.5 py-2 text-body text-primary outline-none placeholder:text-tertiary focus:border-ring disabled:text-tertiary md:min-h-0';
export const SECONDARY_BUTTON =
  'min-h-[44px] rounded-control border border-strong px-3 py-1.5 text-sub text-primary hover:bg-hover md:min-h-0';
export const PRIMARY_BUTTON = 'min-h-[44px] rounded-control bg-action px-3 py-1.5 text-sub font-medium text-action-fg hover:bg-action/90 disabled:opacity-40 md:min-h-0';
/** 真会丢东西的操作：实心 rust 按钮 + 深色字，和普通确认拉开距离。 */
export const DANGER_BUTTON = 'min-h-[44px] rounded-control bg-rust px-3 py-1.5 text-sub text-canvas hover:brightness-110 disabled:opacity-40 md:min-h-0';
export const SMALL_BUTTON = 'shrink-0 rounded-control border border-hair px-2 py-1 text-meta text-secondary hover:border-strong hover:text-primary disabled:opacity-40';
