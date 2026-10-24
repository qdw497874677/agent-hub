import { asAgentId, available, capabilityMatrix, limited } from '@agent-hub/domain';
import type { AgentDescriptor } from '@agent-hub/domain';

/**
 * OpenCode 走 ACP（Agent Client Protocol），是这次 X1 的证明关：
 * 它能跑通而不动 domain 一行，才算「新增 agent 零内核改动」成立。
 *
 * `artifacts` 标 limited：ACP 的 tool_call_update 里没有权威的文件路径字段，
 * 我们只能从 rawOutput 里认，认不出就不归档——少归一个比乱归一个强。
 */
export const openCodeDescriptor: AgentDescriptor = {
  id: asAgentId('opencode'),
  label: 'OpenCode',
  capabilities: capabilityMatrix({
    prompt: available,
    interrupt: available,
    fork: limited('ACP 未暴露按 entry 分叉，v1 复用来源会话的完整上下文；平台血缘仍精确'),
    resume: available,
    tool_calls: available,
    artifacts: limited('ACP 工具结果无权威文件路径，只在 rawOutput 带绝对路径时归档'),
    structured_events: available
  }),
  // ACP 的 session/new 没有稳定的模型选择字段，v1 一律用 OpenCode 自己的默认。
  models: [],
  defaultModel: ''
};
