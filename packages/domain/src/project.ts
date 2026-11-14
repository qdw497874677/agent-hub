import type { ProjectId } from './ids.ts';
import { newProjectId } from './ids.ts';
import { invalid, type DomainError } from './errors.ts';
import { err, ok, type Result } from './result.ts';

/** Project 是「你在做的东西」：不绑机器也不绑目录，在哪干活看工作空间（docs/design/workspaces.md）。 */
export interface Project {
  readonly id: ProjectId;
  readonly name: string;
  /**
   * 过渡期的单仓库字段（= `repos[0]` 的 url/branch）：新建持久工作空间时 clone 它，临时工作空间据此开分支。
   * 多仓库清单见 `repos`；不变量 `repo === repos[0] ?? null` 由 `normalizeRepos` / 项目用例维护。
   */
  readonly repo: ProjectRepoLink | null;
  /** 项目绑定的仓库清单（docs/design/multi-repo.md §11.2）：0..8，空 = 不绑仓库。第一个是 primary。 */
  readonly repos: readonly ProjectRepo[];
  /** 自由格式的项目说明（markdown）：给人看，也原样交给 agent（task.get / 任务背景）。没写是 null。 */
  readonly description: string | null;
  readonly createdAt: number;
  /** 所属团队（ADR 0011）。null = 没装账号体系 / 迁移前的老数据。 */
  readonly teamId: string | null;
  /** 建的人；null = 无主（迁移前的老数据）。 */
  readonly createdBy: string | null;
  /** 共享给的团队成员（看得到、能在里面干活）。 */
  readonly members: readonly string[];
  /** 新任务默认用哪种工作空间、建好后跑不跑准备命令（docs/design/worktree.md §3）。null = 没配，按 shared 处理。 */
  readonly worktree: ProjectWorktree | null;
  /**
   * 项目约定的开发服务器端口（docs/design/preview.md §7）：只用来在预览表单里预填，
   * 不会自动建链接。null / 省略 = 没约定。
   */
  readonly previewPort?: number | null;
  /** 进了回收站的时间；null = 正常。 */
  readonly deletedAt: number | null;
}

/** 项目当授权资源（access.ts）。 */
export const projectResource = (project: Project) => ({
  teamId: project.teamId,
  createdBy: project.createdBy,
  sharedWith: project.members
});

/** 说明的长度上限：会进 agent 的上下文，太长没意义。 */
export const PROJECT_DESCRIPTION_MAX = 8000;

/** 预览默认端口：1024–65535；空/0 当成没配。 */
export function normalizePreviewPort(value: unknown): Result<number | null, DomainError> {
  if (value === null || value === undefined || value === '') return ok(null);
  if (value === 0) return ok(null);
  const port = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return err(invalid('预览端口要是 1024–65535 的整数'));
  return ok(port);
}

/** 空白 = 没写。 */
export function normalizeDescription(text: string | null | undefined): Result<string | null, DomainError> {
  const trimmed = text?.trim() ?? '';
  if (trimmed.length > PROJECT_DESCRIPTION_MAX) return err(invalid(`项目说明太长了（最多 ${PROJECT_DESCRIPTION_MAX} 字）`));
  return ok(trimmed === '' ? null : trimmed);
}

/** 过渡期的单仓库字段（`Project.repo`）：与 `Project.repos[0]` 的 url/branch 保持一致。 */
export interface ProjectRepoLink {
  readonly url: string;
  /** 省略 = 仓库自己的默认分支。 */
  readonly defaultBranch: string | null;
}

/**
 * 项目绑定的一个 git 仓库（docs/design/multi-repo.md §2）。
 * `name` 也是将来组合工作空间里的子目录名，所以形状收得很紧。
 */
export interface ProjectRepo {
  /** 'repo_<8hex>'，项目内稳定；改名字不改 id。 */
  readonly id: string;
  /** 子目录名候选：`^[a-z][a-z0-9-]{0,40}$`，项目内唯一。 */
  readonly name: string;
  readonly url: string;
  readonly defaultBranch: string | null;
}

/** 一个项目最多绑多少个仓库（组合工作空间的成员上限）。 */
export const PROJECT_REPOS_MAX = 8;

/** 仓库名（= 子目录名）的合法形状。 */
export const PROJECT_REPO_NAME_PATTERN = /^[a-z][a-z0-9-]{0,40}$/;

/** FNV-1a 32 位：领域层不依赖 node:crypto，同一输入在 server / worker / 测试里都得到同一个 id。 */
function repoHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** 仓库 id 的确定性生成：同 (name, url) 永远得到同一个 id（老列回填、双写都用它）。 */
export const deriveRepoId = (name: string, url: string): string => `repo_${repoHash(name + url)}`;

