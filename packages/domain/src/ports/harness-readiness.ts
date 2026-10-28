import type { AgentReadiness } from '../worker.ts';

/** 一次探测的结果：能不能用，外加这台机器上它报的模型（报不出来就是空清单）。 */
export interface HarnessProbe {
  readonly readiness: AgentReadiness;
  readonly models: readonly string[];
  readonly defaultModel: string;
}

/**
 * Worker 侧的端口：某个 harness（Pi / OpenCode / Grok……）在这台机器上「装了且能用」吗？
 * 每个 harness 一个适配器，和它的 runtime 放在一起、复用同一套命令与环境变量解析。
 * 实现必须便宜、无副作用（不登录、不改配置、不开会话），不得把凭据带进 reason。
 */
export interface HarnessReadiness {
  readonly agentId: string;
  probe(): Promise<HarnessProbe>;
}
