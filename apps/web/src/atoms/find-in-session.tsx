import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { findMatches, stepMatch } from './find-in-text.ts';

/**
 * 会话内搜索：顶部一条 36px 的细条 + 用 CSS Custom Highlight API 刷命中。
 *
 * 为什么不改 DOM 包 `<mark>`：对话区是流式追加的，包里插节点会让 React 的对账错位，
 * 一层层 setState 也会把「贴底 / 不贴底」的判断搅乱。Custom Highlight API 只登记 Range，
 * 不碰节点树，流式内容和虚拟化都对它透明；浏览器不支持时只是不高亮，命中数照算。
 */
export const TIMELINE_SEARCH_SEEK_LIMIT = 12;

const HIT = 'timeline-search-hit';
const ACTIVE = 'timeline-search-hit-active';

/** 一次最多画亮这么多处：一条超长日志配一个单字母查询时，别为了一次按键建上万个 Range。 */
const PAINT_LIMIT = 1000;

/** 这些地方的文字不参与搜索（代码块里的脚本、被隐藏的辅助文本等）。 */
const SKIP_SELECTOR = 'script, style, noscript, textarea, [data-find-skip]';

interface Hit {
  readonly range: Range;
  readonly node: Text;
}

/** lib.dom 只声明了 forEach；实际是 maplike，有 set / delete。 */
interface HighlightRegistryLike {
  readonly set: (name: string, highlight: Highlight) => void;
  readonly delete: (name: string) => void;
}

function registry(): HighlightRegistryLike | null {
  if (typeof CSS === 'undefined' || typeof Highlight !== 'function') return null;
  return (CSS as unknown as { highlights?: HighlightRegistryLike }).highlights ?? null;
}

export function clearHighlights(): void {
  const store = registry();
  if (store === null) return;
  store.delete(HIT);
  store.delete(ACTIVE);
}

function paintHighlights(hits: readonly Hit[], active: number): void {
  const store = registry();
  if (store === null) return;
  if (hits.length === 0) {
    clearHighlights();
    return;
  }
  const painted = hits.slice(0, PAINT_LIMIT);
  store.set(HIT, new Highlight(...painted.map((hit) => hit.range)));
  const current = hits[active];
  if (current === undefined) {
    store.delete(ACTIVE);
    return;
  }
  // 当前这条要压在其它命中上面：同一条 Range 落在两个 highlight 里时，priority 决定谁赢。
  const highlight = new Highlight(current.range);
  highlight.priority = 1;
  store.set(ACTIVE, highlight);
}

/** 把滚动容器里的文本节点按查询扫一遍，每一处命中留一个 Range。 */
function collectHits(root: HTMLElement, query: string): Hit[] {
  if (query === '') return [];
  const hits: Hit[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node as Text;
    if (text.data.trim() === '') continue;
    const parent = text.parentElement;
    if (parent === null || parent.closest(SKIP_SELECTOR) !== null) continue;
    for (const match of findMatches(text.data, query)) {
      const range = document.createRange();
      range.setStart(text, match.start);
      range.setEnd(text, match.end);
      hits.push({ range, node: text });
    }
  }
  return hits;
}

/**
 * 滚到第 active 条命中。
 *
 * 有的命中在 DOM 里但没画出来（页签被藏起来、折叠的块），量出来是 0×0——
 * 那就顺手往后试，最多试 `TIMELINE_SEARCH_SEEK_LIMIT` 条，别在一处隐身上白等。
 */
function scrollToHit(root: HTMLElement, hits: readonly Hit[], active: number): void {
  const attempts = Math.min(TIMELINE_SEARCH_SEEK_LIMIT, hits.length);
  for (let step = 0; step < attempts; step += 1) {
    const hit = hits[(active + step) % hits.length];
    if (hit === undefined) continue;
    const element = hit.node.parentElement;
    if (element === null || !root.contains(element)) continue;
    const rect = hit.range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    return;
  }
}

export interface FindInSessionProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** 对话区那个滚动容器：搜索只在这棵树里找。 */
  readonly scrollerRef: { readonly current: HTMLElement | null };
  /** 换会话时清空查询和高亮。 */
  readonly resetKey: string;
}