/** 从仓库地址猜一个合法的子目录名：`git@host:me/api.git` → `api`。 */
export function repoNameFromUrl(url: string): string {
  const cleaned = url.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  const last = cleaned.split(/[/:]/).filter((part) => part !== '').pop() ?? '';
  let name = last
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 41)
    .replace(/-+$/g, '');
  if (name === '') return 'repo';
  // 目录名必须以字母开头（`^[a-z]`）：数字 / 符号开头时补个前缀。
  if (!/^[a-z]/.test(name)) name = `repo-${name}`.slice(0, 41).replace(/-+$/g, '');
  return name;
}

/**
 * 校验并规范化项目的仓库清单（PATCH /api/projects/:id 的 repos 字段）。
 * - 最多 `PROJECT_REPOS_MAX` 个；空数组合法（= 不绑仓库）；
 * - 名字缺省时从 URL 派生，给了就必须合规且项目内唯一；
 * - id 缺省时按 (name, url) 确定性生成；给了就保留（改名字不改 id）。
 */
export function normalizeRepos(input: readonly Partial<ProjectRepo>[]): Result<readonly ProjectRepo[], DomainError> {
  if (input.length > PROJECT_REPOS_MAX) return err(invalid(`一个项目最多 ${PROJECT_REPOS_MAX} 个仓库`));
  const seen = new Set<string>();
  const repos: ProjectRepo[] = [];
  for (const raw of input) {
    const url = typeof raw.url === 'string' ? raw.url.trim() : '';
    if (url === '') return err(invalid('仓库地址不能为空'));
    const branch = typeof raw.defaultBranch === 'string' ? raw.defaultBranch.trim() : '';
    const defaultBranch = branch === '' ? null : branch;
    if (defaultBranch !== null && !/^[\w./-]+$/.test(defaultBranch)) {
      return err(invalid('分支名只能有字母、数字和 . _ / -'));
    }
    const hinted = typeof raw.name === 'string' ? raw.name.trim() : '';
    const name = hinted === '' ? repoNameFromUrl(url) : hinted;
    if (!PROJECT_REPO_NAME_PATTERN.test(name)) {
      return err(invalid(`仓库名不合规：${name}（小写字母开头，只能有小写字母、数字和 -，最多 41 个字符）`));
    }
    if (seen.has(name)) return err(invalid(`仓库名重复：${name}`));
    seen.add(name);
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    repos.push({ id: id === '' ? deriveRepoId(name, url) : id, name, url, defaultBranch });
  }
  return ok(repos);
}

/** 项目的主仓库：清单第一个；老数据（只有 `repo`）按单成员派生。 */
export function primaryRepo(project: Pick<Project, 'repo' | 'repos'>): ProjectRepo | null {
  const first = project.repos[0];
  if (first !== undefined) return first;
  const legacy = project.repo;
  if (legacy === null) return null;
  const name = repoNameFromUrl(legacy.url);
  return { id: deriveRepoId(name, legacy.url), name, url: legacy.url, defaultBranch: legacy.defaultBranch };
}

/** 同时写 `repos` 与过渡期的 `repo`，保证 `repo === repos[0] ?? null`。 */
export function withProjectRepos(project: Project, repos: readonly ProjectRepo[]): Project {
  const primary = repos[0] ?? null;
  return { ...project, repos, repo: primary === null ? null : { url: primary.url, defaultBranch: primary.defaultBranch } };
}

/** 建好 worktree 后自动跑的准备命令（docs/design/worktree.md §3）。 */
export interface ProjectSetup {
  /** 例：npm ci && npm run db:migrate。只来自项目配置，不接受每次运行时由客户端传。 */
  readonly command: string;
  /** true = 阻塞 agent 启动，直到命令退出；false = 后台跑。 */
  readonly waitForSetup: boolean;
  /** 30..1800 秒，默认 600。 */
  readonly timeoutSeconds: number;
}

/** 项目级 worktree 配置：新任务默认档位 + 准备命令。 */
export interface ProjectWorktree {
  readonly mode: 'shared' | 'isolated';
  readonly setup: ProjectSetup | null;
}

export const PROJECT_SETUP_COMMAND_MAX = 4000;
export const PROJECT_SETUP_TIMEOUT_DEFAULT = 600;
export const PROJECT_SETUP_TIMEOUT_MIN = 30;
export const PROJECT_SETUP_TIMEOUT_MAX = 1800;

