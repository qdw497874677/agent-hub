import type { RuntimeModelDefaults } from '../agent-defaults.ts';

/**
 * 团队级的运行时默认模型（`agent-defaults.ts` 的存储侧）。
 * 只按团队存一张表；模型名本身是可读的配置，不含密钥。
 */
export interface AgentDefaultsStore {
  forTeam(teamId: string): Promise<RuntimeModelDefaults>;
  save(teamId: string, defaults: RuntimeModelDefaults): Promise<void>;
}
