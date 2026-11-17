import { invalid, type DomainError } from './errors.ts';
import { err, ok, type Result } from './result.ts';

/**
 * MCP 资产（docs/design/asset-hub.md §MCP）：一份 `mcp.json`，描述一个 MCP 服务器怎么连。
 *
 * 配置里**不放密钥明文**：要用密钥的地方写 `${secret:NAME}`，密钥本身单独存在 hub 的保险箱里（加密落库）。
 * - stdio：在 Worker 上由 agent 拉起；密钥只在会话启动时展开进那个进程的环境变量。
 * - http：远端服务器由 hub 代连（经 Worker 长连接中转），密钥只在 hub 上展开进请求头，不下发。
 */
/**
 * 工具级开关：一份 stdio 服务器由 agent 自己拉起，hub 管不到它暴露哪些工具；
 * http 服务器经 hub 代连，`listTools` 会按这里过滤，`callTool` 也会拒。
 */
export interface McpToolFilter {
  /** 只放行这些工具（空 / 缺省 = 全放行）。 */
  readonly allow?: readonly string[];
  /** 屏蔽这些工具（优先级高于 allow）。 */
  readonly deny?: readonly string[];
}

/** OAuth 客户端凭据模式（client_credentials）：hub 取 token、放 Bearer、到期前刷新、401 重试一次。 */
export interface McpOAuth {
  readonly tokenUrl: string;
  readonly clientId: string;
  /** 如果占位是 `${secret:…}`，运行时在 hub 上展开。 */
  readonly clientSecret?: string;
  readonly scope?: string;
  readonly audience?: string;
  /** basic = client_secret_basic（推荐）；post = 放 body 里。 */
  readonly authStyle: 'basic' | 'post';
}

export type McpConfig =
  | {
      readonly transport: 'stdio';
      readonly name: string;
      readonly description: string;
      readonly command: string;
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
      readonly tools?: McpToolFilter;
    }
  | {
      readonly transport: 'http';
      readonly name: string;
      readonly description: string;
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly tools?: McpToolFilter;
      readonly oauth?: McpOAuth;
    };

/** 一份 mcp.json 可以描述多个服务器（`{"servers":[…]}`；也认 Claude/Cursor 的 `{"mcpServers":{…}}`）。 */
export interface McpAsset {
  readonly servers: readonly McpConfig[];
}

export const MCP_SERVERS_MAX = 20;

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
  const values =
    config.transport === 'stdio'
      ? [...config.args, ...Object.values(config.env)]
      : [config.url, ...Object.values(config.headers), ...(config.oauth?.clientSecret ? [config.oauth.clientSecret] : []), ...(config.oauth?.clientId && secretRefsIn(config.oauth.clientId).length > 0 ? [config.oauth.clientId] : [])];
  return [...new Set(values.flatMap(secretRefsIn))].sort();
}

/** 工具过滤：deny 优先，allow 为空表示不限。只对经 hub 代连的 http 服务器生效。 */
export function toolAllowed(config: McpConfig, name: string): boolean {
  const filter = config.tools;
  if (!filter) return true;
  if (filter.deny?.includes(name)) return false;
  return filter.allow === undefined || filter.allow.length === 0 ? true : filter.allow.includes(name);
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

/** 工具过滤：`tools: ["a","b"]` / `tools: {allow,deny}` / `denyTools: [...]` 都认。 */
function toolFilterOf(raw: Record<string, unknown>): Result<McpToolFilter | null, DomainError> {
  const read = (value: unknown, field: string): Result<string[] | null, DomainError> => {
    if (value === undefined) return ok(null);
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) return err(invalid(`mcp.json 的 ${field} 必须是工具名字符串数组`));
    return ok(value as string[]);
  };
  const declared = raw['tools'];
  if (Array.isArray(declared)) {
    const list = read(declared, 'tools');
    if (!list.ok) return list;
    return ok({ allow: list.value ?? [] });
  }
  const deny = read(raw['denyTools'] ?? (isRecord(declared) ? declared['deny'] : undefined), 'denyTools');
  if (!deny.ok) return deny;
  const allow = read(isRecord(declared) ? declared['allow'] : undefined, 'tools.allow');
  if (!allow.ok) return allow;
  if (deny.value === null && allow.value === null) return ok(null);
  return ok({
    ...(allow.value !== null ? { allow: allow.value } : {}),
    ...(deny.value !== null ? { deny: deny.value } : {})
  });
}

