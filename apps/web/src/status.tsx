import type { SessionDto } from './api.ts';

/**
 * 会话状态位（visual-direction §7）：形状和颜色一起说话，色盲也分得清。
 * 运行中=琥珀实心点，完成=灰绿空心圆，已停止=灰方块，中断/失败=锈色方块。
 * 画布卡片、列表、专注对话都用这一份，免得三处各说各话。
 *
 * 「就绪」不是一种存储状态：running 但一句话都还没收到（lastSeq = 0，刚派生或刚分叉）。
 * 进程在、能接话，可它没在干活——别显示成「运行中」，琥珀空心圆。
 */
export const STATUS: Record<SessionDto['status'], { label: string; dot: string; shape: string }> = {
  running: { label: '运行中', dot: 'bg-accent', shape: 'rounded-full' },
  done: { label: '完成', dot: 'border border-sage', shape: 'rounded-full' },
  stopped: { label: '已停止', dot: 'border border-tertiary', shape: 'rounded-sm' },
  interrupted: { label: '中断', dot: 'bg-rust', shape: 'rounded-sm' },
  failed: { label: '失败', dot: 'bg-rust', shape: 'rounded-sm' }
};

const READY = { label: '就绪', dot: 'border border-accent', shape: 'rounded-full' };

/** 状态位要显示的样子：running + 从没发过话 = 就绪。 */
export function statusStyle(status: SessionDto['status'], lastSeq?: number) {
  return status === 'running' && lastSeq === 0 ? READY : STATUS[status];
}

export function StatusPill({ status, reason, lastSeq }: { status: SessionDto['status']; reason?: string | null; lastSeq?: number }) {
  const style = statusStyle(status, lastSeq);
  return (
    <span className="flex items-center gap-1.5 text-meta text-secondary" title={reason ?? (style === READY ? '就绪：等你发第一句话' : style.label)}>
      <span className={`block size-[7px] ${style.dot} ${style.shape}`} />
      {style.label}
    </span>
  );
}
