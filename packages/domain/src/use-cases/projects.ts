import { principalOfSubject, type Subject } from '../access.ts';
import { createProject, deriveRepoId, normalizeChecks, normalizeDescription, normalizePreviewPort, normalizeWorktree, normalizeSubmodules, normalizePrimaryRepoId, normalizeRepos, parseRepo, repoNameFromUrl, repoTokenKey, withProjectRepos } from '../project.ts';
import { normalizeDefaultAgent } from '../agent-ref.ts';
import { asProjectId } from '../ids.ts';
import type { Project, ProjectRepo } from '../project.ts';
import type { DomainError } from '../errors.ts';
import { invalid, notFound } from '../errors.ts';
import type { Result } from '../result.ts';
import { err, ok } from '../result.ts';
import type { Deps } from './deps.ts';
import type { DirectoryEntry } from '../ports/workspace-fs.ts';
import { newWorkspace, type Workspace } from '../workspace.ts';
import { claimOf, directoryOwner, listOn, normalize, parentOf, remoteExists, resolveMachine, rootsOf } from './machine-dirs.ts';
import { authorizeWorker } from './authorization.ts';

export { createDirectory, directoryOwner } from './machine-dirs.ts';
import { managedDirectory, projectSlug, sortDirectoryEntries } from '../directories.ts';

export interface CreateProjectCommand {
  readonly name: string;
  /** 空串 / 不给 = 先不选目录（开始任务时再选工作空间）。 */
  readonly rootPath?: string;
  /** 目录在哪台 Worker 上。不给 / 给的是本机 Worker = 和 Server 同机。 */
  readonly workerId?: string | null;
  /** 可选的 git 仓库。 */
  readonly repoUrl?: string | null;
  readonly defaultBranch?: string | null;
  /** 可选的项目说明（markdown）。 */
  readonly description?: string | null;
  /** 谁建的：项目归他的团队、算他建的（ADR 0011）。 */
  readonly actor?: Subject | null;
}

export async function createProjectUseCase(
  deps: Pick<Deps, 'fs' | 'now' | 'projects' | 'gateway' | 'workspaces' | 'access'>,
  command: CreateProjectCommand
): Promise<Result<Project, DomainError>> {
  const repo = parseRepo(command.repoUrl, command.defaultBranch);
  if (!repo.ok) return repo;
  const description = normalizeDescription(command.description);
  if (!description.ok) return description;
  const rootPath = command.rootPath?.trim() ?? '';
  const where = await resolveMachine(deps, command.workerId ?? null);
  if (!where.ok) return where;
  if (rootPath !== '') {
    const allowed = await authorizeWorker(deps.access, command.actor ?? null, where.value.workerId);
    if (!allowed.ok) return allowed;
    if (!rootPath.startsWith('/')) return err(invalid('目录必须是绝对路径'));
    const route = where.value.route;
    const exists = route === null ? await deps.fs.directoryExists(rootPath) : await remoteExists(deps, route, rootPath);
    if (!exists) return err(invalid(`目录不存在：${rootPath}`));
  }
  const created = createProject({
    name: command.name,
    now: deps.now(),
    repo: repo.value,
    description: description.value,
    teamId: principalOfSubject(command.actor)?.user.teamId ?? null,
    createdBy: principalOfSubject(command.actor)?.user.id ?? null
  });
  if (!created.ok) return created;
  let first: Workspace | null = null;
  let reuse: Workspace | null = null;
  if (rootPath !== '') {
    const taken = await claimOf(deps, { teamId: created.value.teamId, projectId: created.value.id, workerId: where.value.workerId, path: rootPath });
    if (!taken.ok) return taken;
    reuse = taken.value;
    if (!reuse) {
      // 给了目录：它就是这个项目的第一个持久工作空间（关联已有目录，平台永不删它）
      const linked = newWorkspace({ projectId: created.value.id, teamId: created.value.teamId, workerId: where.value.workerId, path: rootPath, kind: 'long_lived', source: 'linked', now: deps.now() });
      if (!linked.ok) return linked;
      first = linked.value;
    }
  }
  await deps.projects.save(created.value);
  if (first) await deps.workspaces.save(first);
  // 团队里已经登记过这个目录（ADR 0026）：直接关联，不再「属于别的项目」
  if (reuse) await deps.workspaces.link({ projectId: created.value.id, workspaceId: reuse.id, linkedBy: created.value.createdBy, linkedAt: deps.now() });
  return ok(created.value);
}

