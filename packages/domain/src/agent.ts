import type { AgentId } from './ids.ts';
import type { CapabilityMatrix } from './capability.ts';

/**
 * agent 的全部自我描述。适配器交出它和 `start()`，别的什么都不用交。
 *
 * `models` 在 v1 由适配器声明（Pi 和 OpenCode 各自硬编码一份）。
 * S3.3 的自动探测是 T2：那时这个字段变成探测结果，形状不变。
 */
export interface AgentDescriptor {
  readonly id: AgentId;
  readonly label: string;
  readonly capabilities: CapabilityMatrix;
  readonly models: readonly string[];
  readonly defaultModel: string;
}
