import type { Project } from '../project.ts';
import { isUsable, newWorkspace, type Workspace } from '../workspace.ts';
import { asProjectId, asTaskId, newId } from '../ids.ts';
import type { DomainError } from '../errors.ts';
import { invalid, notFound } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import type { Deps } from './deps.ts';
import { createDirectory, gitOn, parentOf, resolveMachine, rootsOf, type Machine } from './machine-dirs.ts';
import { MANAGED_DIR } from '../directories.ts';
import { prepareLongLivedWorkspaceUseCase } from './workspaces.ts';

/** 分支和目录名里用的短 slug：只留 ascii 字母数字，中文标题退回 task。 */
export function branchSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  return slug === '' ? 'task' : slug;
}

/** 任务分支名 `agent-hub/<slug>-<短 id>`（§10 已定）。 */
export function taskBranch(title: string, shortId: string): string {
  return `agent-hub/${branchSlug(title)}-${shortId}`;
}

const shortId = (): string => newId().replace(/-/g, '').slice(0, 4);

export interface PrepareTemporaryCommand {
  readonly projectId: string;
  readonly taskId: string;
  readonly workerId: string | null;
  readonly home: string;
  /** 沿用这个已有分支（换个地方继续），不新开 `agent-hub/…`。只对 git 项目有意义。 */
  readonly branch?: string | null;
  /** 新分支从哪儿长（换个地方继续到同一台机器：从刚推送的 WIP 分支长）。 */
  readonly base?: string | null;
}

/**
 * 新建临时工作空间（§4「临时」两项）：
 * - 这台机器上有这个项目的 git 长期工作空间（或项目绑了仓库，先 clone 一个）→ 在它旁边的 `.worktrees/` 下
 *   开 worktree，新分支 `agent-hub/<slug>-<短 id>`（source worktree）；
 * - 否则（非 git 项目）→ 新建空目录 `<roots[0]>/agent-hub-workspaces/.tmp/<slug>-<短 id>`（source created）。
 * 数量不限（§10 第 5 条），提示由界面给。
 */
export async function prepareTemporaryWorkspaceUseCase(
  deps: Pick<Deps, 'fs' | 'git' | 'gateway' | 'now' | 'projects' | 'tasks' | 'workspaces'>,
  command: PrepareTemporaryCommand
): Promise<Result<Workspace, DomainError>> {
  const project = await deps.projects.byId(asProjectId(command.projectId));
  if (!project) return err(notFound('项目不存在'));
  const task = await deps.tasks.byId(asTaskId(command.taskId));
  if (!task || task.projectId !== project.id) return err(notFound('任务不存在'));
  const resolved = await resolveMachine(deps, command.workerId);
  if (!resolved.ok) return resolved;
  const machine = resolved.value;

  const id = shortId();
  const name = `${branchSlug(task.title)}-${id}`;
  const base = await gitBase(deps, project, machine, command);
  if (!base.ok) return base;

  let path: string;
  let branch: string | null = null;
  if (base.value) {
    const repoParent = parentOf(base.value.path) ?? '/';
    const repoName = base.value.path.split('/').filter(Boolean).at(-1) ?? 'repo';
    const made = await gitOn(deps, machine.route).addWorktree({
      repoPath: base.value.path,
      path: `${repoParent === '/' ? '' : repoParent}/.worktrees/${repoName}/${name}`,
      branch: command.branch ?? taskBranch(task.title, id),
      base: command.base ?? project.repo?.defaultBranch ?? base.value.branch,
      ...(command.branch ? { existing: true } : {})
    });
    if (!made.ok) return made;
    path = made.value.path;
    branch = made.value.branch;
  } else {
    const roots = await rootsOf(deps, machine.route, command.workerId, command.home);
    const root = roots[0];
    if (root === undefined) return err(invalid('这台机器没有可以新建目录的位置'));
    let parent = root;
    for (const segment of [MANAGED_DIR, '.tmp']) {
      const made = await createDirectory(deps, { workerId: machine.workerId, parent, name: segment, home: command.home });
      if (!made.ok) return made;
      parent = made.value.path;
    }
    const made = await createDirectory(deps, { workerId: machine.workerId, parent, name, home: command.home });
    if (!made.ok) return made;
    path = made.value.path;
  }

  const created = newWorkspace({
    projectId: project.id,
    workerId: machine.workerId,
    path,
    kind: 'temporary',
    source: base.value ? 'worktree' : 'created',
    ownerTaskId: task.id,
    baseWorkspaceId: base.value?.id ?? null,
    branch,
    isGit: base.value !== null,
    now: deps.now()
  });
  if (!created.ok) return created;
  await deps.workspaces.save(created.value);
  return ok(created.value);
}

/** worktree 从哪个长期工作空间长：这台机器上最近建的 git 长期工作空间；没有但项目有仓库就先 clone 一个。 */
async function gitBase(
  deps: Pick<Deps, 'fs' | 'git' | 'gateway' | 'now' | 'projects' | 'workspaces'>,
  project: Project,
  machine: Machine,
  command: PrepareTemporaryCommand
): Promise<Result<Workspace | null, DomainError>> {
  const candidates = (await deps.workspaces.byProject(project.id))
    .filter((workspace) => workspace.kind === 'long_lived' && isUsable(workspace) && workspace.workerId === machine.workerId)
    .sort((a, b) => b.createdAt - a.createdAt);
  const known = candidates.find((workspace) => workspace.isGit === true);
  if (known) return ok(known);
  // 老登记没探测过：现在问一下
  const git = gitOn(deps, machine.route);
  for (const workspace of candidates.filter((candidate) => candidate.isGit === null)) {
    const inspected = await git.inspect(workspace.path);
    if (!inspected.ok || !inspected.value.isGit) continue;
    const updated = { ...workspace, isGit: true, branch: inspected.value.branch, updatedAt: deps.now() };
    await deps.workspaces.save(updated);
    return ok(updated);
  }
  if (!project.repo) return ok(null);
  const cloned = await prepareLongLivedWorkspaceUseCase(deps, {
    projectId: project.id,
    workerId: command.workerId,
    plan: { mode: 'create' },
    home: command.home
  });
  return cloned.ok ? ok(cloned.value) : cloned;
}
