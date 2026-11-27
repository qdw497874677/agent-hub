import { normalizeDefaultAgent, type AgentRef } from './agent-ref.ts';
import type { ProjectId } from './ids.ts';
import { newProjectId } from './ids.ts';
import { normalizeAssetSetIds } from './asset-set.ts';
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
  /** 项目绑定的仓库清单（docs/design/multi-repo.md §11.2）：0..8，空 = 不绑仓库。 */
  readonly repos: readonly ProjectRepo[];
  /**
   * 组合会话的主仓库（必须是 repos 里的一个）。null / 省略 = 没指定，不出现组合会话。
   * 单仓行为仍看 repos / 过渡期的 repo，不依赖这一项。
   */
  readonly primaryRepoId?: string | null;
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
  /**
   * 项目声明的检查命令（issue #216 P1）：例如 `npm run typecheck`、`npm test`，由 `run.checks` 工具读取后逐条执行。
   * 最多 `CHECK_COMMANDS_MAX` 条，每条最长 `CHECK_COMMAND_MAX` 字；空数组 = 没配。
   */
  readonly checks: readonly string[];
  /** 项目默认带上的资产组合（团队级），按顺序展开；空数组 = 不带。 */
  readonly assetSetIds: readonly string[];
  /**
   * 项目的默认 Agent（runtime + 模型 + 启动选项，含思考强度）。建会话没点名 Agent 时用它，
   * 任务上的默认再覆盖它；会话里显式选的永远优先。null = 没配。
   */
  readonly defaultAgent?: AgentRef | null;
  /**
   * 克隆 / 建 worktree 时要不要递归初始化子模块（默认 off）。
   * 省略或 'off' = 不拉子模块；'recursive' = `git submodule update --init --recursive`。
   * 只影响之后新建的 checkout，已有工作空间不改。
   */
  readonly submodules?: 'off' | 'recursive';
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

/** 项目检查命令最多几条（issue #216 P1）。 */
export const CHECK_COMMANDS_MAX = 5;

/** 单条检查命令最长多少字（issue #216 P1）。 */
export const CHECK_COMMAND_MAX = 300;

/**
 * 校验并规范化项目的检查命令（PATCH /api/projects/:id 的 checks 字段，issue #216 P1）。
 * - 只接受字符串数组；空数组合法（= 没配）；
 * - 逐条 trim，空串丢弃；非字符串元素丢弃（手改过的库不该让项目读不出来）；
 * - 一条命令占一行：含换行直接报错；
 * - 单条最多 `CHECK_COMMAND_MAX` 字，总共最多 `CHECK_COMMANDS_MAX` 条。
 */
export function normalizeChecks(value: unknown): Result<readonly string[], DomainError> {
  if (!Array.isArray(value)) return err(invalid('检查命令要给一个字符串数组'));
  const checks: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const command = raw.trim();
    if (command === '') continue;
    // 检查的是原始值：`npm test\r` 这种末尾带回车的也要拦下来（trim 会把它吃掉）。
    if (raw.includes('\n') || raw.includes('\r')) return err(invalid('检查命令不能换行：一条命令占一行'));
    if (command.length > CHECK_COMMAND_MAX) {
      return err(invalid(`检查命令太长了（一条最多 ${CHECK_COMMAND_MAX} 字）`));
    }
    checks.push(command);
  }
  if (checks.length > CHECK_COMMANDS_MAX) return err(invalid(`检查命令最多 ${CHECK_COMMANDS_MAX} 条`));
  return ok(checks);
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
  /**
   * HTTPS 令牌在密钥箱里的名字（`repo-git:<projectId>:<repoId>`），**只记名字，不存明文**。
   * 省略 / null = 这个仓库不额外带令牌（SSH 走机器自己的 key/agent）。绝不进 HTTP DTO。
   *
   * 旧数据可能还是单段的 `repo-git:<repoId>`。那个键是按 (name, url) 派生的 repoId 拼的，
   * 两个项目绑同一个仓库时会撞在一起，归属不明确：读的时候不认，也不会自动删，
   * 用户需要重新输入一次 credential（见 use-cases/projects.ts）。
   */
  readonly tokenSecret?: string | null;
}

