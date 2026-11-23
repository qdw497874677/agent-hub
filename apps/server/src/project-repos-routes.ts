import type { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import {
  asProjectId,
  authorizeProject,
  authorizeWorker,
  can,
  checkReposUseCase,
  conflict,
  err,
  forbidden,
  isCanonicalRepoTokenKey,
  isHttpsRepoUrl,
  normalizeRepos,
  ok,
  repoUrlHasUserInfo,
  sameRepoUrl,
  type AuditAction,
  type Deps,
  type DomainError,
  type GitAuth,
  type Project,
  type ProjectRepo,
  type RepoCheckProbe,
  type RepoCheckTarget,
  type Result,
  type Subject,
  type WorkerStatus
} from '@agent-hub/domain';
import { checkProjectReposRequest, repoCheckRequest, type ProjectReposCheckDto } from '@agent-hub/contract';
import type { SubjectOf } from './auth.ts';
import { fail } from './http-error.ts';
import { authHeaderFor } from './repo-auth.ts';

/**
 * 保存项目仓库清单前先检查（docs/design/multi-repo.md §11.2 的补充）：
 *
 *   POST /api/projects/:projectId/repos/check   权限 project.update
 *   POST /api/repo-check                        权限 project.create（还没建项目时的草稿检查）
 *
 * body 都是 { repos: ProjectRepoInput[]; workerId?: string | null }。
 * 检查失败（连不上 / 分支不存在）不影响保存——这里只回报，前端提示用户改；
 * 只有「明确指定了一台不在线的机器」才是 409。一台在线机器都没有时 200 + unavailable：
 * 保存不能被离线挡住。
 *
 * 凭据规则（两端一致，草稿端永远不读已保存令牌）：
 * - 请求里显式给了 `credential`（包括空串）：只按请求来；空串 = 明确不用令牌；
 * - 只有旧的保存前检查、且没给 `credential` 时，才按项目里同 id + 同 URL 的已存令牌解析；
 * - 解析不了就老老实实不传凭据（靠机器自己的 SSH key / agent），绝不「猜」别的令牌。
 * 结果里只报来源类别，不回显令牌；上游诊断也做保守清洗。
 */
export interface ProjectReposRouteDeps {
  readonly deps: Deps;
  /** 和 http.ts 里其它路由共用同一个审计入口（带 actor/ip/团队）。 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly audit?: (c: any, subject: Subject | null, action: AuditAction, target: string, detail: string) => Promise<void>;
}

/** 老 Worker 不报 capabilities = 不限（本机 / 共享令牌），按有 git 能力处理。 */
const hasGit = (worker: WorkerStatus): boolean => worker.capabilities === undefined || worker.capabilities.includes('git');

const CREDENTIAL_UNAVAILABLE_MESSAGE = '这个仓库配了令牌，但密钥箱里找不到了；请重新输入令牌再检查';
const WORKER_UNAVAILABLE_MESSAGE = '这台机器暂时连不上，检查没有完成：请稍后重试或换一台机器';
const DNS_MESSAGE = '解析不了这个仓库的主机名：请检查仓库地址，以及这台机器的网络设置';
const TLS_MESSAGE = '和仓库服务器建立 TLS 连接失败：证书可能不被这台机器信任，或机器时间不对';
const TIMEOUT_MESSAGE = '连接仓库超时：请检查网络后重试';
const NETWORK_MESSAGE = '连不上这个仓库：请检查网络和仓库地址';
/** unknown 按凭据来源分开：草稿 / 已保存令牌的用户不该被引去查「这台机器的凭据」。 */
const UNKNOWN_MESSAGES = {
  draft: '检查没有通过，暂时无法归类原因：请检查仓库地址和这次填写的令牌',
  saved: '检查没有通过，暂时无法归类原因：请检查仓库地址和已保存的令牌',
  'worker:https': '检查没有通过，暂时无法归类原因：请检查仓库地址、网络和这台机器的 HTTPS 凭据设置',
  'worker:ssh': '检查没有通过，暂时无法归类原因：请检查仓库地址、网络和这台机器上的 SSH 密钥'
} as const;

/**
 * 认证失败按「这次用的是哪种凭据」给不同话术：草稿令牌 / 已保存令牌 / 机器自己的凭据。
 * HTTPS 用户不要被提示去查 SSH 密钥；SSH 用户也不要被提示去查令牌。
 */
const AUTH_MESSAGES = {
  draft: '认证失败：请检查仓库地址和这次填写的令牌',
  saved: '认证失败：已保存的令牌没能通过认证；请检查仓库地址和令牌',
  'worker:https': '认证失败：请检查仓库地址，以及这台机器的 HTTPS 凭据设置',
  'worker:ssh': '认证失败：请检查仓库地址，以及这台机器上的 SSH 密钥'
} as const;

/**
 * 服务器明确拒绝（401 / 403）时的固定话术：
 * - 401 和 403 分开说，不把 403 一律叫「认证失败」；
 * - 只陈述「被拒」和该查哪类凭据，不断言机器上「没有」HTTPS 凭据。
 */
const REJECTED_401_MESSAGES = {
  draft: '认证失败（HTTP 401）：请检查仓库地址和这次填写的令牌',
  saved: '认证失败（HTTP 401）：已保存的令牌没能通过认证；请检查仓库地址和令牌',
  'worker:https': '认证失败（HTTP 401）：请检查仓库地址，以及这台机器的 HTTPS 凭据设置',
  'worker:ssh': '认证失败（HTTP 401）：请检查仓库地址和这台机器上的 SSH 密钥'
} as const;

const REJECTED_403_MESSAGES = {
  draft: '这个仓库拒绝了访问（HTTP 403）：请检查这次填写的令牌是否有该仓库的权限',
  saved: '这个仓库拒绝了已保存令牌的访问（HTTP 403）：请确认令牌权限仍然有效',
  'worker:https': '这个仓库拒绝了访问（HTTP 403）：请检查这台机器的 HTTPS 凭据是否有该仓库的权限',
  'worker:ssh': '这个仓库拒绝了访问（HTTP 403）：请检查这台机器上的 SSH 密钥是否有该仓库的权限'
} as const;

/**
 * 只有这些上游措辞才归成 authentication；`repository not found` 之类模糊结果不算——
 * 宁可报 unknown / unreachable，也不要把「仓库地址写错」说成「令牌错了」。
 * 注意：裸的 401 / 403 不在其中——状态码只在 git 真正报告 HTTP 状态时才认（见下方）。
 */
const AUTH_FAILURE_PATTERNS: readonly RegExp[] = [
  /authentication failed/i,
  /could not read (?:username|password)/i,
  /permission denied/i,
  /access denied/i,
  /invalid username or password/i,
  /terminal prompts disabled/i,
  /support for password authentication was removed/i,
  /authorization failed/i,
  /bad credentials/i
];

/**
 * 只认本地 git 自己报的 HTTP 状态句式，且必须整行锚定：
 *   fatal: unable to access '…': The requested URL returned error: 401
 *   error: RPC failed; HTTP 403 curl 22 …
 * 不认裸数字、URL 路径里的 /401，也不认任意位置出现的 "HTTP 403"。
 * `remote:` 行是服务端/远端助手回显的文本，先整行剔除，不能当作本地 git 的判断。
 */
const EXPLICIT_HTTP_STATUS_PATTERNS: readonly RegExp[] = [
  /^\s*fatal: unable to access .*: the requested url returned error:\s*(401|403)\b/im,
  /^\s*error: rpc failed;?\s*http (401|403)\b/im
];

const DNS_PATTERNS: readonly RegExp[] = [
  /could not resolve host(?:name)?/i,
  /name or service not known/i,
  /temporary failure in name resolution/i,
  /nodename nor servname/i,
  /getaddrinfo/i
];

const TLS_PATTERNS: readonly RegExp[] = [
  /ssl certificate problem/i,
  /server certificate verification failed/i,
  /certificate has expired/i,
  /unable to get local issuer certificate/i,
  /ssl connect error/i,
  /gnutls_handshake/i,
  /\bssl_error\b/
];

/** 只保留能明确指向超时的措辞；`timeout` 单词本身在 shell 文本里太泛，不认。 */
const TIMEOUT_PATTERNS: readonly RegExp[] = [
  /block timeout reached/i,
  /operation timed out/i,
  /connection timed out/i,
  /\btimed out\b/i
];

/**
 * 只保留明确的连接层措辞；`unable to access` / `rpc failed` 这类每条 git 失败都带的
 * 通用前缀不能拿来判网络，否则 404、地址写错都会被误报成网络问题。
 */
const NETWORK_PATTERNS: readonly RegExp[] = [
  /connection refused/i,
  /connection reset/i,
  /network is unreachable/i,
  /no route to host/i,
  /could not read from remote repository/i,
  /remote end hung up/i,
  /early eof/i,
  /broken pipe/i,
  /couldn't connect to server/i
];


const CONTROL_OR_SPACE = /[\u0000-\u0020\u007f]/;

/**
 * 仓库地址白名单（只用于检查端点，不改保存时的既有宽松行为）：
 * - HTTPS：必须能解析、有主机名、不能带用户名/密码（userinfo 会被 git 当成凭据记进日志）；
 * - SSH：`ssh://` 不能带密码；标准 scp 写法 `user@host:path` 允许；
 * - 其它 scheme、本地路径、`ext::` 之类远程助手、控制字符/空白、`-` 开头（会被 git 当选项）一律拒绝。
 */
export function unsafeRepoUrlProblem(rawUrl: string): string | null {
  const url = rawUrl.trim();
  if (url === '') return '仓库地址不能为空';
  if (CONTROL_OR_SPACE.test(url)) return '仓库地址不能包含空白或控制字符';
  if (url.startsWith('-')) return '仓库地址不能以 - 开头';
  if (url.includes('::')) return '不支持 git 远程助手地址';
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url)?.[1]?.toLowerCase();
  if (scheme === 'https' || scheme === 'ssh') {
    if (repoUrlHasUserInfo(url)) return scheme === 'https' ? 'HTTPS 地址不能带用户名或密码' : 'SSH 地址不能带密码';
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return '仓库地址不合法';
    }
    if (parsed.protocol !== `${scheme}:` || parsed.hostname === '') return '仓库地址不合法';
    return null;
  }
  if (scheme !== undefined) return '只支持 HTTPS 或 SSH 地址';
  // scp 风格：user@host:path；不允许 `host://...`（那是 URL 写错 scheme），也不允许再出现空白。
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?:(?!\/\/)[^\s]+$/.test(url)) return null;
  return '只支持 HTTPS 或 SSH 地址';
}

