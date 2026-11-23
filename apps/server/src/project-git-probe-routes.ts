import type { Context, Hono, MiddlewareHandler } from 'hono';
import { z } from 'zod';
import {
  asProjectId,
  authorizeProject,
  forbidden,
  invalid,
  isHttpsRepoUrl,
  isSystem,
  notFound,
  repoUrlHasUserInfo,
  unavailable,
  type AccessPolicy,
  type Principal,
  type ProjectRepository,
  type ProjectRepo,
  type RepoCheckProbe,
  type SecretVault
} from '@agent-hub/domain';
import type { SubjectOf } from './auth.ts';
import { fail } from './http-error.ts';
import { authHeaderFor } from './repo-auth.ts';

/**
 * 项目仓库的「hub 侧隔离探测」：显式 opt-in、只在 hub 执行、只认浏览器登录的项目管理员。
 *
 * 与 legacy 的 `POST /api/projects/:projectId/repos/check` 分开：
 * - 不选 Worker，不发 Worker RPC，不写仓库 / 资产。
 * - 目标 URL 只能来自项目里已登记的仓库，请求体不接受 URL / 凭据 / 路径 / Worker。
 * - 凭据用独立的 `repo-git-hub:<projectId>:<repoId>` 命名空间，绝不回退到 clone/publish 用的
 *   `repo-git:` 规范键；读取时要求和登记 URL 的规范化结果完全一致，项目改 URL 就自动失效。
 */

/** 与未来 sibling 的结构保持一致；只传执行探测真正需要的三样东西。 */
export interface ProjectGitProbe {
  check(input: { readonly url: string; readonly branch: string | null; readonly authorization: string }): Promise<RepoCheckProbe>;
}

export interface ProjectGitProbeRouteOptions {
  readonly probe: ProjectGitProbe;
  /** 运营方显式启用的仓库白名单；返回 false 时不读密钥、不执行探测。 */
  readonly allows: (projectId: string, repoId: string, url: string) => boolean;
  readonly projects: Pick<ProjectRepository, 'byId'>;
  readonly secrets: Pick<SecretVault, 'reveal' | 'put' | 'remove'>;
  readonly access?: AccessPolicy;
  /** 存密钥时的时间戳；集成方传 deps.now，未传时用墙钟。 */
  readonly now?: () => number;
}

export type ProjectGitProbeStatus = 'ok' | 'branch_missing' | 'credential_unavailable' | 'unreachable';

export interface ProjectGitProbeCheckDto {
  readonly repoId: string;
  readonly status: ProjectGitProbeStatus;
  readonly readable: boolean;
  readonly defaultBranch: string | null;
  readonly branch: string | null;
  readonly branchExists: boolean;
  readonly executor: 'hub';
}

export interface ProjectGitProbeCredentialDto {
  readonly ok: true;
  readonly executor: 'hub';
}

/** 隔离探测凭据的密钥名；和 clone/publish 的 `repoTokenKey` 是不同命名空间。 */
export function isolatedRepoTokenKey(projectId: string, repoId: string): string {
  return `repo-git-hub:${projectId}:${repoId}`;
}

const CREDENTIAL_MAX = 4096;
const BRANCH_MAX = 255;
const noStore = { 'cache-control': 'no-store' } as const;

const credentialRequest = z.object({ credential: z.string().min(1).max(CREDENTIAL_MAX) }).strict();

function noStoreMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.header('cache-control', noStore['cache-control']);
  };
}

function unauthenticated(c: Context): Response {
  return c.json({ error: { code: 'unauthorized', message: '请先登录' } }, 401);
}

/**
 * 浏览器会话 = 有真实用户、且没有走 API token 通道。
 * token 主体（哪怕权限足够）一律拒绝：这个端点只允许人在项目设置里手动触发。
 */
function browserPrincipal(c: Context, subjectOf: SubjectOf): Principal | Response {
  const actor = subjectOf(c);
  if (!actor || isSystem(actor)) return unauthenticated(c);
  if (actor.user.disabledAt !== null || actor.user.deletedAt !== null) return unauthenticated(c);
  if (actor.via) return fail(c, forbidden('这个接口只接受浏览器登录'));
  return actor;
}

/** URL 的规范化绑定：只保留 https scheme/host/port/path；query / fragment（含空的 `?`、`#`）一律拒绝。 */
function canonicalProbeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '' || !isHttpsRepoUrl(trimmed)) return null;
  if (/[\s\u0000-\u001f\u007f]/.test(trimmed)) return null;
  if (/[?#]/.test(trimmed)) return null;
  if (repoUrlHasUserInfo(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') return null;
    if (parsed.username !== '' || parsed.password !== '') return null;
    if (parsed.hostname === '') return null;
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return null;
  }
}

/** 分支名只作为已登记配置回显；上游返回值同样按长度 / 控制字符截断。 */
function boundedBranch(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > BRANCH_MAX) return null;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

function dto(
  repoId: string,
  status: ProjectGitProbeStatus,
  readable: boolean,
  defaultBranch: string | null,
  branch: string | null,
  branchExists: boolean
): ProjectGitProbeCheckDto {
  return { repoId, status, readable, defaultBranch, branch, branchExists, executor: 'hub' };
}

function credentialUnavailable(repoId: string, branch: string | null): ProjectGitProbeCheckDto {
  return dto(repoId, 'credential_unavailable', false, null, branch, false);
}

/** 从密钥箱取值；兼容绑定 URL 的 JSON envelope，但绝不读取 `repo-git:` legacy 键。 */
function parseStoredCredential(raw: string | undefined, url: string): string | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const bound = typeof record.url === 'string' ? canonicalProbeUrl(record.url) : null;
    const token = typeof record.token === 'string' ? record.token : null;
    if (bound === null || bound !== url || token === null) return null;
    if (token.length === 0 || token.length > CREDENTIAL_MAX) return null;
    if (/[\u0000-\u001f\u007f]/.test(token)) return null;
    return token;
  } catch {
    return null;
  }
}

