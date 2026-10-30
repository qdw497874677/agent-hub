import { asAgentId, available, capabilityMatrix, limited } from '@agent-hub/domain';
import type { AgentDescriptor, OptionValue } from '@agent-hub/domain';

/**
 * Grok Build（xAI 官方 `grok` CLI）走 `grok agent stdio`，即 ACP over stdio。
 * 和 OpenCode 同一种协议，所以事件映射同构；差别在握手（authenticate、模型）。
 *
 * - `fork` limited：ACP 的 sessionCapabilities 只有 list/resume/close，没有按 entry 分叉；
 *   headless 的 `--fork-session` 只能整段复制，v1 复用来源会话完整上下文，平台血缘仍精确。
 * - `artifacts` limited：write/edit 完成时的 diff 内容带绝对路径，据此归档；shell 写出的文件认不出。
 * - 思考（agent_thought_chunk）不进平台事件，与 OpenCode 一致。
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
      fork: limited('只能从最新处分叉：新会话带着来源到此刻的完整上下文，不能挑中间某一步'),
      resume: available,
      tool_calls: available,
      artifacts: limited('只归档 write/edit 工具 diff 里的绝对路径；shell 命令写出的文件认不出'),
      structured_events: available,
      // initialize 声明了 promptCapabilities.image / embeddedContext（grok 1.0.70 实测）
      attachments: available
    }),
    // 模型列表由 worker 从 initialize 的 _meta.modelState 里问出来——这里不许猜。
    models,
    defaultModel,
    // 模型清单在这里就能报（id 'model' 与 Grok 的 configOptions 一致）；
    // reasoning_effort 取决于当前模型，要等会话开起来由 Grok 自己报。
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
            }
          ]
  };
}

export const grokDescriptor: AgentDescriptor = grokDescriptorFor();
