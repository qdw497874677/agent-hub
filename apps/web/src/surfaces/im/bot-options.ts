/**
 * bot 的「启动选项」表单逻辑。纯函数，不碰 DOM，单测在 bot-options.test.ts。
 *
 * 口径与后端同源（packages/domain/src/messaging.ts · persistentAgentOptionsProblem）：
 * 键 /^[a-z][a-z0-9_.-]{0,40}$/，值是文本（≤200）或布尔，最多 16 个。
 * 空字符串是合法值（有些选项用空串表示默认）；空键不算选项。
 */

export const BOT_OPTION_KEY = /^[a-z][a-z0-9_.-]{0,40}$/;
export const BOT_OPTIONS_MAX = 16;
export const BOT_OPTION_VALUE_MAX = 200;

/**
 * 常用键 / 值的候选，只做点选建议，不强制。
 * 键必须是 agent 上报的 configId（不是 category）：opencode 的思考强度 id 是 `effort`，
 * Pi 的是 `thinking`；`thought_level` 只是分类名，填进去会被服务端按「没有这个可调项」拒掉。
 */
export const BOT_OPTION_KEY_SUGGESTIONS = ['effort', 'thinking', 'mode'] as const;
export const BOT_OPTION_VALUE_SUGGESTIONS: Record<string, readonly string[]> = {
  effort: ['low', 'medium', 'high', 'xhigh', 'default'],
  thinking: ['off', 'low', 'high', 'max']
};

export type BotOptionKind = 'text' | 'switch';

/** 一行表单：键 + 值。值有两种形态：文本输入框，或一个开关（存成 boolean）。 */
export interface BotOptionRow {
  key: string;
  kind: BotOptionKind;
  text: string;
  on: boolean;
}

export const newBotOptionRow = (key = ''): BotOptionRow => ({ key, kind: 'text', text: '', on: false });

/** 已保存的 options → 表单行。布尔值显示成开关，字符串显示成文本。 */
export function botOptionRows(options: Readonly<Record<string, string | boolean>> | undefined): BotOptionRow[] {
  return Object.entries(options ?? {}).map(([key, value]) =>
    typeof value === 'boolean'
      ? { key, kind: 'switch', text: '', on: value }
      : { key, kind: 'text', text: value, on: false }
  );
}

/** 这行是否算「写了东西」：刚点「添加选项」出来的空行不算，不该报错也不该落库。 */
const touched = (row: BotOptionRow) => row.key.trim() !== '' || row.kind === 'switch' || row.text !== '';

/** 单行的问题；没问题返回 null。重复键只标后出现的那一行。 */
export function botOptionRowProblem(rows: readonly BotOptionRow[], index: number): string | null {
  const row = rows[index];
  if (!row || !touched(row)) return null;
  const key = row.key.trim();
  if (!key) return '键不能空';
  if (!BOT_OPTION_KEY.test(key)) return '键只能用小写字母、数字、-、_ 和 .';
  if (rows.some((other, i) => i !== index && touched(other) && other.key.trim() === key)) return '这个键重复了';
  if (row.kind === 'text' && row.text.length > BOT_OPTION_VALUE_MAX) return `值最多 ${BOT_OPTION_VALUE_MAX} 个字符`;
  return null;
}

/** 整份表单的第一个问题；没问题返回 null。 */
export function botOptionsProblem(rows: readonly BotOptionRow[]): string | null {
  for (let i = 0; i < rows.length; i++) {
    const problem = botOptionRowProblem(rows, i);
    if (problem) return problem;
  }
  return rows.filter(touched).length > BOT_OPTIONS_MAX ? `最多 ${BOT_OPTIONS_MAX} 个选项` : null;
}

/** 「文本 / 开关」互换。文本若能认成真假就沿用，切回文本时开关值写成 "true"。 */
export function flipBotOptionRow(row: BotOptionRow): BotOptionRow {
  if (row.kind === 'text') {
    return { ...row, kind: 'switch', text: '', on: ['true', 'on', 'yes', '1'].includes(row.text.trim().toLowerCase()) };
  }
  return { ...row, kind: 'text', text: row.on ? 'true' : '' };
}

/** 收成请求体里的 options：跳过空键，键去空白。空字符串值照收（它是有意义的默认值）。 */
export function botOptionsValue(rows: readonly BotOptionRow[]): Record<string, string | boolean> {
  const value: Record<string, string | boolean> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    value[key] = row.kind === 'switch' ? row.on : row.text;
  }
  return value;
}

/**
 * 请求体里 options 这一块。
 * - 有内容：原样传。
 * - 新建且没有选项：不传，保持老行为（别把 {} 塞进库）。
 * - 编辑且清空了：传 {}，服务端的 clean() 会当成「没有 options」，等于真清掉。
 */
export function botOptionsInput(
  rows: readonly BotOptionRow[],
  updating: boolean
): { options?: Record<string, string | boolean> } {
  const value = botOptionsValue(rows);
  if (Object.keys(value).length > 0) return { options: value };
  return updating ? { options: {} } : {};
}