/** 检查请求体必须为空（或严格 `{}`）；任何 URL / branch / worker 提示都不接。 */
function checkBodyProblem(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return '检查请求不接受请求体';
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length > 0) {
    return '检查请求不接受请求体';
  }
  return null;
}

interface ResolvedTarget {
  readonly projectId: string;
  readonly repo: ProjectRepo;
  readonly url: string;
}

/**
 * 授权 → 活动项目 → 精确 repoId → 登记 HTTPS 地址 → 运营白名单。
 * 任何一步失败都不 reveal、不调 probe。
 */
async function resolveTarget(
  c: Context,
  options: ProjectGitProbeRouteOptions,
  subjectOf: SubjectOf
): Promise<ResolvedTarget | Response> {
  const actor = browserPrincipal(c, subjectOf);
  if (actor instanceof Response) return actor;

  const project = await options.projects.byId(asProjectId(c.req.param('projectId') ?? ''));
  const allowed = await authorizeProject(options.access, actor, project, 'project.update');
  if (!allowed.ok) return fail(c, allowed.error);

  const repoId = c.req.param('repoId') ?? '';
  const repo = allowed.value.repos.find((candidate) => candidate.id === repoId);
  if (!repo) return fail(c, notFound('仓库不存在'));

  const url = canonicalProbeUrl(repo.url);
  if (url === null) return fail(c, invalid('隔离检查只支持不含凭据的 HTTPS 仓库地址'));

  let operatorAllowed = false;
  try {
    operatorAllowed = options.allows(allowed.value.id, repo.id, url);
  } catch {
    operatorAllowed = false;
  }
  if (!operatorAllowed) return fail(c, notFound('仓库不存在'));

  return { projectId: allowed.value.id, repo, url };
}

export function installProjectGitProbeRoutes(
  app: Hono<any>,
  options: ProjectGitProbeRouteOptions,
  subjectOf: SubjectOf
): void {
  const noStoreAt = noStoreMiddleware();
  const base = '/api/projects/:projectId/repos/:repoId/isolated';

  app.use(`${base}-check`, noStoreAt);
  app.use(`${base}-credential`, noStoreAt);

  app.post(`${base}-check`, async (c) => {
    const target = await resolveTarget(c, options, subjectOf);
    if (target instanceof Response) return target;

    const bodyProblem = checkBodyProblem(await c.req.text().catch(() => ''));
    if (bodyProblem !== null) return fail(c, invalid(bodyProblem));

    const branch = boundedBranch(target.repo.defaultBranch);
    const key = isolatedRepoTokenKey(target.projectId, target.repo.id);

    let raw: string | undefined;
    try {
      raw = (await options.secrets.reveal([key]))[key];
    } catch {
      return c.json(credentialUnavailable(target.repo.id, branch), 200, noStore);
    }

    const token = parseStoredCredential(raw, target.url);
    if (token === null) return c.json(credentialUnavailable(target.repo.id, branch), 200, noStore);

    let result: RepoCheckProbe | null;
    try {
      // authHeaderFor 只在这一步之后调用：token 到这个点才第一次变成 Authorization 头。
      const auth = authHeaderFor(token, target.url);
      result = await options.probe.check({ url: target.url, branch, authorization: auth.header });
    } catch {
      return c.json(dto(target.repo.id, 'unreachable', false, null, branch, false), 200, noStore);
    }

    const probe = result as RepoCheckProbe | null | undefined;
    const readable = probe?.reachable === true;
    if (!readable) {
      return c.json(dto(target.repo.id, 'unreachable', false, null, branch, false), 200, noStore);
    }
    const defaultBranch = boundedBranch(probe?.defaultBranch);
    const branchExists = branch !== null && probe?.branchExists === true;
    return c.json(
      dto(target.repo.id, branchExists ? 'ok' : 'branch_missing', true, defaultBranch, branch, branchExists),
      200,
      noStore
    );
  });

  app.put(`${base}-credential`, async (c) => {
    const target = await resolveTarget(c, options, subjectOf);
    if (target instanceof Response) return target;

    const parsed = credentialRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return fail(c, invalid('credential: 需要 1–4096 个字符的凭据'));

    const credential = parsed.data.credential;
    if (credential.trim() === '') return fail(c, invalid('credential: 凭据不能为空'));
    if (credential.trim() !== credential) return fail(c, invalid('credential: 凭据不能带首尾空白'));
    if (/[\u0000-\u001f\u007f]/.test(credential)) return fail(c, invalid('credential: 凭据不能包含控制字符'));

    const key = isolatedRepoTokenKey(target.projectId, target.repo.id);
    const envelope = JSON.stringify({ url: target.url, token: credential });
    try {
      await options.secrets.put(key, envelope, (options.now ?? (() => Date.now()))());
    } catch {
      return fail(c, unavailable('隔离检查凭据保存失败'));
    }
    return c.json({ ok: true, executor: 'hub' } satisfies ProjectGitProbeCredentialDto, 200, noStore);
  });

  app.delete(`${base}-credential`, async (c) => {
    const target = await resolveTarget(c, options, subjectOf);
    if (target instanceof Response) return target;

    const key = isolatedRepoTokenKey(target.projectId, target.repo.id);
    try {
      await options.secrets.remove(key);
    } catch {
      return fail(c, unavailable('隔离检查凭据删除失败'));
    }
    return c.json({ ok: true, executor: 'hub' } satisfies ProjectGitProbeCredentialDto, 200, noStore);
  });
}
