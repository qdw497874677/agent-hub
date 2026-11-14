import { asAgentId, available, capabilityMatrix, denied, limited } from '@agent-hub/domain';
import type { AgentDescriptor, OptionValue, RuntimeOption } from '@agent-hub/domain';

/** Codex 的思考档位（`turn/start.effort`，schema 里是自由字符串，这里取 app-server 常用四档）。 */
export const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;
export type CodexEffort = (typeof CODEX_EFFORTS)[number];

/** `AskForApproval` 的字符串枚举（对象形态的 granular 策略 v1 不暴露）。 */
export const CODEX_APPROVALS = ['on-request', 'untrusted', 'never'] as const;
export type CodexApproval = (typeof CODEX_APPROVALS)[number];

/** `thread/start.sandbox` 的 `SandboxMode`。 */
export const CODEX_SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'] as const;
export type CodexSandbox = (typeof CODEX_SANDBOXES)[number];

export const CODEX_DEFAULT_APPROVAL: CodexApproval = 'on-request';
export const CODEX_DEFAULT_SANDBOX: CodexSandbox = 'workspace-write';
export const CODEX_DEFAULT_EFFORT: CodexEffort = 'medium';

/** 会话当前的可调项取值。`model` 为空 = 让 Codex 用它自己的默认。 */
export interface CodexSettings {
  model: string;
  effort: string;
  approval: string;
  sandbox: string;
}

export function defaultCodexSettings(overrides: Partial<CodexSettings> = {}): CodexSettings {
  return {
    model: '',
    effort: CODEX_DEFAULT_EFFORT,
    approval: CODEX_DEFAULT_APPROVAL,
    sandbox: CODEX_DEFAULT_SANDBOX,
    ...overrides
  };
}

function selectOption(
  id: string,
  label: string,
  description: string,
  category: RuntimeOption['category'],
  current: string,
  choices: readonly { readonly value: string; readonly label: string; readonly description?: string }[]
): RuntimeOption {
  return {
    id,
    label,
    description,
    category,
    kind: 'select',
    current,
    choices: choices.map<{ kind: 'value'; value: OptionValue }>((choice) => ({
      kind: 'value',
      value: {
        value: choice.value,
        label: choice.label,
        ...(choice.description === undefined ? {} : { description: choice.description })
      }
    }))
  };
}

/**
 * 会话可调项。runtime 和 descriptor 共用这一份，避免「界面说 A、实际发 B」。
 * effort 的 current 只是展示（Codex 各模型的默认档不同）；没显式选过时 turn/start 不带 effort。
 */
export function codexOptions(models: readonly string[], settings: CodexSettings): RuntimeOption[] {
  const modelChoices = models.length === 0 ? [] : models.map((model) => ({ value: model, label: model }));
  const options: RuntimeOption[] = [];
  if (modelChoices.length > 0) {
    options.push(
      selectOption('model', '模型', 'Codex 本轮使用的模型（下一轮生效）', 'model', settings.model === '' ? (models[0] ?? '') : settings.model, modelChoices)
    );
  }
  options.push(
    selectOption(
      'effort',
      '思考强度',
      'minimal 最快，high 想得最久；留默认时由 Codex 按模型决定',
      'thought_level',
      settings.effort,
      CODEX_EFFORTS.map((effort) => ({ value: effort, label: effort }))
    ),
    selectOption(
      'approval',
      '审批策略',
      'on-request = 有风险时才问；untrusted = 只自动跑可信命令；never = 从不问（危险）',
      'mode',
      settings.approval,
      [
        { value: 'on-request', label: '按需审批', description: 'Codex 认为有风险时请求批准' },
        { value: 'untrusted', label: '只信可信命令', description: '只自动执行可信命令，其余都要批准' },
        { value: 'never', label: '从不审批', description: '不弹审批（危险，别在真实仓库里用）' }
      ]
    ),
    selectOption(
      'sandbox',
      '沙箱',
      'read-only 只读；workspace-write 可写工作区；danger-full-access 不设限（危险）',
      'mode',
      settings.sandbox,
      [
        { value: 'read-only', label: '只读', description: '不能改文件、不能联网' },
        { value: 'workspace-write', label: '可写工作区', description: '只能改工作区里的文件' },
        { value: 'danger-full-access', label: '完全放开', description: '不设沙箱限制（危险）' }
      ]
    )
  );
  return options;
}

export function codexDescriptorFor(
  models: readonly string[] = [],
  defaultModel: string = '',
  settingsOverrides: Partial<CodexSettings> = {}
): AgentDescriptor {
  const settings = defaultCodexSettings({ model: defaultModel === '' ? (models[0] ?? '') : defaultModel, ...settingsOverrides });
  return {
    id: asAgentId('codex'),
    label: 'Codex',
    capabilities: capabilityMatrix({
      prompt: available,
      interrupt: available,
      // Codex app-server 能 resume 原 thread，但没有「从第 N 条消息之前分叉」的接口。
      fork: limited('只能续跑原会话，不能从中间某一步分叉'),
      resume: available,
      tool_calls: available,
      artifacts: available,
      structured_events: available,
      attachments: limited('Codex 适配器 v1 只发文字；附件先放进工作区，让 Codex 自己读'),
      branch_at_turn: denied('Codex 没有从某条消息分叉的原生接口')
    }),
    models,
    defaultModel: settings.model,
    options: codexOptions(models, settings)
  };
}