type CredentialSource = 'draft' | 'saved' | 'worker';
type FailureKind = 'authentication' | 'branch_missing' | 'unreachable' | 'credential_unavailable';
type DiagnosticStage = 'credential' | 'worker' | 'git' | 'branch';
type DiagnosticTransport = 'https' | 'ssh';
type DiagnosticCode =
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

/** 与 contract 的 `repoCheckDiagnostic` 同形；只放固定枚举与数字，绝不放地址 / 分支 / 原始 stderr。 */
interface RepoDiagnostic {
  readonly id: string;
  readonly stage: DiagnosticStage;
  readonly code: DiagnosticCode;
  readonly transport: DiagnosticTransport;
  readonly durationMs: number;
  readonly httpStatus?: 401 | 403;
}


interface PlannedRepo {
  readonly target: RepoCheckTarget;
  readonly auth: GitAuth | null;
  readonly credentialSource: CredentialSource;
  /** 检查前就能确定的问题（例如令牌标记还在、密钥箱里却没了）：不发 git，也不静默改用机器凭据。 */
  readonly preflight: { readonly failureKind: FailureKind; readonly message: string } | null;
}

type RepoInput = {
  readonly id?: string;
  readonly name?: string;
  readonly url: string;
  readonly defaultBranch?: string | null;
  readonly credential?: string;
};

