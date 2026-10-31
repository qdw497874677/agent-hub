import type { Asset, AssetKind, AssetScope } from './asset.ts';
import type { McpConfig } from './mcp.ts';
import { secretRefsIn } from './mcp.ts';
import { forbidden, invalid, type DomainError } from './errors.ts';
import { err, ok, type Result } from './result.ts';

/**
 * 资产上架与审核（ADR 0016，docs/design/asset-review.md）。
 *
 * 纯规则：谁能审、要几票、扫描、MCP 风险摘要、密钥命名空间。用例在 use-cases/asset-review.ts。
 * David 的决定：1A 个人资产免审但只能装到作者自己的机器；2A 团队负责人 + 指定审核人审团队资产；
 * 3A 禁止自审，单人团队 / 负责人自己的提交转 hub 管理员，hub 管理员可自审全局资产但打审计标记；
 * 4A 第二审核人默认关，团队 / hub 可对全局和 MCP stdio 打开；5A Git 新内容自动成为待审版本，旧钉住版本照常；
 * 6B 成员往团队共享机器装资产走安装申请，团队负责人批。
 */

export type SubmissionStatus = 'pending' | 'approved' | 'rejected' | 'changes_requested' | 'withdrawn' | 'superseded';
export type SubmissionOrigin = 'user' | 'git' | 'token' | 'migration';

export interface AssetApproval {
  readonly userId: string;
  readonly at: number;
  /** 审核人就是提交人 / 作者（只有 hub 管理员在允许的情形下会出现），审计里打标记。 */
  readonly selfApproved: boolean;
}

export interface FindingLine {
  readonly level: 'info' | 'warn' | 'high';
  readonly rule: string;
  readonly path: string;
  readonly line: number | null;
  readonly message: string;
}

export interface McpRiskSummary {
  readonly transport: 'stdio' | 'http';
  readonly level: 'low' | 'medium' | 'high';
  readonly command: string | null;
  readonly args: readonly string[];
  readonly url: string | null;
  readonly host: string | null;
  readonly packages: readonly { readonly name: string; readonly pinned: boolean }[];
  readonly secrets: readonly string[];
  readonly notes: readonly string[];
  /** 相对已发布版本变了什么（command / args / env / url / headers）。 */
  readonly changed: readonly string[];
}

export interface SecretRefStatus {
  readonly name: string;
  /** 运行时会从哪一层取到；null = 哪层都没设。 */
  readonly from: 'personal' | 'team' | 'hub' | null;
}

export interface ReviewReport {
  readonly findings: readonly FindingLine[];
  readonly mcp: McpRiskSummary | null;
  readonly secrets: readonly SecretRefStatus[];
  readonly filesChanged: number;
}

export interface AssetSubmission {
  readonly id: string;
  readonly assetId: string;
  readonly digest: string;
  /** 提交时已发布的版本（'' = 首次上架）。 */
  readonly previous: string;
  /** 'system' = Git 自动检查。 */
  readonly submittedBy: string;
  readonly origin: SubmissionOrigin;
  readonly tokenId: string | null;
  /** 申请把作用域改成什么（提升到全局）；null = 只是新版本。 */
  readonly targetScope: AssetScope | null;
  readonly status: SubmissionStatus;
  readonly required: number;
  readonly approvals: readonly AssetApproval[];
  readonly decidedBy: string | null;
  readonly reason: string | null;
  readonly report: ReviewReport;
  readonly createdAt: number;
  readonly decidedAt: number | null;
}

export interface ReviewComment {
  readonly id: string;
  readonly submissionId: string;
  readonly authorId: string;
  readonly path: string | null;
  readonly line: number | null;
  readonly body: string;
  readonly at: number;
}

export type InstallRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';
export interface InstallRequest {
  readonly id: string;
  readonly assetId: string;
  readonly workerId: string;
  readonly requestedBy: string;
  readonly status: InstallRequestStatus;
  readonly decidedBy: string | null;
  readonly reason: string | null;
  readonly createdAt: number;
  readonly decidedAt: number | null;
}

/** 团队（key = teamId）或 hub（key = 'hub'）的审核设置。 */
export interface AssetReviewSettings {
  readonly reviewers: readonly string[];
  readonly twoReviewers: { readonly global: boolean; readonly mcpStdio: boolean };
}
export const DEFAULT_REVIEW_SETTINGS: AssetReviewSettings = { reviewers: [], twoReviewers: { global: false, mcpStdio: false } };
export const HUB_REVIEW_KEY = 'hub';

