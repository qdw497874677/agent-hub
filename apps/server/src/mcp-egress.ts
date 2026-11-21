import { lookup as dnsLookup } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { err, invalid, ok, type DomainError, type Result } from '@agent-hub/domain';

/**
 * hub 代连远端 MCP（relay）与 OAuth 取 token 的出口策略（#243 防御项）。
 *
 * 只允许 HTTPS 公网目标：
 * - URL 先做静态校验：协议、userinfo、字面量内网 / 保留地址、内网主机名；
 * - 真正连接时由 app 私有的 Undici Agent `connect.lookup` 再校验 DNS 解析结果，
 *   实际连到的是校验过的那个地址，堵住「解析后指向内网」的 DNS rebinding；
 * - 不跟随重定向、不覆盖 Host、保留 URL 主机名做 TLS SNI / 证书校验；
 * - 不使用全局 dispatcher，Agent 只属于 hub 的 MCP 出口。
 *
 * 运维例外只认「精确主机名」，不做通配：
 * - `MCP_EGRESS_ALLOW_PRIVATE_HOSTS=a.internal,10.0.0.5`：这些主机允许解析到内网 / 保留地址；
 * - `MCP_EGRESS_ALLOW_HTTP_HOSTS=mcp.internal`：这些主机允许明文 HTTP。
 * 两条都只影响各自那一项；OAuth token 地址永远要求 HTTPS。
 */

export interface McpEgressPolicy {
  /** 精确主机名：允许解析到内网 / 保留地址（默认空）。 */
  readonly allowPrivateHosts: readonly string[];
  /** 精确主机名：允许明文 HTTP（默认空；OAuth 不受此例外影响）。 */
  readonly allowHttpHosts: readonly string[];
}

export const DEFAULT_MCP_EGRESS_POLICY: McpEgressPolicy = {
  allowPrivateHosts: [],
  allowHttpHosts: []
};

export interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

/** 可注入的 DNS 解析器；测试用它返回合成地址，不碰真实网络。 */
export type EgressResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export class McpEgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpEgressError';
  }
}

export function normalizeEgressHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function parseHostList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map(normalizeEgressHost)
    .filter((host) => host !== '');
}

/** 运维环境变量 → 策略。只接受精确主机名，通配 / 后缀写法不生效。 */
export function mcpEgressPolicyFromEnv(env: Record<string, string | undefined> = process.env): McpEgressPolicy {
  return {
    allowPrivateHosts: parseHostList(env['MCP_EGRESS_ALLOW_PRIVATE_HOSTS']),
    allowHttpHosts: parseHostList(env['MCP_EGRESS_ALLOW_HTTP_HOSTS'])
  };
}

const hostIn = (host: string, hosts: readonly string[]): boolean =>
  hosts.some((entry) => normalizeEgressHost(entry) === host);

const parseIpv4 = (text: string): number[] | null => {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    out.push(value);
  }
  return out;
};

/** IPv6 展开成 8 个 16 位分组；支持 `::` 压缩与末尾内嵌 IPv4。 */
const parseIpv6 = (text: string): number[] | null => {
  const zone = text.indexOf('%');
  const raw = zone === -1 ? text : text.slice(0, zone);
  if (!raw.includes(':')) return null;

  const expand = (chunk: string): number[] | null => {
    if (chunk === '') return [];
    const groups = chunk.split(':');
    const out: number[] = [];
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index] as string;
      if (group.includes('.')) {
        if (index !== groups.length - 1) return null;
        const v4 = parseIpv4(group);
        if (v4 === null) return null;
        out.push(((v4[0] as number) << 8) | (v4[1] as number), ((v4[2] as number) << 8) | (v4[3] as number));
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };

  const halves = raw.split('::');
  if (halves.length > 2) return null;
  if (halves.length === 2) {
    const head = expand(halves[0] as string);
    const tail = expand(halves[1] as string);
    if (head === null || tail === null) return null;
    const zeros = 8 - head.length - tail.length;
    if (zeros < 1) return null;
    return [...head, ...new Array<number>(zeros).fill(0), ...tail];
  }
  const all = expand(raw);
  return all !== null && all.length === 8 ? all : null;
};

/** 非公网 IPv4：私网、回环、链路本地、CGNAT、文档 / 基准 / 组播 / 保留。 */
const isBlockedIpv4 = (address: readonly number[]): boolean => {
  const [a = 0, b = 0] = address;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 链路本地 / 云元数据
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 0 && address[2] === 0) return true; // 192.0.0.0/24 IETF
  if (a === 192 && b === 0 && address[2] === 2) return true; // 192.0.2.0/24 TEST-NET-1
  if (a === 192 && b === 88 && address[2] === 99) return true; // 192.88.99.0/24 6to4 relay
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmark
  if (a === 198 && b === 51 && address[2] === 100) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && address[2] === 113) return true; // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true; // 组播 + 240.0.0.0/4 保留（含广播）
  return false;
};

