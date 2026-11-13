/**
 * 自定义运行时别名（CAP-1）：hub 上给某台 Worker 声明的 ACP agent。
 *
 * 别名是**声明**，不带 env：密钥、登录态仍留在那台机器的 worker.env / agent 自己的配置里，
 * 不经 hub API 流出。hub 保存后推给在线的 Worker，Worker 重建 harness 注册表——
 * 新建的会话用新别名，正在跑的会话不受影响。
 */
export interface AgentAlias {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly models?: readonly string[];
  readonly defaultModel?: string;
}

/** 一台 Worker 最多声明多少个别名（也是协议帧的上限）。 */
export const AGENT_ALIAS_MAX = 16;

/** id 的形状：小写字母开头，只含 a-z 0-9 -；同时是会话里的 agentId。 */
export const AGENT_ALIAS_ID = /^[a-z][a-z0-9-]{0,40}$/;

/** 内置运行时的 id：别名不能占用，否则会和适配器自己的 agent 抢同一个 id。 */
export const AGENT_ALIAS_RESERVED: readonly string[] = ['pi', 'opencode', 'grok', 'hermes'];

const LABEL_MAX = 80;
const COMMAND_MAX = 512;
const ARG_MAX = 512;
const ARGS_MAX = 64;
const MODEL_MAX = 200;
const MODELS_MAX = 128;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringsProblem = (value: unknown, field: string, where: string, max: number, eachMax: number): string | null => {
  if (!Array.isArray(value)) return `${where}的 ${field} 只能是字符串数组`;
  if (value.length > max) return `${where}的 ${field} 最多 ${max} 项`;
  for (const entry of value) {
    if (typeof entry !== 'string') return `${where}的 ${field} 只能是字符串数组`;
    if (entry.length > eachMax) return `${where}的 ${field} 每项最长 ${eachMax} 个字符`;
  }
  return null;
};

/** 单个别名哪里不对（null = 没问题）。文案直接给人看，指出是哪一项。 */
export function agentAliasProblem(input: unknown): string | null {
  if (!isRecord(input)) return '别名必须是对象（要 id / label / command）';
  const id = input['id'];
  if (typeof id !== 'string' || !AGENT_ALIAS_ID.test(id)) {
    return 'id 要小写字母开头，只含 a-z 0-9 -，最长 41 个字符';
  }
  const where = `别名「${id}」`;
  if (AGENT_ALIAS_RESERVED.includes(id)) return `${where}用了内置运行时的名字，换一个 id`;
  const label = input['label'];
  if (typeof label !== 'string' || label.trim() === '') return `${where}的 label 不能为空`;
  if (label.length > LABEL_MAX) return `${where}的 label 最长 ${LABEL_MAX} 个字符`;
  const command = input['command'];
  if (typeof command !== 'string' || command.trim() === '') return `${where}的 command 不能为空`;
  if (command.length > COMMAND_MAX) return `${where}的 command 最长 ${COMMAND_MAX} 个字符`;
  if (input['args'] !== undefined) {
    const problem = stringsProblem(input['args'], 'args', where, ARGS_MAX, ARG_MAX);
    if (problem) return problem;
  }
  if (input['models'] !== undefined) {
    const problem = stringsProblem(input['models'], 'models', where, MODELS_MAX, MODEL_MAX);
    if (problem) return problem;
  }
  const defaultModel = input['defaultModel'];
  if (defaultModel !== undefined && (typeof defaultModel !== 'string' || defaultModel.length > MODEL_MAX)) {
    return `${where}的 defaultModel 只能是字符串（最长 ${MODEL_MAX} 个字符）`;
  }
  return null;
}

/** 一台 Worker 的整张别名表哪里不对（null = 没问题）：数组、上限、id 唯一、不占内置 id。 */
export function agentAliasesProblem(input: unknown): string | null {
  if (!Array.isArray(input)) return 'aliases 必须是数组（清空就传 []）';
  if (input.length > AGENT_ALIAS_MAX) return `运行时别名最多 ${AGENT_ALIAS_MAX} 个`;
  const seen = new Set<string>();
  for (const [index, entry] of input.entries()) {
    const problem = agentAliasProblem(entry);
    if (problem) return `第 ${index + 1} 个：${problem}`;
    const id = (entry as AgentAlias).id;
    if (seen.has(id)) return `别名 id「${id}」重复了`;
    seen.add(id);
  }
  return null;
}

/** 解析过的别名表 → 统一补上 args（缺省是空数组）。 */
export function normalizeAgentAliases(input: readonly AgentAlias[]): AgentAlias[] {
  return input.map((alias) => ({
    id: alias.id,
    label: alias.label,
    command: alias.command,
    args: [...alias.args],
    ...(alias.models !== undefined ? { models: [...alias.models] } : {}),
    ...(alias.defaultModel !== undefined ? { defaultModel: alias.defaultModel } : {})
  }));
}