export type NotificationKind =
  | 'review.requested'
  | 'review.approved'
  | 'review.rejected'
  | 'review.changes'
  | 'review.comment'
  | 'asset.revoked'
  | 'install.requested'
  | 'install.approved'
  | 'install.rejected';

export interface Notification {
  readonly id: string;
  readonly userId: string;
  readonly kind: NotificationKind;
  readonly title: string;
  readonly body: string;
  /** 前端路由（如 #/assets/review/<id>）。 */
  readonly link: string;
  readonly at: number;
  readonly readAt: number | null;
}

// ---------- 谁能审 ----------

export interface ReviewerContext {
  readonly hubAdminId: string | null;
  /** 资产所属团队的负责人。 */
  readonly teamOwnerId: string | null;
  /** 团队设置里的指定审核人（已过滤成本团队成员）。 */
  readonly reviewers: readonly string[];
  /** hub 级指定审核人（全局资产 / 提升到全局用），不含 hub 管理员本人；缺省为空。 */
  readonly hubReviewers?: readonly string[];
}

export interface Reviewer {
  readonly id: string;
  readonly hubAdmin: boolean;
}

/** 这次提交要按哪个作用域审（提升到全局时按全局）。 */
export const reviewScope = (asset: Pick<Asset, 'scope'>, submission: Pick<AssetSubmission, 'targetScope'>): AssetScope =>
  submission.targetScope ?? asset.scope;

/**
 * 有资格审这次提交的人。
 * - 全局：hub 管理员（他自己提交也算，打自审标记）。
 * - 团队 / 项目：团队负责人 + 指定审核人，去掉提交人和作者；去完没人（单人团队、负责人自己提交）→ 转 hub 管理员。
 *   hub 管理员恰好也是作者 / 提交人时，这是唯一可能的审核人，允许自审并打标记（对 3A 的解释，见 ADR 0016）。
 */
export function eligibleReviewers(
  asset: Pick<Asset, 'scope' | 'ownerId'>,
  submission: Pick<AssetSubmission, 'targetScope' | 'submittedBy'>,
  ctx: ReviewerContext
): { readonly ids: readonly string[]; readonly routedToHub: boolean } {
  const scope = reviewScope(asset, submission);
  if (scope === 'personal') return { ids: [], routedToHub: false };
  if (scope === 'global') {
    // hub 管理员总在（3A 允许他自批全局资产）；指定审核人里剔掉作者本人
    const authors = new Set([submission.submittedBy, asset.ownerId]);
    const extra = (ctx.hubReviewers ?? []).filter((id) => id !== ctx.hubAdminId && !authors.has(id));
    return { ids: [...(ctx.hubAdminId ? [ctx.hubAdminId] : []), ...new Set(extra)], routedToHub: false };
  }
  const authors = new Set([submission.submittedBy, asset.ownerId]);
  const team = [...new Set([ctx.teamOwnerId, ...ctx.reviewers].filter((id): id is string => !!id))].filter((id) => !authors.has(id));
  if (team.length > 0) return { ids: team, routedToHub: false };
  return { ids: ctx.hubAdminId ? [ctx.hubAdminId] : [], routedToHub: true };
}

/** 这个人现在能不能给这次提交投通过票；能的话这票是不是自审。 */
export function checkReviewer(
  asset: Pick<Asset, 'scope' | 'ownerId'>,
  submission: Pick<AssetSubmission, 'targetScope' | 'submittedBy' | 'status' | 'approvals'>,
  reviewer: Reviewer,
  ctx: ReviewerContext
): Result<{ readonly selfApproved: boolean }, DomainError> {
  if (submission.status !== 'pending') return err(invalid('这次提交已经处理过了'));
  if (submission.approvals.some((vote) => vote.userId === reviewer.id)) return err(invalid('你已经投过通过票了，需要另一位审核人'));
  const { ids } = eligibleReviewers(asset, submission, ctx);
  if (!ids.includes(reviewer.id)) {
    const self = reviewer.id === submission.submittedBy || reviewer.id === asset.ownerId;
    return err(forbidden(self ? '不能审核自己提交的资产（3A：禁止自审）' : '你不是这次提交的审核人'));
  }
  const self = reviewer.id === submission.submittedBy || reviewer.id === asset.ownerId;
  // 自审只可能是 hub 管理员（eligibleReviewers 已把其他作者剔除）
  if (self && !reviewer.hubAdmin) return err(forbidden('不能审核自己提交的资产（3A：禁止自审）'));
  return ok({ selfApproved: self });
}