const isBlockedIpv6 = (groups: readonly number[]): boolean => {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = groups;

  // ::ffff:0:0/96（IPv4-mapped）与 ::/96（IPv4-compatible）：按内嵌 IPv4 判。
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && (f === 0 || f === 0xffff)) {
    if (f === 0 && g === 0 && h < 2) return true; // :: / ::1
    return isBlockedIpv4([(g >>> 8) & 0xff, g & 0xff, (h >>> 8) & 0xff, h & 0xff]);
  }
  // 64:ff9b::/96 NAT64：同样按内嵌 IPv4 判。
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) {
    return isBlockedIpv4([(g >>> 8) & 0xff, g & 0xff, (h >>> 8) & 0xff, h & 0xff]);
  }

  // 只放行全局单播 2000::/3；其余（ULA / 链路本地 / 组播 / 未指定 / 丢弃）一律拒绝。
  if ((a & 0xe000) !== 0x2000) return true;
  if (a === 0x2001 && b === 0x0000) return true; // 2001::/32 Teredo
  if (a === 0x2001 && b === 0x0002) return true; // 2001:2::/48 benchmarking
  if (a === 0x2001 && b === 0x0db8) return true; // 2001:db8::/32 文档
  if (a === 0x2001 && ((b & 0xfff0) === 0x0010 || (b & 0xfff0) === 0x0020)) return true; // ORCHID
  if (a === 0x2002) {
    // 2002::/16 6to4：按内嵌 IPv4 判。
    return isBlockedIpv4([(b >>> 8) & 0xff, b & 0xff, (c >>> 8) & 0xff, c & 0xff]);
  }
  if (a === 0x3fff && (b & 0xf000) === 0) return true; // 3fff::/20 文档（RFC 9637）
  return false;
};

/** 地址是否不可作为 MCP 出口目标。解析不了的地址按不可用处理。 */
export function isBlockedEgressAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const v4 = parseIpv4(address);
    return v4 === null || isBlockedIpv4(v4);
  }
  if (family === 6) {
    const v6 = parseIpv6(address);
    return v6 === null || isBlockedIpv6(v6);
  }
  return true;
}

const isBlockedHostname = (host: string): boolean =>
  host === 'localhost' ||
  host.endsWith('.localhost') ||
  host.endsWith('.local') ||
  host.endsWith('.internal') ||
  host.endsWith('.home.arpa') ||
  host.endsWith('.lan');

export interface McpEgressCheckOptions {
  /** OAuth token 地址等：无论 HTTP 例外如何配置，都只允许 HTTPS。 */
  readonly requireHttps?: boolean;
}

/** 使用前校验展开后的 URL（含 userinfo、协议、字面量内网地址 / 主机名）。 */
export function checkMcpEgressUrl(
  raw: string,
  policy: McpEgressPolicy = DEFAULT_MCP_EGRESS_POLICY,
  options: McpEgressCheckOptions = {}
): Result<URL, DomainError> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return err(invalid('MCP 地址不是合法 URL'));
  }
  if (url.username !== '' || url.password !== '') {
    return err(invalid('MCP 地址不能带用户名或密码'));
  }

  const host = normalizeEgressHost(url.hostname);
  if (host === '') return err(invalid('MCP 地址缺少主机名'));

  const privateAllowed = hostIn(host, policy.allowPrivateHosts);
  if (!privateAllowed) {
    const family = isIP(host);
    if (family !== 0 && isBlockedEgressAddress(host)) {
      return err(invalid('MCP 地址指向内网 / 保留地址'));
    }
    if (family === 0 && !host.includes('.')) {
      return err(invalid('MCP 地址不能使用单段主机名'));
    }
    if (isBlockedHostname(host)) {
      return err(invalid('MCP 地址不能使用内网主机名'));
    }
  }

  if (url.protocol === 'https:') return ok(url);
  if (url.protocol === 'http:') {
    if (options.requireHttps) return err(invalid('OAuth token 地址必须使用 HTTPS'));
    return hostIn(host, policy.allowHttpHosts)
      ? ok(url)
      : err(invalid('MCP 地址必须使用 HTTPS（明文 HTTP 只允许运维显式放行的主机）'));
  }
  return err(invalid(`不支持的 MCP 地址协议：${url.protocol}`));
}

