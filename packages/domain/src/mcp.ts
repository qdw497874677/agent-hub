import { invalid, type DomainError } from './errors.ts';
import { err, ok, type Result } from './result.ts';

/**
 * MCP 资产（docs/design/asset-hub.md §MCP）：一份 `mcp.json`，描述一个 MCP 服务器怎么连。
 *
 * 配置里**不放密钥明文**：要用密钥的地方写 `${secret:NAME}`，密钥本身单独存在 hub 的保险箱里（加密落库）。
 * - stdio：在 Worker 上由 agent 拉起；密钥只在会话启动时展开进那个进程的环境变量。
 * - http：远端服务器由 hub 代连（经 Worker 长连接中转），密钥只在 hub 上展开进请求头，不下发。
 */
export type McpConfig =
  | {
      readonly transport: 'stdio';
      readonly name: string;
      readonly description: string;
      readonly command: string;
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
    }
  | {
      readonly transport: 'http';
      readonly name: string;
      readonly description: string;
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
    };

/** 会话启动时下发给 Worker 的一项：stdio 带已展开的环境变量（只活在内存和那个进程里）；http 只有名字，url 由 Worker 填成本机中转入口。 */
export type McpLaunch =
  | {
      readonly transport: 'stdio';
      readonly name: string;
      readonly command: string;
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
    }
  | { readonly transport: 'http'; readonly name: string; readonly url: string };

export const MCP_CONFIG_FILE = 'mcp.json';

const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const SECRET_REF = /\$\{secret:([^}]*)\}/g;
/** 看起来是密钥的键：值必须写成 `${secret:…}` 引用，免得明文进版本库。 */
const SENSITIVE_KEY = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE|CREDENTIAL|AUTHORIZATION|COOKIE)/i;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_KEY = /^[A-Za-z0-9-]{1,64}$/;
/** hub 自己用的服务器名，资产不能占。 */
const RESERVED = new Set(['agent-hub']);

export function checkSecretName(name: string): Result<string, DomainError> {
  if (!SECRET_NAME.test(name)) return err(invalid(`密钥名「${name}」不合规：大写字母开头，只能用大写字母、数字和下划线，最多 64 个字符`));
  return ok(name);
}

/** 一段文本里引用到的密钥名。 */
export function secretRefsIn(text: string): string[] {
  return [...text.matchAll(SECRET_REF)].map((match) => match[1] ?? '');
}

export function mcpSecretRefs(config: McpConfig): string[] {
  const values = config.transport === 'stdio' ? [...config.args, ...Object.values(config.env)] : [config.url, ...Object.values(config.headers)];
  return [...new Set(values.flatMap(secretRefsIn))].sort();
}

/** 把 `${secret:NAME}` 换成真值；缺哪个就报哪个（只报名字，不报值）。 */
export function expandSecrets(text: string, secrets: Readonly<Record<string, string>>): Result<string, DomainError> {
  const missing: string[] = [];
  const out = text.replace(SECRET_REF, (_, name: string) => {
    const value = secrets[name];
    if (value === undefined) {
      missing.push(name);
      return '';
    }
    return value;
  });
  return missing.length > 0 ? err(invalid(`缺密钥：${[...new Set(missing)].join('、')}`)) : ok(out);
}

export function expandRecord(
  record: Readonly<Record<string, string>>,
  secrets: Readonly<Record<string, string>>
): Result<Record<string, string>, DomainError> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    const expanded = expandSecrets(value, secrets);
    if (!expanded.ok) return expanded;
    out[key] = expanded.value;
  }
  return ok(out);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function stringRecord(value: unknown, field: string, keyRule: RegExp): Result<Record<string, string>, DomainError> {
  if (value === undefined) return ok({});
  if (!isRecord(value)) return err(invalid(`mcp.json 的 ${field} 必须是「名字 → 字符串」的对象`));
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!keyRule.test(key)) return err(invalid(`mcp.json 的 ${field} 里「${key}」这个名字不合法`));
    if (typeof entry !== 'string') return err(invalid(`mcp.json 的 ${field}.${key} 必须是字符串`));
    if (SENSITIVE_KEY.test(key) && secretRefsIn(entry).length === 0 && entry !== '') {
      return err(invalid(`mcp.json 的 ${field}.${key} 看起来是密钥：不要写明文，改成 \${secret:${key.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}} 并在「密钥」里设置`));
    }
    out[key] = entry;
  }
  return ok(out);
}

/** 校验 mcp.json：结构、名字、命令、地址，以及密钥都写成引用、引用名合规。错误都是能直接给人看的中文。 */
export function parseMcpConfig(text: string): Result<McpConfig, DomainError> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return err(invalid(`mcp.json 不是合法的 JSON：${(error as Error).message}`));
  }
  if (!isRecord(raw)) return err(invalid('mcp.json 必须是一个对象'));
  const name = raw['name'];
  if (typeof name !== 'string' || name === '') return err(invalid('mcp.json 里缺 name'));
  if (RESERVED.has(name)) return err(invalid(`「${name}」是 hub 自己的工具服务器名，换一个`));
  const description = raw['description'] ?? '';
  if (typeof description !== 'string') return err(invalid('mcp.json 的 description 必须是字符串'));
  const transport = raw['transport'] ?? (raw['url'] !== undefined ? 'http' : 'stdio');
  let config: McpConfig;
  if (transport === 'stdio') {
    const command = raw['command'];
    if (typeof command !== 'string' || command.trim() === '') return err(invalid('stdio 的 MCP 要写 command（例如 npx）'));
    if (secretRefsIn(command).length > 0) return err(invalid('command 里不能引用密钥'));
    const args = raw['args'] ?? [];
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) return err(invalid('mcp.json 的 args 必须是字符串数组'));
    const env = stringRecord(raw['env'], 'env', ENV_KEY);
    if (!env.ok) return env;
    config = { transport, name, description, command, args: args as string[], env: env.value };
  } else if (transport === 'http') {
    const url = raw['url'];
    if (typeof url !== 'string' || !/^https?:\/\/[^\s]+$/.test(url)) return err(invalid('http 的 MCP 要写 url（http:// 或 https:// 开头）'));
    const headers = stringRecord(raw['headers'], 'headers', HEADER_KEY);
    if (!headers.ok) return headers;
    config = { transport, name, description, url, headers: headers.value };
  } else {
    return err(invalid('transport 只能是 stdio 或 http（SSE 不支持）'));
  }
  for (const ref of mcpSecretRefs(config)) {
    const checked = checkSecretName(ref);
    if (!checked.ok) return checked;
  }
  return ok(config);
}
