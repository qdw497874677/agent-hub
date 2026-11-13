/**
 * 运行时别名（ACP agent 声明）的纯逻辑：一行怎么校验、表单字符串怎么和接口数组互转。
 *
 * 这里不碰 DOM、不 import `shell/api.ts`（根 tsconfig 没有 DOM lib，单测只编译这个文件）。
 * 服务端会按同一套规则再校验一遍，前端先拦是为了让错误出现在打字的地方，而不是保存失败之后。
 */

/** 与 `PUT /api/workers/:workerId/agents` 的 body 同形（contract 那边还在改，先在 web 内声明）。 */
export interface AgentAliasDto {
  id: string;
  label: string;
  command: string;
  args?: string[];
  models?: string[];
  defaultModel?: string;
}

/** 编辑中的一行：`args` / `models` 先按「逗号或空格分隔」的字符串编辑，保存时再拆成数组。 */
export interface AgentAliasRow {
  id: string;
  label: string;
  command: string;
  args: string;
  models: string;
  defaultModel: string;
}

/** 一台机器最多配这么多别名（服务端同值）。 */
export const MAX_ALIASES = 16;
/** 内置的四个运行时，别名不能顶掉它们的名字。 */
export const RESERVED_ALIAS_IDS: readonly string[] = ['pi', 'opencode', 'grok', 'hermes'];
/** 小写字母开头，后面只能是小写字母、数字、-，总长 1–41。 */
export const ALIAS_ID_PATTERN = /^[a-z][a-z0-9-]{0,40}$/;

const LIMIT = { label: 80, command: 500, args: 20, arg: 200, models: 100, model: 200, defaultModel: 200 } as const;

export function emptyAgentAlias(): AgentAliasRow {
  return { id: '', label: '', command: '', args: '', models: '', defaultModel: '' };
}

/** 逗号或空白分隔 → 去掉空项。`a, b  c` 和 `a b c` 一样。 */
export function parseAliasList(input: string): string[] {
  return input
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** 数组 → 表单里的逗号串；没有值就是空串。 */
export function formatAliasList(values: readonly string[] | undefined): string {
  return (values ?? []).join(', ');
}

/** 整行一个字都没填：保存时直接丢掉，不当成错误。 */
export function isBlankAliasRow(row: AgentAliasRow): boolean {
  return (
    row.id.trim() === '' &&
    row.label.trim() === '' &&
    row.command.trim() === '' &&
    row.args.trim() === '' &&
    row.models.trim() === '' &&
    row.defaultModel.trim() === ''
  );
}

/** 一行的就地校验：返回中文原因，没问题返回 null。 */
export function aliasRowProblem(row: AgentAliasRow): string | null {
  const id = row.id.trim();
  if (id === '') return 'id 不能为空';
  if (!ALIAS_ID_PATTERN.test(id)) return 'id 用小写字母开头，只能有小写字母、数字和 -，最长 41 位';
  if (RESERVED_ALIAS_IDS.includes(id)) return 'pi / opencode / grok / hermes 是内置的';
  if (row.label.trim().length > LIMIT.label) return `名称最多 ${LIMIT.label} 个字`;

  const command = row.command.trim();
  if (command === '') return '命令不能为空';
  if (command.length > LIMIT.command) return `命令最多 ${LIMIT.command} 个字`;

  const args = parseAliasList(row.args);
  if (args.length > LIMIT.args) return `参数最多 ${LIMIT.args} 条`;
  if (args.some((arg) => arg.length > LIMIT.arg)) return `每条参数最多 ${LIMIT.arg} 个字`;

  const models = parseAliasList(row.models);
  if (models.length > LIMIT.models) return `模型最多 ${LIMIT.models} 个`;
  if (models.some((model) => model.length > LIMIT.model)) return `每个模型最多 ${LIMIT.model} 个字`;

  if (row.defaultModel.trim().length > LIMIT.defaultModel) return `默认模型最多 ${LIMIT.defaultModel} 个字`;
  return null;
}

/** 整表的问题：条数上限、id 重复。单行的问题走 `aliasRowProblem`。 */
export function aliasesProblem(rows: readonly AgentAliasRow[]): string | null {
  const filled = rows.filter((row) => !isBlankAliasRow(row));
  if (filled.length > MAX_ALIASES) return `最多 ${MAX_ALIASES} 个别名`;
  const seen = new Set<string>();
  for (const row of filled) {
    const id = row.id.trim();
    if (id === '') continue;
    if (seen.has(id)) return `id 不能重复：${id}`;
    seen.add(id);
  }
  return null;
}

/** 表单 → 接口值：去掉空行，空串的 args / models / defaultModel 整个字段省略，名称没填就用 id。 */
export function aliasRowsValue(rows: readonly AgentAliasRow[]): AgentAliasDto[] {
  return rows
    .filter((row) => !isBlankAliasRow(row))
    .map((row) => {
      const id = row.id.trim();
      const label = row.label.trim();
      const args = parseAliasList(row.args);
      const models = parseAliasList(row.models);
      const defaultModel = row.defaultModel.trim();
      return {
        id,
        label: label === '' ? id : label,
        command: row.command.trim(),
        ...(args.length > 0 ? { args } : {}),
        ...(models.length > 0 ? { models } : {}),
        ...(defaultModel !== '' ? { defaultModel } : {})
      };
    });
}

/** 接口值 → 表单行（数组拼成逗号串）。 */
export function aliasRowsFrom(aliases: readonly AgentAliasDto[]): AgentAliasRow[] {
  return aliases.map((alias) => ({
    id: alias.id,
    label: alias.label,
    command: alias.command,
    args: formatAliasList(alias.args),
    models: formatAliasList(alias.models),
    defaultModel: alias.defaultModel ?? ''
  }));
}
