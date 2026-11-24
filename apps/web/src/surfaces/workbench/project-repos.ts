/**
 * 项目仓库清单（docs/design/multi-repo.md §2 §7）的产品层逻辑：草稿行、就地校验、PATCH body。
 *
 * 这里是纯函数，不碰 DOM，也不 import shell/api.ts —— 根 tsconfig 会编 `apps/web/src/**\/*.test.ts`，
 * 那边没有 DOM 类型。字段形状直接取契约（ProjectDto.repos），读取仍然防御：老项目没有 repos。
 */
export const PROJECT_REPOS_MAX = 8;
/** 访问令牌长度上限，跟后端一致（1..512）。 */
export const REPO_TOKEN_MAX = 512;
/** 仓库名 = 组合工作目录里的子目录名，所以形状和后端一致：小写字母开头，最多 41 个字符。 */
export const REPO_NAME_PATTERN = /^[a-z][a-z0-9-]{0,40}$/;
/**
 * 留空默认分支时写 null：让 git 用仓库自己的默认分支。
 * 早先这里写死 `main`，克隆 `master` 为默认分支的仓库会报
 * 「fatal: Remote branch main not found in upstream origin」。
 */
export const REPO_DEFAULT_BRANCH: null = null;

/** 设置页手里的一行草稿：id 空 = 还没保存过的新行。 */
export interface ProjectRepoRow {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly defaultBranch: string;
  /** 这次编辑里新填的令牌；'' = 没填（已有令牌时表示「不改」）。服务端不会回显明文。 */
  readonly credential: string;
  /** 服务端说这一行已经存了令牌 —— 只用来决定占位文案和「清除」按钮。 */
  readonly hasToken: boolean;
  /**
   * 用户点了「清除」：保存时显式传 `credential: ''`。
   * 单独一个字段是因为「没填」和「要清掉」都是空串，光看 credential 分不出来。
   */
  readonly clearToken: boolean;
}

/** PATCH `{ repos }` 里的一项（id 只在原本就有时回传，避免换掉已有仓库的身份）。 */
export interface ProjectRepoValue {
  readonly id?: string;
  readonly name: string;
  readonly url: string;
  readonly defaultBranch: string | null;
  /** 只在本次编辑里填了令牌（或点了清除）时出现；不带 = 保持服务端原值。 */
  readonly credential?: string;
}

/**
 * 能接受的仓库地址：http(s)://、ssh://，以及 `git@host:path` 这类 scp 写法（本质也是 ssh）。
 * 不认本地路径 —— 组合工作目录要在 Worker 上 clone，路径只在某台机器上有意义。
 */
const REPO_URL_PATTERN = /^(?:https?:\/\/|ssh:\/\/|[a-z0-9._-]+@[a-z0-9.-]+:)/i;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** 项目（或任意 JSON）→ 草稿行；没有 repos 返回空清单（= 不绑仓库）。 */
export function repoRowsFrom(project: unknown): readonly ProjectRepoRow[] {
  const raw = typeof project === 'object' && project !== null ? (project as { repos?: unknown }).repos : null;
  if (!Array.isArray(raw)) return [];
  const rows: ProjectRepoRow[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const repo = item as Record<string, unknown>;
    rows.push({
      id: text(repo.id),
      name: text(repo.name),
      url: text(repo.url),
      defaultBranch: text(repo.defaultBranch),
      // 服务端只回「有没有令牌」，不回明文；草稿永远从空串开始
      credential: '',
      hasToken: repo.hasToken === true,
      clearToken: false
    });
  }
  return rows;
}

/** 「加一个仓库」的那一行：空着，等用户填。 */
/** 项目指定的主仓库 id；没指定或形状不对是 null。 */
export function primaryRepoIdFrom(project: unknown): string | null {
  const raw = typeof project === 'object' && project !== null ? (project as { primaryRepoId?: unknown }).primaryRepoId : null;
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}

export function emptyRepoRow(): ProjectRepoRow {
  return { id: '', name: '', url: '', defaultBranch: '', credential: '', hasToken: false, clearToken: false };
}

/**
 * 一行的令牌补丁：只有「这次确实填了值」或「点了清除」才带 `credential`。
 * 什么都不带 = 保持服务端原值 —— 否则每次保存都会把已有令牌抹掉。
 */