export async function listProjects(deps: Pick<Deps, 'projects'>): Promise<Result<Project[], DomainError>> {
  return ok(await deps.projects.list());
}

export async function loadProject(
  deps: Pick<Deps, 'projects'>,
  projectId: Project['id']
): Promise<Result<Project, DomainError>> {
  const project = await deps.projects.byId(projectId);
  return project ? ok(project) : err(notFound('项目不存在'));
}



export interface DirectoryListing {
  readonly path: string;
  readonly parent: string | null;
  readonly entries: readonly DirectoryEntry[];
  readonly workerId: string | null;
  /** 这台机器允许浏览的根（面包屑的起点，不能往上越过）。 */
  readonly roots: readonly string[];
  /** 当前项目的托管目录 `<roots[0]>/agent-hub/<slug>`（给了项目名才有）；不一定已存在。 */
  readonly managed: string | null;
}

/**
 * 目录选择器：在「项目要绑的那台机器」上浏览。
 * `path` 为空时从那台机器的起点开始（Server 本机由 `home` 给，remote Worker 由它自己的 roots[0] 给）。
 */
export async function browseDirectories(
  deps: Pick<Deps, 'fs' | 'gateway'>,
  input: { readonly workerId: string | null; readonly path: string; readonly home: string; readonly project?: string }
): Promise<Result<DirectoryListing, DomainError>> {
  const owner = await directoryOwner(deps, input.workerId);
  if (!owner.ok) return owner;
  const roots = await rootsOf(deps, owner.value, input.workerId, input.home);
  const slug = input.project ? projectSlug(input.project) : null;
  const managed = slug === null ? null : managedDirectory(roots, slug);
  // 没指定路径：优先从项目托管目录开始，没有就退到 <root>/agent-hub，再退到 root
  const candidates =
    input.path !== ''
      ? [normalize(input.path)]
      : [...(managed ? [managed, parentOf(managed) ?? ''] : []), roots[0] ?? ''].filter((c) => c !== '');
  if (candidates.length === 0) candidates.push('');
  let lastError: DomainError | null = null;
  for (const candidate of candidates) {
    const listed = await listOn(deps, owner.value, candidate);
    if (!listed.ok) {
      lastError = listed.error;
      continue;
    }
    if (listed.value === null) continue;
    const path = listed.value.path;
    const atRoot = roots.some((root) => normalize(root) === path) || path === '/';
    return ok({
      path,
      parent: atRoot ? null : parentOf(path),
      entries: sortDirectoryEntries(listed.value.entries),
      workerId: owner.value,
      roots,
      managed
    });
  }
  if (lastError) return err(lastError);
  return err(notFound(`没有这个目录：${input.path || candidates[candidates.length - 1]}`));
}







/**
 * 绑定 / 改 / 解除项目仓库（url 为空 = 解除）。只影响以后新建的工作空间，已有的不动。
 * 多仓库项目里这是「改 primary」：替换第一个成员，保留其后的仓库（旧客户端不该顺手清掉别的仓库）。
 * 地址没变时保留 primary 的 HTTPS 令牌；换了地址（可能是另一台主机）就把它从密钥箱里回收。
 */
