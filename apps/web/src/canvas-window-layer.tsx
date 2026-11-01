import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Rnd } from 'react-rnd';
import type { CanvasDto, SessionDto } from './api.ts';
import { FocusView } from './focus.tsx';
import { resolveLive, waitingForReply, type LiveMap } from './live.ts';
import { statusStyle } from './status.tsx';
import { useAccount } from './auth.tsx';
import {
  closeWindow, focusWindow, focused, keepOnly, layoutWindows, minimizeWindow, minimized, moveWindow, openWindow,
  restoreWindow, retile, tileCapacity, toggleMaximize, windowsKey, type Rect, type WindowSet, type WindowStore
} from './canvas-windows.ts';
import { localWindowStore } from './canvas-windows-store.ts';

/** 窗口区留出的边：右边是画布控件，下边是窗口条。 */
const MARGIN = { top: 12, left: 12, right: 60, bottom: 52 } as const;
const NARROW_MARGIN = { top: 0, left: 0, right: 0, bottom: 0 } as const;

export interface CanvasWindows {
  readonly set: WindowSet;
  readonly expand: (sessionId: string) => void;
  readonly expanded: (sessionId: string) => boolean;
  readonly retile: () => void;
  readonly act: (change: (set: WindowSet, capacity: number) => WindowSet) => void;
  readonly area: Rect | null;
}

/**
 * 应用层：窗口集合的状态、持久化（WindowStore 端口）和可视区量取。
 * 规则都在 canvas-windows.ts，这里只把它们接到 React 上。
 */