export function repoCredentialPatch(row: ProjectRepoRow): { credential?: string } {
  const typed = row.credential.trim();
  if (typed !== '') return { credential: typed };
  if (row.clearToken) return { credential: '' };
  return {};
}

/**
 * 「清除」按钮的状态迁移：点一下进入清除态（草稿里的令牌也丢掉），再点撤销。
 * 撤销只回到「不改」，服务端的令牌本身要保存后才变 —— 正好配「留空不改」。
 */
export function clearCredential(row: ProjectRepoRow): Partial<ProjectRepoRow> {
  return row.clearToken ? { credential: '', clearToken: false } : { credential: '', clearToken: true };
}

/**
 * 从仓库地址猜一个子目录名（`https://host/acme/api.git` / `git@host:acme/api.git` → `api`）。
 * 只在「用户还没自己起名」时用它预填，猜不出来就返回空串。
 */
export function repoNameFromUrl(url: string): string {
  const tail = url.trim().replace(/\/+$/, '').split(/[/:]/).filter(Boolean).pop() ?? '';
  const bare = tail.replace(/\.git$/i, '');
  // 剩下带点的说明这不是仓库名（比如只写了主机 `github.com`），别猜
  if (bare.includes('.')) return '';
  const name = bare
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 41);
  return /^[a-z][a-z0-9-]*$/.test(name) ? name : '';
}

/**
 * 改地址时的补丁：仓库名还是空的、或者正好等于上一个地址猜出来的名字，就跟着新地址走；
 * 用户自己改过名字之后就不再动它。
 */
export function repoUrlPatch(row: ProjectRepoRow, url: string): Partial<ProjectRepoRow> {
  const name = row.name.trim();
  const auto = name === '' || name === repoNameFromUrl(row.url);
  const next = auto ? repoNameFromUrl(url) : '';
  return next === '' ? { url } : { url, name: next };
}

/**
 * 就地校验一行；null = 没问题。错误文案直接给用户看，别只标红一个框。
 * 重名按整份清单判断，所以同一份清单里两个同名行都会报（不猜用户想留哪个）。
 */
export function repoRowProblem(row: ProjectRepoRow, rows: readonly ProjectRepoRow[]): string | null {
  if (rows.length > PROJECT_REPOS_MAX) return `一个项目最多 ${PROJECT_REPOS_MAX} 个仓库`;
  const name = row.name.trim();
  if (name === '') return '写上仓库名（会用作组合工作目录里的子目录名）';
  if (name === 'repos') return '仓库名不能是 repos（留给附加仓库目录）';
  if (!REPO_NAME_PATTERN.test(name)) return '仓库名只能用小写字母、数字和 -，并且以字母开头';
  if (rows.filter((item) => item.name.trim() === name).length > 1) return `仓库名重复：${name}`;
  const url = row.url.trim();
  if (url === '') return '写上仓库地址';
  if (!REPO_URL_PATTERN.test(url)) return '仓库地址要以 http(s):// 或 ssh:// 开头';
  if (row.credential.trim().length > REPO_TOKEN_MAX) return `访问令牌最多 ${REPO_TOKEN_MAX} 个字符`;
  const branch = row.defaultBranch.trim();
  if (branch !== '' && !/^[\w./-]+$/.test(branch)) return '默认分支只能有字母、数字和 . _ / -';
  return null;
}

/**
 * 克隆/准备失败的常见原因 → 一句能照着做的话。原文照旧展示，这句只是补在下面。
 * 最常踩的是「默认分支写死成 main」而仓库用的是 master。
 */
export function cloneErrorHint(message: string): string | null {
  if (/Remote branch \S+ not found/i.test(message)) {
    return '仓库里没有这个分支：把项目设置的「默认分支」清空（就会用仓库自己的默认分支），或者填成实际存在的分支。';
  }
  if (/Could not resolve host|Temporary failure in name resolution/i.test(message)) {
    return '机器解析不了这个域名：换成能访问的镜像地址，或者先在机器上把仓库 clone 好，再「关联 git 目录」。';
  }
  if (/Authentication failed|could not read Username|Permission denied \(publickey\)/i.test(message)) {
    return '这台机器上没有可用的 git 凭据：先在 worker 机器上配好 SSH key / token。';
  }
  return null;
}