function noCredentialPlan(target: RepoCheckTarget): PlannedRepo {
  return { target, auth: null, credentialSource: 'worker', preflight: null };
}

/** 保存 / 检查共用的目标形状：`ProjectRepo.defaultBranch` -> `RepoCheckTarget.branch`。 */
const targetsOf = (repos: readonly ProjectRepo[]): RepoCheckTarget[] =>
  repos.map((repo) => ({ name: repo.name, url: repo.url, branch: repo.defaultBranch }));

/** 在项目里找「同一个仓库」的已保存令牌：给了 id 就必须 id 对上；没给 id 才按 URL 兼容匹配。 */
function findStoredRepo(project: Project, url: string, suppliedId: string | undefined): ProjectRepo | null {
  const id = typeof suppliedId === 'string' ? suppliedId.trim() : '';
  if (id !== '') {
    const repo = project.repos.find((candidate) => candidate.id === id);
    if (!repo) return null;
    return isHttpsRepoUrl(repo.url) && sameRepoUrl(repo.url, url) && isCanonicalRepoTokenKey(project.id, repo.id, repo.tokenSecret)
      ? repo
      : null;
  }
  return (
    project.repos.find(
      (repo) => isHttpsRepoUrl(repo.url) && sameRepoUrl(repo.url, url) && isCanonicalRepoTokenKey(project.id, repo.id, repo.tokenSecret)
    ) ?? null
  );
}

