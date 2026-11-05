/**
 * GitHub 连接器的全部硬规则（ADR 0032 R4）：纯函数，不碰网络和存储。
 * 「谁能把 issue 交给 bot」「什么算疑似注入」「哪些工具在哪个预设下能用」都只在这里定。
 */

export const GITHUB_DEFAULT_LABEL = 'agent';
export const GITHUB_MIN_EVERY_MIN = 5;
export const GITHUB_DEFAULT_EVERY_MIN = 15;
/** 一次轮询最多看几个 issue / 几条评论（再多留到下次）。 */
export const GITHUB_MAX_ISSUES_PER_POLL = 10;
export const GITHUB_MAX_COMMENTS_PER_POLL = 20;
/** 送进模型的外部正文上限。 */
export const GITHUB_MAX_TEXT = 8000;

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
export const isRepo = (s: unknown): s is string => typeof s === 'string' && REPO.test(s) && !s.endsWith('.git');
const LABEL = /^[^,\n]{1,50}$/;

export interface GithubParams { readonly repo: string; readonly label: string; readonly everyMin: number }

export function githubParams(params: Readonly<Record<string, unknown>>): GithubParams {
  const n = typeof params.everyMin === 'number' ? Math.floor(params.everyMin) : GITHUB_DEFAULT_EVERY_MIN;
  return {
    repo: typeof params.repo === 'string' ? params.repo.trim() : '',
    label: typeof params.label === 'string' && params.label.trim() ? params.label.trim() : GITHUB_DEFAULT_LABEL,
    everyMin: Math.max(GITHUB_MIN_EVERY_MIN, n)
  };
}

export function validateGithubParams(kind: string, params: Readonly<Record<string, unknown>>): string | null {
  if (kind !== 'issue') return 'GitHub 只有 issue';
  if (!isRepo(params.repo)) return '仓库要写成 owner/name';
  if (params.label !== undefined && (typeof params.label !== 'string' || (params.label.trim() !== '' && !LABEL.test(params.label.trim())))) return '标签名不合法';
  if (params.everyMin !== undefined && (typeof params.everyMin !== 'number' || !Number.isFinite(params.everyMin))) return 'everyMin 要是数字';
  if (typeof params.everyMin === 'number' && params.everyMin < GITHUB_MIN_EVERY_MIN) return `最短 ${GITHUB_MIN_EVERY_MIN} 分钟`;
  if (typeof params.everyMin === 'number' && params.everyMin > 24 * 60) return '最长 1 天';
  return null;
}

/** 写权限：collaborators/{user}/permission 的 permission 字段（admin / maintain / write 才算）。 */
export const isWriterPermission = (p: string | null | undefined): boolean => p === 'admin' || p === 'maintain' || p === 'write';

/** 时间线里最后一次把 label 贴上去的人（之后被摘掉就算没有）。 */
export function lastLabeler(events: readonly GhIssueEvent[], label: string): { login: string; eventId: number } | null {
  let found: { login: string; eventId: number } | null = null;
  for (const e of events) {
    if (e.label?.name !== label) continue;
    if (e.event === 'labeled' && e.actor?.login) found = { login: e.actor.login, eventId: e.id };
    if (e.event === 'unlabeled') found = null;
  }
  return found;
}

export interface GhIssueEvent { readonly id: number; readonly event: string; readonly actor?: { readonly login: string } | null; readonly label?: { readonly name: string } | null }

/**
 * 疑似提示注入：规则判定，不问模型。命中就不送给 bot，记进「等我处理」由人看。
 * 宁可误拦（人一眼能放行）也不漏：这些句式在正常 issue 里几乎不出现。
 */
