import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import {
  MIN_OVERFLOW,
  contentEffect,
  createFollowState,
  endProbeTarget,
  holdsScroll,
  isFollowing,
  maxScrollOf,
  nearEndOf,
  nextFollowReserve,
  needsBottomSnap,
  needsEndProbe,
  reachedEnd,
  scrollKey,
  transitionFollow,
  type Contact,
  type FollowAction,
  type FollowState,
  type ScrollGeometry,
  type ScrollMetrics,
} from './stick-to-bottom.ts';
import { canRestorePosition, type ScrollPositionKey, type ScrollPositionStore } from './scroll-position-store.ts';

/** 滚动停下来多久算「停」：触屏松手后惯性还在滑，这段时间用来等它真的停。 */
const IDLE_MS = 120;

export interface StickToBottom<T extends HTMLElement> {
  /** 挂到滚动容器上。 */
  readonly ref: RefObject<T | null>;
  /**
   * 离底部够近（`NEAR_END_PX`，宽松阈值，和贴底的 0.5px 无关）：
   * 「回到底部」按钮据此收起。内容不足一屏时恒为 true。
   */
  readonly nearEnd: boolean;
  /** 平滑滚回最后一条（系统开了「减少动态效果」就直接跳）。 */
  readonly scrollToEnd: (smooth?: boolean) => void;
}

/**
 * 对话区跟着最新消息走（专注对话页、画布卡片、子代理面板共用）。
 * - 打开 / 换会话：默认跟随最新；提供 restoration 时恢复该会话的阅读位置。
 * - 流式输出、新消息：只有在「跟随」里才贴底；读者往上翻着看历史时一律不抢。
 * - 状态判定全在 stick-to-bottom.ts 的纯状态机里，这里只做接线：事件 → 动作，状态 → 要不要写 scrollTop。
 * 内容变化用 MutationObserver 盯，不靠调用方传依赖——流式追加文字时块数和 seq 都可能不变。
 *
 * `nearEnd` 复用同一个 scroll 监听（不额外加监听器），只在布尔值变化时 setState。
 */
export interface ScrollRestoration {
  readonly store: ScrollPositionStore;
  readonly key: ScrollPositionKey;
  readonly historyReady: boolean;
}

export function useStickToBottom<T extends HTMLElement>(resetKey: string, restoration?: ScrollRestoration): StickToBottom<T> {
  const ref = useRef<T | null>(null);
  const requestEnd = useRef<((smooth: boolean) => void) | null>(null);
  const refresh = useRef<(() => void) | null>(null);
  const historyReady = useRef(restoration?.historyReady ?? true);
  historyReady.current = restoration?.historyReady ?? true;
  const [nearEnd, setNearEnd] = useState(true);
  const store = restoration?.store;
  const positionKey = restoration ? JSON.stringify(restoration.key) : undefined;

  // 换会话时先清理旧的尾部预留，再定位并接上新状态机，避免旧清理晚于新会话定位。
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const saved = store && positionKey ? { store, key: JSON.parse(positionKey) as ScrollPositionKey } : undefined;
    const follow = attachFollow(el, setNearEnd, saved, () => historyReady.current);
    requestEnd.current = follow.requestEnd;
    refresh.current = follow.refresh;
    return () => {
      requestEnd.current = null;
      refresh.current = null;
      follow.dispose();
    };
  }, [resetKey, store, positionKey]);

  useLayoutEffect(() => { refresh.current?.(); }, [restoration?.historyReady]);

  const scrollToEnd = useCallback((smooth = true) => {
    const reduced =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    requestEnd.current?.(smooth && !reduced);
  }, []);

  return { nearEnd, ref, scrollToEnd };
}

