import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Rnd } from 'react-rnd';
import { sessionGroupId, type CanvasDto, type SessionDto } from '../../shell/api.ts';
import { useWorkspaceViews } from './workspace-chooser.tsx';
import { eligibleWorkdir } from './workdir-model.ts';
import { FocusView } from './focus.tsx';
import { SessionDocumentTabs } from './session-document-tabs.tsx';
import { resolveLive, waitingForReply, type Block, type LiveMap } from '../../atoms/live.ts';
import { useTurnProgress } from '../../atoms/use-turn-progress.ts';
import { statusStyle } from '../../atoms/status.tsx';
import { useAccount } from '../../shell/auth.tsx';
import {
  closeWindow, focusWindow, focused, keepOnly, layoutWindows, minimizeWindow, minimized, moveWindow, openWindow,
  restoreWindow, retile, tileCapacity, toggleMaximize, windowsKey, selectWindowSession, type Rect, type WindowSet, type WindowStore, type SessionWindow
} from './canvas-windows.ts';
import { localWindowStore } from './canvas-windows-store.ts';
import { Sheet } from '../../shell/dialog-shell.tsx';

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
      return top && current.windows.filter((w) => w.mode === 'tiled').length > cap ? restoreWindow(current, top.windowId, cap) : current;
    });
  }, [capacity, measured, act]);
  const expand = useCallback((sessionId: string) => {
    const session = canvas.sessions.find((item) => item.id === sessionId);
    act((current, cap) => openWindow(current, sessionId, cap, session && !sessionGroupId(session) ? session.workspaceId : null));
  }, [act, canvas.sessions]);
  const expanded = useCallback((sessionId: string) => set.windows.some((w) => w.sessionId === sessionId), [set]);
  return { set, expand, expanded, retile: () => act((current, cap) => retile(current, cap)), act, area };
}

