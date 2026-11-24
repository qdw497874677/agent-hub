import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { copyText } from './clipboard.ts';

/** 拿不到剪贴板时，选中已经在页面上的文字，让人按快捷键复制。 */
export function selectElementText(node: Node | null): void {
  const doc = node?.ownerDocument;
  const selection = doc?.getSelection();
  if (!node || !doc || !selection) return;
  const range = doc.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * 复制动作的共享状态：只有原生剪贴板真的写成功才显示「已复制」。
 * 失败时置 manual，让调用方决定是把同一段文字摊成只读输入框，还是选中页面上已有的文字。
 * 这些动作只在点击时发生——渲染、挂载、列表刷新都不会顺手写剪贴板。
 */
export interface CopyAction {
  readonly copied: boolean;
  readonly manual: boolean;
  /** 每次落到手动复制 +1：同一段文字再点一次，也能重新聚焦并全选。 */
  readonly attempts: number;
  copy(): void;
  /** 换标签 / 换令牌 / 关弹窗时清掉“已复制”，别把上一段文字的结果带过去。 */
  reset(): void;
}

const COPIED_MS = 1_500;

interface CopyState {
  /** 这份状态属于哪一段文字；和当前 value 不一致时一律当作新的、干净的状态。 */
  readonly value: string;
  readonly copied: boolean;
  readonly manual: boolean;
  readonly attempts: number;
}

const IDLE = (value: string): CopyState => ({ value, copied: false, manual: false, attempts: 0 });

export function useCopy(value: string, options: { onManual?: () => void } = {}): CopyAction {
  const [state, setState] = useState<CopyState>(() => IDLE(value));
  const run = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 当前 value 的同步记录：换值之后，上一段文字的异步结果不能再落回来。
  const active = useRef(value);
  const onManual = useRef(options.onManual);
  onManual.current = options.onManual;

  const stop = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    run.current += 1;
    stop();
    setState(IDLE(active.current));
  }, [stop]);

  // 换值 = 换一次复制动作：清掉「已复制 / 手动选中」，也作废还在路上的写入。
  // 布局阶段完成，避免上一段的 manual 字段在新内容上短暂出现、被自动聚焦。
  useLayoutEffect(() => {
    active.current = value;
    run.current += 1;
    stop();
    setState((prev) =>
      prev.value === value && !prev.copied && !prev.manual && prev.attempts === 0 ? prev : IDLE(value)
    );
  }, [value, stop]);

  const copy = useCallback(() => {
    const requested = value;
    const round = ++run.current;
    stop();
    setState((prev) => (prev.value === requested ? { ...prev, copied: false } : IDLE(requested)));
    void copyText(requested).then((outcome) => {
      // 换过文字或又点过别的地方：这次结果已经过期，既不更新状态，也不触发 onManual。
      if (round !== run.current || active.current !== requested) return;
      if (outcome === 'copied') {
        setState((prev) => (prev.value === requested ? { ...prev, copied: true, manual: false } : prev));
        timer.current = setTimeout(() => {
          timer.current = null;
          if (round !== run.current || active.current !== requested) return;
          setState((prev) => (prev.value === requested ? { ...prev, copied: false } : prev));
        }, COPIED_MS);
        return;
      }
      setState((prev) =>
        prev.value === requested ? { ...prev, copied: false, manual: true, attempts: prev.attempts + 1 } : prev
      );
      onManual.current?.();
    });
  }, [stop, value]);

  useEffect(
    () => () => {
      run.current += 1;
      stop();
    },
    [stop]
  );

  const live = state.value === value;
  return {
    copied: live && state.copied,
    manual: live && state.manual,
    attempts: live ? state.attempts : 0,
    copy,
    reset
  };
}

/**
 * 复制按钮：视觉完全由 className 决定，字和状态跟着 CopyAction 走。
 * 屏幕阅读器用隐藏的状态行听结果；手动复制时不在这里说“成功”。
 */
export function CopyButton({
  action,
  className,
  label = '复制',
  copiedLabel = '已复制',
  ariaLabel,
  testId,
  title,
  disabled
}: {
  action: CopyAction;
  className?: string;
  label?: string;
  copiedLabel?: string;
  ariaLabel?: string;
  testId?: string;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <>
      <button
        type="button"
        data-testid={testId}
        data-state={action.copied ? 'copied' : action.manual ? 'manual' : 'idle'}
        aria-label={ariaLabel}
        title={title}
        className={className}
        disabled={disabled}
        onClick={action.copy}
      >
        {action.copied ? copiedLabel : label}
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {action.copied ? copiedLabel : action.manual ? '没法写入剪贴板，请手动复制' : ''}
      </span>
    </>
  );
}

/**
 * 手动复制字段：剪贴板不可用 / 被拒时，把要复制的原文摊成只读 textarea。
 * 出现即聚焦并全选；同一段再失败一次（attempt 变化）也会重新选中。
 * 说清楚“没法写入剪贴板”，不说复制成功。
 */
export function ManualCopy({
  text,
  attempt,
  testId,
  label = '没法写入剪贴板，下面是同一段内容；已选中，可直接复制',
  rows,
  className
}: {
  text: string;
  attempt: number;
  testId: string;
  label?: string;
  rows?: number;
  className?: string;
}) {
  const id = useId();
  const field = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const node = field.current;
    if (node === null) return;
    node.focus();
    node.select();
  }, [attempt, text]);
  const lines = Math.min(Math.max(rows ?? text.split('\n').length, 3), 8);
  return (
    <div className={className} data-testid={testId}>
      <label htmlFor={id} className="block text-meta text-tertiary">
        {label}
      </label>
      <textarea
        id={id}
        ref={field}
        readOnly
        rows={lines}
        value={text}
        spellCheck={false}
        data-testid={`${testId}-text`}
        className="mt-0.5 w-full resize-none rounded-sm border border-hair bg-card px-2 py-1 font-mono text-[11px] leading-4 text-primary"
        onFocus={(event) => event.currentTarget.select()}
      />
    </div>
  );
}