/** 驳回 / 要求修改：同样只有审核人能做（自己撤回走 withdraw）。 */
export function checkDecider(
  asset: Pick<Asset, 'scope' | 'ownerId'>,
  submission: Pick<AssetSubmission, 'targetScope' | 'submittedBy' | 'status'>,
  reviewer: Reviewer,
  ctx: ReviewerContext
): Result<true, DomainError> {
  if (submission.status !== 'pending') return err(invalid('这次提交已经处理过了'));
  const { ids } = eligibleReviewers(asset, submission, ctx);
  return ids.includes(reviewer.id) ? ok(true) : err(forbidden('你不是这次提交的审核人'));
}

/** 需要几票（4A：默认 1；设置打开时全局 / MCP stdio 要 2）。个人资产 0（1A 免审）。 */
export function requiredApprovals(scope: AssetScope, mcpStdio: boolean, settings: AssetReviewSettings): number {
  if (scope === 'personal') return 0;
  if (scope === 'global' && settings.twoReviewers.global) return 2;
  if (mcpStdio && settings.twoReviewers.mcpStdio) return 2;
  return 1;
}

/**
 * 实际能凑到的票数上限：合格审核人不够两个时（比如只有 hub 管理员），要求降到人数，至少 1。
 * 降级会写进审计（见用例）。
 */
export const attainableApprovals = (required: number, eligible: number): number => Math.max(1, Math.min(required, Math.max(eligible, 1)));

// ---------- 扫描 ----------