/**
 * 每个仓库最终用哪种凭据。`project` 为 null（草稿端点）时永远只用请求里显式的令牌。
 * 返回的 source 只表示「选了哪种来源」，不代表后端真的认证成功。
 */
async function planRepos(
  deps: Deps,
  project: Project | null,
  repos: readonly RepoCheckTarget[],
  inputs: readonly RepoInput[]
): Promise<PlannedRepo[]> {
  const plans: PlannedRepo[] = [];
  for (let index = 0; index < repos.length; index += 1) {
    const target = repos[index]!;
    const input = inputs[index];
    // 请求 schema 里 credential 是可选的；显式给了（哪怕空串）就以它为准。
    if (input?.credential !== undefined) {
      const token = input.credential.trim();
      if (token !== '' && isHttpsRepoUrl(target.url)) {
        plans.push({
          target,
          auth: authHeaderFor(token, target.url),
          credentialSource: 'draft',
          preflight: null
        });
      } else {
        // 空串 = 明确清空，绝不回落到项目里已保存的令牌；SSH 地址本来也不用 HTTPS 令牌。
        plans.push(noCredentialPlan(target));
      }
      continue;
    }

    if (!project || !isHttpsRepoUrl(target.url)) {
      plans.push(noCredentialPlan(target));
      continue;
    }

    const stored = findStoredRepo(project, target.url, input?.id);
    const tokenName = stored?.tokenSecret;
    if (!stored || !tokenName) {
      plans.push(noCredentialPlan(target));
      continue;
    }

    // 密钥箱不可用（抛错）和「找不到令牌」同样处理：不发 git、不回落机器凭据，只报凭据不可用。
    let token: string | undefined;
    try {
      const revealed = await deps.secrets.reveal([tokenName]);
      token = revealed[tokenName];
    } catch {
      token = undefined;
    }
    if (!token) {
      plans.push({
        target,
        auth: null,
        credentialSource: 'saved',
        preflight: { failureKind: 'credential_unavailable', message: CREDENTIAL_UNAVAILABLE_MESSAGE }
      });
      continue;
    }
    plans.push({
      target,
      auth: authHeaderFor(token, target.url),
      credentialSource: 'saved',
      preflight: null
    });
  }
  return plans;
}

