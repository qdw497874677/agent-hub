import type { LinkState } from './link-health.ts';

/**
 * Worker 更新的试运行与握手提交（ADR 0030 D2，P5）。
 *
 * 新版本换上后以 `update:{id, phase:'trial'}` hello 上来；hub 观察这条连接，
 * 满足「首轮 inventory 已应用、link.echo 正常（live）、稳定 60s 且没有重连」就下发 update_commit，
 * 从第一次 trial hello 起 5 分钟还没满足就下发 update_abort，Worker 自己切回 previous。
 * 新版本根本连不上 hub 的情况由 Worker 的启动守卫（boots > 2 → 切回 previous）兜底，hub 看不到也不需要看到。
 */
export const TRIAL_STABLE_MS = 60_000;
export const TRIAL_TIMEOUT_MS = 5 * 60_000;

/** 更新 id：Worker 生成，只用来对上 commit / abort，不拼进任何命令。 */
export const UPDATE_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

export interface TrialObservation {
  /** 第一次看到这个 id 的 trial hello 的时间（重连不重置）。 */
  readonly startedAt: number;
  /** 当前这条连接建立的时间（重连就重置：要求「稳定且没有重连」）。 */
  readonly connectedAt: number;
  readonly link: LinkState;
  /** 这条连接上收到过 inventory（或 Worker 声明不发 inventory）。 */
  readonly inventoryApplied: boolean;
  readonly online: boolean;
}

export type TrialDecision =
  | { readonly kind: 'wait'; readonly remainingMs: number; readonly deadlineAt: number }
  | { readonly kind: 'commit' }
  | { readonly kind: 'abort'; readonly reason: string };

export function decideTrial(trial: TrialObservation, now: number, stableMs = TRIAL_STABLE_MS, timeoutMs = TRIAL_TIMEOUT_MS): TrialDecision {
  const healthy = trial.online && trial.link === 'live' && trial.inventoryApplied;
  if (healthy && now - trial.connectedAt >= stableMs) return { kind: 'commit' };
  const deadlineAt = trial.startedAt + timeoutMs;
  if (now >= deadlineAt) {
    const why = !trial.online ? '新版本掉线了' : trial.link !== 'live' ? '连接一直不健康' : !trial.inventoryApplied ? '没报上套件清单' : '一直没能稳定满 60 秒';
    return { kind: 'abort', reason: `试运行 ${Math.round(timeoutMs / 60_000)} 分钟内没通过（${why}）` };
  }
  // 剩余时间按「从现在起还要稳定多久」估：没健康就按满 60 秒算
  const remainingMs = healthy ? Math.max(0, stableMs - (now - trial.connectedAt)) : stableMs;
  return { kind: 'wait', remainingMs, deadlineAt };
}
