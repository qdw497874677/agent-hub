import type { ReactNode } from 'react';
import { Icon, type IconName } from './icons.tsx';

export type NoticeTone = 'warning' | 'danger' | 'info' | 'success';

const TONE: Record<NoticeTone, { readonly icon: IconName; readonly text: string; readonly box: string }> = {
  warning: { icon: 'warning', text: 'text-warning', box: 'border-warning/35 bg-warning-bg' },
  danger: { icon: 'alert', text: 'text-danger', box: 'border-danger/35 bg-danger-bg' },
  info: { icon: 'info', text: 'text-info', box: 'border-info/35 bg-info-bg' },
  success: { icon: 'check', text: 'text-success', box: 'border-success/35 bg-success-bg' }
};

/**
 * 提示条（令牌 v2）：警告 / 失败 / 信息各一色，并且总带图标——不靠颜色一项区分，
 * 也不再借用「在跑」的琥珀。`inline` 只是一行带图标的文字，`box` 带淡底和细边。
 */
export function Notice({
  tone,
  children,
  variant = 'inline',
  className = '',
  testId,
  role
}: {
  tone: NoticeTone;
  children: ReactNode;
  variant?: 'inline' | 'box';
  className?: string;
  testId?: string;
  role?: 'status' | 'alert';
}) {
  const t = TONE[tone];
  return (
    <p
      role={role ?? (tone === 'danger' ? 'alert' : 'status')}
      data-testid={testId}
      data-tone={tone}
      className={`flex min-w-0 items-start gap-1.5 text-meta ${t.text} ${
        variant === 'box' ? `rounded-[var(--radius-control)] border px-2.5 py-1.5 ${t.box}` : ''
      } ${className}`}
    >
      <Icon name={t.icon} size={13} className="mt-[1px]" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}
