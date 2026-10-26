import { workspaceFor, type Location, type Project } from '../project.ts';
import type { Session } from '../session.ts';
import { isUsable, newWorkspace, samePlace, type Workspace } from '../workspace.ts';
import type { ProjectId } from '../ids.ts';
import { asProjectId } from '../ids.ts';
import type { DomainError } from '../errors.ts';
import { notFound } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import type { Deps } from './deps.ts';

/**
 * 一条会话（或「还没有会话」时的项目本身）实际在哪个目录干活。
 * 有工作空间就听工作空间的；迁移前的老会话没有，就按项目目录推算（与以前完全一样）。
 */
export async function locationOf(
  deps: Pick<Deps, 'workspaces'>,
  project: Project,
  session: Pick<Session, 'workerId' | 'workspaceId'> | null
): Promise<Location> {
  if (session?.workspaceId) {
    const workspace = await deps.workspaces.byId(session.workspaceId);
    if (workspace && workspace.state !== 'removed') return { workerId: workspace.workerId, root: workspace.path };
  }
  return workspaceFor(project, session?.workerId ?? null);
}

/**
 * 「项目目录」对应的长期工作空间：落到哪台机器就用哪台登记过的目录。
 * 迁移会把老数据全登记好；这里兜底，碰到没登记的（迁移后才映射的目录）就补登一条 linked。
 */
export async function linkedWorkspaceFor(
  deps: Pick<Deps, 'workspaces' | 'now'>,
  project: Project,
  workerId: string | null
): Promise<Workspace | null> {
  const place = workspaceFor(project, workerId);
  if (!place.root.startsWith('/')) return null; // 没有目录的新项目：只能在运行面板里选工作空间
  const existing = (await deps.workspaces.byProject(project.id)).find(
    (workspace) => workspace.kind === 'long_lived' && isUsable(workspace) && samePlace(workspace, { workerId: place.workerId, path: place.root })
  );
  if (existing) return existing;
  const created = newWorkspace({
    projectId: project.id,
    workerId: place.workerId,
    path: place.root,
    kind: 'long_lived',
    source: 'linked',
    now: deps.now()
  });
  if (!created.ok) return null;
  await deps.workspaces.save(created.value);
  return created.value;
}

/** 项目名下还在的工作空间（不含已删除的），长期在前、临时在后，各自按新旧排。 */
export async function listWorkspacesUseCase(
  deps: Pick<Deps, 'projects' | 'workspaces'>,
  projectId: string
): Promise<Result<Workspace[], DomainError>> {
  const id: ProjectId = asProjectId(projectId);
  if (!(await deps.projects.byId(id))) return err(notFound('项目不存在'));
  const all = await deps.workspaces.byProject(id);
  const rank = (workspace: Workspace): number => (workspace.kind === 'long_lived' ? 0 : 1);
  return ok(
    all
      .filter((workspace) => workspace.state !== 'removed')
      .sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt)
  );
}