interface WorkerChoice {
  /** 挑中的机器；null = 一台可用的都没有（返回 200 + unavailable）。 */
  readonly chosen: WorkerStatus | null;
  readonly unavailable: string | null;
}

/**
 * 选机器并做 worker.use 授权：
 * - 省略 workerId：在线的、有 git 能力的机器里从本机开始挑第一台**有权限**的；
 *   有候选但都没权限 -> 403（不把权限问题伪装成「没有机器」）；
 * - null：明确要本机，不在线 409；
 * - 指定：必须存在且在线，否则 409；绝不静默换机器。
 */
async function chooseWorker(
  deps: Deps,
  subject: Subject | null,
  requested: string | null | undefined
): Promise<Result<WorkerChoice, DomainError>> {
  const workers = await deps.gateway.status();
  const online = workers.filter((worker) => worker.state === 'online' && hasGit(worker));

  if (requested === undefined) {
    for (const worker of online) {
      const allowed = await authorizeWorker(deps.access, subject, worker.workerId, 'worker.use');
      if (allowed.ok) return ok({ chosen: worker, unavailable: null });
    }
    if (online.length > 0) return err(forbidden('你没有可以检查仓库的机器权限'));
    return ok({ chosen: null, unavailable: '现在没有在线的机器可以检查仓库' });
  }

  if (requested === null) {
    const local = online.find((worker) => worker.origin === 'local');
    if (!local) return err(conflict('那台机器现在不在线'));
    const allowed = await authorizeWorker(deps.access, subject, local.workerId, 'worker.use');
    if (!allowed.ok) return err(allowed.error);
    return ok({ chosen: local, unavailable: null });
  }

  const found = workers.find((worker) => worker.workerId === requested);
  if (!found || found.state !== 'online') return err(conflict('那台机器现在不在线'));
  if (!hasGit(found)) return err(conflict('那台机器没有 git 能力，检查不了仓库'));
  const allowed = await authorizeWorker(deps.access, subject, found.workerId, 'worker.use');
  if (!allowed.ok) return err(allowed.error);
  return ok({ chosen: found, unavailable: null });
}

/** 短、定长的诊断 id：同一批检查里能对上审计，又不会把一行日志撑爆。 */
const newDiagnosticId = (): string => `diag-${randomUUID().replace(/-/g, '').slice(0, 12)}`;

const transportOf = (url: string): DiagnosticTransport => (/^https:\/\//i.test(url.trim()) ? 'https' : 'ssh');

/**
 * 去掉远端/服务端回显的 `remote:` 行：这些不是本地 git 的判断，可能被用来伪造
 * `HTTP 403` / `Could not resolve host`。所有分类只看过滤后的本地输出。
 */
const localGitOutput = (message: string): string =>
  message
    .split(/\r?\n/)
    .filter((line) => !/^\s*remote:\s?/i.test(line))
    .join('\n');

/** 只有本地 git 在 HTTPS 上明确给出 HTTP 状态时才返回状态码；裸数字 / URL / `remote:` 行都不算。 */
function explicitHttpStatus(message: string): 401 | 403 | null {
  const local = localGitOutput(message);
  for (const pattern of EXPLICIT_HTTP_STATUS_PATTERNS) {
    const match = pattern.exec(local);
    if (match?.[1] === '401') return 401;
    if (match?.[1] === '403') return 403;
  }
  return null;
}

/** git 传输层失败的保守分类；顺序有意义：先看明确状态码，再看更具体的网络措辞。 */
function classifyGitFailure(
  message: string,
  transport: DiagnosticTransport
): Pick<RepoDiagnostic, 'code' | 'httpStatus'> {
  const local = localGitOutput(message);
  if (transport === 'https') {
    const status = explicitHttpStatus(local);
    if (status !== null) {
      return { code: status === 401 ? 'http_401' : 'http_403', httpStatus: status };
    }
  }
  if (DNS_PATTERNS.some((pattern) => pattern.test(local))) return { code: 'dns' };
  // TLS 是 HTTPS 的传输层；SSH 报证书措辞不当作 TLS 结论。
  if (transport === 'https' && TLS_PATTERNS.some((pattern) => pattern.test(local))) return { code: 'tls' };
  if (TIMEOUT_PATTERNS.some((pattern) => pattern.test(local))) return { code: 'timeout' };
  if (NETWORK_PATTERNS.some((pattern) => pattern.test(local))) return { code: 'network' };
  if (AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(local))) return { code: 'authentication_unknown' };
  return { code: 'unknown' };
}

