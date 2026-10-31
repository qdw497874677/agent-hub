import type { ResourceSample } from '../resources.ts';

/**
 * 采样端口（ADR 0014）：Worker 侧由 node-gateway 实现（os + /proc + pidtree/pidusage + 可选 nvidia-smi）。
 * sessions：会话 id → 它的 agent 进程 pid；实现按进程树汇总。
 */
export interface ResourceProbe {
  sample(sessions: ReadonlyMap<string, number>): Promise<ResourceSample>;
}
