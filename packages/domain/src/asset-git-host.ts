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

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

const ipv4Parts = (host: string): number[] | null => {
  if (!IPV4.test(host)) return null;
  const parts = host.split('.').map(Number);
  return parts.every((part) => part >= 0 && part <= 255) ? parts : null;
};

/**
 * 内网 / 回环 / 保留地址（#224）。只覆盖静态字面量；域名解析结果不在检查范围（见文件头注释）。
 */
export function isBlockedGitHost(host: string): boolean {
  const name = normalizeHost(host);
  if (name === '') return true;
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  if (name.endsWith('.local') || name.endsWith('.internal')) return true;

  const v4 = ipv4Parts(name);
  if (v4) {
    const [a, b] = v4 as [number, number, number, number];
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // 169.254.0.0/16
    return false;
  }

  if (name === '::1' || name === '0:0:0:0:0:0:0:1') return true;
  if (name === '::' || name === '0:0:0:0:0:0:0:0') return true;
  return false;
}

/** 从 URL 里取出主机：`https://host/...`、`ssh://git@host/...`、`git@host:org/repo.git`。 */
export function gitUrlHost(url: string): string | null {
  const raw = url.trim();
  if (!GIT_URL.test(raw)) return null;
  if (raw.startsWith('git@')) {
    const rest = raw.slice('git@'.length);
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
