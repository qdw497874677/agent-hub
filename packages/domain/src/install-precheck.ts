/**
 * 安装预检规则（ADR 0030 D4）：阈值和文案是数据，由 hub 渲染进引导脚本；脚本只采集事实、比较结果。
 * 全部检查做完再一起报失败项，避免「修一个、重跑、再撞下一个」。
 */
export const INSTALL_PRECHECK = {
  os: ['Linux', 'Darwin'] as readonly string[],
  arch: ['x86_64', 'amd64', 'aarch64', 'arm64'] as readonly string[],
  minFreeKb: 1536 * 1024,
  maxSkewSec: 300,
  healthTimeoutSec: 5,
  tools: ['curl', 'tar'] as readonly string[]
} as const;

export interface InstallFacts {
  readonly os: string;
  readonly arch: string;
  readonly homeWritable: boolean;
  /** 家目录所在盘的可用空间（KB）；拿不到为 null（不判失败）。 */
  readonly freeKb: number | null;
  readonly missingTools: readonly string[];
  readonly hubReachable: boolean;
  /** 本机时间 - hub 时间（秒）；hub 没给 Date 头为 null。 */
  readonly skewSec: number | null;
}

export interface PrecheckIssue { readonly code: string; readonly message: string }

export function evaluatePrecheck(facts: InstallFacts, rules = INSTALL_PRECHECK): readonly PrecheckIssue[] {
  const issues: PrecheckIssue[] = [];
  if (!rules.os.includes(facts.os)) issues.push({ code: 'os', message: `不支持的系统 ${facts.os}（只支持 Linux / macOS）` });
  if (!rules.arch.includes(facts.arch)) issues.push({ code: 'arch', message: `不支持的 CPU 架构 ${facts.arch}（只支持 x64 / arm64）` });
  if (!facts.homeWritable) issues.push({ code: 'home', message: '家目录不可写' });
  if (facts.freeKb !== null && facts.freeKb < rules.minFreeKb) {
    issues.push({ code: 'disk', message: `家目录可用空间 ${Math.floor(facts.freeKb / 1024)}MB，不够 ${Math.floor(rules.minFreeKb / 1024)}MB` });
  }
  for (const tool of facts.missingTools) issues.push({ code: 'tool', message: `缺少 ${tool}，请先安装（比如 apt install -y ${tool}）` });
  if (!facts.hubReachable) issues.push({ code: 'hub', message: `${rules.healthTimeoutSec} 秒内连不上 hub 的 /api/health` });
  if (facts.skewSec !== null && Math.abs(facts.skewSec) > rules.maxSkewSec) {
    issues.push({ code: 'clock', message: `本机时钟和 hub 差 ${Math.round(facts.skewSec)} 秒（超过 ${rules.maxSkewSec} 秒，接入码会被判过期），请先校时` });
  }
  return issues;
}

/** 渲染进脚本的变量（只含数字和空格分隔的单词，放心进 shell）。 */
export function precheckShellVars(rules = INSTALL_PRECHECK): string {
  return [
    `PRE_OS='${rules.os.join(' ')}'`,
    `PRE_ARCH='${rules.arch.join(' ')}'`,
    `PRE_MIN_FREE_KB=${rules.minFreeKb}`,
    `PRE_MAX_SKEW=${rules.maxSkewSec}`,
    `PRE_HEALTH_TIMEOUT=${rules.healthTimeoutSec}`,
    `PRE_TOOLS='${rules.tools.join(' ')}'`
  ].join('\n');
}
