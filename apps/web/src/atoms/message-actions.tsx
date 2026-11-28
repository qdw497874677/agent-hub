import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { ManualCopy } from './copy.tsx';
import { copyText } from './clipboard.ts';
import { Icon } from './icons.tsx';
import { MENU_WIDTH, menuPosition } from './session-actions.ts';

type MessageAction = 'copy' | 'quote';

function MessageMenu({ anchor, state, onPick, onClose }: {
  anchor: { x: number; y: number };
  state: 'idle' | 'copied' | 'manual';
  onPick: (id: MessageAction) => void;
  onClose: (refocus: boolean) => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => { menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true }); }, []);
  const position = menuPosition(anchor, 2, { width: window.innerWidth, height: window.innerHeight });
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(true); return; }
    if (event.key === 'Tab') { onClose(false); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : event.key === 'ArrowDown' ? (index + 1) % buttons.length : (index - 1 + buttons.length) % buttons.length;
    buttons[next]?.focus({ preventScroll: true });
  };
  const itemClass = 'min-h-[44px] px-3 text-left text-meta text-secondary hover:bg-hover hover:text-primary focus-visible:bg-hover focus-visible:outline-2 focus-visible:outline-ring';
  return createPortal(<>
    <div className="fixed inset-0 z-[60]" onPointerDown={() => onClose(false)} onContextMenu={(event) => { event.preventDefault(); onClose(false); }} />
    <div ref={menu} role="menu" aria-label="消息操作" data-testid="message-actions-menu" onKeyDown={onKey} className="fixed z-[61] flex flex-col rounded-lg border border-strong bg-overlay py-1 shadow-overlay" style={{ left: position.left, top: position.top, minWidth: MENU_WIDTH }}>
      <button type="button" role="menuitem" data-testid="message-copy" data-state={state} className={itemClass} onClick={() => onPick('copy')}>{state === 'copied' ? '已复制' : '复制消息'}</button>
      <button type="button" role="menuitem" data-testid="message-quote" className={itemClass} onClick={() => onPick('quote')}>引用到输入框</button>
    </div>
  </>, document.body);
}