const authMessageKey = (plan: PlannedRepo, transport: DiagnosticTransport): keyof typeof AUTH_MESSAGES =>
  plan.credentialSource === 'worker' ? `worker:${transport}` : plan.credentialSource;

/** 失败时只回固定安全话术；分支缺失沿用领域层已生成的「没有分支 X，默认分支是 Y」。 */
function messageFor(plan: PlannedRepo, diagnostic: RepoDiagnostic | undefined, domainMessage: string | null): string {
  // 理论上失败一定有诊断；万一没有，也只给固定话术，绝不回显上游原文。
  if (!diagnostic) return UNKNOWN_MESSAGES[authMessageKey(plan, transportOf(plan.target.url))];
  switch (diagnostic.code) {
    case 'branch_missing':
      return domainMessage ?? '仓库检查没通过';
    case 'credential_unavailable':
      return CREDENTIAL_UNAVAILABLE_MESSAGE;
    case 'worker_unavailable':
      return WORKER_UNAVAILABLE_MESSAGE;
    case 'http_401':
      return REJECTED_401_MESSAGES[authMessageKey(plan, diagnostic.transport)];
    case 'http_403':
      return REJECTED_403_MESSAGES[authMessageKey(plan, diagnostic.transport)];
    case 'authentication_unknown':
      return AUTH_MESSAGES[authMessageKey(plan, diagnostic.transport)];
    case 'dns':
      return DNS_MESSAGE;
    case 'tls':
      return TLS_MESSAGE;
    case 'timeout':
      return TIMEOUT_MESSAGE;
    case 'network':
      return NETWORK_MESSAGE;
    case 'unknown':
      return UNKNOWN_MESSAGES[authMessageKey(plan, diagnostic.transport)];
  }
}

function failureKindOf(diagnostic: RepoDiagnostic | undefined): FailureKind | undefined {
  if (!diagnostic) return undefined;
  switch (diagnostic.code) {
    case 'credential_unavailable':
      return 'credential_unavailable';
    case 'branch_missing':
      return 'branch_missing';
    case 'http_401':
    case 'authentication_unknown':
      return 'authentication';
    // 403 不一定是凭据问题（限流、代理、WAF 也会 403），老 failureKind 里没有更合适的细类。
    default:
      return 'unreachable';
  }
}

function diagnosticFor(
  plan: PlannedRepo,
  result: { readonly ok: boolean },
  probe: RepoCheckProbe,
  failure: { readonly code: string } | undefined,
  durationMs: number
): RepoDiagnostic | undefined {
  if (result.ok) return undefined;
  const transport = transportOf(plan.target.url);
  const base = { id: newDiagnosticId(), transport, durationMs: Math.max(0, durationMs) };
  // 检查前就能确定（令牌标记在、密钥箱里没了）：不是 git 的错。
  if (plan.preflight) return { ...base, stage: 'credential', code: 'credential_unavailable' };
  // 网关 / Worker 层失败（掉线、没有及时回复）由错误码判定，不靠猜文案。
  if (failure?.code === 'unavailable') return { ...base, stage: 'worker', code: 'worker_unavailable' };
  // 只有探测成功（连得上）之后才可能确定是分支不存在。
  if (probe.reachable && !probe.branchExists && plan.target.branch !== null && plan.target.branch !== '') {
    return { ...base, stage: 'branch', code: 'branch_missing' };
  }
  return { ...base, stage: 'git', ...classifyGitFailure(probe.message ?? '', transport) };
}

