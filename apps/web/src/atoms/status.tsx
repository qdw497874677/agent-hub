import type { SessionDto } from '../shell/api.ts';

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

const READY = { label: '就绪', dot: 'border border-sage', shape: 'rounded-full' };

/** 状态位要显示的样子：running + 从没发过话 = 就绪。 */
export function statusStyle(status: SessionDto['status'], lastSeq?: number) {
  return status === 'running' && lastSeq === 0 ? READY : STATUS[status];
}

export function StatusPill({
  status,
  reason,
  lastSeq,
  attention
}: {
  status: SessionDto['status'];
  reason?: string | null;
  lastSeq?: number;
  /**
   * 回合已经结束、当前仍挂着「等回答」时才传：把主状态说成「等你回答 / 可能在等你」，
   * 标题里说明上一轮已结束。运行状态本身不变，也不表示 runtime 正在等协议回复。
   */
  attention?: { possible: boolean } | null;
}) {
  if (attention) {
    const label = attention.possible ? '可能在等你' : '等你回答';
    return (
      <span
        data-testid="session-attention-status"
        data-possible={attention.possible ? 'true' : 'false'}
        className={`flex shrink-0 items-center gap-1.5 text-meta ${attention.possible ? 'text-secondary' : 'text-rust'}`}
        title={attention.possible ? '上一轮已结束；最后一句是问句，可能还需要你回复。' : '上一轮已结束；问题留给了你，回复会接着这条会话。'}
        aria-label={`${label}；上一轮已结束，${attention.possible ? '最后一句是问句，可能还需要你回复' : '问题留给了你'}`}
      >
        <span className="block size-[7px] rounded-full border border-current" />
        {label}
      </span>
    );
  }
  const style = statusStyle(status, lastSeq);
  return (
    <span className="flex items-center gap-1.5 text-meta text-secondary" title={reason ?? (style === READY ? '就绪：等你发第一句话' : style.label)}>
      <span className={`block size-[7px] ${style.dot} ${style.shape}`} />
      {style.label}
    </span>
  );
}