export function useCanvasWindows(
  canvas: CanvasDto,
  container: RefObject<HTMLDivElement | null>,
  narrow: boolean,
  store: WindowStore = localWindowStore
): CanvasWindows {
  const account = useAccount();
  const key = windowsKey(account?.id ?? null, 'project', canvas.project.id);
  const [set, setSet] = useState<WindowSet>(() => store.load(key));
  const loadedKey = useRef(key);
  useEffect(() => {
    if (loadedKey.current === key) return;
    loadedKey.current = key;
    setSet(store.load(key));
  }, [key, store]);
  const [area, setArea] = useState<Rect | null>(null);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => {
      const m = narrow ? NARROW_MARGIN : MARGIN;
      setArea({ x: m.left, y: m.top, width: Math.max(1, element.clientWidth - m.left - m.right), height: Math.max(1, element.clientHeight - m.top - m.bottom) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [container, narrow]);
  const capacity = area ? (narrow ? 1 : tileCapacity(area)) : 1;
  const measured = area !== null;
  const capacityRef = useRef(capacity);
  capacityRef.current = capacity;
  const act = useCallback(
    (change: (current: WindowSet, capacity: number) => WindowSet) =>
      setSet((current) => {
        const next = change(current, capacityRef.current);
        if (next !== current) store.save(loadedKey.current, next);
        return next;
      }),
    [store]
  );
  // 会话删了、进回收站、没权限了：窗口静默丢掉。可视区变小：多出来的平铺窗口收进窗口条。
  useEffect(() => {
    const ids = new Set(canvas.sessions.map((session) => session.id));
    act((current) => keepOnly(current, (id) => ids.has(id)));
  }, [canvas.sessions, act]);
  useEffect(() => {
    if (!measured) return; // 还没量出可视区时不收窗口（否则刷新时会把平铺窗口全收进窗口条）
    act((current, cap) => {
      const top = focused(current);
      return top && current.windows.filter((w) => w.mode === 'tiled').length > cap ? restoreWindow(current, top.sessionId, cap) : current;
    });
  }, [capacity, measured, act]);
  const expand = useCallback((sessionId: string) => act((current, cap) => openWindow(current, sessionId, cap)), [act]);
  const expanded = useCallback((sessionId: string) => set.windows.some((w) => w.sessionId === sessionId), [set]);
  return { set, expand, expanded, retile: () => act((current, cap) => retile(current, cap)), act, area };
}

interface LayerProps {
  readonly windows: CanvasWindows;
  readonly narrow: boolean;
  readonly canvas: CanvasDto;
  readonly live: LiveMap;
  readonly drafts: Readonly<Record<string, string>>;
  readonly onDraftChange: (sessionId: string, text: string) => void;
  readonly onChanged: () => void;
  /** 进会话页（整页）。 */
  readonly onOpen: (sessionId: string) => void;
  readonly onChangeOption: (sessionId: string, optionId: string, value: string | boolean) => Promise<void>;
}

export function sessionTitle(canvas: CanvasDto, session: SessionDto): string {
  const task = canvas.tasks.find((candidate) => candidate.id === session.taskId);
  const agent = canvas.agents.find((candidate) => candidate.id === session.agentId);
  if (session.title) return session.title;
  return `${task?.title ?? session.taskId} · ${agent?.label ?? session.agentId}`;
}

const BTN = 'flex h-9 w-8 shrink-0 items-center justify-center rounded-sm text-meta text-tertiary hover:bg-hair/40 hover:text-primary';

/**
 * 画布上面的窗口层（屏幕坐标）：画布平移缩放时窗口不动，字始终清楚。
 * 交互分区：标题栏拖窗口、对话区只滚动、右下角改大小；窗口以外的画布照旧。
 */
export function CanvasWindowLayer({ windows, narrow, canvas, live, drafts, onDraftChange, onChanged, onOpen, onChangeOption }: LayerProps) {
  const { set, act, area } = windows;
  const byId = useMemo(() => new Map(canvas.sessions.map((session) => [session.id, session])), [canvas.sessions]);
  const rects = useMemo(() => (area ? layoutWindows(set, area) : new Map<string, Rect>()), [set, area]);
  const top = focused(set);
  const open = set.windows.filter((w) => byId.has(w.sessionId));
  if (!area || open.length === 0) return null;

  const pane = (sessionId: string, actions: ReactNode) => {
    const session = byId.get(sessionId)!;
    return (
      <FocusView
        canvas={canvas}
        session={session}
        live={resolveLive(session, canvas.previews[session.id] ?? [], live[session.id])}
        draft={drafts[session.id] ?? ''}
        onDraftChange={(text) => onDraftChange(session.id, text)}
        onChanged={onChanged}
        onOpenSession={(id) => act((current, cap) => openWindow(current, id, cap))}
        artifacts={canvas.artifacts.filter((artifact) => artifact.sessionId === session.id)}
        onChangeOption={(optionId, value) => onChangeOption(session.id, optionId, value)}
        windowChrome={{ actions }}
      />
    );
  };

  const bar = (
    <WindowBar
      items={minimized(set).flatMap((w) => {
        const session = byId.get(w.sessionId);
        return session ? [{ session, title: sessionTitle(canvas, session), waiting: waitingForReply(live[session.id] ?? null, live[session.id]?.status ?? session.status) }] : [];
      })}
      onRestore={(id) => act((current, cap) => restoreWindow(current, id, cap))}
      onClose={(id) => act((current) => closeWindow(current, id))}
    />
  );

  if (narrow) {
    const shown = top && byId.has(top.sessionId) ? top : null;
    if (!shown) return bar;
    const index = open.findIndex((w) => w.sessionId === shown.sessionId);
    const go = (step: number) => {
      const next = open[(index + step + open.length) % open.length];
      if (next && next.sessionId !== shown.sessionId) act((current, cap) => restoreWindow(current, next.sessionId, cap));
    };
    return (
      <div className="absolute inset-0 z-30 flex flex-col bg-canvas" data-testid="canvas-window" data-session-id={shown.sessionId} data-mobile="true">
        <SwipeStrip
          onSwipe={go}
          title={sessionTitle(canvas, byId.get(shown.sessionId)!)}
          count={`${index + 1}/${open.length}`}
          onBack={() => act((current) => minimizeWindow(current, shown.sessionId))}
          onClose={() => act((current) => closeWindow(current, shown.sessionId))}
        />
        <div className="min-h-0 flex-1">{pane(shown.sessionId, null)}</div>
      </div>
    );
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-20" data-testid="canvas-window-layer">
      {open.map((w) => {
        const rect = rects.get(w.sessionId);
        if (!rect || w.mode === 'min') return null;
        const isTop = top?.sessionId === w.sessionId;
        const session = byId.get(w.sessionId)!;
        return (
          <Rnd
            key={w.sessionId}
            className="pointer-events-auto"
            style={{ zIndex: w.z }}
            position={{ x: rect.x, y: rect.y }}
            size={{ width: rect.width, height: rect.height }}
            minWidth={320}
            minHeight={240}
            bounds="parent"
            dragHandleClassName="window-drag"
            cancel="button, a, input, textarea, select, [role=menu], [role=menuitem]"
            enableResizing={w.mode === 'max' ? false : { bottomRight: true, right: true, bottom: true }}
            disableDragging={w.mode === 'max'}
            resizeHandleStyles={{ bottomRight: { right: 0, bottom: 0, width: 18, height: 18, zIndex: 50 } }}
            resizeHandleComponent={{ bottomRight: <span data-testid="window-resize" className="block size-full cursor-se-resize border-r-2 border-b-2 border-strong" /> }}
            onMouseDown={() => act((current) => focusWindow(current, w.sessionId))}
            onTouchStart={() => act((current) => focusWindow(current, w.sessionId))}
            onDragStop={(_, d) => {
              if (Math.abs(d.x - rect.x) < 2 && Math.abs(d.y - rect.y) < 2) return;
              act((current) => moveWindow(current, w.sessionId, { ...rect, x: d.x, y: d.y }, area));
            }}
            onResizeStop={(_, __, element, ___, position) =>
              act((current) =>
                moveWindow(current, w.sessionId, { x: position.x, y: position.y, width: element.offsetWidth, height: element.offsetHeight }, area)
              )
            }
          >
            <section
              aria-label={`会话窗口：${sessionTitle(canvas, session)}`}
              data-testid="canvas-window"
              data-session-id={w.sessionId}
              data-mode={w.mode}
              data-focused={isTop ? 'true' : undefined}
              className={`h-full overflow-hidden rounded-md border bg-canvas shadow-lg ${isTop ? 'border-accent' : 'border-hair'}`}
            >
              {pane(
                w.sessionId,
                <>
                  <button className={BTN} title="最小化" aria-label="最小化" onClick={() => act((current) => minimizeWindow(current, w.sessionId))}>
                    –
                  </button>
                  <button
                    className={BTN}
                    title={w.mode === 'max' ? '还原' : '最大化'}
                    aria-label={w.mode === 'max' ? '还原' : '最大化'}
                    onClick={() => act((current, cap) => toggleMaximize(current, w.sessionId, cap))}
                  >
                    {w.mode === 'max' ? '❐' : '□'}
                  </button>
                  <button className={BTN} title="打开会话页" aria-label="打开会话页" onClick={() => onOpen(w.sessionId)}>
                    ↗
                  </button>
                  <button className={BTN} title="关闭窗口（会话照常跑）" aria-label="关闭窗口" onClick={() => act((current) => closeWindow(current, w.sessionId))}>
                    ×
                  </button>
                </>
              )}
            </section>
          </Rnd>
        );
      })}
      <div className="pointer-events-auto">{bar}</div>
    </div>
  );
}

function WindowBar({
  items,
  onRestore,
  onClose
}: {
  items: { session: SessionDto; title: string; waiting: boolean }[];
  onRestore: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <nav
      aria-label="最小化的会话窗口"
      data-testid="window-bar"
      className="pointer-events-auto absolute bottom-3 left-1/2 z-30 flex max-w-[calc(100%-8rem)] -translate-x-1/2 gap-1.5 overflow-x-auto rounded-md border border-hair bg-card p-1 shadow-sm"
    >
      {items.map(({ session, title, waiting }) => {
        const style = statusStyle(session.status, session.lastSeq);
        return (
          <span key={session.id} className="flex shrink-0 items-center rounded-sm border border-hair">
            <button className="flex h-9 max-w-[14rem] items-center gap-1.5 px-2 text-meta text-secondary hover:text-primary" onClick={() => onRestore(session.id)} title={title}>
              <span className={`block size-[7px] shrink-0 ${style.dot} ${style.shape}`} />
              <span className="truncate">{title}</span>
              {waiting ? <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" aria-label="正在回复" /> : null}
            </button>
            <button className="h-9 px-1.5 text-meta text-tertiary hover:text-primary" aria-label={`关闭 ${title}`} onClick={() => onClose(session.id)}>
              ×
            </button>
          </span>
        );
      })}
    </nav>
  );
}

/** 手机：顶部一条，左右滑切换打开的窗口（只在这条上滑，不和对话区的滚动、选字抢）。 */
function SwipeStrip({ title, count, onSwipe, onBack, onClose }: { title: string; count: string; onSwipe: (step: number) => void; onBack: () => void; onClose: () => void }) {
  const start = useRef<{ x: number; y: number } | null>(null);
  return (
    <div
      data-testid="window-swipe-strip"
      className="flex h-11 shrink-0 touch-none items-center gap-2 border-b border-hair bg-card px-2"
      onPointerDown={(event) => {
        start.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerUp={(event) => {
        const from = start.current;
        start.current = null;
        if (!from) return;
        const dx = event.clientX - from.x;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(event.clientY - from.y)) onSwipe(dx < 0 ? 1 : -1);
      }}
    >
      <button className="flex h-11 shrink-0 items-center px-1 text-meta text-tertiary hover:text-primary" onClick={onBack}>
        ‹ 画布
      </button>
      <span className="min-w-0 flex-1 truncate text-center text-meta text-secondary">{title}</span>
      <span className="shrink-0 font-mono text-meta text-tertiary" data-testid="window-count">
        {count}
      </span>
      <button className="flex h-11 w-9 shrink-0 items-center justify-center text-meta text-tertiary hover:text-primary" aria-label="关闭窗口" onClick={onClose}>
        ×
      </button>
    </div>
  );
}