/**
 * 审计里追加诊断 id + 凭据来源 + 安全代码 + 时长；只有固定枚举和数字，
 * 没有地址 / 分支 / 上游原文，也没有令牌内容。
 */
function auditDetail(prefix: string, results: ProjectReposCheckDto['results']): string {
  const bad = results.filter((result) => !result.ok).length;
  const diagnostics = results
    .map((result) => (result.diagnostic ? `${result.diagnostic.id}:${result.credentialSource}/${result.diagnostic.stage}/${result.diagnostic.code}/${result.diagnostic.transport}/${result.diagnostic.durationMs}ms` : null))
    .filter((line): line is string => line !== null);
  const suffix = diagnostics.length > 0 ? `；诊断 ${diagnostics.join('，')}` : '';
  return `${prefix} ${results.length} 个仓库，${bad} 个有问题${suffix}`;
}

interface CheckOutcome {
  readonly workerId: string | null;
  readonly workerLabel: string | null;
  readonly unavailable: string | null;
  readonly results: ProjectReposCheckDto['results'];
}

/** 两端共用的执行体：假设权限、机器和凭据计划都已确定。 */
async function runCheck(
  deps: Deps,
  chosen: WorkerStatus,
  plans: readonly PlannedRepo[]
): Promise<CheckOutcome> {
  const route = chosen.origin === 'local' ? null : chosen.workerId;
  const git = route === null ? deps.git : deps.gateway.git(route);

  const probes = new Map<RepoCheckTarget, RepoCheckProbe>();
  const failures = new Map<RepoCheckTarget, { readonly code: string }>();
  const durations = new Map<RepoCheckTarget, number>();
  const results = await checkReposUseCase(
    {
      checkRepo: async (target) => {
        const plan = plans.find((candidate) => candidate.target === target);
        const started = Date.now();
        let probe: RepoCheckProbe;
        try {
          if (plan?.preflight) {
            probe = { reachable: false, defaultBranch: null, branchExists: false, message: plan.preflight.message };
          } else {
            const outcome = await git.checkRepo(target.url, target.branch, plan?.auth ?? undefined);
            // 网关掉线 / 超时也翻成一条普通的「检查不通过」，别让整批 500。
            if (outcome.ok) {
              probe = outcome.value;
            } else {
              failures.set(target, { code: outcome.error.code });
              probe = { reachable: false, defaultBranch: null, branchExists: false, message: outcome.error.message };
            }
          }
        } catch {
          // 端口异常抛错也不能让整批 500；归到 Worker 不可用，message 只用固定话术，不序列化异常。
          failures.set(target, { code: 'unavailable' });
          probe = { reachable: false, defaultBranch: null, branchExists: false, message: WORKER_UNAVAILABLE_MESSAGE };
        } finally {
          durations.set(target, Date.now() - started);
        }
        probes.set(target, probe);
        return probe;
      }
    },
    plans.map((plan) => plan.target)
  );

  const dtoResults = results.map((result, index) => {
    const plan = plans[index]!;
    const probe: RepoCheckProbe =
      probes.get(plan.target) ?? { reachable: false, defaultBranch: null, branchExists: false, message: result.message };
    const diagnostic = diagnosticFor(plan, result, probe, failures.get(plan.target), durations.get(plan.target) ?? 0);
    const failureKind = failureKindOf(diagnostic);
    return {
      name: result.name,
      url: result.url,
      branch: result.branch,
      ok: result.ok,
      defaultBranch: result.defaultBranch,
      // 失败一律给固定话术：不把上游 stderr（可能带令牌 / 地址）带回响应。
      message: result.ok ? null : messageFor(plan, diagnostic, result.message),
      credentialSource: plan.credentialSource,
      ...(failureKind ? { failureKind } : {}),
      ...(diagnostic ? { diagnostic } : {})
    };
  });

  return {
    workerId: route,
    workerLabel: chosen.label,
    unavailable: null,
    results: dtoResults
  };
}