const INJECTION_RULES: readonly { readonly id: string; readonly re: RegExp }[] = [
  { id: '要求忽略之前的指令', re: /\b(ignore|disregard|forget|override)\b[^\n]{0,40}\b(previous|prior|above|earlier|all|system|your)\b[^\n]{0,20}\b(instructions?|prompts?|rules?|messages?)\b/i },
  { id: '要求忽略之前的指令', re: /(忽略|无视|忘记|忘掉|覆盖)[^\n]{0,12}(之前|以上|上面|前面|所有|系统)[^\n]{0,8}(指令|提示|规则|设定|要求)/ },
  { id: '冒充系统 / 角色切换', re: /(<\|?(im_start|im_end|system|endoftext)\|?>|\[\/?(system|INST)\]|^\s*(system|assistant)\s*:)/im },
  { id: '冒充系统 / 角色切换', re: /\byou are now\b|\bnew instructions?\s*:|\bdeveloper mode\b|\bjailbreak\b|你现在是|从现在起你是|新的指令[:：]/i },
  { id: '索要密钥 / 环境变量', re: /\b(print|show|reveal|leak|send|post|cat|echo|dump|exfiltrate)\b[^\n]{0,40}\b(token|secret|api[_ -]?key|password|credential|env(ironment)?( variables?)?|\.env|ssh key|private key)\b/i },
  { id: '索要密钥 / 环境变量', re: /(打印|输出|发出|泄露|贴出|告诉我)[^\n]{0,12}(令牌|token|密钥|密码|环境变量|私钥|凭据)/i },
  { id: '要求外传数据', re: /\b(curl|wget|fetch)\b[^\n]{0,80}https?:\/\/[^\s]+[^\n]{0,40}(\$\{?[A-Z_]{3,}|token|secret|env)/i },
  { id: '要求越权操作', re: /\b(merge|force[- ]push|delete)\b[^\n]{0,30}\b(this|the|main|master)?\s*(pr|pull request|branch|repo(sitory)?)\b[^\n]{0,30}\b(without|skip|bypass)\b[^\n]{0,20}\b(review|approval|checks?|ci)\b/i }
];

export function detectInjection(text: string): string | null {
  for (const r of INJECTION_RULES) if (r.re.test(text)) return r.id;
  return null;
}

/** 评论里是否 @ 了 bot（整词：@bot 后面不能再跟用户名字符）。 */
export function mentions(body: string, login: string): boolean {
  if (!login) return false;
  const esc = login.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9-])@${esc}(?![A-Za-z0-9-])`, 'i').test(body);
}

/** 任务来源键：owner/repo#N（task.create 的 source.externalId，去重也按它）。 */
export const issueKey = (repo: string, n: number): string => `${repo}#${n}`;
export function parseIssueKey(key: string): { repo: string; number: number } | null {
  const m = /^([^#\s]+)#(\d+)$/.exec(key);
  if (!m || !isRepo(m[1])) return null;
  return { repo: m[1], number: Number(m[2]) };
}

export const clipText = (s: string, n = GITHUB_MAX_TEXT): string => (s.length > n ? `${s.slice(0, n)}\n…（截断）` : s);

/**
 * 细粒度能力（ADR 0032 R4）：连接器工具不进 Worker 能力表，按 Worker 预设映射。
 * 不能推送（no-remote）仍可评论 / 加表情——它们不碰代码；只读预设不能跑 agent，也就没有。
 * 没有合并、关 issue、推送一类工具：要改代码只能走开 PR，由人合并。
 */
export type GithubCapability = 'connector.github.comment' | 'connector.github.react';
export const GITHUB_CAPABILITIES: readonly GithubCapability[] = ['connector.github.comment', 'connector.github.react'];
export const GITHUB_PRESET_CAPABILITIES: Readonly<Record<'full' | 'no-remote' | 'no-install' | 'readonly', readonly GithubCapability[]>> = {
  full: GITHUB_CAPABILITIES,
  'no-remote': GITHUB_CAPABILITIES,
  'no-install': GITHUB_CAPABILITIES,
  readonly: []
};

/** 由 Worker 能力推出（自定义组合也适用）：能跑 agent 会话（sessions）才有评论 / 表情。null = 老凭据，按完整。 */
export function githubCapabilitiesOf(workerCapabilities: readonly string[] | null | undefined): readonly GithubCapability[] {
  if (workerCapabilities == null) return GITHUB_CAPABILITIES;
  return workerCapabilities.includes('sessions') ? GITHUB_CAPABILITIES : [];
}

export const REACTIONS = ['+1', '-1', 'laugh', 'confused', 'heart', 'hooray', 'rocket', 'eyes'] as const;
export type Reaction = (typeof REACTIONS)[number];
