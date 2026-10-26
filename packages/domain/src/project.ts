import type { ProjectId } from './ids.ts';
import { newProjectId } from './ids.ts';
import { invalid, type DomainError } from './errors.ts';
import { err, ok, type Result } from './result.ts';

/** Project 是作用域容器：绑定一个本地目录，没有领域行为。见 GLOSSARY。 */
export interface Project {
  readonly id: ProjectId;
  readonly name: string;
  readonly rootPath: string;
  /** 目录在哪台 Worker 的文件系统上。null = 和 Server 同机（多机之前的老项目都是）。 */
  readonly workerId: string | null;
  /**
   * 同一份代码在别的 Worker 上的目录（workerId → 绝对路径）。
   * 只有「换台机器继续」时才会登记；会话落在哪台就用哪台的目录。
   */
  readonly directories: Readonly<Record<string, string>>;
  /** 项目的 git 仓库（可选）：新建持久工作空间时 clone 它，临时工作空间据此开分支。 */
  readonly repo: ProjectRepo | null;
  /** 自由格式的项目说明（markdown）：给人看，也原样交给 agent（task.get / 任务背景）。没写是 null。 */
  readonly description: string | null;
  readonly createdAt: number;
}

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

/** 会话落在映射过的那台 Worker 上就用那台的目录，否则用项目自己的目录。 */
export function workspaceFor(project: Project, sessionWorker: string | null): Location {
  const mapped = sessionWorker !== null && sessionWorker !== project.workerId ? project.directories[sessionWorker] : undefined;
  const ws = mapped !== undefined ? { workerId: sessionWorker, root: mapped } : { workerId: project.workerId, root: project.rootPath };
  // 没有目录的项目（W2 起允许）：root 为空串，调用方必须改走工作空间，不能把它当成 /
  if (ws.root === '') return { workerId: ws.workerId, root: '' };
  return { workerId: ws.workerId, root: ws.root.replace(/\/+$/, '') || '/' };
}

export interface CreateProjectInput {
  readonly name: string;
  readonly rootPath: string;
  /** 由 WorkspaceFS 提供：目录是否存在。领域层不做 I/O。 */
  readonly directoryExists: boolean;
  readonly now: number;
  readonly id?: ProjectId;
  readonly workerId?: string | null;
  readonly repo?: ProjectRepo | null;
  readonly description?: string | null;
}

export function createProject(input: CreateProjectInput): Result<Project, DomainError> {
  const name = input.name.trim();
  if (!name) return err(invalid('项目名称不能为空'));
  // 目录可以不给：项目只是「你在做的东西」，开始任务时再选机器和工作空间
  if (input.rootPath !== '' && !input.rootPath.startsWith('/')) return err(invalid('目录必须是绝对路径'));
  if (input.rootPath !== '' && !input.directoryExists) return err(invalid(`目录不存在：${input.rootPath}`));
  return ok({
    id: input.id ?? newProjectId(),
    name,
    rootPath: input.rootPath,
    workerId: input.workerId ?? null,
    directories: {},
    repo: input.repo ?? null,
    description: input.description ?? null,
    createdAt: input.now
  });
}
