import type { ProjectId } from './ids.ts';
import { newProjectId } from './ids.ts';
import { invalid, type DomainError } from './errors.ts';
import { err, ok, type Result } from './result.ts';

/** Project 是「你在做的东西」：不绑机器也不绑目录，在哪干活看工作空间（docs/design/workspaces.md）。 */
export interface Project {
  readonly id: ProjectId;
  readonly name: string;
  /** 项目的 git 仓库（可选）：新建持久工作空间时 clone 它，临时工作空间据此开分支。 */
  readonly repo: ProjectRepo | null;
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

/** 空白 = 没写。 */
export function normalizeDescription(text: string | null | undefined): Result<string | null, DomainError> {
  const trimmed = text?.trim() ?? '';
  if (trimmed.length > PROJECT_DESCRIPTION_MAX) return err(invalid(`项目说明太长了（最多 ${PROJECT_DESCRIPTION_MAX} 字）`));
  return ok(trimmed === '' ? null : trimmed);
}

export interface ProjectRepo {
  readonly url: string;
  /** 省略 = 仓库自己的默认分支。 */
  readonly defaultBranch: string | null;
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
export function parseRepo(url: string | null | undefined, branch?: string | null): Result<ProjectRepo | null, DomainError> {
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
  readonly repo?: ProjectRepo | null;
  readonly description?: string | null;
  readonly worktree?: ProjectWorktree | null;
  readonly teamId?: string | null;
  readonly createdBy?: string | null;
}

export function createProject(input: CreateProjectInput): Result<Project, DomainError> {
  const name = input.name.trim();
  if (!name) return err(invalid('项目名称不能为空'));
  return ok({
    id: input.id ?? newProjectId(),
    name,
    repo: input.repo ?? null,
    description: input.description ?? null,
    worktree: input.worktree ?? null,
    createdAt: input.now,
    teamId: input.teamId ?? null,
    createdBy: input.createdBy ?? null,
    members: [],
    deletedAt: null
  });
}
