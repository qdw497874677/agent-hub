import { asAgentId, available, capabilityMatrix, denied, limited } from '@agent-hub/domain';
import type { AgentDescriptor } from '@agent-hub/domain';

/**
 * Hermes Agent（ADR 0022）走 API Server 的 Runs API。
 *
 * - 模型只走 hub 模型提供商（决定 D6）：没有自己的模型清单，选了 hub 提供商才能开会话。
 * - `fork` denied：Runs API 有 session fork，但 hub 侧的分叉语义（从第 N 条事件长出新分支）对不上，P1 不做。
 * - `attachments` limited：Runs API 只收文本；附件以绝对路径写进消息，由 Hermes 自己读。
 */
export function hermesDescriptor(): AgentDescriptor {
  return {
    id: asAgentId('hermes'),
    label: 'Hermes',
    capabilities: capabilityMatrix({
      prompt: available,
      interrupt: available,
      fork: denied('Hermes 的会话分叉和 hub 的「从第 N 步分叉」对不上，暂不支持'),
      resume: available,
      tool_calls: available,
      artifacts: limited('Hermes 只报工具名和脱敏预览，认不出写了哪些文件'),
      structured_events: available,
      attachments: limited('Runs API 只收文本；上传文件以绝对路径写进消息，由 Hermes 自己读取')
    }),
    models: [],
    defaultModel: '',
    // Hermes 的 custom provider 是 OpenAI 兼容的 chat completions
    providers: ['openai-chat'],
    options: []
  };
}