/** 项目仓库令牌在密钥箱里的前缀：内部密钥，跟着仓库清单走，不能从密钥接口单独删。 */
export const REPO_TOKEN_PREFIX = 'repo-git:';

/**
 * 仓库令牌的规范密钥箱键：`repo-git:<projectId>:<repoId>`。
 *
 * `projectId` 与 `repoId` 都是不可变的（仓库改名 / 换地址都不变），所以两个项目
 * 即使绑同名同地址的仓库，也各自落在不同的键上。
 */
export const repoTokenKey = (projectId: string, repoId: string): string => `${REPO_TOKEN_PREFIX}${projectId}:${repoId}`;

/** 旧的单段键 `repo-git:<repoId>`。只用于识别历史数据，不再写入。 */
export const legacyRepoTokenKey = (repoId: string): string => `${REPO_TOKEN_PREFIX}${repoId}`;

export interface RepoTokenName {
  /** 旧格式为 null：单凭键名判断不出属于哪个项目。 */
  readonly projectId: string | null;
  readonly repoId: string;
  /** true = 旧格式 `repo-git:<repoId>`，归属不明确，不能读也不能删。 */
  readonly legacy: boolean;
}

/** 解析仓库令牌键；不是仓库令牌或格式不完整返回 null。 */
export function parseRepoTokenName(name: string): RepoTokenName | null {
  if (!name.startsWith(REPO_TOKEN_PREFIX)) return null;
  const rest = name.slice(REPO_TOKEN_PREFIX.length);
  const separator = rest.indexOf(':');
  if (separator === -1) return rest === '' ? null : { projectId: null, repoId: rest, legacy: true };
  const projectId = rest.slice(0, separator);
  const repoId = rest.slice(separator + 1);
  if (projectId === '' || repoId === '' || repoId.includes(':')) return null;
  return { projectId, repoId, legacy: false };
}

/**
 * 只认这个项目 + 这个仓库自己的规范键；旧格式、别的项目的键、调用方随便写的名字
 * 一律 false。查找 / 删除令牌前必须过这一关。
 */
export function isCanonicalRepoTokenKey(projectId: string, repoId: string, name: string | null | undefined): name is string {
  return name === repoTokenKey(projectId, repoId);
}

/** 反过来认一个密钥名是不是仓库令牌；是就拿到 repoId（不判断归属）。 */
export function repoIdOfTokenName(name: string): string | null {
  return parseRepoTokenName(name)?.repoId ?? null;
}

/** 只有 http(s) 仓库才可能用令牌；SSH / git:// / 本地路径一律让 git 用机器上的凭据。 */
export function isHttpRepoUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

/**
 * 只有在 HTTPS 上才允许附带仓库令牌。
 *
 * 明文 http 会把 Authorization 头裸露在同网段；`sameRepoUrl` 又故意忽略 scheme，
 * 所以调用方必须自己对「目标地址」和「配置地址」都做这一层判断。
 */
export function isHttpsRepoUrl(url: string): boolean {
  return /^https:\/\//i.test(url.trim());
}

/**
 * 仓库地址里是不是直接带了凭据。
 *
 * 令牌必须走项目仓库的 `credential`（只写不回，落在密钥箱里）；写进 URL 会被
 * 持久化、回显、进日志，`sameRepoUrl` 又故意忽略 userinfo，不能当凭据用。
 * HTTP(S) 的用户名也可能是令牌；SSH 的用户名允许，密码不允许。
 */
export function repoUrlHasUserInfo(url: string): boolean {
  const trimmed = url.trim();
  if (!/^(?:https?|ssh):\/\//i.test(trimmed)) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.password !== '' || (isHttpRepoUrl(trimmed) && parsed.username !== '');
  } catch {
    return true;
  }
}

/** 一个项目最多绑多少个仓库（组合工作空间的成员上限）。 */
export const PROJECT_REPOS_MAX = 8;

