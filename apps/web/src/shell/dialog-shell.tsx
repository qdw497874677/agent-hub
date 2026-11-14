import { useEffect, type ReactNode } from 'react';

/**
 * 对话框共用的壳：遮罩点一下或按 Esc 就关；窄屏上贴底（拇指够得着），宽屏居中。
 * role=dialog + aria-modal，读屏能知道背后的画布暂时不可操作。
 *
 * 给了 footer 就成了「粘底」结构：标题/内容区自己滚，footer 常驻在面板底部。
 * 手机上内容再长，取消/开始也不会被滚出去或被浏览器工具栏挤掉（安全区仍由外层遮罩的
 * pb-[max(0.75rem,env(safe-area-inset-bottom))] 兜住）。
 */
export function DialogShell({
  title,
  onClose,
  children,
  footer,
  wide = false,
  testId
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** 常驻底部的操作区（取消/开始这类）。有它时内容区自己滚动，footer 不跟着滚。 */
  footer?: ReactNode;
  /** 放 diff、文件这类宽内容：更宽，且内容区自己滚动。 */
  wide?: boolean;
  /** 面板上的 data-testid：弹窗自己的名字，别拿标题去猜。 */
  testId?: string;
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
        data-testid={testId}
        className={`w-full rounded-md border border-strong bg-panel ${
          footer === undefined
            ? `p-4 ${wide ? 'relative flex max-h-[88dvh] max-w-[820px] flex-col' : 'max-h-[88dvh] max-w-[420px] overflow-y-auto overscroll-contain'}`
            : `relative flex max-h-[88dvh] flex-col overflow-hidden ${wide ? 'max-w-[820px]' : 'max-w-[420px]'}`
        }`}
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
        {footer === undefined ? (
          children
        ) : (
          <>
            {/* 唯一会滚的东西：内容。min-h-0 让 flex 子项真的能缩下去，不然它会把 footer 顶出面板。 */}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">{children}</div>
            <div
              data-testid={testId === undefined ? undefined : `${testId}-footer`}
              className="shrink-0 border-t border-hair bg-panel px-4 pb-3 pt-2"
            >
              {footer}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export const INPUT =
  'min-h-11 w-full rounded-sm border border-hair bg-card px-2.5 py-2 text-body text-primary outline-none placeholder:text-tertiary focus:border-accent disabled:text-tertiary md:min-h-0';
export const SECONDARY_BUTTON =
  'min-h-11 rounded-sm border border-hair px-3 py-1.5 text-sub text-secondary hover:border-strong hover:text-primary md:min-h-0';
export const PRIMARY_BUTTON = 'min-h-11 rounded-sm bg-accent px-3 py-1.5 text-sub text-canvas hover:brightness-110 disabled:opacity-40 md:min-h-0';
/** 真会丢东西的操作：实心 rust 按钮 + 深色字，和普通确认拉开距离。 */
export const DANGER_BUTTON = 'min-h-11 rounded-sm bg-rust px-3 py-1.5 text-sub text-canvas hover:brightness-110 disabled:opacity-40 md:min-h-0';
export const SMALL_BUTTON = 'shrink-0 rounded-sm border border-hair px-2 py-1 text-meta text-secondary hover:border-accent hover:text-accent disabled:opacity-40';

