import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject
} from 'react';
import { createPortal } from 'react-dom';
import { DialogShell } from '../shell/dialog-shell.tsx';
import { useNarrow } from '../shell/device.ts';
import type { Block } from './live-core.ts';
import {
  SUBAGENT_STATUS_CLASS,
  subagentEntries,
  subagentStatusLabel,
  subagentStepsLabel,
  subagentSummary,
  subagentTone,
  type SubagentBucket,
  type SubagentEntry
} from './subagent-track.ts';

const GUTTER = 12;
const GAP = 8;
const MIN_WIDTH = 320;
const MAX_WIDTH = 420;
/** 桌面上最多占六成屏高：再高就把对话压没了。 */
const MAX_HEIGHT_RATIO = 0.6;

const RING: Record<SubagentBucket, string> = {
  running: 'border-accent/70',
  failed: 'border-rust/70',
  done: 'border-sage/60'
};
const DOT: Record<SubagentBucket, string> = {
  running: 'bg-accent',
  failed: 'bg-rust',
  done: 'bg-sage'
};

interface Placement {
  readonly left: number;
  readonly width: number;
  readonly maxHeight: number;
  readonly top?: number;
  readonly bottom?: number;
}

/**
 * 输入框上方那条「子代理」轨道：常驻一行，点开是列表，再点一行就进只读时间线。
 *
 * 为什么常驻：回合一结束就把轨道收起来，用户想看看子代理刚才干了什么就得滚回去翻卡；
 * 全跑完时也留着，计数照常变。
 *
 * 桌面是贴着轨道的浮层（不铺遮罩，对话还在眼前）；窄屏铺成底部抽屉，
 * 拇指够得着、一行一个子代理。
 */
export function SubagentTrack({
  blocks,
  onSelect,
  triggerRef
}: {
  readonly blocks: readonly Block[];
  /** 挑中某个子代理：焦点视图负责打开只读时间线。 */
  readonly onSelect: (id: string) => void;
  /** 让外层的「关闭面板后回焦」拿到同一个按钮。 */
  readonly triggerRef?: RefObject<HTMLButtonElement | null>;
}) {
  const narrow = useNarrow();
  const entries = useMemo(() => subagentEntries(blocks), [blocks]);
  const tone = subagentTone(entries);
  const summary = subagentSummary(entries);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Placement | null>(null);
  const ownRef = useRef<HTMLButtonElement | null>(null);
  const trigger = triggerRef ?? ownRef;
  const panel = useRef<HTMLDivElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const entered = useRef(false);
  const panelId = useId();

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };
  // 监听只挂一次，用 ref 取最新闭包。
  const closeRef = useRef(close);
  closeRef.current = close;

  // 列表开着的时候，子代理没了（换会话）就自己收起，别留个空壳。
  useEffect(() => {
    if (open && entries.length === 0) setOpen(false);
  }, [open, entries.length]);

  useEffect(() => {
    if (!open || narrow) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
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
  }, [open, narrow, trigger]);

  useLayoutEffect(() => {
    if (!open || narrow) {
      setPos(null);
      return;
    }
    const place = () => {
      const anchor = trigger.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - GUTTER * 2));
      const left = Math.min(Math.max(GUTTER, rect.left), Math.max(GUTTER, window.innerWidth - width - GUTTER));
      const spaceAbove = rect.top - GAP - GUTTER;
      const spaceBelow = window.innerHeight - rect.bottom - GAP - GUTTER;
      // 轨道贴着输入框，上方通常够；屏太矮才翻到下面。
      const below = spaceAbove < 160 && spaceBelow > spaceAbove;
      const maxHeight = Math.max(120, Math.min(window.innerHeight * MAX_HEIGHT_RATIO, below ? spaceBelow : spaceAbove));
      setPos({
        left,
        width,
        maxHeight,
        ...(below ? { top: rect.bottom + GAP } : { bottom: window.innerHeight - rect.top + GAP })
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
  }, [open, narrow, trigger]);

  useEffect(() => {
    if (!open) {
      entered.current = false;
      return;
    }
    // 桌面浮层要先量完位置才可见，那时再给焦点，不然 focus 会落在隐藏元素上。
    if (entered.current || (!narrow && pos === null)) return;
    entered.current = true;
    const frame = requestAnimationFrame(() => {
      list.current?.querySelector<HTMLElement>('[data-subagent-row]')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, narrow, pos]);

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const stops = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-subagent-row]')];
      if (stops.length === 0) return;
      event.preventDefault();
      const active = stops.indexOf(document.activeElement as HTMLElement);
      const next =
        event.key === 'ArrowDown'
          ? (active + 1) % stops.length
          : active <= 0
            ? stops.length - 1
            : active - 1;
      stops[next]?.focus();
      return;
    }
    if (event.key !== 'Tab') return;
    const stops = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled])')];
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    const inside = event.currentTarget.contains(active);
    if (event.shiftKey && (active === first || !inside)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !inside)) {
      event.preventDefault();
      first.focus();
    }
  };

  const pick = (id: string) => {
    // 面板接管焦点；这里不把焦点抢回轨道，等面板关了再说。
    close(false);
    onSelect(id);
  };

  if (entries.length === 0 || tone === null || summary === null) return null;

  const rows = (
    <div ref={list} className="flex flex-col gap-0.5" onKeyDown={onListKeyDown}>
      {entries.map((entry) => (
        <TrackRow key={entry.id} entry={entry} onPick={pick} />
      ))}
    </div>
  );

  return (
    <div className="mb-1.5">
      <button
        ref={trigger}
        type="button"
        data-testid="subagent-track"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open && !narrow ? panelId : undefined}
        title="查看子代理"
        className="flex h-10 w-full items-center gap-2 rounded-full border border-hair bg-card/60 px-3 text-meta transition-colors hover:border-strong hover:bg-card-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        onClick={() => (open ? close(true) : setOpen(true))}
      >
        <span aria-hidden className={`flex size-3.5 shrink-0 items-center justify-center rounded-full border ${RING[tone]}`}>
          <span className={`size-1.5 rounded-full ${DOT[tone]} ${tone === 'running' ? 'motion-safe:animate-pulse' : ''}`} />
        </span>
        <span className="shrink-0 text-tertiary">子代理</span>
        <span className="min-w-0 flex-1 truncate text-left text-secondary">{summary}</span>
        <span className="shrink-0 text-tertiary">查看</span>
        <span aria-hidden className="shrink-0 text-tertiary">
          ›
        </span>
      </button>
      {open && !narrow
        ? createPortal(
            <div
              ref={panel}
              id={panelId}
              role="dialog"
              aria-label="子代理"
              data-testid="subagent-track-popover"
              onKeyDown={onListKeyDown}
              style={{
                left: pos?.left ?? GUTTER,
                width: pos?.width ?? MAX_WIDTH,
                maxHeight: pos?.maxHeight ?? 320,
                ...(pos?.top === undefined ? {} : { top: pos.top }),
                ...(pos?.bottom === undefined ? {} : { bottom: pos.bottom }),
                visibility: pos === null ? 'hidden' : 'visible'
              }}
              className="fixed z-50 flex flex-col overflow-y-auto overscroll-contain rounded-md border border-strong bg-panel p-1.5 shadow"
            >
              <p className="px-2 pb-1 pt-1.5 text-meta text-tertiary">子代理</p>
              {rows}
            </div>,
            document.body
          )
        : null}
      {open && narrow ? (
        <DialogShell title="子代理" onClose={() => close(true)} testId="subagent-track-sheet">
          <p className="pb-2 text-meta text-tertiary">子代理</p>
          {rows}
        </DialogShell>
      ) : null}
    </div>
  );
}