export function FindInSession({ open, onOpenChange, scrollerRef, resetKey }: FindInSessionProps) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<readonly Hit[]>([]);
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** 关闭时要把焦点和滚动位置还回去，先记下来。 */
  const restore = useRef<{ focus: HTMLElement | null; scrollTop: number } | null>(null);
  /** 「视图跟着当前命中走」：用户自己滚一下就关掉，再按上/下条或改查询会重新打开。 */
  const anchored = useRef(true);
  /** 上一次程序化滚动的时间：紧接着的 scroll 事件是我们自己制造的，别当成用户滚了。 */
  const autoScrollAt = useRef(0);
  /** 流式输出一秒改几十次，合并成一次重算。 */
  const pending = useRef<number | null>(null);

  const recompute = useCallback(
    (keepActive: boolean) => {
      const root = scrollerRef.current;
      if (!open || root === null) {
        setHits([]);
        setActive(-1);
        return;
      }
      const next = collectHits(root, query);
      setHits(next);
      setActive((current) => (next.length === 0 ? -1 : keepActive ? Math.min(Math.max(current, 0), next.length - 1) : 0));
    },
    [open, query, scrollerRef]
  );

  // 查询变了就重头数；打开时也数一遍（比如上次留着查询）。
  useEffect(() => {
    if (!open) {
      setHits([]);
      setActive(-1);
      return;
    }
    anchored.current = true;
    recompute(false);
  }, [open, query, recompute]);

  // 换会话：查询、命中、高亮都不该跟过去。
  useEffect(() => {
    setQuery('');
    setHits([]);
    setActive(-1);
  }, [resetKey]);

  // 打开：记下焦点和滚动位置，聚焦输入框并全选既有查询。
  useEffect(() => {
    if (!open) return;
    const root = scrollerRef.current;
    restore.current = {
      focus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      scrollTop: root?.scrollTop ?? 0
    };
    anchored.current = true;
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => {
      cancelAnimationFrame(frame);
      clearHighlights();
      const saved = restore.current;
      restore.current = null;
      if (saved === null) return;
      const element = scrollerRef.current;
      // 关掉搜索回到原来的位置：刚才是翻到中间找的，别把人留在那儿。
      if (element !== null) element.scrollTop = saved.scrollTop;
      const focus = saved.focus;
      const owner = document.activeElement;
      // 只有焦点还在搜索条上才还回去；用户点了别处就别抢。
      const fromBar = owner === null || owner === document.body || owner.closest('[data-testid="find-bar"]') !== null;
      if (focus !== null && focus.isConnected && fromBar) focus.focus({ preventScroll: true });
    };
  }, [open, scrollerRef]);

  // 对话区在长（流式追加、图片载入、块折叠）：重新数一遍命中。
  useEffect(() => {
    if (!open) return;
    const root = scrollerRef.current;
    if (root === null) return;
    const observer = new MutationObserver(() => {
      if (pending.current !== null) return;
      pending.current = window.setTimeout(() => {
        pending.current = null;
        recompute(true);
      }, 120);
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (pending.current !== null) window.clearTimeout(pending.current);
      pending.current = null;
    };
  }, [open, recompute, scrollerRef]);

  // 命中数交给滚动容器（e2e / 调试看 data-find-hits）。
  useEffect(() => {
    const root = scrollerRef.current;
    if (root === null) return;
    if (!open) {
      root.removeAttribute('data-find-hits');
      return;
    }
    root.setAttribute('data-find-hits', String(hits.length));
  }, [open, hits, scrollerRef]);

  useLayoutEffect(() => {
    if (!open) {
      clearHighlights();
      return;
    }
    paintHighlights(hits, active);
  }, [open, hits, active]);

  // 当前命中居中。内容再长也先把命中留在视野里——这正是「搜索期间不贴底」的落点。
  useEffect(() => {
    if (!open || !anchored.current) return;
    const root = scrollerRef.current;
    if (root === null || hits[active] === undefined) return;
    autoScrollAt.current = performance.now();
    scrollToHit(root, hits, active);
  }, [open, hits, active, scrollerRef]);

  // 用户自己滚了：取消跟随，别每一次流式更新都把人拽回命中处。
  useEffect(() => {
    if (!open) return;
    const root = scrollerRef.current;
    if (root === null) return;
    const onScroll = () => {
      if (performance.now() - autoScrollAt.current < 200) return;
      anchored.current = false;
    };
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => root.removeEventListener('scroll', onScroll);
  }, [open, scrollerRef]);

  const move = (delta: number): void => {
    if (hits.length === 0) return;
    anchored.current = true;
    setActive((current) => stepMatch(current, hits.length, delta));
  };

  const close = (): void => {
    onOpenChange(false);
  };

  const onBarKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      // 搜索条的 Esc 只关搜索条，不往上冒给画布窗口当「关窗」用。
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'Enter') return;
    // 按钮自己的 Enter 是「按下这个按钮」，不是「下一条」。
    if (event.target instanceof HTMLButtonElement) return;
    event.preventDefault();
    move(event.shiftKey ? -1 : 1);
  };

  if (!open) return null;

  const total = hits.length;
  const countLabel = query === '' ? '' : total === 0 ? '无结果' : `${total} 个结果`;
  const position = total === 0 ? '没有结果' : `第 ${active + 1} 条，共 ${total} 条`;
  const buttonClass =
    'flex size-7 shrink-0 items-center justify-center rounded-sm text-meta text-tertiary hover:bg-card-raised hover:text-primary disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-tertiary';

  return (
    <div
      role="search"
      aria-label="会话内搜索"
      data-testid="find-bar"
      className="flex h-9 shrink-0 items-center border-b border-hair bg-panel/95 px-2 md:px-3"
      onKeyDown={onBarKeyDown}
    >
      <div className="mx-auto flex w-full max-w-[760px] items-center gap-1.5">
        <svg aria-hidden viewBox="0 0 16 16" className="size-3 shrink-0 text-tertiary" fill="none">
          <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <input
          ref={inputRef}
          data-testid="find-input"
          type="text"
          value={query}
          placeholder="在会话内搜索"
          aria-label="在会话内搜索"
          autoComplete="off"
          spellCheck={false}
          className="h-7 min-w-0 flex-1 bg-transparent text-body text-primary outline-none placeholder:text-tertiary"
          onChange={(event) => {
            anchored.current = true;
            setQuery(event.target.value);
          }}
        />
        <span
          role="status"
          aria-live="polite"
          aria-label={position}
          title={position}
          data-testid="find-count"
          className="min-w-16 shrink-0 text-right text-meta tabular-nums text-tertiary"
        >
          {countLabel}
        </span>
        <button
          type="button"
          data-testid="find-prev"
          className={buttonClass}
          aria-label="上一个结果"
          title="上一个结果（Shift+Enter）"
          disabled={total === 0}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => move(-1)}
        >
          ↑
        </button>
        <button
          type="button"
          data-testid="find-next"
          className={buttonClass}
          aria-label="下一个结果"
          title="下一个结果（Enter）"
          disabled={total === 0}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => move(1)}
        >
          ↓
        </button>
        <button
          type="button"
          data-testid="find-close"
          className={buttonClass}
          aria-label="关闭搜索"
          title="关闭搜索（Esc）"
          onClick={close}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