export async function setProjectRepoUseCase(
  deps: Pick<Deps, 'projects' | 'secrets'>,
  command: { readonly projectId: string; readonly repoUrl: string | null; readonly defaultBranch?: string | null }
): Promise<Result<Project, DomainError>> {
  const project = await deps.projects.byId(asProjectId(command.projectId));
  if (!project) return err(notFound('项目不存在'));
  const parsed = parseRepo(command.repoUrl, command.defaultBranch);
  if (!parsed.ok) return parsed;
  const previous = project.repos[0] ?? null;
  if (parsed.value === null) {
    const cleared = withProjectRepos(project, []);
    await deps.projects.save(cleared);
    if (previous?.tokenSecret) await deps.secrets.remove(previous.tokenSecret);
    return ok(cleared);
  }
  const existing = previous;
  // name 是组合工作空间的子目录名，跟着旧 primary 走，不随 URL 变化；没有旧 primary 时从 URL 派生。
  const name = existing?.name ?? repoNameFromUrl(parsed.value.url);
  const sameUrl = existing !== null && existing.url === parsed.value.url;
  const primary: ProjectRepo = {
    id: existing?.id ?? deriveRepoId(name, parsed.value.url),
    name,
    url: parsed.value.url,
    defaultBranch: parsed.value.defaultBranch,
    ...(sameUrl && existing?.tokenSecret ? { tokenSecret: existing.tokenSecret } : {})
  };
  const next = withProjectRepos(project, [primary, ...project.repos.slice(1)]);
  await deps.projects.save(next);
  if (!sameUrl && existing?.tokenSecret) await deps.secrets.remove(existing.tokenSecret);
  return ok(next);
}

/**
 * 一个仓库条目的输入：`credential` 是明文令牌，只在这一次请求里出现。
 * 非空 = 存进密钥箱并写 `tokenSecret`；`''` = 清掉；省略 = 不动已有的。
 */
export interface ProjectRepoInput extends Partial<ProjectRepo> {
  readonly credential?: string | null;
}

/**
 * 改项目的仓库清单（PATCH /api/projects/:id 的 repos 字段，docs/design/multi-repo.md §11.2）。
 * 空数组 = 不绑仓库；同时维护过渡期的 `repo`（= 第一个）。
 *
 * 令牌只以密钥名（`repo-git:<id>`）落在 domain 对象上：明文进密钥箱，从清单里移除的仓库、
 * 换了地址（可能是另一台主机）的仓库、显式 `credential: ''` 的仓库，密钥条目一起回收。
 */
export async function updateProjectReposUseCase(
  deps: Pick<Deps, 'projects' | 'secrets' | 'now'>,
  command: { readonly projectId: string; readonly repos: readonly ProjectRepoInput[]; readonly primaryRepoId?: string | null }
): Promise<Result<Project, DomainError>> {
  const project = await deps.projects.byId(asProjectId(command.projectId));
  if (!project) return err(notFound('项目不存在'));
  const normalized = normalizeRepos(command.repos);
  if (!normalized.ok) return normalized;
  const previous = new Map(project.repos.map((repo) => [repo.id, repo] as const));
  const repos: ProjectRepo[] = [];
  const revoked: string[] = [];
  for (const [index, repo] of normalized.value.entries()) {
    const raw = command.repos[index];
    const credential = typeof raw?.credential === 'string' ? raw.credential : null;
    const before = previous.get(repo.id) ?? null;
    const sameUrl = before !== null && before.url === repo.url;
    const secret = repoTokenKey(repo.id);
    if (credential !== null && credential.trim() !== '') {
      await deps.secrets.put(secret, credential.trim(), deps.now());
      repos.push({ ...repo, tokenSecret: repoTokenKey(repo.id) });
      if (before?.tokenSecret && before.tokenSecret !== secret) revoked.push(before.tokenSecret);
      continue;
    }
    if (credential === '') revoked.push(secret);
    // 没给新令牌：地址没变就沿用，换了地址（可能换了主机）就丢弃并回收
    const carried = credential !== null ? null : sameUrl ? before?.tokenSecret ?? null : null;
    if (credential === null && !sameUrl && before?.tokenSecret) revoked.push(before.tokenSecret);
    repos.push(carried === null ? repo : { ...repo, tokenSecret: carried });
  }
  const kept = new Set(repos.map((repo) => repo.id));
  for (const repo of project.repos) {
    if (!kept.has(repo.id) && repo.tokenSecret) revoked.push(repo.tokenSecret);
  }
  for (const name of new Set(revoked)) await deps.secrets.remove(name);
  const primaryRepoId = command.primaryRepoId !== undefined
    ? normalizePrimaryRepoId(repos, command.primaryRepoId)
    : normalizePrimaryRepoId(repos, project.primaryRepoId);
  if (!primaryRepoId.ok) return primaryRepoId;
  const next = withProjectRepos(project, repos, primaryRepoId.value);
  await deps.projects.save(next);
  return ok(next);
}