interface LayerProps {
  readonly windows: CanvasWindows;
  readonly narrow: boolean;
  readonly canvas: CanvasDto;
  readonly live: LiveMap;
  readonly history: Readonly<Record<string, import('../../atoms/live.ts').HistoryState>>;
  readonly onRetryHistory: (session: SessionDto) => void;
  readonly sync: Readonly<Record<string, 'syncing' | 'stale'>>;
  readonly onRetrySync: (sessionId: string) => void;
  readonly drafts: Readonly<Record<string, string>>;
  readonly onDraftChange: (sessionId: string, text: string) => void;
  readonly onChanged: () => void;
  /** 进会话页（整页）。 */
  readonly onOpen: (sessionId: string) => void;
  readonly onChangeOption: (sessionId: string, optionId: string, value: string | boolean) => Promise<void>;
  readonly onProjectSessions: (sessionId: string) => void;
  readonly onWindowFocusChange: (sessionId: string | null) => void;
  readonly onNewSessionCreated: (session: SessionDto) => void;
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
export function CanvasWindowLayer({ windows, narrow, canvas, live, history, onRetryHistory, sync, onRetrySync, drafts, onDraftChange, onChanged, onOpen, onChangeOption, onProjectSessions, onWindowFocusChange, onNewSessionCreated }: LayerProps) {
  const { set, act, area } = windows;
  const account = useAccount();
  const workspaceViews = useWorkspaceViews(canvas.project.id);
  const byId = useMemo(() => new Map(canvas.sessions.map((session) => [session.id, session])), [canvas.sessions]);
  const rects = useMemo(() => (area ? layoutWindows(set, area) : new Map<string, Rect>()), [set, area]);
  const top = focused(set);
  const open = set.windows.filter((w) => w.sessionId === null || byId.has(w.sessionId));
  const [chooser, setChooser] = useState(false);
  const standaloneSwipe = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  useEffect(() => { onWindowFocusChange(top?.sessionId ?? null); }, [top?.sessionId, onWindowFocusChange]);
  useEffect(() => {
    if (!narrow || !area || !top || top.sessionId !== null && !byId.has(top.sessionId)) setChooser(false);
  }, [narrow, area, top, byId]);
  if (!area || open.length === 0) return null;

  const pane = (window: SessionWindow, actions: ReactNode, onSwipe?: (step: number) => void) => (
    <SessionDocumentTabs
      key={window.windowId}
      accountId={account?.id ?? 'anon'}
      canvas={canvas}
      scopeKey={`canvas:${window.windowId}`}
      initialSessionId={window.sessionId}
      anchorSessionId={window.anchorSessionId}
      workspace={(() => {
        const anchor = byId.get(window.anchorSessionId);
        const id = window.anchorWorkspaceId ?? (anchor && !sessionGroupId(anchor) ? anchor.workspaceId : null);
        return (workspaceViews.data ?? []).find(({ workspace, ownerProjectId }) => workspace.id === id && eligibleWorkdir(workspace, ownerProjectId, canvas.project.id))?.workspace;
      })()}
      standaloneActions={actions}
      sessionUnavailable="会话暂不可用"
      onSession={(id) => act((current) => selectWindowSession(current, window.windowId, id))}
      onNewSessionCreated={onNewSessionCreated}
      onRefresh={onChanged}
      renderSession={(sessionId, navigation) => {
        const session = byId.get(sessionId);
        if (!session) return null;
        return <FocusView
          key={sessionId}
          canvas={canvas}
          session={session}
          live={resolveLive(session, canvas.previews[session.id] ?? [], live[session.id])}
          historyState={history[session.id] ?? 'loading'}
          onRetryHistory={() => onRetryHistory(session)}
          syncState={sync[session.id]}
          onRetrySync={() => onRetrySync(session.id)}
          draft={drafts[session.id] ?? ''}
          onDraftChange={(text) => onDraftChange(session.id, text)}
          onChanged={onChanged}
          onOpenSession={windows.expand}
          onSeedDraft={onDraftChange}
          artifacts={canvas.artifacts.filter((artifact) => artifact.sessionId === session.id)}
          onChangeOption={(optionId, value) => onChangeOption(session.id, optionId, value)}
          documentTabs={navigation}
          windowChrome={{ actions, onSwipe }}
        />;
      }}
    />
  );

  const bar = (
    <WindowBar
      items={minimized(set).flatMap((w) => {
        const session = byId.get(w.sessionId ?? w.anchorSessionId);
        if (!session && w.sessionId !== null) return [];
        const local = session ? live[session.id] : undefined;
        const agentLabel = session ? (canvas.agents.find((candidate) => candidate.id === session.agentId)?.label ?? session.agentId) : '';
        return [{
          windowId: w.windowId,
          session,
          title: w.sessionId === null || !session ? '终端' : sessionTitle(canvas, session),
          waiting: !!session && w.sessionId !== null && waitingForReply(local ?? null, local?.status ?? session.status),
          blocks: local?.blocks ?? [],
          agentLabel
        }];
      })}
      onRestore={(id) => act((current, cap) => restoreWindow(current, id, cap))}
      onClose={(id) => act((current) => closeWindow(current, id))}
    />
  );

  if (narrow) {
    const shown = top && (top.sessionId === null || byId.has(top.sessionId)) ? top : null;
    if (!shown) return bar;
    const index = open.findIndex((w) => w.windowId === shown.windowId);
    const go = (step: number) => {
      const next = open[(index + step + open.length) % open.length];
      if (next && next.windowId !== shown.windowId) act((current, cap) => restoreWindow(current, next.windowId, cap));
    };
    return (
      <div className="absolute inset-0 z-30 flex flex-col bg-canvas" data-testid="canvas-window" data-session-id={shown.sessionId ?? undefined} data-window-id={shown.windowId} data-mobile="true">
        <div
          className="flex min-h-0 flex-1 flex-col overflow-hidden [&_header.window-drag-handle]:[touch-action:pan-y]"
          onPointerDown={(event) => {
            const target = event.target;
            if (!(target instanceof Element) || !target.closest('header.window-drag-handle') || target.closest('button, a, input, textarea, select, [role="menu"], [role="menuitem"]')) return;
            standaloneSwipe.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
          }}
          onPointerUp={(event) => {
            const start = standaloneSwipe.current;
            standaloneSwipe.current = null;
            if (!start || start.pointerId !== event.pointerId) return;
            const dx = event.clientX - start.x;
            if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(event.clientY - start.y)) go(dx < 0 ? 1 : -1);
          }}
          onPointerCancel={() => { standaloneSwipe.current = null; }}
        >{pane(shown, <>
          <button className="min-h-[44px] min-w-[44px] shrink-0 text-sub text-tertiary hover:text-primary" aria-label="‹ 画布" onClick={() => act((current) => minimizeWindow(current, shown.windowId))}>‹</button>
          <button className="min-h-[44px] min-w-[44px] shrink-0 text-meta text-secondary hover:text-primary" aria-label={`窗口 ${index + 1}/${open.length}`} aria-haspopup="dialog" onClick={() => setChooser(true)}><span className="font-mono" data-testid="window-count">{index + 1}/{open.length}</span></button>
          <button className="min-h-[44px] min-w-[44px] shrink-0 text-meta text-tertiary hover:text-primary" aria-label="关闭窗口" onClick={() => act((current) => closeWindow(current, shown.windowId))}>×</button>
        </>, go)}</div>
        {chooser ? (
          <Sheet title="已打开的窗口" testId="window-chooser" onClose={() => setChooser(false)} footer={
            <button className="min-h-[44px] w-full rounded-md border border-hair px-3 text-left text-sub text-primary hover:bg-hover" onClick={() => { setChooser(false); onProjectSessions(shown.sessionId ?? shown.anchorSessionId); }}>
              查看项目全部会话 <span aria-hidden className="float-right">→</span>
            </button>
          }>
            <p className="px-2 pb-2 text-meta text-tertiary">已打开 {open.length} 个窗口</p>
            {open.map((w) => {
              const current = w.windowId === shown.windowId;
              return <button key={w.windowId} data-testid="window-chooser-item" data-session-id={w.sessionId ?? undefined} data-window-id={w.windowId} aria-current={current ? 'true' : undefined} className={`flex min-h-[44px] w-full items-center gap-3 rounded-md px-3 text-left text-sub ${current ? 'bg-selected text-primary' : 'text-secondary hover:bg-hover'}`} onClick={() => { act((value, cap) => restoreWindow(value, w.windowId, cap)); setChooser(false); }}>
                <span className="min-w-0 flex-1 truncate">{w.sessionId === null ? '终端' : sessionTitle(canvas, byId.get(w.sessionId)!)}</span>
                <span className="shrink-0 font-mono text-meta text-tertiary">#{(w.sessionId ?? w.anchorSessionId).slice(-4)}</span>
                {current ? <span className="shrink-0 text-meta text-tertiary">当前</span> : null}
              </button>;
            })}
          </Sheet>
        ) : null}
      </div>
    );
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-20" data-testid="canvas-window-layer">
      {open.map((w) => {
        const rect = rects.get(w.windowId);
        if (!rect || w.mode === 'min') return null;
        const isTop = top?.windowId === w.windowId;
        const session = byId.get(w.sessionId ?? w.anchorSessionId);
        return (
          <Rnd
            key={w.windowId}
            className="pointer-events-auto"
            style={{ zIndex: w.z }}
            position={{ x: rect.x, y: rect.y }}
            size={{ width: rect.width, height: rect.height }}
            minWidth={320}
            minHeight={240}
            bounds="parent"
            dragHandleClassName="window-drag, .window-drag-handle"
            cancel="button, a, input, textarea, select, [role=menu], [role=menuitem]"
            enableResizing={w.mode === 'max' ? false : { bottomRight: true, right: true, bottom: true }}
            disableDragging={w.mode === 'max'}
            resizeHandleStyles={{ bottomRight: { right: 0, bottom: 0, width: 18, height: 18, zIndex: 50 } }}
            resizeHandleComponent={{ bottomRight: <span data-testid="window-resize" className="block size-full cursor-se-resize border-r-2 border-b-2 border-strong" /> }}
            onMouseDown={() => act((current) => focusWindow(current, w.windowId))}
            onTouchStart={() => act((current) => focusWindow(current, w.windowId))}
            onDragStop={(_, d) => {
              if (Math.abs(d.x - rect.x) < 2 && Math.abs(d.y - rect.y) < 2) return;
              act((current) => moveWindow(current, w.windowId, { ...rect, x: d.x, y: d.y }, area));
            }}
            onResizeStop={(_, __, element, ___, position) =>
              act((current) =>
                moveWindow(current, w.windowId, { x: position.x, y: position.y, width: element.offsetWidth, height: element.offsetHeight }, area)
              )
            }
          >
            {/* 窗口本身要是 flex 容器：pane 的滚动区靠 flex-1 + min-h-0 收缩，block 父级下会塌成内容高度（#215）。 */}
            <section
              aria-label={session ? `会话窗口：${w.sessionId === null ? '终端' : sessionTitle(canvas, session)}` : '会话窗口'}
              data-testid="canvas-window"
              data-session-id={w.sessionId ?? undefined}
              data-window-id={w.windowId}
              data-mode={w.mode}
              data-focused={isTop ? 'true' : undefined}
              className={`flex h-full flex-col overflow-hidden rounded-md border bg-canvas shadow-lg ${isTop ? 'border-fg/40' : 'border-hair'}`}
            >
              {pane(
                w,
                <>
                  <button className={BTN} title="最小化" aria-label="最小化" onClick={() => act((current) => minimizeWindow(current, w.windowId))}>
                    –
                  </button>
                  <button
                    className={BTN}
                    title={w.mode === 'max' ? '还原' : '最大化'}
                    aria-label={w.mode === 'max' ? '还原' : '最大化'}
                    onClick={() => act((current, cap) => toggleMaximize(current, w.windowId, cap))}
                  >
                    {w.mode === 'max' ? '❐' : '□'}
                  </button>
                  <button className={BTN} title="打开会话页" aria-label="打开会话页" disabled={w.sessionId === null} onClick={() => { if (w.sessionId !== null) onOpen(w.sessionId); }}>
                    ↗
                  </button>
                  <button className={BTN} title="关闭窗口（会话照常跑）" aria-label="关闭窗口" onClick={() => act((current) => closeWindow(current, w.windowId))}>
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
  items: { windowId: string; session: SessionDto | undefined; title: string; waiting: boolean; blocks: readonly Block[]; agentLabel: string }[];
  onRestore: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <nav
      aria-label="最小化的会话窗口"
      data-testid="window-bar"
      className="pointer-events-auto absolute bottom-3 left-1/2 z-30 flex max-w-[calc(100%-8rem)] -translate-x-1/2 gap-1.5 overflow-x-auto rounded-lg border border-strong bg-overlay p-1 shadow-overlay"
    >
      {items.map(({ windowId, session, title, waiting, blocks, agentLabel }) => {
        const style = session ? statusStyle(session.status, session.lastSeq) : null;
        return (
          <span key={windowId} className="flex shrink-0 items-center rounded-sm border border-hair">
            <button className="flex h-9 max-w-[14rem] items-center gap-1.5 px-2 text-meta text-secondary hover:text-primary" onClick={() => onRestore(windowId)} title={title}>
              {style ? <span className={`block size-[7px] shrink-0 ${style.dot} ${style.shape}`} /> : null}
              <span className="truncate">{title}</span>
              {waiting && session ? <WaitingDot sessionId={session.id} blocks={blocks} agentLabel={agentLabel} /> : null}
            </button>
            <button className="h-9 px-1.5 text-meta text-tertiary hover:text-primary" aria-label={`关闭 ${title}`} onClick={() => onClose(windowId)}>
              ×
            </button>
          </span>
        );
      })}
    </nav>
  );
}

/** 窗口条上的脉冲点：形状照旧，悬停时补一句「<agent> 正在回复 · N 秒」。 */
function WaitingDot({ sessionId, blocks, agentLabel }: { sessionId: string; blocks: readonly Block[]; agentLabel: string }) {
  const progress = useTurnProgress(sessionId, blocks, true, agentLabel);
  return (
    <span
      className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent"
      aria-label="正在回复"
      title={progress ? `${agentLabel} 正在回复` : undefined}
    />
  );
}
