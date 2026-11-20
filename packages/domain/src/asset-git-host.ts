import { invalid, type DomainError } from './errors.ts';
import { err, ok, type Result } from './result.ts';

/**
 * 从 git 导入资产时的主机白名单（#224 SSRF）：
 * 只做静态主机名检查 —— 不做 DNS 解析，所以「解析后指向内网」的域名（DNS rebinding）
 * 仍可能穿透，这是已知边界；适配器另有 `http.followRedirects=false` + 干净 HOME/无代理，
 * 缩小但不消灭这条边界。
 */
export interface GitHostPolicy {
  /** 额外放行的主机（大小写不敏感）。以 `.` 开头表示放行整个后缀，例如 `.example.com`。 */
  readonly allowedHosts: readonly string[];
  /** 自建环境才开：放行所有主机（默认关，第一次命中时日志警告一次）。 */
  readonly allowAnyHost: boolean;
}

export const DEFAULT_GIT_HOST_POLICY: GitHostPolicy = { allowedHosts: [], allowAnyHost: false };

/** 仓库地址 form：https:// / ssh:// / git@host:path（与导入接口的输入约束一致）。 */
const GIT_URL = /^(https:\/\/|ssh:\/\/|git@)[^\s]+$/;

const normalizeHost = (host: string): string => host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');

/**
 * 按 inet_aton 规则解析 IPv4 字面量：1–4 段，末段可以更宽；每段支持十进制、
 * `0x` 十六进制、前导 0 八进制（`127.1`、`0x7f.1`、`0177.0.0.1` 都等于 127.0.0.1）。
 * 解析不了返回 null（交给域名分支）。
 */
const parseIpv4 = (host: string): number[] | null => {
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (part === '') return null;
    let digits = part;
    let base = 10;
    if (/^0[xX]/.test(digits)) {
      base = 16;
      digits = digits.slice(2);
    } else if (digits.length > 1 && digits.startsWith('0')) {
      base = 8;
      digits = digits.slice(1);
    }
    if (digits === '' || !/^[0-9a-fA-F]+$/.test(digits)) return null;
    const value = Number.parseInt(digits, base);
    if (!Number.isSafeInteger(value)) return null;
    nums.push(value);
  }
  const [a, b, c, d] = nums as [number, number?, number?, number?];
  let value: number;
  if (nums.length === 1) {
    value = a;
  } else if (nums.length === 2) {
    if (a > 0xff || (b as number) > 0xffffff) return null;
    value = a * 0x1000000 + (b as number);
  } else if (nums.length === 3) {
    if (a > 0xff || (b as number) > 0xff || (c as number) > 0xffff) return null;
    value = a * 0x1000000 + (b as number) * 0x10000 + (c as number);
  } else {
    if (a > 0xff || (b as number) > 0xff || (c as number) > 0xff || (d as number) > 0xff) return null;
    value = a * 0x1000000 + (b as number) * 0x10000 + (c as number) * 0x100 + (d as number);
  }
  if (value > 0xffffffff) return null;
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
};

/** 把 IPv6 展开成 8 个 16 位分组；末段允许内嵌 IPv4（`::ffff:127.0.0.1`）。 */
const parseIpv6 = (host: string): number[] | null => {
  const zone = host.indexOf('%');
  const text = zone === -1 ? host : host.slice(0, zone);
  if (!text.includes(':')) return null;
  const expand = (chunk: string): number[] | null => {
    if (chunk === '') return [];
    const groups = chunk.split(':');
    const out: number[] = [];
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i] as string;
      if (group.includes('.')) {
        if (i !== groups.length - 1) return null;
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
  const halves = text.split('::');
  if (halves.length > 2) return null;
  if (halves.length === 2) {
    const head = expand(halves[0] as string);
    const tail = expand(halves[1] as string);
    if (head === null || tail === null) return null;
    const zeros = 8 - head.length - tail.length;
    if (zeros < 1) return null;
    return [...head, ...new Array<number>(zeros).fill(0), ...tail];
  }
  const all = expand(text);
  return all !== null && all.length === 8 ? all : null;
};

const isBlockedIpv4 = ([a, b]: number[]): boolean => {
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && (b as number) >= 16 && (b as number) <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16
  return false;
};

/**
 * 内网 / 回环 / 保留地址（#224）。判定前先把主机规整成规范 IP：
 * IPv4 简写 / 十六进制 / 八进制、IPv4-mapped IPv6（`::ffff:127.0.0.1`）都归一到同一组规则，
 * 避免 `git@127.1:`、`https://[::ffff:7f00:1]/` 这类写法绕过。只覆盖静态字面量；
 * 域名解析结果不在检查范围（见文件头注释）。
 */
export function isBlockedGitHost(host: string): boolean {
  const name = normalizeHost(host);
  if (name === '') return true;
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  if (name.endsWith('.local') || name.endsWith('.internal')) return true;

  const v4 = parseIpv4(name);
  if (v4 !== null) return isBlockedIpv4(v4);

  const v6 = parseIpv6(name);
  if (v6 !== null) {
    const [g0, g1, g2, g3, g4, g5, g6, g7] = v6 as [number, number, number, number, number, number, number, number];
    // ::ffff:0:0/96：IPv4-mapped，按内嵌的 IPv4 判。
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
      return isBlockedIpv4([(g6 >>> 8) & 0xff, g6 & 0xff, (g7 >>> 8) & 0xff, g7 & 0xff]);
    }
    // ::（未指定）/ ::1（回环）/ IPv4-compatible（::a.b.c.d，已废弃但仍可能被解析）。
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
      if (g6 === 0 && g7 === 0) return true;
      if (g6 === 0 && g7 === 1) return true;
      return isBlockedIpv4([(g6 >>> 8) & 0xff, g6 & 0xff, (g7 >>> 8) & 0xff, g7 & 0xff]);
    }
    if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 链路本地
    if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 唯一本地
    return false;
  }
  return false;
}

