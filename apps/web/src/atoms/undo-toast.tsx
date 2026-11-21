import { useEffect, useRef } from 'react';

/**
 * 删除 / 收起之后的「撤销」条。
 *
 * 位置固定底部中间：手机上也压不到底栏（底栏是 composer，这里 z 更高、只在自己那屏出现）。
 * 只在真的能还原时才显示——按钮点下去发的是同一个恢复请求，失败就把原因写在条里，
 * 不假装成功（「假的撤销」比没有撤销更糟）。
 */
export function UndoToast({
  message,
  actionLabel = '撤销',
  pending = false,
  error,
  onAction,
  onDismiss
}: {
  message: string;
  actionLabel?: string;
  pending?: boolean;
  /** 撤销失败的原因：有它就不自动消失，等用户看清再点 × 或重试。 */
  error?: string | null;
  onAction(): void;
  onDismiss(): void;
}) {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    if (error) return;
    const timer = window.setTimeout(() => dismiss.current(), 8000);
    return () => window.clearTimeout(timer);
  }, [error]);

  return (
    <div
      data-testid="undo-toast"
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] z-[70] flex justify-center px-3"
    >
      <div className="pointer-events-auto flex w-full max-w-[420px] items-center gap-2 rounded-md border border-strong bg-overlay px-3 py-2 shadow-overlay">
        <span className="min-w-0 flex-1 text-sub text-secondary">
          <span className="block truncate">{message}</span>
          {error ? <span className="mt-0.5 block text-meta text-rust">撤销失败：{error}</span> : null}
        </span>
        <button
          type="button"
          data-testid="undo-toast-action"
          className="flex min-h-[44px] shrink-0 items-center rounded-sm px-2 text-sub text-link hover:underline disabled:opacity-50 md:min-h-[32px]"
          disabled={pending}
          onClick={onAction}
        >
          {pending ? '还原中…' : actionLabel}
        </button>
        <button
          type="button"
          aria-label="关掉提示"
          className="flex size-[44px] shrink-0 items-center justify-center rounded-sm text-body text-tertiary hover:text-primary md:size-8"
          onClick={onDismiss}
        >
          ×
        </button>
      </div>
    </div>
  );
}
