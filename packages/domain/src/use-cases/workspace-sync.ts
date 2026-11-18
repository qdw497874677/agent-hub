import type { Subject } from '../access.ts';
import { asProjectId, asWorkspaceId } from '../ids.ts';
import type { DomainError } from '../errors.ts';
import { invalid, notFound } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import type { Workspace } from '../workspace.ts';
import type { Deps } from './deps.ts';
import { authorizeProject } from './authorization.ts';
import { parentOf } from './machine-dirs.ts';

export interface WorkspaceRepoPlacement {
  readonly name: string;
  readonly path: string;
}

export interface SyncWorkspaceResult {
  readonly workspace: Workspace;
  /** 这次新克隆的仓库。 */
  readonly added: readonly WorkspaceRepoPlacement[];
  /** 本来就在的（含工作空间自己那个仓库）。 */
  readonly present: readonly WorkspaceRepoPlacement[];
  /** 有意跳过的，带原因（给调用方解释用）。 */
  readonly skipped: readonly { readonly name: string; readonly reason: string }[];
}

/**
 * 把项目的仓库清单同步到已有工作空间（#236 多仓库补克隆）。
 *
 * 只处理「一个目录」的工作空间：缺的仓库克隆到工作空间的**同级目录** `<parent>/<name>`，
 * 和工作空间自己那份 checkout 并排；已经在的（按目录存在性判定）不重复克隆。
 * 组合工作空间（groupId）不走这里——它的成员由建组 / retry-setup 管理，避免两套登记打架。
 */
export async function syncWorkspaceReposUseCase(
  deps: Pick<Deps, 'gateway' | 'projects' | 'workspaces' | 'access' | 'repoAuth'>,
  command: { readonly workspaceId: string; readonly actor: Subject | null }
): Promise<Result<SyncWorkspaceResult, DomainError>> {
  const workspace = await deps.workspaces.byId(asWorkspaceId(command.workspaceId));
  if (!workspace) return err(notFound('工作空间不存在'));
  if (workspace.state === 'removed') return err(notFound('工作空间已移除'));
  const project = workspace.projectId ? await deps.projects.byId(asProjectId(workspace.projectId)) : null;
  if (!project) return err(notFound('工作空间不属于任何项目'));
  const allowed = await authorizeProject(deps.access, command.actor, project, 'project.update');
  if (!allowed.ok) return allowed;
  if (workspace.groupId) {
    return err(invalid('这是组合工作空间：成员由建组和「重试准备」管理，不能单独同步'));
  }
  if (!workspace.isGit) return err(invalid('这个目录不是 git 工作空间，没有可同步的仓库'));
  const repos = project.repos;
  if (repos.length === 0) {
    return ok({ workspace, added: [], present: [], skipped: [] });
  }
  const workerId = workspace.workerId;
  if (workerId === null) return err(invalid('这个工作空间和 hub 同机（没有 workerId），暂不支持同步'));
  const baseDir = parentOf(workspace.path);
  if (baseDir === null) return err(invalid('工作空间路径没有上级目录，无法确定仓库放哪'));
  const git = deps.gateway.git(workerId);
  const added: WorkspaceRepoPlacement[] = [];
  const present: WorkspaceRepoPlacement[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const repo of repos) {
    // 工作空间自己就是按这个仓库 clone 出来的：不再另找一份。
    if (workspace.repoUrl !== null && workspace.repoUrl === repo.url) {
      present.push({ name: repo.name, path: workspace.path });
      continue;
    }
    const path = `${baseDir === '/' ? '' : baseDir}/${repo.name}`;
    const inspected = await git.inspect(path);
    if (!inspected.ok) return inspected;
    if (inspected.value.exists) {
      if (!inspected.value.isGit) {
        skipped.push({ name: repo.name, reason: '同名目录存在但不是 git 仓库，没有动它' });
        continue;
      }
      present.push({ name: repo.name, path });
      continue;
    }
    const auth = (await deps.repoAuth?.forUrl(workerId, repo.url)) ?? undefined;
    const cloned = await git.clone({
      repoUrl: repo.url,
      parent: baseDir,
      name: repo.name,
      branch: repo.defaultBranch,
      ...(auth ? { auth } : {})
    });
    if (!cloned.ok) return cloned;
    added.push({ name: repo.name, path: cloned.value.path });
  }
  return ok({ workspace, added, present, skipped });
}
