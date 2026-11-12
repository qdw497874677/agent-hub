import { useEffect, type ReactNode } from 'react';

/**
 * 对话框共用的壳：遮罩点一下或按 Esc 就关；窄屏上贴底（拇指够得着），宽屏居中。
 * role=dialog + aria-modal，读屏能知道背后的画布暂时不可操作。
 */
export function DialogShell({
  title,
  onClose,
  children,
  wide = false
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** 放 diff、文件这类宽内容：更宽，且内容区自己滚动。 */
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-canvas/75 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:items-center sm:pb-0"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`w-full rounded-md border border-strong bg-panel p-4 ${wide ? 'relative flex max-h-[88dvh] max-w-[820px] flex-col' : 'max-h-[88dvh] max-w-[420px] overflow-y-auto overscroll-contain'}`}
        onClick={(event) => event.stopPropagation()}
      >
        {wide ? (
          <button
            aria-label="关闭"
            className="absolute right-2 top-2 flex h-11 w-11 items-center justify-center rounded-sm text-body text-tertiary hover:text-primary"
            onClick={onClose}
          >
            ×
          </button>
        ) : null}
        {children}
      </div>
    </div>
  );
}

export const INPUT =
  'min-h-11 w-full rounded-sm border border-hair bg-card px-2.5 py-2 text-body text-primary outline-none placeholder:text-tertiary focus:border-accent disabled:text-tertiary md:min-h-0';
export const SECONDARY_BUTTON =
  'min-h-11 rounded-sm border border-hair px-3 py-1.5 text-sub text-secondary hover:border-strong hover:text-primary md:min-h-0';
export const PRIMARY_BUTTON = 'min-h-11 rounded-sm bg-accent px-3 py-1.5 text-sub text-canvas hover:brightness-110 disabled:opacity-40 md:min-h-0';

