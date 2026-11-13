import type { AgentAlias } from '../agent-alias.ts';

/**
 * 每台 Worker 的自定义运行时别名（CAP-1）。按 workerId 存，和具体账号 / 团队无关。
 * `get` 返回 null = 从没配过（不是「配成空」）；保存空数组等于删掉这一行。
 */
export interface WorkerAgentsRepository {
  get(workerId: string): Promise<readonly AgentAlias[] | null>;
  save(workerId: string, aliases: readonly AgentAlias[]): Promise<void>;
}
