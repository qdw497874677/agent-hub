import type { SessionDto } from '@agent-hub/contract';

/**
 * 会话在界面上「是什么状态」（docs/design/interaction-borrowing.md §1）：
 * 状态是注意力，不是元数据。六种，够人一眼分清「在干活 / 出事了 / 歇着」。
 *
 * `settled`（收起）压过 `status`：一条会话收起之后不管进程是完成还是失败，
 * 它都已经从活跃列表退场了；要接着看就移回活跃列表。
 */
export type SessionPhase = 'working' | 'failed' | 'interrupted' | 'stopped' | 'done' | 'settled';

const PHASE_LABEL: Record<SessionPhase, string> = {
  working: '工作中',
  failed: '失败了',
  interrupted: '已中断',
  stopped: '已停止',
  done: '已完成',
  settled: '已收起'
};

/** 状态文案：短，能在卡片标题行和侧栏 title 里直接读。 */
export function phaseLabel(phase: SessionPhase): string {
  return PHASE_LABEL[phase];
}

export type PhaseTone = 'busy' | 'bad' | 'idle';

/** 冲突色用 accent + rust；其余退到背景（和 atoms/status.tsx 的状态位同一套色）。 */
export function phaseTone(phase: SessionPhase): PhaseTone {
  if (phase === 'working') return 'busy';
  if (phase === 'failed' || phase === 'interrupted') return 'bad';
  return 'idle';
}

/** 小圆点的 class：卡片和侧栏共用，别两处各写一份颜色。 */
export const PHASE_DOT: Record<PhaseTone, string> = {
  busy: 'bg-accent',
  bad: 'bg-rust',
  idle: 'border border-tertiary'
};

/** 有 settledAt 就是收起；否则 running = 工作中，其余状态原样保留。 */
export function sessionPhase(session: Pick<SessionDto, 'status' | 'settledAt'>): SessionPhase {
  if (session.settledAt != null) return 'settled';
  switch (session.status) {
    case 'running':
      return 'working';
    case 'failed':
      return 'failed';
    case 'interrupted':
      return 'interrupted';
    case 'stopped':
      return 'stopped';
    case 'done':
      return 'done';
  }
}

/**
 * 过了多久：只要粗粒度，不要秒级跳动（卡片每渲染一次都变数字会让人分心）。
 * 未来时间（机器时钟偏一点）当成「刚刚」。
 */
export function elapsedLabel(from: number, now: number): string {
  const diff = Math.max(0, now - from);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时`;
  return `${Math.floor(diff / 86_400_000)} 天`;
}

type Settleable = { readonly settledAt?: number | null | undefined };

/** 活跃列表默认不含收起过的；顺序保持服务端给的顺序。 */
export function activeSessions<T extends Settleable>(sessions: readonly T[]): T[] {
  return sessions.filter((session) => session.settledAt == null);
}

/** 收起过的那些，展开「已收起 N」时用。 */
export function settledSessions<T extends Settleable>(sessions: readonly T[]): T[] {
  return sessions.filter((session) => session.settledAt != null);
}