export function installProjectReposRoutes(app: Hono<any>, options: ProjectReposRouteDeps, subjectOf: SubjectOf): void {
  const { deps, audit } = options;

  app.post('/api/projects/:projectId/repos/check', async (c) => {
    const parsed = checkProjectReposRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return fail(c, { code: 'invalid', message: issue ? `${issue.path.join('.')}: ${issue.message}` : '仓库清单不对' });
    }

    const projectId = c.req.param('projectId');
    const subject = subjectOf(c);
    const project = await deps.projects.byId(asProjectId(projectId));
    const allowed = await authorizeProject(deps.access, subject, project, 'project.update');
    if (!allowed.ok) return fail(c, allowed.error);

    // 形状 / 上限 / 重名与保存走同一套规则：检查的必须就是保存时会被记下的那份。
    // tokenSecret 由服务端按 (projectId, repoId) 生成，请求里带的一律忽略。
    const normalized = normalizeRepos(parsed.data.repos, { acceptTokenSecret: false });
    if (!normalized.ok) return fail(c, normalized.error);

    for (const [index, repo] of parsed.data.repos.entries()) {
      const problem = unsafeRepoUrlProblem(repo.url);
      if (problem) return fail(c, { code: 'invalid', message: `repos.${index}.url: ${problem}` });
    }

    const choice = await chooseWorker(deps, subject, parsed.data.workerId);
    if (!choice.ok) return fail(c, choice.error);
    const { chosen, unavailable } = choice.value;
    if (!chosen) {
      const body: ProjectReposCheckDto = { workerId: null, workerLabel: null, unavailable, results: [] };
      return c.json(body);
    }

    const plans = await planRepos(deps, project, targetsOf(normalized.value), parsed.data.repos);
    const outcome = await runCheck(deps, chosen, plans);
    await audit?.(c, subject, 'project.repos_check', projectId, auditDetail('检查', outcome.results));
    return c.json(outcome satisfies ProjectReposCheckDto);
  });

  app.post('/api/repo-check', async (c) => {
    const subject = subjectOf(c);
    // 这条路由不在 access 中间件的匹配前缀里，权限自己判：与 POST /api/projects 一致。
    if (!can(subject, 'project.create')) return fail(c, forbidden('你没有权限新建项目'));

    const parsed = repoCheckRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return fail(c, { code: 'invalid', message: issue ? `${issue.path.join('.')}: ${issue.message}` : '仓库清单不对' });
    }

    const normalized = normalizeRepos(parsed.data.repos, { acceptTokenSecret: false });
    if (!normalized.ok) return fail(c, normalized.error);

    for (const [index, repo] of parsed.data.repos.entries()) {
      const problem = unsafeRepoUrlProblem(repo.url);
      if (problem) return fail(c, { code: 'invalid', message: `repos.${index}.url: ${problem}` });
    }

    const choice = await chooseWorker(deps, subject, parsed.data.workerId);
    if (!choice.ok) return fail(c, choice.error);
    const { chosen, unavailable } = choice.value;
    if (!chosen) {
      // 草稿检查还没落库：没有机器就直说，不伪造结果。
      await audit?.(c, subject, 'project.repos_check', 'draft', '新建项目前检查：现在没有在线的机器');
      const body: ProjectReposCheckDto = { workerId: null, workerLabel: null, unavailable, results: [] };
      return c.json(body);
    }

    // project = null：草稿端点永远不读已保存令牌，也不用任何项目身份。
    const plans = await planRepos(deps, null, targetsOf(normalized.value), parsed.data.repos);
    const outcome = await runCheck(deps, chosen, plans);
    await audit?.(c, subject, 'project.repos_check', 'draft', auditDetail('新建项目前检查', outcome.results));
    return c.json(outcome satisfies ProjectReposCheckDto);
  });
}
