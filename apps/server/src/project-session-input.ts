import { err, invalid, ok, type DomainError, type Result } from '@agent-hub/domain';

/**
 * 项目会话 / 项目资产 MCP 工具的共用输入校验。
 *
 * 这些谓词在 provider 与动作层里原本各有一份逐字相同的实现。抽出来只共用
 * **纯校验**：不读写项目、不解析身份、不碰路径拼接。路径校验只用于「资产内
 * 相对 POSIX 路径」这一种语义，不拿它校验标识 / 请求键。
 */

/** 未知键诊断最多列几个；超出的只给「等」。 */
const UNKNOWN_KEYS_SHOWN = 5;
/** 只回显键名长度，避免把超长键值写进错误。 */
const UNKNOWN_KEY_MAX = 40;
/** 资产内相对路径上限（provider schema 与动作层共用）。 */
export const PATH_MAX = 512;

const CONTROL = /[\u0000-\u001f\u007f]/;

/** 控制字符不能出现在 id / 名称 / 路径 / 状态里；正文类内容由调用方另行放行。 */
export function hasControl(value: string): boolean {
  return CONTROL.test(value);
}

export function asObject(input: unknown): Result<Record<string, unknown>, DomainError> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return err(invalid('参数必须是对象'));
  }
  return ok(input as Record<string, unknown>);
}

/**
 * 未知键一律拒绝（actor / project_id / worktree_path / token / repo_url 等）。
 * 诊断只列**键名**，不把键值写进错误或审计。
 */
export function rejectUnknownKeys(raw: Record<string, unknown>, allowed: ReadonlySet<string>): DomainError | null {
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unknown.length === 0) return null;
  const shown = unknown.slice(0, UNKNOWN_KEYS_SHOWN).map((key) => key.slice(0, UNKNOWN_KEY_MAX));
  const suffix = unknown.length > UNKNOWN_KEYS_SHOWN ? ' 等' : '';
  return invalid(`不支持的参数：${shown.join(', ')}${suffix}`);
}

/** id / 请求键 / 分支 / 模型 id / 路径 / 名称：非空、无首尾空白、无控制字符、限长。 */
export function exactString(
  raw: Record<string, unknown>,
  key: string,
  max: number
): Result<string | null, DomainError> {
  const value = raw[key];
  if (value === undefined || value === null) return ok(null);
  if (typeof value !== 'string') return err(invalid(`${key} 必须是字符串`));
  if (value === '' || value !== value.trim()) {
    return err(invalid(`${key} 必须是非空字符串，且不能有首尾空白`));
  }
  if (value.length > max) return err(invalid(`${key} 不能超过 ${max} 字符`));
  if (hasControl(value)) return err(invalid(`${key} 不能包含控制字符`));
  return ok(value);
}

export function requiredExact(
  raw: Record<string, unknown>,
  key: string,
  max: number
): Result<string, DomainError> {
  const parsed = exactString(raw, key, max);
  if (!parsed.ok) return parsed;
  if (parsed.value === null) return err(invalid(`${key} 必填`));
  return ok(parsed.value);
}

/** 资产内相对路径：不做规范化、不接受绝对路径 / 反斜杠 / 盘符 / 空段 / `.` / `..`。 */
export function checkRelativePath(value: string): DomainError | null {
  if (value.length > PATH_MAX) return invalid(`文件路径不能超过 ${PATH_MAX} 字符`);
  if (value.startsWith('/') || value.includes('\\') || value.includes(':')) {
    return invalid('文件路径不合法：必须是资产内的相对 POSIX 路径');
  }
  if (value.endsWith('/')) return invalid('文件路径不合法：不能以 / 结尾');
  if (value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return invalid('文件路径不合法：不能包含空段、. 或 ..');
  }
  if (hasControl(value)) return invalid('文件路径不能包含控制字符');
  return null;
}