/**
 * 校验并规范化项目级 worktree 配置（PATCH /api/projects/:id 的 worktree 字段）。
 * - mode 只认 shared / isolated；
 * - command trim 后为空 = 不跑准备命令（setup: null）；
 * - timeoutSeconds 缺省 600，范围 30..1800；
 * - waitForSetup 只有明确的 true 才算 true。
 */
export function normalizeWorktree(input: unknown): Result<ProjectWorktree | null, DomainError> {
  if (input === null || input === undefined) return ok(null);
  if (typeof input !== 'object') return err(invalid('工作空间配置应该是一个对象'));
  const raw = input as Record<string, unknown>;
  const mode = raw.mode;
  if (mode !== 'shared' && mode !== 'isolated') {
    return err(invalid('默认工作空间档位只能是 shared（共用长期空间）或 isolated（隔离 worktree）'));
  }
  const setupInput = raw.setup;
  if (setupInput === null || setupInput === undefined) return ok({ mode, setup: null });
  if (typeof setupInput !== 'object') return err(invalid('准备命令配置应该是一个对象'));
  const setupRaw = setupInput as Record<string, unknown>;
  const command = typeof setupRaw.command === 'string' ? setupRaw.command.trim() : '';
  if (command.length > PROJECT_SETUP_COMMAND_MAX) {
    return err(invalid(`准备命令太长了（最多 ${PROJECT_SETUP_COMMAND_MAX} 字）`));
  }
  if (command === '') return ok({ mode, setup: null });
  const timeoutRaw = setupRaw.timeoutSeconds;
  const timeoutSeconds =
    typeof timeoutRaw === 'number' && Number.isFinite(timeoutRaw) ? Math.trunc(timeoutRaw) : PROJECT_SETUP_TIMEOUT_DEFAULT;
  if (timeoutSeconds < PROJECT_SETUP_TIMEOUT_MIN || timeoutSeconds > PROJECT_SETUP_TIMEOUT_MAX) {
    return err(invalid(`准备超时要在 ${PROJECT_SETUP_TIMEOUT_MIN}～${PROJECT_SETUP_TIMEOUT_MAX} 秒之间`));
  }
  return ok({ mode, setup: { command, waitForSetup: setupRaw.waitForSetup === true, timeoutSeconds } });
}

/** 认得出的仓库地址：https / ssh / git@host:path / file:// / 本机绝对路径。只做形状检查，能不能拉由那台机器的 git 说了算。 */
export function parseRepo(url: string | null | undefined, branch?: string | null): Result<ProjectRepoLink | null, DomainError> {
  const trimmed = url?.trim() ?? '';
  if (trimmed === '') return ok(null);
  if (!/^(https?:\/\/|ssh:\/\/|git:\/\/|file:\/\/|[\w.-]+@[\w.-]+:|\/)/.test(trimmed) || /\s/.test(trimmed)) {
    return err(invalid('仓库地址看起来不对：用 https://…、git@host:… 或本机绝对路径'));
  }
  const name = branch?.trim() || null;
  if (name !== null && !/^[\w./-]+$/.test(name)) return err(invalid('分支名只能有字母、数字和 . _ / -'));
  return ok({ url: trimmed, defaultBranch: name });
}

/** 一条会话真正干活的地方：哪台机器（null = Server 本机的文件系统）+ 哪个目录。 */
export interface Location {
  readonly workerId: string | null;
  readonly root: string;
}

export interface CreateProjectInput {
  readonly name: string;
  readonly now: number;
  readonly id?: ProjectId;
  readonly repo?: ProjectRepoLink | null;
  /** 已规范化的仓库清单（优先于 `repo`）；不传则按 `repo` 派生单成员。 */
  readonly repos?: readonly ProjectRepo[] | null;
  readonly description?: string | null;
  readonly worktree?: ProjectWorktree | null;
  readonly teamId?: string | null;
  readonly createdBy?: string | null;
}

export function createProject(input: CreateProjectInput): Result<Project, DomainError> {
  const name = input.name.trim();
  if (!name) return err(invalid('项目名称不能为空'));
  const repos = input.repos ?? (input.repo ? [primaryRepo({ repo: input.repo, repos: [] })!] : []);
  const primary = repos[0] ?? null;
  return ok({
    id: input.id ?? newProjectId(),
    name,
    repo: primary === null ? null : { url: primary.url, defaultBranch: primary.defaultBranch },
    repos,
    description: input.description ?? null,
    worktree: input.worktree ?? null,
    createdAt: input.now,
    teamId: input.teamId ?? null,
    createdBy: input.createdBy ?? null,
    members: [],
    deletedAt: null
  });
}
