import { Icon } from './icons.tsx';

/**
 * 设置页统一的保存反馈：一律放在保存按钮左边。
 * 有改动 → 「未保存」；刚存完且没再改 → ✓ 已保存；其它时候不占字。
 */
export function SaveStatus({ dirty, saved, testId }: { dirty: boolean; saved: boolean; testId?: string }) {
  if (dirty) {
    return (
      <span className="inline-flex items-center gap-1.5 text-meta text-tertiary" data-testid={testId ? `${testId}-dirty` : undefined}>
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[var(--color-fg-faint)]" />
        未保存
      </span>
    );
  }
  if (!saved) return null;
  return (
    <span role="status" className="inline-flex items-center gap-1 text-meta text-success" data-testid={testId}>
      <Icon name="check" size={12} />
      已保存
    </span>
  );
}
