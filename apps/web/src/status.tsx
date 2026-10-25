import type { SessionDto } from './api.ts';

/**
 * 会话状态位（visual-direction §7）：形状和颜色一起说话，色盲也分得清。
 * 运行中=琥珀实心点，完成=灰绿空心圆，已停止=灰方块，中断/失败=锈色方块。
 * 画布卡片、列表、专注对话都用这一份，免得三处各说各话。
 */
export const STATUS: Record<SessionDto['status'], { label: string; dot: string; shape: string }> = {
  running: { label: '运行中', dot: 'bg-accent', shape: 'rounded-full' },
  done: { label: '完成', dot: 'border border-sage', shape: 'rounded-full' },
  stopped: { label: '已停止', dot: 'border border-tertiary', shape: 'rounded-sm' },
  interrupted: { label: '中断', dot: 'bg-rust', shape: 'rounded-sm' },
  failed: { label: '失败', dot: 'bg-rust', shape: 'rounded-sm' }
};

export function StatusPill({ status, reason }: { status: SessionDto['status']; reason?: string | null }) {
  const style = STATUS[status];
  return (
    <span className="flex items-center gap-1.5 text-meta text-secondary" title={reason ?? style.label}>
      <span className={`block size-[7px] ${style.dot} ${style.shape}`} />
      {style.label}
    </span>
  );
}