/** 仓库名（= 子目录名）的合法形状。 */
export const PROJECT_REPO_NAME_PATTERN = /^[a-z][a-z0-9-]{0,40}$/;

/** 克隆 / worktree 时的子模块策略：默认关闭，打开则递归 init/update。 */
export type ProjectSubmodules = 'off' | 'recursive';

/** 缺省或非法值都当成 off（老数据没有这一列）。 */
export function projectSubmodules(project: Pick<Project, 'submodules'> | { readonly submodules?: unknown }): ProjectSubmodules {
  return project.submodules === 'recursive' ? 'recursive' : 'off';
}

/** 传给 git clone / worktree 的开关。 */
export function recurseSubmodules(project: Pick<Project, 'submodules'> | { readonly submodules?: unknown }): boolean {
  return projectSubmodules(project) === 'recursive';
}

export function normalizeSubmodules(value: unknown): Result<ProjectSubmodules, DomainError> {
  if (value === null || value === undefined || value === '') return ok('off');
  if (value === 'off' || value === 'recursive') return ok(value);
  return err(invalid('子模块只能是 off 或 recursive'));
}


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

export interface NormalizeReposOptions {
  /**
   * 是否接受输入里带的 `tokenSecret`。默认 true：storage 还原持久化数据要用。
   * 处理用户请求时必须传 false —— 密钥名只能由用例按 (projectId, repoId) 生成，
   * 不能信任调用方塞进来的引用（否则可以指向别人的令牌）。
   */
  readonly acceptTokenSecret?: boolean;
  /** Read old records without silently replacing a malformed repo list with the legacy single repo. Never set on writes. */
  readonly allowLegacyDuplicateIds?: boolean;
}

/**
 * 校验并规范化项目的仓库清单（PATCH /api/projects/:id 的 repos 字段）。
 * - 最多 `PROJECT_REPOS_MAX` 个；空数组合法（= 不绑仓库）；
 * - 名字缺省时从 URL 派生，给了就必须合规且项目内唯一；
 * - id 缺省时按 (name, url) 确定性生成；给了就保留（改名字不改 id），且项目内必须唯一。
 * - `tokenSecret` 默认照原样保留（storage 用），请求路径传 `acceptTokenSecret: false` 忽略。
 */
export function normalizeRepos(input: readonly Partial<ProjectRepo>[], options: NormalizeReposOptions = {}): Result<readonly ProjectRepo[], DomainError> {
  if (input.length > PROJECT_REPOS_MAX) return err(invalid(`一个项目最多 ${PROJECT_REPOS_MAX} 个仓库`));
  const seen = new Set<string>();
  const seenIds = new Set<string>();
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
    if (name === 'repos') return err(invalid('仓库名不能是 repos（组合会话里留给附加仓库目录）'));
    if (!PROJECT_REPO_NAME_PATTERN.test(name)) {
      return err(invalid(`仓库名不合规：${name}（小写字母开头，只能有小写字母、数字和 -，最多 41 个字符）`));
    }
    if (seen.has(name)) return err(invalid(`仓库名重复：${name}`));
    seen.add(name);
    const id = (typeof raw.id === 'string' ? raw.id.trim() : '') || deriveRepoId(name, url);
    if (seenIds.has(id) && !options.allowLegacyDuplicateIds) return err(invalid(`仓库 id 重复：${id}`));
    seenIds.add(id);
    // 令牌只保留密钥箱里的名字（trim 后非空才算）；空串 / 省略 = 不写这个字段。
    // 请求路径（acceptTokenSecret: false）完全忽略调用方给的名字。
    const tokenSecret =
      options.acceptTokenSecret !== false && typeof raw.tokenSecret === 'string' ? raw.tokenSecret.trim() : '';
    repos.push({
      id,
      name,
      url,
      defaultBranch,
      ...(tokenSecret === '' ? {} : { tokenSecret })
    });
  }
  return ok(repos);
}