/** OAuth：`{"tokenUrl": "…", "clientId": "…", "clientSecret": "${secret:X}", "scope": "…", "authStyle": "basic"}`。 */
function oauthOf(raw: Record<string, unknown>): Result<McpOAuth | null, DomainError> {
  const value = raw['oauth'];
  if (value === undefined) return ok(null);
  if (!isRecord(value)) return err(invalid('mcp.json 的 oauth 必须是对象'));
  const tokenUrl = value['tokenUrl'];
  if (typeof tokenUrl !== 'string' || !/^https?:\/\/[^\s]+$/.test(tokenUrl)) return err(invalid('oauth.tokenUrl 要写 http(s) 地址'));
  const clientId = value['clientId'];
  if (typeof clientId !== 'string' || clientId.trim() === '') return err(invalid('oauth.clientId 不能为空'));
  const clientSecret = value['clientSecret'];
  if (clientSecret !== undefined && typeof clientSecret !== 'string') return err(invalid('oauth.clientSecret 必须是字符串'));
  const scope = value['scope'];
  if (scope !== undefined && typeof scope !== 'string') return err(invalid('oauth.scope 必须是字符串'));
  const audience = value['audience'];
  if (audience !== undefined && typeof audience !== 'string') return err(invalid('oauth.audience 必须是字符串'));
  const style = value['authStyle'] ?? 'basic';
  if (style !== 'basic' && style !== 'post') return err(invalid('oauth.authStyle 只能是 basic 或 post'));
  return ok({
    tokenUrl,
    clientId,
    ...(clientSecret !== undefined && clientSecret !== '' ? { clientSecret } : {}),
    ...(scope !== undefined && scope !== '' ? { scope } : {}),
    ...(audience !== undefined && audience !== '' ? { audience } : {}),
    authStyle: style
  });
}

/** 一个服务器条目（单服务器格式 / servers[] / mcpServers{}) 都走这里。 */
function parseServer(raw: unknown, fallbackName?: string): Result<McpConfig, DomainError> {
  if (!isRecord(raw)) return err(invalid('mcp.json 里的服务器必须是对象'));
  const name = raw['name'] ?? fallbackName;
  if (typeof name !== 'string' || name === '') return err(invalid('mcp.json 里缺 name'));
  if (!/^[a-z0-9-]{1,64}$/.test(name)) return err(invalid(`MCP 服务器名「${name}」只能用小写字母、数字和短横线（最多 64 个）`));
  if (RESERVED.has(name)) return err(invalid(`「${name}」是 hub 自己的工具服务器名，换一个`));
  const description = raw['description'] ?? '';
  if (typeof description !== 'string') return err(invalid('mcp.json 的 description 必须是字符串'));
  const tools = toolFilterOf(raw);
  if (!tools.ok) return tools;
  const declared = raw['transport'] ?? raw['type'];
  const transport = declared ?? (raw['url'] !== undefined ? 'http' : 'stdio');
  if (transport === 'sse' || transport === 'streamable-http' || transport === 'streamableHttp') {
    return err(invalid('只支持 stdio 和 http（streamable HTTP）两种 MCP 传输；旧式 SSE 不支持'));
  }
  let config: McpConfig;
  if (transport === 'stdio') {
    const command = raw['command'];
    if (typeof command !== 'string' || command.trim() === '') return err(invalid('stdio 的 MCP 要写 command（例如 npx）'));
    if (secretRefsIn(command).length > 0) return err(invalid('command 里不能引用密钥'));
    const args = raw['args'] ?? [];
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) return err(invalid('mcp.json 的 args 必须是字符串数组'));
    const env = stringRecord(raw['env'], 'env', ENV_KEY);
    if (!env.ok) return env;
    config = { transport, name, description, command, args: args as string[], env: env.value, ...(tools.value ? { tools: tools.value } : {}) };
  } else if (transport === 'http') {
    const url = raw['url'];
    if (typeof url !== 'string' || !/^https?:\/\/[^\s]+$/.test(url)) return err(invalid('http 的 MCP 要写 url（http:// 或 https:// 开头）'));
    const headers = stringRecord(raw['headers'], 'headers', HEADER_KEY);
    if (!headers.ok) return headers;
    const oauth = oauthOf(raw);
    if (!oauth.ok) return oauth;
    config = {
      transport,
      name,
      description,
      url,
      headers: headers.value,
      ...(tools.value ? { tools: tools.value } : {}),
      ...(oauth.value ? { oauth: oauth.value } : {})
    };
  } else {
    return err(invalid('transport 只能是 stdio 或 http（SSE 不支持）'));
  }
  for (const ref of mcpSecretRefs(config)) {
    const checked = checkSecretName(ref);
    if (!checked.ok) return checked;
  }
  return ok(config);
}

