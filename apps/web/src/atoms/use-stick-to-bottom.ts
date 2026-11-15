import { useEffect, useLayoutEffect, useRef } from 'react';
import {
  MIN_OVERFLOW,
  contentEffect,
  createFollowState,
  endProbeTarget,
  holdsScroll,
  maxScrollOf,
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

/** 滚动停下来多久算「停」：触屏松手后惯性还在滑，这段时间用来等它真的停。 */
const IDLE_MS = 120;

/**
 * 对话区跟着最新消息走（专注对话页、画布卡片、子代理面板共用）。
 * - 打开 / 换会话（resetKey 变了）：直接滚到最后，从跟随重新开始。
 * - 流式输出、新消息：只有在「跟随」里才贴底；读者往上翻着看历史时一律不抢。
 * - 状态判定全在 stick-to-bottom.ts 的纯状态机里，这里只做接线：事件 → 动作，状态 → 要不要写 scrollTop。
 * 内容变化用 MutationObserver 盯，不靠调用方传依赖——流式追加文字时块数和 seq 都可能不变。
 */
export function useStickToBottom<T extends HTMLElement>(resetKey: string) {
  const ref = useRef<T | null>(null);

  // 换会话、首次挂载：先落到最后，别让首帧闪在顶部（状态机随后从 following 重来）。
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [resetKey]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return attachFollow(el);
  }, [resetKey]);

  return ref;
}

/** 把状态机接到一个真实滚动区上；返回卸载函数。 */
function attachFollow(el: HTMLElement): () => void {
  let state: FollowState = createFollowState();
  let last: ScrollGeometry = measure();
  let contact: Contact | null = null;
  let attempt = 0;
  let frame: number | null = null;
  let idle: ReturnType<typeof setTimeout> | null = null;
  let lastScrollAt = 0;

  function measure(): ScrollGeometry {
    return { clientHeight: el.clientHeight, scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
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

  function overflowing(): boolean {
    return maxScrollOf(measure()) > MIN_OVERFLOW;
  }

  /** scrollTop 写超过上限时浏览器会钳到底，正好把缩放下差的那几像素一起吃掉。 */
  function snap(): void {
    if (el.scrollTop !== el.scrollHeight) el.scrollTop = el.scrollHeight;
    last = measure();
  }

  function runReturn(): void {
    if (state.type !== 'returning') return;
    // 惯性还没走完：等 touchend / 静止（见 onTouchEnd、scheduleIdle）再来。
    if (holdsScroll(contact)) return;

    const pending = state.attempt;
    snap();
    dispatch({ attempt: pending, type: 'return.run' });
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

      if (needsEndProbe(state, contact)) dispatch({ atEnd: probe(), type: 'scroll.settled' });

      runReturn();
    }, IDLE_MS);
  }

  function onScroll(): void {
    lastScrollAt = Date.now();
    dispatch({ type: 'scroll' });
    last = measure();
    scheduleIdle();
  }

  function onWheel(event: WheelEvent): void {
    dispatch({ overflow: overflowing(), trigger: 'wheel', type: 'scroll.intent', upward: event.deltaY < 0 });
  }

  function onKeyDown(event: KeyboardEvent): void {
    const direction = scrollKey(event.key);
    if (direction === null) return;
    // 输入框里的翻页键是给输入框的，不是给列表的。
    if (event.target !== el && isTextEntry(event.target)) return;

    dispatch({
      overflow: overflowing(),
      trigger: 'keyboard',
      type: 'scroll.intent',
      upward: direction === 'up'
    });
  }

  function onContent(): void {
    const effect = contentEffect(state, contact);

    if (effect === 'idle') {
      // 停在读者放下的地方：只记住新的尺寸，等下一次滚动再判定。
      last = measure();
      return;
    }

    if (effect === 'defer') {
      beginReturn();
      return;
    }

    snap();
    if (state.type === 'returning') dispatch({ attempt: state.attempt, type: 'return.run' });
  }

  function onPointerDown(event: PointerEvent): void {
    // 触屏走 touch 那条：只有那里拿得到松手之后的惯性。
    if (event.pointerType === 'touch') return;
    contact = 'pointer';
  }

  function onPointerUp(): void {
    if (contact === 'pointer') contact = null;
  }

  function onTouchStart(): void {
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
  snap();

  return () => {
    if (frame !== null) cancelAnimationFrame(frame);
    if (idle !== null) clearTimeout(idle);
    observer?.disconnect();
    resize?.disconnect();
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
  };
}

/** 输入类元素：它们自己会用翻页键。 */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;

  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
}