/** 清单第一个（过渡期 `repo` 的来源）；老数据（只有 `repo`）按单成员派生。不是组合会话的主仓库。 */
export function primaryRepo(project: Pick<Project, 'repo' | 'repos'>): ProjectRepo | null {
  const first = project.repos[0];
  if (first !== undefined) return first;
  const legacy = project.repo;
  if (legacy === null) return null;
  const name = repoNameFromUrl(legacy.url);
  return { id: deriveRepoId(name, legacy.url), name, url: legacy.url, defaultBranch: legacy.defaultBranch };
}

/** 组合会话指定的主仓库；没指定或已从清单里消失则返回 null。 */
export function designatedPrimaryRepo(project: Pick<Project, 'repos' | 'primaryRepoId'>): ProjectRepo | null {
  const id = project.primaryRepoId ?? null;
  if (id === null || id === '') return null;
  return project.repos.find((repo) => repo.id === id) ?? null;
}

/** 主仓库 id：空 = 不指定；必须落在当前清单里。 */
export function normalizePrimaryRepoId(repos: readonly ProjectRepo[], value: string | null | undefined): Result<string | null, DomainError> {
  if (value === null || value === undefined || value.trim() === '') return ok(null);
  const id = value.trim();
  if (!repos.some((repo) => repo.id === id)) return err(invalid('主仓库必须是项目里的一个仓库'));
  return ok(id);
}

/** 同时写 `repos` 与过渡期的 `repo`，保证 `repo === repos[0] ?? null`。主仓库不在清单里就清掉。 */
export function withProjectRepos(project: Project, repos: readonly ProjectRepo[], primaryRepoId: string | null | undefined = project.primaryRepoId): Project {
  const first = repos[0] ?? null;
  const designated = normalizePrimaryRepoId(repos, primaryRepoId);
  return {
    ...project,
    repos,
    repo: first === null ? null : { url: first.url, defaultBranch: first.defaultBranch },
    primaryRepoId: designated.ok ? designated.value : null
  };
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
  /** 已规范化的检查命令；不传 = 没配。 */
  readonly checks?: readonly string[];
  readonly teamId?: string | null;
  readonly createdBy?: string | null;
  /** 项目默认资产组合；不传 = 空。 */
  readonly assetSetIds?: readonly string[] | null;
  /** 项目默认 Agent；不传 = 没配。 */
  readonly defaultAgent?: AgentRef | null;
  /** 子模块策略；不传 = off。 */
  readonly submodules?: ProjectSubmodules | null;
  /** 组合会话的主仓库；不传 = 不指定。 */
  readonly primaryRepoId?: string | null;
}

export function createProject(input: CreateProjectInput): Result<Project, DomainError> {
  const name = input.name.trim();
  if (!name) return err(invalid('项目名称不能为空'));
  const assetSetIds = normalizeAssetSetIds(input.assetSetIds);
  const defaultAgent = normalizeDefaultAgent(input.defaultAgent ?? null);
  if (!defaultAgent.ok) return defaultAgent;
  if (!assetSetIds.ok) return assetSetIds;
  const repos = input.repos ?? (input.repo ? [primaryRepo({ repo: input.repo, repos: [] })!] : []);
  const first = repos[0] ?? null;
  const primaryRepoId = normalizePrimaryRepoId(repos, input.primaryRepoId);
  if (!primaryRepoId.ok) return primaryRepoId;
  return ok({
    id: input.id ?? newProjectId(),
    name,
    repo: first === null ? null : { url: first.url, defaultBranch: first.defaultBranch },
    repos,
    primaryRepoId: primaryRepoId.value,
    description: input.description ?? null,
    worktree: input.worktree ?? null,
    checks: input.checks ?? [],
    assetSetIds: assetSetIds.value,
    defaultAgent: defaultAgent.value,
    ...(input.submodules === 'recursive' ? { submodules: 'recursive' as const } : {}),
    createdAt: input.now,
    teamId: input.teamId ?? null,
    createdBy: input.createdBy ?? null,
    members: [],
    deletedAt: null
  });
}
