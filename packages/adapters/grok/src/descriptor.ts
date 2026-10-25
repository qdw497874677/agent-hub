import { asAgentId, available, capabilityMatrix, limited } from '@agent-hub/domain';
import type { AgentDescriptor } from '@agent-hub/domain';

/**
 * Grok Build（xAI 官方 `grok` CLI）走 `grok agent stdio`，即 ACP over stdio。
 * 和 OpenCode 同一种协议，所以事件映射同构；差别在握手（authenticate、模型）。
 *
 * - `fork` limited：ACP 的 sessionCapabilities 只有 list/resume/close，没有按 entry 分叉；
 *   headless 的 `--fork-session` 只能整段复制，v1 复用来源会话完整上下文，平台血缘仍精确。
 * - `artifacts` limited：ACP 工具结果无权威文件路径，只在 rawOutput 带绝对路径时归档。
 */
export function grokDescriptorFor(
  models: readonly string[] = [],
  defaultModel: string = ''
): AgentDescriptor {
  return {
    id: asAgentId('grok'),
    label: 'Grok',
    capabilities: capabilityMatrix({
      prompt: available,
      interrupt: available,
      fork: limited('Grok ACP 未暴露按 entry 分叉，v1 复用来源会话的完整上下文；平台血缘仍精确'),
      resume: available,
      tool_calls: available,
      artifacts: limited('ACP 工具结果无权威文件路径，只在 rawOutput 带绝对路径时归档'),
      structured_events: available
    }),
    // 模型列表由 worker 从 initialize 的 _meta.modelState 里问出来——这里不许猜。
    models,
    defaultModel
  };
}

export const grokDescriptor: AgentDescriptor = grokDescriptorFor();