/**
 * 校验一份 mcp.json，得到一个或多个服务器：
 * - 单服务器：`{"name": "github", "transport": "stdio", "command": "npx", …}`
 * - 多服务器：`{"servers": [ … ]}`
 * - Claude / Cursor 导出格式：`{"mcpServers": {"github": {"command": "npx", …}}}`
 */
export function parseMcpAsset(text: string): Result<McpAsset, DomainError> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return err(invalid(`mcp.json 不是合法的 JSON：${(error as Error).message}`));
  }
  if (!isRecord(raw)) return err(invalid('mcp.json 必须是一个对象'));
  const servers: McpConfig[] = [];
  const listed = raw['servers'];
  const mapped = raw['mcpServers'];
  if (Array.isArray(listed)) {
    if (listed.length === 0) return err(invalid('mcp.json 的 servers 是空的'));
    if (listed.length > MCP_SERVERS_MAX) return err(invalid(`一份 mcp.json 最多 ${MCP_SERVERS_MAX} 个服务器`));
    for (const entry of listed) {
      const parsed = parseServer(entry);
      if (!parsed.ok) return parsed;
      servers.push(parsed.value);
    }
  } else if (isRecord(mapped)) {
    const entries = Object.entries(mapped);
    if (entries.length === 0) return err(invalid('mcp.json 的 mcpServers 是空的'));
    if (entries.length > MCP_SERVERS_MAX) return err(invalid(`一份 mcp.json 最多 ${MCP_SERVERS_MAX} 个服务器`));
    for (const [name, entry] of entries) {
      const parsed = parseServer(entry, name);
      if (!parsed.ok) return parsed;
      servers.push(parsed.value);
    }
  } else {
    const parsed = parseServer(raw);
    if (!parsed.ok) return parsed;
    servers.push(parsed.value);
  }
  const seen = new Set<string>();
  for (const server of servers) {
    if (seen.has(server.name)) return err(invalid(`mcp.json 里有两个同名服务器「${server.name}」`));
    seen.add(server.name);
  }
  return ok({ servers });
}

/** 单服务器格式的便捷入口（老调用方 / 测试用）：不是恰好一个就报错。 */
export function parseMcpConfig(text: string): Result<McpConfig, DomainError> {
  const parsed = parseMcpAsset(text);
  if (!parsed.ok) return parsed;
  const [first] = parsed.value.servers;
  if (parsed.value.servers.length !== 1 || !first) return err(invalid('这个位置只接受单个 MCP 服务器'));
  return ok(first);
}