/** 整份草稿的第一个问题；null = 可以保存。 */
export function repoRowsProblem(rows: readonly ProjectRepoRow[]): string | null {
  for (const row of rows) {
    const problem = repoRowProblem(row, rows);
    if (problem !== null) return problem;
  }
  return null;
}

/** 草稿 → PATCH `{ repos }` 的数组；默认分支留空写 null（= 用仓库自己的默认分支）。 */
export function repoRowsValue(rows: readonly ProjectRepoRow[]): readonly ProjectRepoValue[] {
  return rows.map((row) => {
    const id = row.id.trim();
    const branch = row.defaultBranch.trim();
    return {
      ...(id === '' ? {} : { id }),
      name: row.name.trim(),
      url: row.url.trim(),
      defaultBranch: branch === '' ? REPO_DEFAULT_BRANCH : branch,
      ...repoCredentialPatch(row)
    };
  });
}

/** 草稿和已保存的值有没有差别（都按保存后的形状比，空默认分支不会误报「改过」）。 */
export function reposDirty(draft: readonly ProjectRepoRow[], saved: readonly ProjectRepoRow[]): boolean {
  return JSON.stringify(repoRowsValue(draft)) !== JSON.stringify(repoRowsValue(saved));
}

/**
 * 保存前的一次仓库检查（POST /api/projects/:id/repos/check）里一项的结果。
 * 形状跟后端约定好的字段一一对应；`message` 已经是能直接给用户看的话。
 *
 * `failureKind` / `credentialSource` 是新版后端给的提示。旧后端不带这两个字段，
 * 所以界面只在字段存在时使用它，绝不从 `message` 反推「令牌失效」。
 */
export interface RepoCheckResult {
  readonly name: string;
  readonly url: string;
  readonly branch: string | null;
  readonly ok: boolean;
  readonly defaultBranch: string | null;
  readonly message: string | null;
  readonly failureKind?: RepoCheckFailureKind | null;
  readonly credentialSource?: RepoCheckCredentialSource | null;
  /** 失败时的受控诊断；旧后端不带，界面就当没有（不猜原因）。 */
  readonly diagnostic?: RepoCheckDiagnostic | null;
}

/**
 * 一次失败检查的结构化诊断（新增字段，老后端没有）。
 *
 * 只收枚举和数字：不接收仓库地址、令牌、服务端原话或 stderr，
 * 所以详情里能显示什么完全由这份结构决定，不会把请求内容漏出去。
 */
export interface RepoCheckDiagnostic {
  /** 前后端 / 日志对得上的短编号（如 `repo-check-401-9f2c`）。 */
  readonly id: string;
  readonly stage: RepoCheckDiagnosticStage;
  readonly code: RepoCheckDiagnosticCode;
  readonly transport: 'https' | 'ssh';
  readonly durationMs: number;
  readonly httpStatus?: 401 | 403;
}

/** 失败发生在哪一步。 */
export type RepoCheckDiagnosticStage = 'credential' | 'worker' | 'git' | 'branch';

/** 受控的失败代码；`unknown` = 后端也没归类。 */
export type RepoCheckDiagnosticCode =
  | 'credential_unavailable'
  | 'worker_unavailable'
  | 'http_401'
  | 'http_403'
  | 'authentication_unknown'
  | 'dns'
  | 'tls'
  | 'timeout'
  | 'network'
  | 'branch_missing'
  | 'unknown';

const DIAGNOSTIC_STAGES: readonly RepoCheckDiagnosticStage[] = ['credential', 'worker', 'git', 'branch'];
const DIAGNOSTIC_CODES: readonly RepoCheckDiagnosticCode[] = [
  'credential_unavailable',
  'worker_unavailable',
  'http_401',
  'http_403',
  'authentication_unknown',
  'dns',
  'tls',
  'timeout',
  'network',
  'branch_missing',
  'unknown'
];

/** 诊断编号只接受短、无空白的标识；带空格 / 换行的任意文本一律不显示（契约上限 80）。 */
const DIAGNOSTIC_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;
/** 耗时上限：超过一天的数字没有参考价值，避免把异常值原样印出来。 */
const DIAGNOSTIC_MAX_DURATION_MS = 86_400_000;

const pickOne = <T extends string>(allowed: readonly T[], value: unknown): T | null =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null;

/**
 * 服务端字段 → 诊断；任一必填项缺失或形状不对就返回 null（宁可不显示，也不猜）。
 * 可选 `httpStatus` 只认 401 / 403，其它值直接丢掉，不影响其余字段。
 */
