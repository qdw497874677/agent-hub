import { useEffect, useLayoutEffect, useRef } from 'react';
import { isNearBottom } from './stick-to-bottom.ts';

/**
 * 对话区跟着最新消息走（专注对话页和画布卡片共用）。
 * - 打开 / 换会话（resetKey 变了）、历史载入：直接滚到最后。
 * - 流式输出、新消息：用户本来就在底部附近才跟着滚；往上翻着看历史时不打扰。
 * 内容变化用 MutationObserver 盯，不靠调用方传依赖——流式追加文字时块数和 seq 都可能不变。
 */
export function useStickToBottom<T extends HTMLElement>(resetKey: string) {
  const ref = useRef<T | null>(null);
  const stick = useRef(true);

  useLayoutEffect(() => {
    stick.current = true;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [resetKey]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 上一次贴底后的内容高度：内容变了再按「变之前」的高度判断用户是不是还在底部，
    // 免得用户刚翻上去、scroll 事件还没派发，新消息就把他拽回去。
    let lastHeight = el.scrollHeight;
    const onScroll = () => {
      stick.current = isNearBottom(el);
    };
    const follow = () => {
      const { scrollTop, clientHeight } = el;
      if (stick.current && !isNearBottom({ scrollTop, clientHeight, scrollHeight: lastHeight })) stick.current = false;
      if (stick.current) el.scrollTop = el.scrollHeight;
      lastHeight = el.scrollHeight;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    const observer = new MutationObserver(follow);
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    // 尺寸变化（卡片被拖大、手机转屏、图片载入）也要保持贴底
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(follow);
    resize?.observe(el);
    follow();
    return () => {
      el.removeEventListener('scroll', onScroll);
      observer.disconnect();
      resize?.disconnect();
    };
  }, [resetKey]);

  return ref;
}
