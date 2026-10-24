import type { SessionEvent } from '@agent-hub/domain';
import { asAgentId, available, capabilityMatrix, limited } from '@agent-hub/domain';
import type { AgentDescriptor } from '@agent-hub/domain';

/**
 * Pi 的能力矩阵。
 *
 * `fork` 是 limited 而不是 available：平台的 fork 语义（从第 N 条事件长出新分支）
 * 在 Pi 的 RPC 上没有被暴露出来，v1 的做法是新会话说「继续这个 Pi 会话」，
 * 于是模型侧的上下文是来源会话的**完整**历史，而平台侧的血缘仍然精确。
 * 差别是一句话能说清的，所以是 limited 带原因，不是 denied。
 */
export function piDescriptorFor(
  models: readonly string[] = [],
  defaultModel: string = ''
): AgentDescriptor {
  return {
  id: asAgentId('pi'),
  label: 'Pi',
  capabilities: capabilityMatrix({
    prompt: available,
    interrupt: available,
    fork: limited('Pi RPC 未暴露按 entry 分叉，v1 复用来源会话的完整上下文；平台血缘仍精确'),
    resume: available,
    tool_calls: available,
    artifacts: available,
    structured_events: available
  }),
  // 模型列表由 worker 从本机 Pi 配置里读出来报上去——这里不许猜。
  models,
  defaultModel
  };
}

export const piDescriptor: AgentDescriptor = piDescriptorFor();


/**
 * v1 的 Pi 用不到 denied，但记一笔它该出现在什么场合：某天 Pi 的某个能力被
 * provider 或配置关掉时，写成 denied + 原因，不要偷偷降级成 limited 混过去。
 */