export function repoDiagnosticFrom(value: unknown): RepoCheckDiagnostic | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!DIAGNOSTIC_ID_PATTERN.test(id)) return null;
  const stage = pickOne(DIAGNOSTIC_STAGES, raw.stage);
  const code = pickOne(DIAGNOSTIC_CODES, raw.code);
  const transport = raw.transport === 'https' || raw.transport === 'ssh' ? raw.transport : null;
  const duration = raw.durationMs;
  if (stage === null || code === null || transport === null) return null;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) return null;
  const httpStatus = raw.httpStatus === 401 || raw.httpStatus === 403 ? raw.httpStatus : undefined;
  return {
    id,
    stage,
    code,
    transport,
    durationMs: Math.min(Math.round(duration), DIAGNOSTIC_MAX_DURATION_MS),
    ...(httpStatus === undefined ? {} : { httpStatus })
  };
}

/** 耗时 → 人话：不到 1 秒说毫秒，之后按秒（10 秒以上不要小数）。 */
export function repoDiagnosticDuration(durationMs: number): string {
  const ms = Math.max(0, Math.round(durationMs));
  if (ms < 1000) return `${ms} 毫秒`;
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1).replace(/\.0$/, '')} 秒`;
  return `${Math.round(seconds)} 秒`;
}

export function repoDiagnosticStageLabel(stage: RepoCheckDiagnosticStage): string {
  switch (stage) {
    case 'credential':
      return '凭据';
    case 'worker':
      return '机器';
    case 'git':
      return 'Git 访问';
    case 'branch':
      return '分支';
    default:
      return '其它阶段';
  }
}

/** 失败代码 → 一句人话；只说代码本身能支撑的事，不替用户判断「令牌一定无效」。 */
export function repoDiagnosticCodeLabel(code: RepoCheckDiagnosticCode): string {
  switch (code) {
    case 'credential_unavailable':
      // 已保存的令牌读不出来，检查根本没发出去；别写成「项目里没有令牌」。
      return '无法读取已保存的令牌，未发起仓库检查';
    case 'worker_unavailable':
      // 机器可能在线，只是这次 RPC 没成；不能据此说它「不在线」。
      return '机器未完成检查';
    case 'http_401':
      return '服务器返回 401（未授权）';
    case 'http_403':
      return '服务器返回 403（禁止访问）';
    case 'authentication_unknown':
      return '认证没通过，具体原因不明确';
    case 'dns':
      return '域名解析失败';
    case 'tls':
      return 'TLS / 证书握手失败';
    case 'timeout':
      return '连接超时';
    case 'network':
      return '网络连不上';
    case 'branch_missing':
      return '分支不存在';
    default:
      return '原因未分类';
  }
}

export interface RepoDiagnosticRow {
  readonly label: string;
  readonly value: string;
  /** 编号 / 耗时这类适合等宽字体的值。 */
  readonly mono?: boolean;
}

export interface RepoDiagnosticContext {
  /** 这次是在哪台机器上查的；跟结论行用的是同一个标签。 */
  readonly workerLabel?: string | null;
  readonly credentialSource?: RepoCheckCredentialSource | null;
}

/** 机器标签可能带路径或很长，收成一行并限长，别把复制的诊断撑散。 */
const DIAGNOSTIC_MACHINE_MAX = 48;

function oneLineMachine(value: string | null | undefined): string {
  const text = value?.replace(/\s+/g, ' ').trim() ?? '';
  return text.length > DIAGNOSTIC_MACHINE_MAX ? `${text.slice(0, DIAGNOSTIC_MACHINE_MAX - 1)}…` : text;
}

/** 检查没跑完时，凭据只说明「准备用哪份」，不代表已经发给仓库。 */
function repoCredentialPlanNote(source: RepoCheckCredentialSource | null | undefined): string | null {
  switch (source) {
    case 'draft':
      return '填写的令牌';
    case 'saved':
      return '已保存的令牌';
    case 'worker':
      return '机器上的 git 配置';
    default:
      return null;
  }
}

/**
 * 诊断 → 详情行。只放结构化字段和已经展示过的机器 / 凭据来源；
 * 不放仓库名、地址、分支名、令牌或后端原话。
 */
export function repoDiagnosticRows(
  diagnostic: RepoCheckDiagnostic,
  context: RepoDiagnosticContext = {}
): readonly RepoDiagnosticRow[] {
  const rows: RepoDiagnosticRow[] = [
    { label: '编号', value: diagnostic.id, mono: true },
    { label: '阶段', value: repoDiagnosticStageLabel(diagnostic.stage) },
    { label: '原因', value: repoDiagnosticCodeLabel(diagnostic.code) },
    // 稳定枚举值给日志排查用，跟本地化原因并排但不混在一起。
    { label: '代码', value: diagnostic.code, mono: true },
    { label: '传输', value: diagnostic.transport === 'ssh' ? 'SSH' : 'HTTPS' },
    { label: '耗时', value: repoDiagnosticDuration(diagnostic.durationMs), mono: true }
  ];
  if (diagnostic.httpStatus !== undefined) {
    rows.push({ label: 'HTTP 状态', value: String(diagnostic.httpStatus), mono: true });
  }
  // 令牌读不出来时机器根本没参与，别让人以为是在那台机器上查失败的。
  if (diagnostic.code !== 'credential_unavailable') {
    const machine = oneLineMachine(context.workerLabel);
    if (machine !== '') rows.push({ label: '机器', value: machine });
  }
  if (diagnostic.code === 'credential_unavailable') {
    // 令牌没被用上，再说「这次用的是已保存的令牌」会自相矛盾。
  } else if (diagnostic.code === 'worker_unavailable') {
    // 机器没跑完检查，不能断言令牌已经到了仓库。
    const plan = repoCredentialPlanNote(context.credentialSource);
    if (plan !== null) rows.push({ label: '凭据', value: `${plan}（未确认送达仓库）` });
  } else {
    const source = repoCredentialSourceNote(context.credentialSource);
    if (source !== null) rows.push({ label: '凭据', value: source });
  }
  return rows;
}

/** 诊断 → 纯文本（给复制按钮）；跟详情行一致，同样不含地址 / 令牌。 */
export function repoDiagnosticText(diagnostic: RepoCheckDiagnostic, context: RepoDiagnosticContext = {}): string {
  const lines = repoDiagnosticRows(diagnostic, context).map((row) => `${row.label}：${row.value}`);
  return ['仓库检查诊断', ...lines].join('\n');
}

/** 后端对失败原因的分类；未知值按没有分类处理（只展示 message）。 */
export type RepoCheckFailureKind = 'authentication' | 'branch_missing' | 'unreachable' | 'credential_unavailable';

/** 这次检查实际用了哪份凭据：草稿里填的 / 服务端已存的 / 机器自己的 git 凭据。 */
export type RepoCheckCredentialSource = 'draft' | 'saved' | 'worker';

/** 整份检查结果。`unavailable` 非空 = 没检查成（比如没有在线的机器），不代表仓库有问题。 */
export interface ReposCheck {
  readonly workerId: string | null;
  readonly workerLabel: string | null;
  readonly unavailable: string | null;
  readonly results: readonly RepoCheckResult[];
  /** 整份结果共用的凭据来源；单项里的字段优先。 */
  readonly credentialSource?: RepoCheckCredentialSource | null;
}

/**
 * 一条检查结果 → 一行状态文字（null = 没有要说的）。
 * 成功且本来就没指定分支时顺手告诉用户实际用的是哪个默认分支 —— 这正是「写死 main」踩过的坑。
 */
export function repoCheckLine(result: RepoCheckResult): string | null {
  const branch = result.branch?.trim() ?? '';
  if (result.ok && branch === '') {
    return `可以访问，默认分支是 ${result.defaultBranch ?? '未知'}`;
  }
  return result.message;
}

/** 检查结果的总结：没检查成原样转述；有失败就说几个要处理；全通过返回 null。 */
export function repoCheckSummary(check: ReposCheck): string | null {
  if (check.unavailable !== null && check.unavailable !== '') return check.unavailable;
  const failed = check.results.filter((result) => !result.ok).length;
  return failed === 0 ? null : `有 ${failed} 个仓库需要先处理`;
}

/**
 * 检查结果要不要挡保存：只有「确实查了、且有仓库失败」才算。
 * 没机器可用（unavailable）时不能挡 —— 否则离线就等于不能改项目设置。
 */
export function repoCheckBlocksSave(check: ReposCheck): boolean {
  if (check.unavailable !== null && check.unavailable !== '') return false;
  return check.results.some((result) => !result.ok);
}

/** 后端的失败分类 → 一句人话；不认识的分类返回 null（不猜原因）。 */
export function repoCheckFailureLabel(kind: RepoCheckFailureKind | null | undefined): string | null {
  switch (kind) {
    case 'authentication':
      return '认证没通过';
    case 'branch_missing':
      return '分支不存在';
    case 'unreachable':
      return '连不上仓库';
    case 'credential_unavailable':
      return '无法读取已保存的令牌';
    default:
      return null;
  }
}

/** 服务端告诉我们这次用的是哪份凭据；旧后端没这个字段就什么都不说。 */
export function repoCredentialSourceNote(source: RepoCheckCredentialSource | null | undefined): string | null {
  switch (source) {
    case 'draft':
      return '这次用的是填写的令牌';
    case 'saved':
      return '这次用的是已保存的令牌';
    case 'worker':
      // 后端只说明「没选草稿/已保存令牌，交给机器」；不替它断言机器上一定配了凭据
      return '这次没带令牌，交给机器上的 git 配置';
    default:
      return null;
  }
}

/**
 * 单行检查 → 一行结论。开头先说清是哪台机器查的：同一个仓库换台机器结果可能不同。
 *
 * 成功时的「可读取」只代表这次请求读到了仓库；公开仓库不校验令牌，
 * 所以界面另外放一句常驻提示，别把成功读成「令牌一定有效」。
 * 失败原因优先贴后端给的话（认证失败时后端会换成固定话术）；后端只给了分类、
 * 没给 message 时才用分类兜底，不自己推断「令牌无效」。
 */
export function repoProbeText(
  result: RepoCheckResult,
  workerLabel: string | null,
  fallbackSource: RepoCheckCredentialSource | null = null
): string {
  const diagnostic = repoDiagnosticFrom(result.diagnostic);
  const code = diagnostic?.code ?? null;
  // 预检就没过：令牌读不出来，检查一步都没发出去。这时带上机器名反而像
  // 「在那台机器上查失败了」，所以只留这一句可执行的结论。
  if (!result.ok && code === 'credential_unavailable') {
    return '无法读取已保存的令牌，未发起仓库检查；请重新输入令牌再检查';
  }
  const machine = workerLabel?.trim() ?? '';
  const where = machine === '' ? '' : `在 ${machine} 上，`;
  const message = result.message?.trim() ?? '';
  let body: string;
  if (result.ok) {
    const branch = result.branch?.trim() ?? '';
    body =
      branch === ''
        ? `可读取，默认分支是 ${result.defaultBranch ?? '未知'}`
        : `可读取，分支 ${branch} 存在`;
  } else if (code === 'worker_unavailable') {
    // 机器可能在线，只是这次 RPC 没成；后端的话优先，没话术就只说到「未完成检查」。
    body = message === '' ? '机器未完成检查' : message;
  } else if (result.failureKind === 'branch_missing') {
    body = message === '' ? '仓库里没有这个分支' : message;
  } else {
    // 后端的 message 已经是给人看的（认证失败还会刻意换成固定话术），不要再套一层分类，
    // 否则会出现「认证没通过：认证失败：…」这种重复。
    const label = repoCheckFailureLabel(result.failureKind);
    body = message !== '' ? message : (label ?? '仓库检查没通过');
  }
  // 令牌读不出来、或机器没跑完检查时，凭据来源要么没参与、要么没送达，
  // 不能再说「这次用的是…」；成功 / Git / 分支的失败保持原有来源说明。
  const credentialUnused =
    code === 'credential_unavailable' ||
    code === 'worker_unavailable' ||
    (code === null && result.failureKind === 'credential_unavailable');
  const source = credentialUnused
    ? null
    : repoCredentialSourceNote(result.credentialSource ?? fallbackSource);
  return `${where}${body}${source === null ? '' : ` · ${source}`}`;
}

/**
 * 改这一行的哪些字段会让上一次检查结论过期。
 * 只改仓库名不影响「能不能读到」；地址 / 分支 / 令牌（含清除）都必须重新查。
 */
export function repoProbeAffected(patch: Partial<ProjectRepoRow>): boolean {
  return 'url' in patch || 'defaultBranch' in patch || 'credential' in patch || 'clearToken' in patch;
}
