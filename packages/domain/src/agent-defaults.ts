/**
 * 团队级的「运行时默认模型」：新会话没点名模型时，按这条会话用的运行时来取。
 *
 * 为什么放在团队而不是项目：运行时（opencode / codex / hermes…）是团队统一的接入，
 * 一个团队通常只有一个主力模型；项目之间来回改反而容易忘。会话显式选的模型永远优先。
 */
export type RuntimeModelDefaults = Readonly<Record<string, string>>;

/** 一条模型名最长 200（与 `AgentRef.model`、Bot 的 `ref.model` 一致）。 */
export const RUNTIME_MODEL_MAX = 200;
/** 一个团队最多给 16 个运行时配默认模型（远端机器上会出现的 runtime 远少于这个数）。 */
export const AGENT_DEFAULTS_MAX = 16;
/** 运行时 id：与 `AgentId` 的生成规则一致（小写字母、数字、短横线）。 */
export const RUNTIME_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;

/**
 * 校验并归一：去掉空值（空串 = 「没有默认」），key 必须是合法运行时 id，value 不能带换行。
 * 返回错误文案，`null` 表示没问题。
 */
export function agentDefaultsProblem(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'object' || Array.isArray(input)) return '默认模型要写成「运行时: 模型」的对象';
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > AGENT_DEFAULTS_MAX) return `最多给 ${AGENT_DEFAULTS_MAX} 个运行时配默认模型`;
  for (const [runtime, model] of entries) {
    if (!RUNTIME_ID.test(runtime)) return `运行时名字不合法：${runtime}`;
    if (typeof model !== 'string') return `${runtime} 的默认模型要是字符串`;
    if (/[\r\n]/.test(model)) return `${runtime} 的默认模型不能带换行`;
    if (model.trim().length > RUNTIME_MODEL_MAX) return `${runtime} 的默认模型最长 ${RUNTIME_MODEL_MAX} 个字符`;
  }
  return null;
}

/** 归一后的默认模型表（空值丢弃，值去首尾空白）。 */
export function normalizeAgentDefaults(input: unknown): RuntimeModelDefaults {
  const out: Record<string, string> = {};
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [runtime, model] of Object.entries(input as Record<string, unknown>)) {
    if (typeof model !== 'string') continue;
    const trimmed = model.trim();
    if (trimmed === '' || !RUNTIME_ID.test(runtime)) continue;
    out[runtime] = trimmed;
  }
  return out;
}
