import { asAgentId, available, capabilityMatrix, limited } from '@agent-hub/domain';
import type { AgentDescriptor, ProviderLaunch, ProviderProtocol, RuntimeOption, SessionAssets } from '@agent-hub/domain';

/**
 * 一个 ACP agent 的全部可配置项。
 *
 * 关键决定：**它是配置，不是代码**。opencode 之所以不再有专属适配器包，
 * 是因为它跟 claude-code、gemini、zed 的 agent 说的是同一种协议——
 * 换一个 agent 只是换一个命令行，不该要求重编译。
 */
export interface AcpAgentConfig {
  /** agent id，会出现在画布的卡片和血缘里，最好和命令行名字一致。 */
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  /** 可选：这个 agent 认得的额外启动参数以外的东西，暂时只用于日志。 */
  readonly note?: string;
  /**
   * 钩子：initialize 之后要不要 authenticate、用哪种方式。
   * 参数是 agent 声明的 authMethods id；返回 null 表示用 agent 自己缓存的凭据。
   */
  readonly authenticate?: (authMethods: readonly string[]) => { methodId: string; _meta?: Record<string, unknown> } | null;
  /** session/new 与 session/load 附带的 `_meta`（ACP 的扩展口子，例如 Grok 的 yoloMode）。 */
  readonly sessionMeta?: Readonly<Record<string, unknown>>;
  /**
   * 可选：列模型的命令行参数（同一个 command，每行输出一个模型 id）。
   * ACP 只在 session/new 之后才报模型选项，没有它派生对话框里的模型清单就是空的。
   */
  readonly listModelsArgs?: readonly string[];
  /**
   * 可选：hub 下发了技能 / 指令时怎么告诉这个 agent（docs/design/asset-hub.md）。
   * `args` 整体替换 `config.args`，`env` 叠加到子进程环境。都只作用于这一次启动，不改全局配置。
   */
  readonly launch?: (assets: SessionAssets) => Promise<AcpLaunch> | AcpLaunch;
  /** 认得的 hub 模型提供商协议（ADR 0013）；不给 = 不支持。 */
  readonly providerProtocols?: readonly ProviderProtocol[];
  /**
   * 会话选了 hub 模型时怎么告诉 agent：在资产 launch 之上叠加（env 合并）。
   * 渲染出来的配置只能引用令牌的环境变量名，令牌值只进 env。
   */
  readonly providerLaunch?: (sessionId: string, provider: ProviderLaunch, base: AcpLaunch) => Promise<AcpLaunch> | AcpLaunch;
}

export interface AcpLaunch {
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /** 叠加到 session/new|load 的 `_meta` 上（在 config.sessionMeta 之后）；有的 agent 只在这里认会话级参数。 */
  readonly sessionMeta?: Readonly<Record<string, unknown>>;
}

/**
 * OpenCode：`OPENCODE_CONFIG_CONTENT` 是叠加在用户配置之上的一段内联配置，
 * `skills.paths` 加一个技能目录，`instructions` 加指令文件。
 * 机器上已经设置了这个变量时做深合并：用户的值全部保留，数组追加 hub 的条目（去重）；
 * 原值不是 JSON 对象就没法合并，只用 hub 这一段（OpenCode 本来也读不了它）。
 */
export function opencodeLaunch(assets: SessionAssets, existing: string | undefined = process.env['OPENCODE_CONFIG_CONTENT']): AcpLaunch {
  const content: Record<string, unknown> = {};
  // 每个技能目录单独给（OpenCode 在每个 path 下找 **/SKILL.md）：会话只看得见这次生效的那些。
  if (assets.skills.length > 0) content['skills'] = { paths: assets.skills.map((skill) => skill.path.replace(/\/SKILL\.md$/, '')) };
  if (assets.instructions.length > 0) content['instructions'] = assets.instructions.map((item) => item.path);
  const base = parseObject(existing);
  return { env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(base ? mergeConfig(base, content) : content) } };
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseObject(text: string | undefined): Json | null {
  if (!text?.trim()) return null;
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

/** 深合并：对象逐键递归，数组用户在前、hub 追加并去重，标量以用户为准。 */
export function mergeConfig(user: Json, hub: Json): Json {
  const out: Json = { ...user };
  for (const [key, value] of Object.entries(hub)) {
    const mine = out[key];
    if (mine === undefined) out[key] = value;
    else if (isObject(mine) && isObject(value)) out[key] = mergeConfig(mine, value);
    else if (Array.isArray(mine) && Array.isArray(value)) {
      const seen = new Set(mine.map((item) => JSON.stringify(item)));
      out[key] = [...mine, ...value.filter((item) => !seen.has(JSON.stringify(item)))];
    }
  }
  return out;
}

export const ACP_AGENT_DEFAULTS: readonly AcpAgentConfig[] = [
  { id: 'opencode', label: 'OpenCode', command: 'opencode', args: ['acp'], listModelsArgs: ['models'], launch: opencodeLaunch }
];

/**
 * 能力矩阵。
 *
 * `fork` 标 limited：ACP 没有「从某条消息分叉」的通用方法，v1 复用来源会话的完整上下文，
 * 平台血缘仍然精确——降级的只是「agent 那边也真的从那一刻起重来」这半件事。
 * `artifacts` 标 limited：ACP 的 tool_call_update 没有权威文件路径字段。
 */
export function acpDescriptor(
  config: AcpAgentConfig,
  options: readonly RuntimeOption[] = [],
  discovered: readonly string[] = []
): AgentDescriptor {
  const model = options.find((option) => option.category === 'model');
  const models = model === undefined ? [...new Set(discovered)] : [...new Set(choicesOf(model))];
  return {
    id: asAgentId(config.id),
    label: config.label,
    capabilities: capabilityMatrix({
      prompt: available,
      interrupt: available,
      fork: limited('只能从最新处分叉：新会话带着来源到此刻的完整上下文，不能挑中间某一步'),
      resume: available,
      tool_calls: available,
      artifacts: limited('ACP 工具结果无权威文件路径，只在 rawOutput 带绝对路径时归档'),
      structured_events: available,
      attachments: limited('图片与内嵌文件取决于 agent 声明的 promptCapabilities，不支持时发送会明确报错；@ 引用以 resource_link 传递')
    }),
    models,
    defaultModel: typeof model?.current === 'string' ? model.current : '',
    options,
    ...(config.providerLaunch && config.providerProtocols?.length ? { providers: config.providerProtocols } : {})
  };
}

function choicesOf(option: RuntimeOption): string[] {
  return option.choices.flatMap((choice) =>
    choice.kind === 'value' ? [choice.value.value] : choice.values.map((value) => value.value)
  );
}