function TrackRow({ entry, onPick }: { readonly entry: SubagentEntry; readonly onPick: (id: string) => void }) {
  const indent = 8 + Math.min(2, Math.max(0, entry.depth - 1)) * 12;
  return (
    <button
      type="button"
      data-testid="subagent-track-row"
      data-subagent-id={entry.id}
      data-status={entry.status}
      data-subagent-row
      style={{ paddingLeft: `${indent}px` }}
      className="flex w-full items-start gap-2 rounded-sm py-2 pr-2 text-left transition-colors hover:bg-card-raised focus-visible:bg-card-raised focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      onClick={() => onPick(entry.id)}
    >
      <span aria-hidden className={`mt-1 flex size-3 shrink-0 items-center justify-center rounded-full border ${RING[entry.bucket]}`}>
        <span className={`size-1 rounded-full ${DOT[entry.bucket]} ${entry.bucket === 'running' ? 'motion-safe:animate-pulse' : ''}`} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span className="min-w-0 truncate text-sub text-primary">{entry.title}</span>
          {entry.agent !== null && entry.agent !== entry.title ? (
            <span className="shrink-0 truncate font-mono text-meta text-sage">{entry.agent}</span>
          ) : null}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-meta">
          <span className={`shrink-0 ${SUBAGENT_STATUS_CLASS[entry.status]}`}>{subagentStatusLabel(entry.status)}</span>
          <span aria-hidden className="shrink-0 text-tertiary">
            ·
          </span>
          <span className="shrink-0 text-tertiary">{subagentStepsLabel(entry.steps)}</span>
        </span>
        {entry.activity !== null ? (
          <span className="mt-0.5 block truncate text-meta text-tertiary" title={entry.activity}>
            {entry.activity}
          </span>
        ) : null}
      </span>
      <span aria-hidden className="mt-0.5 shrink-0 text-tertiary">
        ›
      </span>
    </button>
  );
}
