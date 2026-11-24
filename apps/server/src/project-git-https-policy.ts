import { lookup as dnsLookup } from 'node:dns';
import { normalizeEgressHost, type EgressResolver, type ResolvedAddress } from './mcp-egress.ts';

/**
 * 项目 HTTPS Git（只读广告探测 / 隔离抓取）共用的「精确 origin + 出口目标」规范化。
 *
 * 这里只收 probe 与 fetch 语义完全一致的构件：
 * - operator 放行 origin 的解析与规范化（精确 HTTPS origin，无通配 / 路径 / query / fragment）；
 * - 云元数据端点与 loopback 地址的识别；
 * - 测试专用 loopback 解析器（生产关闭，只额外放行真 loopback）；
 * - 调用方给的 Basic Authorization 头值的形状校验。
 *
 * 目标路径校验、分支规则、超时 / 配额与阶段错误文案都留在各自模块：probe 只读广告，
 * fetch 是 bridge + Git 抓取，两者的接受面与失败语义并不相同；会话级组合的校验更宽，
 * 也不在这里共用。
 */

/** 单行 Authorization 头值的长度上限。 */
const MAX_AUTHORIZATION_LENGTH = 8192;

export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '::1', 'localhost']);

const METADATA_HOSTS = new Set(['metadata', 'metadata.google.internal', 'instance-data']);
const METADATA_ADDRESSES = new Set([
  '169.254.169.254',
  '169.254.170.2',
  '100.100.100.200',
  'fd00:ec2::254'
]);

/** 精确 origin 的规范化 key；IPv6 主机名重新加回方括号。 */
export function originKey(url: URL): string {
  const host = normalizeEgressHost(url.hostname);
  const hostPart = host.includes(':') ? `[${host}]` : host;
  return `${url.protocol}//${hostPart}${url.port === '' ? '' : `:${url.port}`}`;
}

/**
 * 解析 operator 放行清单。只接受精确 HTTPS origin；`label` 用于保留各调用方原有的
 * 启动期错误前缀（错误文案是既有契约的一部分，不能合并成一句新的）。
 */
export function parseAllowedOrigins(entries: readonly string[], label: string): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const entry of entries) {
    const raw = entry.trim();
    if (raw === '' || raw.includes('*')) {
      throw new Error(`${label}: allowedOrigins 必须是精确的 HTTPS origin`);
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`${label}: allowedOrigins 里有不合法的 URL`);
    }
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      (url.pathname !== '' && url.pathname !== '/')
    ) {
      throw new Error(`${label}: allowedOrigins 只接受纯 HTTPS origin`);
    }
    origins.add(originKey(url));
  }
  return origins;
}

/** 云元数据端点：即使 operator 把私网例外写到这些地址上也拒绝。 */
export function isMetadataHost(host: string): boolean {
  if (METADATA_HOSTS.has(host)) return true;
  if (host.endsWith('.metadata.google.internal')) return true;
  if (METADATA_ADDRESSES.has(host)) return true;
  // 兼容 IPv4-mapped / 带前缀写法，避免换一种写法绕过。
  return host.includes('169.254.169.254') || host.includes('100.100.100.200');
}

function isLoopbackAddress(address: string): boolean {
  if (address === '::1') return true;
  const parts = address.split('.');
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
  );
}

const defaultResolver: EgressResolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses as ResolvedAddress[]);
    });
  });

/**
 * 测试 loopback 模式下 DNS 只能解析到真 loopback：即使 `localhost` 被 aliases 成别的地址，
 * 也不会把私网 / 元数据端点带进来。`label` 同样只用于保留调用方原有的错误前缀。
 */
export function createLoopbackResolver(base: EgressResolver | undefined, label: string): EgressResolver {
  const resolve = base ?? defaultResolver;
  return async (hostname) => {
    const host = normalizeEgressHost(hostname);
    const addresses = await resolve(hostname);
    if (
      LOOPBACK_HOSTS.has(host) &&
      (addresses.length === 0 || !addresses.every((entry) => isLoopbackAddress(entry.address)))
    ) {
      throw new Error(`${label}: 测试 loopback 目标解析到了非回环地址`);
    }
    return addresses;
  };
}

/**
 * 调用方已经生成好的 Basic 头值形状：必须是不超过 8192 字符、无 CRLF / NUL 的单行
 * `Basic …`。空串（不带凭据）由调用方先处理；这里只回答「非空值能否原样当请求头」。
 */
export function isAcceptableBasicAuthorization(raw: unknown): raw is string {
  return (
    typeof raw === 'string' &&
    raw.length <= MAX_AUTHORIZATION_LENGTH &&
    !/[\r\n\u0000]/u.test(raw) &&
    /^Basic [A-Za-z0-9+/]+={0,2}$/iu.test(raw)
  );
}
