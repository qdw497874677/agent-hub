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
    createdAt: input.now,
    teamId: input.teamId ?? null,
    createdBy: input.createdBy ?? null,
    members: [],
    deletedAt: null
  });
}