/** 只接收当前消息可见的正文；不从 DOM 或相邻工作过程拼文本。 */
export function MessageActions({ text, onQuote }: { text: string; onQuote: (text: string) => void }) {
  // 复制时冻结正文：流式更新不能替换手动复制框里的选中内容。
  const [copy, setCopy] = useState<{ copied: boolean; manualText: string | null; attempts: number }>({ copied: false, manualText: null, attempts: 0 });
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const copyButton = useRef<HTMLButtonElement | null>(null);
  const [touch, setTouch] = useState(() => typeof window === 'undefined' || !window.matchMedia('(pointer: fine)').matches || window.matchMedia('(any-pointer: coarse)').matches);
  const run = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { run.current += 1; if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => {
    const fine = window.matchMedia('(pointer: fine)');
    const coarse = window.matchMedia('(any-pointer: coarse)');
    const update = () => setTouch(!fine.matches || coarse.matches);
    fine.addEventListener('change', update);
    coarse.addEventListener('change', update);
    return () => { fine.removeEventListener('change', update); coarse.removeEventListener('change', update); };
  }, []);
  // 滚动时关闭固定定位的菜单，避免菜单停在已经移走的消息旁。
  useEffect(() => {
    if (!anchor) return;
    const close = () => setAnchor(null);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [anchor]);
  const copyMessage = () => {
    const round = ++run.current;
    const snapshot = text;
    if (timer.current) clearTimeout(timer.current);
    setCopy((prev) => ({ ...prev, copied: false }));
    void copyText(snapshot).then((outcome) => {
      if (round !== run.current) return;
      if (outcome === 'manual') {
        setCopy((prev) => ({ copied: false, manualText: snapshot, attempts: prev.attempts + 1 }));
      } else {
        setCopy((prev) => ({ ...prev, copied: true, manualText: null }));
        timer.current = setTimeout(() => { if (round === run.current) setCopy((prev) => ({ ...prev, copied: false })); }, 1500);
      }
    });
  };
  const closeMenu = (refocus: boolean) => {
    setAnchor(null);
    if (refocus) trigger.current?.focus({ preventScroll: true });
  };
  return (
    <div data-find-skip="" className="contents">
      <div data-testid="message-actions" data-state={copy.copied ? 'copied' : copy.manualText !== null ? 'manual' : 'idle'} className="absolute right-0 top-0 pointer-fine:opacity-0 pointer-fine:group-hover/message:opacity-100 pointer-fine:group-focus-within/message:opacity-100 [@media(any-pointer:coarse)]:!opacity-100 transition-opacity motion-reduce:transition-none">
        {touch ? <button ref={trigger} type="button" data-testid="message-actions-trigger" aria-label="消息操作" aria-haspopup="menu" aria-expanded={anchor !== null} title="消息操作" onClick={(event) => {
          if (anchor) { closeMenu(false); return; }
          const rect = event.currentTarget.getBoundingClientRect();
          setAnchor({ x: rect.right - 168, y: rect.bottom });
        }} className="flex size-[44px] pointer-fine:size-[28px] [@media(any-pointer:coarse)]:!size-[44px] items-center justify-center rounded-sm text-tertiary hover:bg-card-raised hover:text-primary focus-visible:outline-2 focus-visible:outline-ring">
          {copy.copied ? <Icon name="check" size={15} /> : <span aria-hidden className="text-lg leading-none">⋯</span>}
        </button> : <div className="flex">
          <button ref={copyButton} type="button" data-testid="message-copy" data-state={copy.copied ? 'copied' : copy.manualText !== null ? 'manual' : 'idle'} aria-label={copy.copied ? '已复制' : '复制消息'} title={copy.copied ? '已复制' : '复制消息'} onClick={copyMessage} className="flex size-7 items-center justify-center rounded-sm text-tertiary hover:bg-card-raised hover:text-primary focus-visible:outline-2 focus-visible:outline-ring">
            {copy.copied ? <Icon name="check" size={15} /> : <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></svg>}
          </button>
          <button type="button" data-testid="message-quote" aria-label="引用到输入框" title="引用到输入框" onClick={() => onQuote(text)} className="flex size-7 items-center justify-center rounded-sm text-tertiary hover:bg-card-raised hover:text-primary focus-visible:outline-2 focus-visible:outline-ring">
            <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M10 11H5a2 2 0 0 0-2 2v5h6v-5c0-3 1-5 3-6M21 11h-5a2 2 0 0 0-2 2v5h6v-5c0-3 1-5 3-6" /></svg>
          </button>
        </div>}
      </div>
      {anchor ? <MessageMenu
        anchor={anchor} state={copy.copied ? 'copied' : copy.manualText !== null ? 'manual' : 'idle'}
        onClose={closeMenu}
        onPick={(id) => { closeMenu(true); if (id === 'copy') copyMessage(); else onQuote(text); }}
      /> : null}
      <span role="status" aria-live="polite" className="sr-only">{copy.copied ? '已复制' : copy.manualText !== null ? '没法写入剪贴板，请手动复制' : ''}</span>
      {copy.manualText !== null ? <div className="w-full min-w-0 max-w-full text-left">
        <ManualCopy text={copy.manualText} attempt={copy.attempts} testId="message-copy-manual" />
        <button type="button" aria-label="关闭手动复制" data-testid="message-copy-manual-close" className="min-h-[44px] rounded-sm text-meta text-secondary hover:text-primary focus-visible:outline-2 focus-visible:outline-ring" onClick={() => {
          run.current += 1;
          setCopy((prev) => ({ ...prev, manualText: null }));
          (trigger.current ?? copyButton.current)?.focus({ preventScroll: true });
        }}>关闭</button>
      </div> : null}
    </div>
  );
}