const SCRIPT_RULES: readonly { rule: string; level: 'warn' | 'high'; pattern: RegExp; message: string }[] = [
  { rule: 'pipe-shell', level: 'high', pattern: /\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(ba|z)?sh\b/, message: '下载后直接管道给 shell 执行' },
  { rule: 'rm-root', level: 'high', pattern: /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(\/|~|\$HOME)(\s|$)/, message: '递归删除根目录 / 家目录' },
  { rule: 'eval-decode', level: 'high', pattern: /(base64\s+(-d|--decode)[^\n]*\|\s*(ba)?sh|eval\s*\(\s*(atob|Buffer\.from)|exec\(\s*base64)/, message: '解码后执行（混淆代码）' },
  { rule: 'ssh-keys', level: 'high', pattern: /(~|\$HOME)\/\.ssh\/|id_rsa|id_ed25519/, message: '读写 SSH 密钥' },
  { rule: 'agent-config', level: 'high', pattern: /\.(claude|codex|gemini)\/(settings|config|auth)|\.config\/opencode|\.agent-hub\/(config|token)/, message: '改写 agent / hub 配置或令牌' },
  { rule: 'cred-files', level: 'warn', pattern: /\.(aws|kube|docker)\/(credentials|config)|\.netrc|\.npmrc|\.pypirc/, message: '访问凭据文件' },
  { rule: 'env-dump', level: 'warn', pattern: /\b(printenv|env\s*$|process\.env\b(?!\.)|os\.environ\b(?!\[))/, message: '整体读取环境变量' },
  { rule: 'sudo', level: 'warn', pattern: /\bsudo\b/, message: '提权' },
  { rule: 'network', level: 'warn', pattern: /\b(curl|wget|nc|ncat|socat)\b|fetch\(\s*['"`]https?:|requests\.(get|post)\(/, message: '访问网络' },
  { rule: 'persist', level: 'warn', pattern: /\bcrontab\b|systemctl\s+(enable|--user)|\.bashrc|\.zshrc|\.profile/, message: '写入开机 / 登录持久化' }
];

const INSTRUCTION_RULES: readonly { rule: string; level: 'warn' | 'high'; pattern: RegExp; message: string }[] = [
  { rule: 'override', level: 'high', pattern: /ignore (all |any )?(previous|prior|above) (instructions|rules)|忽略(之前|以上|上面|先前)的?(所有)?(指令|规则|要求)|disregard (the )?(system|previous)/i, message: '要求忽略上级指令（提示注入）' },
  { rule: 'exfil', level: 'high', pattern: /(send|upload|post|发送|上传).{0,40}(token|secret|password|api.?key|密钥|令牌|密码|\.env)/i, message: '要求外发令牌 / 密钥' },
  { rule: 'hide', level: 'warn', pattern: /(do not|don't|never) (tell|mention|reveal|inform) (the )?user|不要(告诉|提示|让)用户/i, message: '要求对用户隐瞒' },
  { rule: 'auto-approve', level: 'warn', pattern: /--dangerously-skip-permissions|--yolo|bypass(ing)? (approvals?|permissions)|跳过(权限|审批|确认)/i, message: '要求跳过权限确认' }
];

/** 看不见的字符：零宽、双向控制符——常用来藏提示注入。 */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;
const SCRIPT_PATH = /(^|\/)scripts?\/|\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|ps1)$/i;
const TEXT_PATH = /\.(md|markdown|txt)$/i;

/** 把一份内容扫一遍（文件 → 发现）。纯文本匹配，不执行任何东西。 */
export function scanAssetFiles(files: readonly { readonly path: string; readonly text: string | null }[]): FindingLine[] {
  const out: FindingLine[] = [];
  for (const file of files) {
    if (file.text === null) {
      out.push({ level: 'info', rule: 'binary', path: file.path, line: null, message: '二进制文件，无法逐行审阅' });
      continue;
    }
    const lines = file.text.split('\n');
    const script = SCRIPT_PATH.test(file.path);
    const prose = TEXT_PATH.test(file.path) || file.path === 'SKILL.md';
    lines.forEach((text, index) => {
      if (INVISIBLE.test(text)) out.push({ level: 'high', rule: 'invisible', path: file.path, line: index + 1, message: '含零宽 / 双向控制字符' });
      if (script || /^\s*(\$\s|```)/.test(text) || prose) {
        for (const rule of SCRIPT_RULES) {
          if (!script && rule.level !== 'high') continue;
          if (rule.pattern.test(text)) out.push({ level: rule.level, rule: rule.rule, path: file.path, line: index + 1, message: rule.message });
        }
      }
      if (prose) {
        for (const rule of INSTRUCTION_RULES) {
          if (rule.pattern.test(text)) out.push({ level: rule.level, rule: rule.rule, path: file.path, line: index + 1, message: rule.message });
        }
      }
    });
    const hidden = [...file.text.matchAll(/<!--([\s\S]*?)-->/g)];
    for (const match of hidden) {
      if (INSTRUCTION_RULES.some((rule) => rule.pattern.test(match[1] ?? '')) || /\b(you must|always|run|execute)\b|你(必须|要)/i.test(match[1] ?? '')) {
        const line = file.text.slice(0, match.index ?? 0).split('\n').length;
        out.push({ level: 'warn', rule: 'hidden-comment', path: file.path, line, message: 'HTML 注释里藏着指令' });
      }
    }
    if (/[A-Za-z0-9+/]{400,}={0,2}/.test(file.text)) out.push({ level: 'warn', rule: 'blob', path: file.path, line: null, message: '大段 base64 / 混淆内容' });
  }
  return out;
}

export const hasHighFinding = (report: Pick<ReviewReport, 'findings' | 'mcp'>): boolean =>
  report.findings.some((finding) => finding.level === 'high') || report.mcp?.level === 'high';

const RUNNERS = new Set(['npx', 'uvx', 'pnpm', 'bunx', 'pipx', 'docker', 'deno']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'cmd', 'powershell', 'pwsh']);

const privateHost = (host: string): boolean =>
  /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0|\[?::1\]?$)/.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host.endsWith('.local');

/** MCP 风险摘要：审 MCP 资产时最先看这个。 */
export function mcpRiskSummary(config: McpConfig, previous: McpConfig | null = null): McpRiskSummary {
  const notes: string[] = [];
  const changed: string[] = [];
  if (config.transport === 'stdio') {
    const base = config.command.split('/').pop() ?? config.command;
    const packages: { name: string; pinned: boolean }[] = [];
    if (RUNNERS.has(base)) {
      const name = config.args.find((arg) => !arg.startsWith('-') && arg !== 'run' && arg !== 'x' && arg !== 'dlx');
      if (name) {
        const pinned = /@[^/@]*\d[^/@]*$/.test(name) || /==\d/.test(name) || /:[\w.-]*\d/.test(name) || /@sha256:/.test(name);
        packages.push({ name, pinned });
        if (!pinned) notes.push(`${name} 没有钉版本：每次启动可能拉到不同代码`);
      }
    }
    const shell = SHELLS.has(base) && config.args.some((arg) => arg === '-c' || arg === '/c' || arg === '-Command');
    if (shell) notes.push('通过 shell -c 执行任意命令');
    if (base === 'docker' && config.args.some((arg) => /--privileged|-v\s*\/:|--volume=\/:|--network=host/.test(arg))) notes.push('docker 特权 / 挂载根目录 / host 网络');
    const secrets = [...new Set([...config.args, ...Object.values(config.env)].flatMap(secretRefsIn))].sort();
    if (previous) {
      if (previous.transport !== 'stdio') changed.push('transport');
      else {
        if (previous.command !== config.command) changed.push('command');
        if (JSON.stringify(previous.args) !== JSON.stringify(config.args)) changed.push('args');
        if (JSON.stringify(previous.env) !== JSON.stringify(config.env)) changed.push('env');
      }
    }
    const level = shell || notes.some((note) => note.startsWith('docker')) ? 'high' : packages.some((pkg) => !pkg.pinned) || !RUNNERS.has(base) ? 'medium' : 'medium';
    return { transport: 'stdio', level, command: config.command, args: config.args, url: null, host: null, packages, secrets, notes: ['在 Worker 上以会话用户身份执行本地命令', ...notes], changed };
  }
  let host: string | null = null;
  try {
    host = new URL(config.url).hostname;
  } catch {
    host = null;
  }
  if (host && privateHost(host)) notes.push(`指向内网 / 本机地址 ${host}`);
  if (/^http:\/\//.test(config.url)) notes.push('明文 http');
  const secrets = [...new Set([config.url, ...Object.values(config.headers)].flatMap(secretRefsIn))].sort();
  if (previous) {
    if (previous.transport !== 'http') changed.push('transport');
    else {
      if (previous.url !== config.url) changed.push('url');
      if (JSON.stringify(previous.headers) !== JSON.stringify(config.headers)) changed.push('headers');
    }
  }
  const level = host && privateHost(host) ? 'high' : secrets.length > 0 || /^http:\/\//.test(config.url) ? 'medium' : 'low';
  return { transport: 'http', level, command: null, args: [], url: config.url, host, packages: [], secrets, notes, changed };
}

// ---------- 密钥命名空间 ----------

/**
 * 保险箱里的键：hub 级 = NAME（老数据原样）；团队 = @team:<teamId>:NAME；个人 = @user:<userId>:NAME。
 * 运行时按资产归属依次找，见 secretLookupOrder。
 */
export const secretKey = (layer: 'hub' | 'team' | 'personal', name: string, ref: string | null = null): string =>
  layer === 'hub' ? name : `@${layer === 'team' ? 'team' : 'user'}:${ref ?? ''}:${name}`;
export const isHubSecretKey = (key: string): boolean => !key.startsWith('@');
export function parseSecretKey(key: string): { layer: 'hub' | 'team' | 'personal'; ref: string | null; name: string } {
  const match = /^@(team|user):([^:]*):(.+)$/.exec(key);
  if (!match) return { layer: 'hub', ref: null, name: key };
  return { layer: match[1] === 'team' ? 'team' : 'personal', ref: match[2] ?? '', name: match[3] ?? '' };
}

/**
 * 这个资产引用 ${secret:NAME} 时依次去哪些键找（先到先得）。
 * 个人：作者个人 → 作者团队 →（作者是 hub 管理员时）hub；团队 / 项目：团队 →（作者是 hub 管理员时）hub；全局：hub。
 * 成员上架的资产因此碰不到 hub 级密钥，也碰不到别人的个人密钥。
 */
export function secretLookupOrder(
  asset: Pick<Asset, 'scope' | 'ownerId' | 'teamId'>,
  name: string,
  hubAdminId: string | null
): { key: string; layer: 'personal' | 'team' | 'hub' }[] {
  const hubOwned = asset.ownerId === '' || (hubAdminId !== null && asset.ownerId === hubAdminId);
  const out: { key: string; layer: 'personal' | 'team' | 'hub' }[] = [];
  if (asset.scope === 'global') return [{ key: secretKey('hub', name), layer: 'hub' }];
  if (asset.scope === 'personal') out.push({ key: secretKey('personal', name, asset.ownerId), layer: 'personal' });
  if (asset.teamId) out.push({ key: secretKey('team', name, asset.teamId), layer: 'team' });
  if (hubOwned) out.push({ key: secretKey('hub', name), layer: 'hub' });
  return out;
}

export const isMcpStdio = (kind: AssetKind, config: McpConfig | null): boolean => kind === 'mcp' && config?.transport === 'stdio';

export const checkReason = (reason: string): Result<string, DomainError> => {
  const trimmed = reason.trim();
  if (trimmed.length === 0) return err(invalid('请写明理由'));
  if (trimmed.length > 2000) return err(invalid('理由太长（最多 2000 字）'));
  return ok(trimmed);
};
