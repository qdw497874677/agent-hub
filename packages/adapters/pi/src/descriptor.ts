import { asAgentId, available, capabilityMatrix, limited } from '@agent-hub/domain';
import type { AgentDescriptor, OptionValue, RuntimeOption } from '@agent-hub/domain';

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
    fork: limited('只能从最新处分叉：新会话带着来源到此刻的完整上下文，不能挑中间某一步'),
    resume: available,
    tool_calls: available,
    artifacts: available,
    structured_events: available,
    attachments: limited('Pi RPC 只接收图片；上传文件和 @ 引用以绝对路径写进消息，由 Pi 自己读取')
  }),
  // 模型列表由 worker 从本机 Pi 配置里读出来报上去——这里不许猜。
  models,
  defaultModel,
  // 模型清单在这里就能报；思考档位取决于当前模型，要等会话开起来问 Pi 才知道。
  options:
    models.length === 0
      ? []
      : [
          {
            id: 'model',
            label: '模型',
            category: 'model',
            kind: 'select',
            current: defaultModel === '' ? (models[0] ?? '') : defaultModel,
            choices: models.map<{ kind: 'value'; value: OptionValue }>((model) => ({
              kind: 'value',
              value: { value: model, label: model }
            }))
          } satisfies RuntimeOption
        ]
  };
}

export const piDescriptor: AgentDescriptor = piDescriptorFor();


/**
 * v1 的 Pi 用不到 denied，但记一笔它该出现在什么场合：某天 Pi 的某个能力被
 * provider 或配置关掉时，写成 denied + 原因，不要偷偷降级成 limited 混过去。
 */