/** 请求头里不允许覆盖 Host（会破坏 TLS 身份 / 名字对应关系）。 */
export function assertNoHostHeader(headers: RequestInit['headers'] | undefined): void {
  if (!headers) return;
  const entries: [string, string][] = [];
  if (headers instanceof Headers) {
    for (const [name, value] of headers) entries.push([name, value]);
  } else if (Array.isArray(headers)) {
    for (const pair of headers) entries.push([String(pair[0]), String(pair[1])]);
  } else {
    for (const [name, value] of Object.entries(headers as Record<string, string>)) entries.push([name, value]);
  }
  if (entries.some(([name]) => name.trim().toLowerCase() === 'host')) {
    throw new McpEgressError('MCP 请求头不能覆盖 Host');
  }
}

const defaultResolver: EgressResolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses as ResolvedAddress[]);
    });
  });

/**
 * 给 Undici Agent 的 `connect.lookup`：解析结果逐个校验，实际连接的地址就是校验过的地址。
 * 同时兼容 Node 的 single（address + family）与 `all: true`（地址数组）两种回调形态。
 * 主机名精确命中 `allowPrivateHosts` 时才放行内网解析结果。
 */
export function createEgressLookup(
  policy: McpEgressPolicy,
  resolve: EgressResolver = defaultResolver
): LookupFunction {
  return (hostname, options, callback) => {
    const host = normalizeEgressHost(hostname);
    const allowPrivate = hostIn(host, policy.allowPrivateHosts);
    resolve(hostname)
      .then((addresses) => {
        const wanted =
          options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : typeof options.family === 'number' ? options.family : 0;
        const candidates = wanted === 0 ? addresses : addresses.filter((entry) => entry.family === wanted);
        if (candidates.length === 0) {
          throw new McpEgressError('MCP 地址解析不到可用主机');
        }
        if (!allowPrivate) {
          for (const entry of candidates) {
            if (isBlockedEgressAddress(entry.address)) {
              throw new McpEgressError('MCP 地址解析到内网 / 保留地址');
            }
          }
        }
        if (options.all) {
          callback(null, candidates.map((entry) => ({ address: entry.address, family: entry.family })));
          return;
        }
        const first = candidates[0] as ResolvedAddress;
        callback(null, first.address, first.family);
      })
      .catch((error: unknown) => {
        const failure = error instanceof McpEgressError ? error : new McpEgressError('MCP 地址解析失败');
        callback(failure, '', 0);
      });
  };
}

export interface McpEgressOptions {
  readonly policy?: McpEgressPolicy;
  /** 测试注入：默认使用 node:dns。 */
  readonly resolve?: EgressResolver;
  /** 测试注入：默认使用 undici 的 fetch（仍会带上本模块的 Agent）。 */
  readonly fetchImpl?: typeof fetch;
}

export interface McpEgress {
  readonly policy: McpEgressPolicy;
  /** relay 与 OAuth 共用的安全 fetch：校验 URL / Host，强制不跟随重定向，绑定 app 私有 Agent。 */
  readonly fetch: typeof fetch;
  checkUrl(raw: string, options?: McpEgressCheckOptions): Result<URL, DomainError>;
  assertHeaders(headers: RequestInit['headers'] | undefined): void;
  close(): Promise<void>;
}

/**
 * 建一个 hub 私有的出口。不要设置 `connect.servername`：TLS SNI / 证书校验继续用 URL 里的
 * 主机名，`lookup` 只替换「主机名 → 地址」这一步。
 */
export function createMcpEgress(options: McpEgressOptions = {}): McpEgress {
  const policy = options.policy ?? mcpEgressPolicyFromEnv();
  const agent = new Agent({ connect: { lookup: createEgressLookup(policy, options.resolve) } });
  const baseFetch = options.fetchImpl ?? (undiciFetch as unknown as typeof fetch);

  const secureFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const checked = checkMcpEgressUrl(raw, policy);
    if (!checked.ok) throw new McpEgressError(checked.error.message);
    // Request 自带的头可能藏着 Host；即使 init.headers 覆盖了也要拒绝。
    if (input instanceof Request) assertNoHostHeader(input.headers);
    assertNoHostHeader(init?.headers);
    return baseFetch(input, { ...init, redirect: 'error', dispatcher: agent } as RequestInit & { dispatcher: Agent });
  }) as typeof fetch;

  return {
    policy,
    fetch: secureFetch,
    checkUrl: (raw, checkOptions) => checkMcpEgressUrl(raw, policy, checkOptions),
    assertHeaders: assertNoHostHeader,
    close: () => agent.close()
  };
}

let sharedEgress: McpEgress | null = null;

/** hub 默认出口：relay 与 OAuth 用同一个实例 / 同一个 Agent。 */
export function defaultMcpEgress(): McpEgress {
  sharedEgress ??= createMcpEgress();
  return sharedEgress;
}