/** 从 URL 里取出主机：`https://host/...`、`ssh://git@host/...`、`git@host:org/repo.git`。 */
export function gitUrlHost(url: string): string | null {
  const raw = url.trim();
  if (!GIT_URL.test(raw)) return null;
  if (raw.startsWith('git@')) {
    const rest = raw.slice('git@'.length);
    // scp 形式里的 IPv6 字面量是 `git@[::1]:repo`，冒号在括号里，不能按第一个冒号切。
    if (rest.startsWith('[')) {
      const close = rest.indexOf(']');
      if (close === -1) return null;
      const host = rest.slice(1, close);
      return host === '' ? null : host;
    }
    const end = rest.search(/[/:]/);
    const host = end === -1 ? rest : rest.slice(0, end);
    return host === '' ? null : host;
  }
  try {
    const parsed = new URL(raw);
    return parsed.hostname === '' ? null : parsed.hostname;
  } catch {
    return null;
  }
}

const hostAllowed = (host: string, allowed: readonly string[]): boolean => {
  const name = normalizeHost(host);
  return allowed.some((entry) => {
    const rule = normalizeHost(entry);
    if (rule === '') return false;
    return rule.startsWith('.') ? name.endsWith(rule) : name === rule;
  });
};

/** `ASSET_GIT_ALLOWED_HOSTS`：逗号分隔，忽略空白项。 */
export function parseGitAllowedHosts(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/** 环境里的策略：`ASSET_GIT_ALLOWED_HOSTS` 追加放行，`ASSET_GIT_ALLOW_ANY_HOST=1` 放开全部。 */
export function gitHostPolicyFromEnv(env: Record<string, string | undefined> = process.env): GitHostPolicy {
  return {
    allowedHosts: parseGitAllowedHosts(env['ASSET_GIT_ALLOWED_HOSTS']),
    allowAnyHost: env['ASSET_GIT_ALLOW_ANY_HOST'] === '1'
  };
}

let warnedAllowAny = false;

/**
 * 导入 / 扫描前的统一入口：校验地址 form 与主机。返回主机名，方便调用方记日志。
 * 只做静态检查；不解析 DNS（见文件头）。
 */
export function checkGitSourceUrl(url: string, policy: GitHostPolicy = gitHostPolicyFromEnv()): Result<string, DomainError> {
  const host = gitUrlHost(url);
  if (host === null) return err(invalid('只支持 https://、ssh:// 或 git@ 开头的仓库地址'));
  if (hostAllowed(host, policy.allowedHosts)) return ok(host);
  if (isBlockedGitHost(host)) {
    if (policy.allowAnyHost) {
      if (!warnedAllowAny) {
        warnedAllowAny = true;
        console.warn('[assets] ASSET_GIT_ALLOW_ANY_HOST=1：允许从任意主机克隆，仅限自建环境');
      }
      return ok(host);
    }
    return err(invalid(`不能从内网 / 保留地址克隆：${host}（要放行请设 ASSET_GIT_ALLOWED_HOSTS）`));
  }
  return ok(host);
}