/** 改项目的工作空间档位 / 准备命令（null = 没配，按 shared 处理）。只影响以后新建的临时工作空间。 */
export async function setProjectPreviewPortUseCase(
  deps: Pick<Deps, 'projects'>,
  command: { readonly projectId: string; readonly previewPort: unknown }
): Promise<Result<Project, DomainError>> {
  const project = await deps.projects.byId(asProjectId(command.projectId));
  if (!project) return err(notFound('项目不存在'));
  const port = normalizePreviewPort(command.previewPort);
  if (!port.ok) return port;
  const next: Project = { ...project, previewPort: port.value };
  await deps.projects.save(next);
  return ok(next);
}

/** 改项目的检查命令（issue #216 P1）：空数组 = 清掉；逐条校验后写回。 */
export async function setProjectChecksUseCase(
  deps: Pick<Deps, 'projects'>,
  command: { readonly projectId: string; readonly checks: unknown }
): Promise<Result<Project, DomainError>> {
  const project = await deps.projects.byId(asProjectId(command.projectId));
  if (!project) return err(notFound('项目不存在'));
  const checks = normalizeChecks(command.checks);
  if (!checks.ok) return checks;
  const next: Project = { ...project, checks: checks.value };
  await deps.projects.save(next);
  return ok(next);
}

/** 改项目的默认 Agent（runtime + 模型 + 启动选项）；null = 清掉。 */
export async function setProjectDefaultAgentUseCase(
  deps: Pick<Deps, 'projects'>,
  command: { readonly projectId: string; readonly defaultAgent: unknown }
): Promise<Result<Project, DomainError>> {
  const project = await deps.projects.byId(asProjectId(command.projectId));
  if (!project) return err(notFound('项目不存在'));
  const agent = normalizeDefaultAgent(command.defaultAgent);
  if (!agent.ok) return agent;
  const next: Project = { ...project, defaultAgent: agent.value };
  await deps.projects.save(next);
  return ok(next);
}

/** 改子模块策略（'off' = 不拉）。只影响之后新建的 clone / worktree。 */
export async function setProjectSubmodulesUseCase(
  deps: Pick<Deps, 'projects'>,
  command: { readonly projectId: string; readonly submodules: unknown }
): Promise<Result<Project, DomainError>> {
  const project = await deps.projects.byId(asProjectId(command.projectId));
  if (!project) return err(notFound('项目不存在'));
  const submodules = normalizeSubmodules(command.submodules);
  if (!submodules.ok) return submodules;
  const next: Project = { ...project, submodules: submodules.value === 'off' ? undefined : submodules.value };
  await deps.projects.save(next);
  return ok(next);
}

export async function setProjectWorktreeUseCase(
  deps: Pick<Deps, 'projects'>,
  command: { readonly projectId: string; readonly worktree: unknown }
): Promise<Result<Project, DomainError>> {
  const project = await deps.projects.byId(asProjectId(command.projectId));
  if (!project) return err(notFound('项目不存在'));
  const worktree = normalizeWorktree(command.worktree);
  if (!worktree.ok) return worktree;
  const next: Project = { ...project, worktree: worktree.value };
  await deps.projects.save(next);
  return ok(next);
}

/** 改项目说明（空 = 清掉）。 */
export async function setProjectDescriptionUseCase(
  deps: Pick<Deps, 'projects'>,
  command: { readonly projectId: string; readonly description: string | null }
): Promise<Result<Project, DomainError>> {
  const project = await deps.projects.byId(asProjectId(command.projectId));
  if (!project) return err(notFound('项目不存在'));
  const description = normalizeDescription(command.description);
  if (!description.ok) return description;
  const next: Project = { ...project, description: description.value };
  await deps.projects.save(next);
  return ok(next);
}
