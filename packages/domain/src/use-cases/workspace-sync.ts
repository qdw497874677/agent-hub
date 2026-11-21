import type { Subject } from '../access.ts';
import { asProjectId, asWorkspaceId } from '../ids.ts';
import type { DomainError } from '../errors.ts';
import { invalid, notFound } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import type { Workspace } from '../workspace.ts';
import type { Deps } from './deps.ts';
import { authorizeProject } from './authorization.ts';
import { sameRepoUrl } from '../repo-url.ts';

export { sameRepoUrl } from '../repo-url.ts';

export interface WorkspaceRepoPlacement {
  readonly name: string;
  readonly path: string;
}

export interface WorkspaceRepoFailure {
  readonly name: string;
  readonly message: string;
}

export interface SyncWorkspaceResult {
  readonly workspace: Workspace;
  /** 这次新克隆的仓库。 */
  readonly added: readonly WorkspaceRepoPlacement[];
  /** 本来就在的（含工作空间自己那个仓库）。 */
  readonly present: readonly WorkspaceRepoPlacement[];
  /** 有意跳过的，带原因（给调用方解释用）。 */
  readonly skipped: readonly { readonly name: string; readonly reason: string }[];
  /** 试了但失败的（地址错、没权限、网络不通…）：不影响其它仓库，调用方可以只重试这些。 */
  readonly failed: readonly WorkspaceRepoFailure[];
}

/**
 * 查看已有（单仓）工作空间里，项目清单中的仓库是否已经在场。
 *
 * 只看工作空间自己登记的目录：比对它的 origin 和项目仓库是不是同一个。
 * 多仓项目不再把缺的仓库克隆到工作空间的同级目录：那些目录不会登记进 Workspace 表，
 * 也不走组合工作空间（agent-hub-groups）的路径约定，容易写成「未登记的兄弟目录」。
 * 多个仓库请新建组合工作空间。已有的同级目录不动，单仓工作空间保持原样。
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
    return ok({ workspace, added: [], present: [], skipped: [], failed: [] });
  }
  // 多仓：拒绝在长期单仓工作空间旁边克隆未登记的兄弟目录。请用组合工作空间。
  if (repos.length > 1) {
    return err(invalid('这个项目绑定了多个仓库：请新建组合工作空间来一起用，不要把仓库克隆到工作空间的同级目录'));
  }
  const workerId = workspace.workerId;
  if (workerId === null) return err(invalid('这个工作空间和 hub 同机（没有 workerId），暂不支持同步'));
  const git = deps.gateway.git(workerId);

  // 只检查登记的这个目录本身。不列上级目录、不碰任何同级目录（可能是别的项目）。
  const inspected = await git.inspect(workspace.path);
  if (!inspected.ok) return inspected;

  const repo = repos[0]!;
  const present: WorkspaceRepoPlacement[] = [];
  const skipped: { name: string; reason: string }[] = [];
  if (!inspected.value.exists) {
    skipped.push({ name: repo.name, reason: '工作空间的目录不存在，没有动任何目录；多个仓库请新建组合工作空间' });
  } else if (!inspected.value.isGit) {
    skipped.push({ name: repo.name, reason: '工作空间目录不是 git 仓库，没有动它' });
  } else if (inspected.value.remoteUrl === null) {
    skipped.push({ name: repo.name, reason: '工作空间目录没有 origin，无法确认仓库来源；多个仓库请新建组合工作空间' });
  } else if (!sameRepoUrl(inspected.value.remoteUrl, repo.url)) {
    skipped.push({ name: repo.name, reason: '工作空间目录的 origin 和项目仓库对不上，没有动任何目录；多个仓库请新建组合工作空间' });
  } else {
    present.push({ name: repo.name, path: workspace.path });
  }
  return ok({ workspace, added: [], present, skipped, failed: [] });
}
