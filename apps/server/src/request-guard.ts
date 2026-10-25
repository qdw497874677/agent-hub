import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

/**
 * 浏览器侧的两道门：防 DNS 重绑定，防跨站。
 *
 * 默认只绑回环、不设 token——这时「能连上 127.0.0.1」就等于有权限，
 * 而浏览器里随便一个网页都能让请求打到 127.0.0.1：
 * - DNS 重绑定：evil.example 解析到 127.0.0.1，请求带的 Host 是 evil.example。
 *   只认 IP 字面量、localhost 和显式配置的主机名就挡住了（重绑定必须用域名）。
 * - 跨站 WebSocket / 表单：浏览器总会带 Origin。Origin 和 Host 不是同一个站就拒；
 *   不带 Origin 的是 worker、curl 这类非浏览器客户端，它们不受同源保护，也不需要。
 */
export interface RequestGuard {
  hostAllowed(host: string | undefined): boolean;
  originAllowed(origin: string | undefined, host: string | undefined): boolean;
}

export function createRequestGuard(extraHosts: readonly string[]): RequestGuard {
  const named = new Set(['localhost', ...extraHosts.map((name) => name.trim().toLowerCase()).filter(Boolean)]);
  const hostnameOf = (host: string): string => {
    const value = host.trim().toLowerCase();
    if (value.startsWith('[')) return value.slice(1, value.indexOf(']'));
    const colon = value.lastIndexOf(':');
    return colon > 0 && value.indexOf(':') === colon ? value.slice(0, colon) : value;
  };
  return {
    hostAllowed(host) {
      if (host === undefined || host === '') return true; // HTTP/1.0 之类不带 Host 的客户端不是浏览器
      const name = hostnameOf(host);
      return isIP(name) !== 0 || named.has(name) || name.endsWith('.localhost');
    },
    originAllowed(origin, host) {
      if (origin === undefined || origin === '') return true;
      if (host === undefined) return false;
      try {
        return new URL(origin).host.toLowerCase() === host.trim().toLowerCase();
      } catch {
        return false;
      }
    }
  };
}

/** token 的常量时间比较：逐字节 `!==` 会从响应时间里漏出「前几个字符对了」。 */
export function sameSecret(offered: string, expected: string): boolean {
  const a = Buffer.from(offered);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
