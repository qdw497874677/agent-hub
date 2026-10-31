import type { ResourceSample } from '../resources.ts';

/** hub 侧的资源视图（ADR 0014）：网关在内存里攒的采样，加上「满了拒绝新会话」的策略开关。 */
export interface WorkerMetrics {
  /** 最近 1 小时，时间升序；没有就是空数组。 */
  history(workerId: string): readonly ResourceSample[];
  /** 把持久化的策略同步给网关（启动时、改动后）。 */
  applyRefuseWhenFull(workerIds: readonly string[]): void;
}
