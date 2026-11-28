import { useEffect, useRef, useState } from 'react';
import { ManualCopy } from './copy.tsx';
import { copyText } from './clipboard.ts';
import { Icon } from './icons.tsx';

/** 只接收当前消息可见的正文；不从 DOM 或相邻工作过程拼文本。 */
export function MessageActions({ text, onQuote, align = 'start' }: { text: string; onQuote: (text: string) => void; align?: 'start' | 'end' }) {
  // 复制时冻结正文：流式更新不能替换手动复制框里的选中内容。
  const [copy, setCopy] = useState<{ copied: boolean; manualText: string | null; attempts: number }>({ copied: false, manualText: null, attempts: 0 });
  const copyButton = useRef<HTMLButtonElement | null>(null);
  const run = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { run.current += 1; if (timer.current) clearTimeout(timer.current); }, []);
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
  return (
    <div data-find-skip="" className={`w-full ${align === 'end' ? 'text-right' : ''}`}>
      <div data-testid="message-actions" className={`flex h-[44px] pointer-fine:h-[28px] [@media(any-pointer:coarse)]:!h-[44px] ${align === 'end' ? 'justify-end' : ''} pointer-fine:opacity-0 pointer-fine:group-hover/message:opacity-100 pointer-fine:group-focus-within/message:opacity-100 [@media(any-pointer:coarse)]:!opacity-100 transition-opacity motion-reduce:transition-none`}>
        <button ref={copyButton} type="button" data-testid="message-copy" data-state={copy.copied ? 'copied' : copy.manualText !== null ? 'manual' : 'idle'} aria-label={copy.copied ? '已复制' : '复制消息'} title={copy.copied ? '已复制' : '复制消息'} onClick={copyMessage} className="flex size-[44px] pointer-fine:size-[28px] [@media(any-pointer:coarse)]:!size-[44px] items-center justify-center rounded-sm text-tertiary hover:bg-card-raised hover:text-primary focus-visible:outline-2 focus-visible:outline-ring">
          {copy.copied ? <Icon name="check" size={15} /> : <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></svg>}
        </button>
        <button type="button" data-testid="message-quote" aria-label="引用到输入框" title="引用到输入框" onClick={() => onQuote(text)} className="flex size-[44px] pointer-fine:size-[28px] [@media(any-pointer:coarse)]:!size-[44px] items-center justify-center rounded-sm text-tertiary hover:bg-card-raised hover:text-primary focus-visible:outline-2 focus-visible:outline-ring">
          <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M10 11H5a2 2 0 0 0-2 2v5h6v-5c0-3 1-5 3-6M21 11h-5a2 2 0 0 0-2 2v5h6v-5c0-3 1-5 3-6" /></svg>
        </button>
      </div>
      <span role="status" aria-live="polite" className="sr-only">{copy.copied ? '已复制' : copy.manualText !== null ? '没法写入剪贴板，请手动复制' : ''}</span>
      {copy.manualText !== null ? <div className="max-w-full text-left">
        <ManualCopy text={copy.manualText} attempt={copy.attempts} testId="message-copy-manual" />
        <button type="button" aria-label="关闭手动复制" data-testid="message-copy-manual-close" className="min-h-[44px] rounded-sm text-meta text-secondary hover:text-primary focus-visible:outline-2 focus-visible:outline-ring" onClick={() => {
          run.current += 1;
          setCopy((prev) => ({ ...prev, manualText: null }));
          copyButton.current?.focus({ preventScroll: true });
        }}>关闭</button>
      </div> : null}
    </div>
  );
}
