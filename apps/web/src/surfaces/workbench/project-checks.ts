/**
 * 项目检查命令（issue #216 P1）的设置页逻辑：多行草稿 ↔ 命令数组，以及保存前校验。
 *
 * 纯函数，不碰 DOM，单测直接跑——所以这里只从契约取形状，不 import shell/api.ts。
 * 上限和后端 `packages/domain/src/project.ts` 的 CHECK_COMMANDS_MAX / CHECK_COMMAND_MAX 一致；
 * 前端先拦一遍只是不想为必然失败的请求跑一个来回，真正的裁判还是后端。
 */

/** 最多几条检查命令。 */
export const CHECK_COMMANDS_MAX = 5;

/** 单条命令最长多少字。 */
export const CHECK_COMMAND_MAX = 300;

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/**
 * 多行草稿 → 命令数组：一行一条，trim，空行丢掉。
 *
 * 换行就是分隔符，所以单条命令不可能再带换行——后端「一条命令占一行」那条规则在这里天然成立。
 * `\r\n` 也按换行切（从别处粘进来的 Windows 换行不该让人改两遍），切完 trim 已经不剩 `\r`。
 */
export function parseChecks(text: string): string[] {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** 项目里存着的检查命令；老数据 / 手改过的库读到怪东西时按「没配」处理，别让设置页崩。 */
export function storedChecks(project: unknown): string[] {
  const raw = record(project)?.checks;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string');
}

/** 已存的命令 → 多行草稿。 */
export function checksDraft(project: unknown): string {
  return storedChecks(project).join('\n');
}

/** 就地校验草稿；null = 可以保存。错误文案直接给用户看，不是只标红。 */
export function checksDraftProblem(text: string): string | null {
  const checks = parseChecks(text);
  if (checks.length > CHECK_COMMANDS_MAX) {
    return `最多 ${CHECK_COMMANDS_MAX} 条检查命令，现在有 ${checks.length} 条。`;
  }
  const tooLong = checks.find((command) => command.length > CHECK_COMMAND_MAX);
  if (tooLong !== undefined) {
    return `单条命令最多 ${CHECK_COMMAND_MAX} 字，有一条 ${tooLong.length} 字了。`;
  }
  return null;
}

/** 草稿和已存的命令是不是同一份（用来决定「保存」亮不亮、要不要显示「已保存」）。 */
export function checksDirty(project: unknown, text: string): boolean {
  return JSON.stringify(storedChecks(project)) !== JSON.stringify(parseChecks(text));
}
