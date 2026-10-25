import type { AgentId } from './ids.ts';
import type { CapabilityMatrix } from './capability.ts';
import type { RuntimeOption } from './option.ts';

/**
 * agent 的全部自我描述。适配器交出它和 `start()`，别的什么都不用交。
 *
 * `options` 是这个 runtime 报上来的可调项（模型、思考强度、模式……），
 * 界面只渲染清单里的东西。`models` / `defaultModel` 是它在 `category: 'model'`
 * 上的投影，留着是因为派生会话时要用——但**不许**和 options 说不一样的话。
 */
export interface AgentDescriptor {
  readonly id: AgentId;
  readonly label: string;
  readonly capabilities: CapabilityMatrix;
  readonly models: readonly string[];
  readonly defaultModel: string;
  readonly options: readonly RuntimeOption[];
}
