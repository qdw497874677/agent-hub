import type { Hono } from 'hono';
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
const AUTHENTICATION_MESSAGE = '认证失败：请检查仓库地址、令牌，或这台机器上的凭据';

/**
 * 只有这些上游措辞才归成 authentication；`repository not found` 之类模糊结果不算——
 * 宁可报 unreachable，也不要把「仓库地址写错」说成「令牌错了」。
 */
const AUTH_FAILURE_PATTERNS: readonly RegExp[] = [
  /authentication failed/i,
  /could not read (?:username|password)/i,
  /permission denied/i,
  /access denied/i,
  /invalid username or password/i,
  /terminal prompts disabled/i,
  /\b401\b/,
  /\b403\b/,
  /support for password authentication was removed/i,
  /authorization failed/i,
  /bad credentials/i
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

/** 把可能带凭据的上游输出洗成一句可展示的话：去控制字符、去 URL userinfo、去常见令牌形态。 */
export function sanitizeDiagnostic(
  message: string | null | undefined,
  secrets: readonly string[] = []
): string | null {
  if (!message) return null;
  let text = message.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
  text = text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1');
  text = text.replace(/\b(Basic|Bearer)\s+[A-Za-z0-9+/=._~-]{4,}/gi, '$1 ***');
  text = text.replace(/x-access-token:[^\s'"]+/gi, 'x-access-token:***');
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    text = text.split(secret).join('***');
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (text === '') return null;
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

/** 令牌的各种可能被上游回显的形态：原文、URL 编码、以及 x-access-token 的 base64。 */
function redactionForms(token: string): string[] {
  const forms = new Set<string>([token, encodeURIComponent(token)]);
  if (token.length >= 8) {
    forms.add(Buffer.from(token).toString('base64'));
    forms.add(Buffer.from(`x-access-token:${token}`).toString('base64'));
  }
  return [...forms].filter((form) => form.length >= 4);
}

type CredentialSource = 'draft' | 'saved' | 'worker';
type FailureKind = 'authentication' | 'branch_missing' | 'unreachable' | 'credential_unavailable';

interface PlannedRepo {
  readonly target: RepoCheckTarget;
  readonly auth: GitAuth | null;
  readonly credentialSource: CredentialSource;
  /** 检查前就能确定的问题（例如令牌标记还在、密钥箱里却没了）：不发 git，也不静默改用机器凭据。 */
  readonly preflight: { readonly failureKind: FailureKind; readonly message: string } | null;
  readonly redactions: readonly string[];
}

type RepoInput = {
  readonly id?: string;
  readonly name?: string;
  readonly url: string;
  readonly defaultBranch?: string | null;
  readonly credential?: string;
};

function noCredentialPlan(target: RepoCheckTarget): PlannedRepo {
  return { target, auth: null, credentialSource: 'worker', preflight: null, redactions: [] };
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
          preflight: null,
          redactions: redactionForms(token)
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

    const revealed = await deps.secrets.reveal([tokenName]);
    const token = revealed[tokenName];
    if (!token) {
      plans.push({
        target,
        auth: null,
        credentialSource: 'saved',
        preflight: { failureKind: 'credential_unavailable', message: CREDENTIAL_UNAVAILABLE_MESSAGE },
        redactions: []
      });
      continue;
    }
    plans.push({
      target,
      auth: authHeaderFor(token, target.url),
      credentialSource: 'saved',
      preflight: null,
      redactions: redactionForms(token)
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

function failureKindOf(plan: PlannedRepo, result: { ok: boolean; branch: string | null; message: string | null }, probe: RepoCheckProbe): FailureKind | undefined {
  if (plan.preflight) return plan.preflight.failureKind;
  if (result.ok) return undefined;
  if (!probe.reachable) return AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(result.message ?? '')) ? 'authentication' : 'unreachable';
  if (!probe.branchExists) return result.branch !== null ? 'branch_missing' : undefined;
  return undefined;
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
  const results = await checkReposUseCase(
    {
      checkRepo: async (target) => {
        const plan = plans.find((candidate) => candidate.target === target);
        let probe: RepoCheckProbe;
        if (plan?.preflight) {
          probe = { reachable: false, defaultBranch: null, branchExists: false, message: plan.preflight.message };
        } else {
          const outcome = await git.checkRepo(target.url, target.branch, plan?.auth ?? undefined);
          // 网关掉线 / 超时也翻成一条普通的「检查不通过」，别让整批 500。
          probe = outcome.ok
            ? outcome.value
            : { reachable: false, defaultBranch: null, branchExists: false, message: outcome.error.message };
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
    const failureKind = failureKindOf(plan, result, probe);
    const rawMessage = plan.preflight ? plan.preflight.message : result.message;
    return {
      name: result.name,
      url: result.url,
      branch: result.branch,
      ok: result.ok,
      defaultBranch: result.defaultBranch,
      // 认证失败时上游输出最可能带凭据（URL 里的 token、Basic 头）：只给固定话术。
      message: failureKind === 'authentication' ? AUTHENTICATION_MESSAGE : sanitizeDiagnostic(rawMessage, plan.redactions),
      credentialSource: plan.credentialSource,
      ...(failureKind ? { failureKind } : {})
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
    const bad = outcome.results.filter((result) => !result.ok).length;
    await audit?.(c, subject, 'project.repos_check', projectId, `检查 ${outcome.results.length} 个仓库，${bad} 个有问题`);
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
    const bad = outcome.results.filter((result) => !result.ok).length;
    await audit?.(c, subject, 'project.repos_check', 'draft', `新建项目前检查 ${outcome.results.length} 个仓库，${bad} 个有问题`);
    return c.json(outcome satisfies ProjectReposCheckDto);
  });
}