function measureOf(el: HTMLElement): ScrollGeometry {
  return { clientHeight: el.clientHeight, scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
}

/** 把状态机接到一个真实滚动区上；返回卸载函数。 */
function attachFollow(el: HTMLElement, onNearEnd: (value: boolean) => void, saved: { store: ScrollPositionStore; key: ScrollPositionKey } | undefined, historyReady: () => boolean): { requestEnd: (smooth: boolean) => void; refresh: () => void; dispose: () => void } {
  let state: FollowState = createFollowState();
  let last: ScrollGeometry = measureOf(el);
  const previous = saved?.store.read(saved.key);
  let pending = previous && !previous.following ? previous : undefined;
  let lastValid: { scrollTop: number; following: boolean } | undefined;
  // 只有显式提供尾部空间的视图启用：收起活动行时避免整段记录向下弹。
  const spacer = el.querySelector<HTMLElement>('[data-follow-spacer]');
  let reserve = 0;
  let naturalHeight = last.scrollHeight;
  let contact: Contact | null = null;
  let attempt = 0;
  let frame: number | null = null;
  let idle: ReturnType<typeof setTimeout> | null = null;
  let lastScrollAt = 0;
  let smoothReturn = false;
  // 记一份本地值：普通滚动每帧都来，只在跨过阈值时才麻烦 React。
  let near = nearEndOf(last);

  function measure(): ScrollGeometry {
    return measureOf(el);
  }

  /** 按钮的可见性：几何变了就报一次，值没变就什么都不做。 */
  function reportNear(): void {
    const next = nearEndOf(last);
    if (next === near) return;
    near = next;
    onNearEnd(next);
  }

  function metrics(): ScrollMetrics {
    return {
      ...measure(),
      contact,
      previousMaxScroll: maxScrollOf(last),
      previousTop: last.scrollTop
    };
  }

  function dispatch(action: FollowAction): void {
    state = transitionFollow(state, action, metrics());
  }

  function remember(): void {
    if (pending || el.clientHeight === 0) return;
    lastValid = { following: isFollowing(state), scrollTop: el.scrollTop };
    saved?.store.write(saved.key, lastValid);
  }

  function restore(): boolean {
    if (!pending) return false;
    if (!canRestorePosition(pending, measure(), historyReady())) return true;
    el.scrollTop = pending.scrollTop;
    pending = undefined;
    last = measure();
    reportNear();
    remember();
    return true;
  }

  function overflowing(): boolean {
    return maxScrollOf(measure()) > MIN_OVERFLOW;
  }

  /** scrollTop 写超过上限时浏览器会钳到底，正好把缩放下差的那几像素一起吃掉。 */
  function snap(): void {
    if (needsBottomSnap(measure())) el.scrollTop = el.scrollHeight;
    last = measure();
  }

  function runReturn(): void {
    if (state.type !== 'returning') return;
    // 惯性还没走完：等 touchend / 静止（见 onTouchEnd、scheduleIdle）再来。
    if (holdsScroll(contact)) return;

    // 接触期间的内容变化也要先结算预留空间，再贴底。
    onContent();
  }

  function scheduleFrame(): void {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      runReturn();
    });
  }

  function beginReturn(): void {
    attempt += 1;
    dispatch({ attempt, type: 'return.start' });
    scheduleFrame();
  }

  /** 探底：写一下 scrollTop，看浏览器能不能真的滚到底（缩放下会差几像素）。 */
  function probe(): boolean {
    el.scrollTop = endProbeTarget(measure());
    last = measure();

    return reachedEnd(last);
  }

  // 滚动静止后才探底：探测要写 scrollTop，还在滑的时候写会把滚动按停。
  function scheduleIdle(): void {
    if (idle !== null) clearTimeout(idle);
    idle = setTimeout(() => {
      idle = null;
      if (contact === 'momentum') contact = null;

      if (smoothReturn) {
        smoothReturn = false;
        onContent();
      }

      if (needsEndProbe(state, contact)) dispatch({ atEnd: probe(), type: 'scroll.settled' });

      runReturn();
    }, IDLE_MS);
  }

  function onScroll(): void {
    if (el.clientHeight === 0) return;
    lastScrollAt = Date.now();
    if (pending) {
      if (!contact) return;
      pending = undefined;
    }
    dispatch({ type: 'scroll' });
    last = measure();
    reportNear();
    remember();
    scheduleIdle();
  }

  function onWheel(event: WheelEvent): void {
    pending = undefined;
    smoothReturn = false;
    dispatch({ overflow: overflowing(), trigger: 'wheel', type: 'scroll.intent', upward: event.deltaY < 0 });
    remember();
  }

  function onKeyDown(event: KeyboardEvent): void {
    const direction = scrollKey(event.key);
    if (direction === null) return;
    // 输入框里的翻页键是给输入框的，不是给列表的。
    if (event.target !== el && isTextEntry(event.target)) return;

    pending = undefined;
    smoothReturn = false;

    dispatch({
      overflow: overflowing(),
      trigger: 'keyboard',
      type: 'scroll.intent',
      upward: direction === 'up'
    });
    remember();
  }

  function onContent(): void {
    // 隐藏页签没有可用的布局尺寸，别把它当成内容清空。
    if (el.clientHeight === 0) return;
    if (restore()) return;
    const effect = contentEffect(state, contact);
    const current = measure();
    const nextHeight = current.scrollHeight - reserve;

    // 不在读者手指或惯性期间改几何，也不改变离底阅读的位置。
    // 预留有上限，后续输出先填补空白；不借此伪造任何状态提示。
    if (spacer && effect === 'snap' && maxScrollOf(last) > MIN_OVERFLOW) {
      const next = nextFollowReserve(naturalHeight, nextHeight, reserve);
      if (next !== reserve) {
        reserve = next;
        spacer.style.height = `${reserve}px`;
      }
    }
    if (effect !== 'defer') naturalHeight = nextHeight;

    if (effect === 'idle') {
      // 停在读者放下的地方：只记住新的尺寸，等下一次滚动再判定。
      last = measure();
      reportNear();
      remember();
      return;
    }

    if (effect === 'defer') {
      beginReturn();
      return;
    }

    // 平滑回底过程中不让内容观察器打断动画；静止后再补齐新的内容。
    if (smoothReturn) return;

    snap();
    if (state.type === 'returning') dispatch({ attempt: state.attempt, type: 'return.run' });
    remember();
  }

  function onPointerDown(event: PointerEvent): void {
    // 触屏走 touch 那条：只有那里拿得到松手之后的惯性。
    if (event.pointerType === 'touch') return;
    smoothReturn = false;
    contact = 'pointer';
  }

  function onPointerUp(): void {
    if (contact === 'pointer') contact = null;
  }

  function onTouchStart(): void {
    smoothReturn = false;
    contact = 'touch';
  }

  function onTouchEnd(): void {
    // 刚才还在滚：手指虽然抬起来了，惯性还在走，先按「惯性」算。
    contact = Date.now() - lastScrollAt < IDLE_MS ? 'momentum' : null;

    if (!holdsScroll(contact)) runReturn();
  }

  function onContactLost(): void {
    contact = null;
  }

  function onVisibilityChange(): void {
    if (document.visibilityState === 'hidden') contact = null;
  }

  const observer =
    typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver(() => {
          onContent();
        });
  observer?.observe(el, { characterData: true, childList: true, subtree: true });

  const resize =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          onContent();
        });
  resize?.observe(el);
  // 容器高度不变时，图片或异步排版仍可能改变记录高度。
  if (el.firstElementChild) resize?.observe(el.firstElementChild);

  el.addEventListener('scroll', onScroll, { passive: true });
  el.addEventListener('wheel', onWheel, { passive: true });
  el.addEventListener('keydown', onKeyDown);
  el.addEventListener('pointerdown', onPointerDown);
  el.addEventListener('pointerup', onPointerUp);
  el.addEventListener('pointercancel', onPointerUp);
  el.addEventListener('touchstart', onTouchStart, { passive: true });
  el.addEventListener('touchend', onTouchEnd);
  el.addEventListener('touchcancel', onTouchEnd);
  window.addEventListener('blur', onContactLost);
  document.addEventListener('visibilitychange', onVisibilityChange);

  dispatch({ type: 'attach' });
  if (pending) dispatch({ type: 'detach' });
  if (!restore() && el.clientHeight > 0) snap();
  onNearEnd(nearEndOf(last));
  reportNear();
  remember();

  function requestEnd(smooth: boolean): void {
    const prior = pending;
    pending = undefined;
    dispatch({ type: 'follow.request' });
    smoothReturn = smooth;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    if (el.clientHeight > 0) remember();
    else if (lastValid || prior) {
      lastValid = { following: true, scrollTop: (lastValid ?? prior)!.scrollTop };
      saved?.store.write(saved.key, lastValid);
    }
    if (smooth) scheduleIdle();
  }

  function dispose(): void {
    // React may already have replaced or hidden the old session's DOM at cleanup.
    if (!pending && lastValid) saved?.store.write(saved.key, lastValid);
    if (frame !== null) cancelAnimationFrame(frame);
    if (idle !== null) clearTimeout(idle);
    observer?.disconnect();
    resize?.disconnect();
    if (spacer) spacer.style.height = '';
    el.removeEventListener('scroll', onScroll);
    el.removeEventListener('wheel', onWheel);
    el.removeEventListener('keydown', onKeyDown);
    el.removeEventListener('pointerdown', onPointerDown);
    el.removeEventListener('pointerup', onPointerUp);
    el.removeEventListener('pointercancel', onPointerUp);
    el.removeEventListener('touchstart', onTouchStart);
    el.removeEventListener('touchend', onTouchEnd);
    el.removeEventListener('touchcancel', onTouchEnd);
    window.removeEventListener('blur', onContactLost);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  }
  return { dispose, refresh: onContent, requestEnd };
}

/** 输入类元素：它们自己会用翻页键。 */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;

  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
}
