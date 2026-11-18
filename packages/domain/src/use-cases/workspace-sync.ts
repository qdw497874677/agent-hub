import type { Subject } from '../access.ts';
import { asProjectId, asWorkspaceId } from '../ids.ts';
import type { DomainError } from '../errors.ts';
import { invalid, notFound } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import type { Workspace } from '../workspace.ts';
import type { WorkspaceGit } from '../ports/workspace-git.ts';
import type { Deps } from './deps.ts';
import { authorizeProject } from './authorization.ts';
import { parentOf } from './machine-dirs.ts';

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
 * 比较两个仓库地址是不是同一个（远端 / 项目清单里可能一个带令牌、一个不带，或者 .git 有无差别）。
 * 去掉 userinfo、末尾 `.git` 与斜杠，主机与路径都按小写比。
 */
export function sameRepoUrl(a: string, b: string): boolean {
  const normalize = (raw: string): string | null => {
    try {
      const url = new URL(raw.trim());
      const path = url.pathname.replace(/\/+$/, '').replace(/\.git$/i, '');
      return `${url.hostname.toLowerCase()}${path.toLowerCase()}`;
    } catch {
      return null;
    }
  };
  const left = normalize(a);
  const right = normalize(b);
  return left !== null && right !== null && left === right;
}

/**
 * 把项目的仓库清单同步到已有工作空间（#236 多仓库补克隆）。
 *
 * 只处理「一个目录」的工作空间：缺的仓库克隆到工作空间的**同级目录** `<parent>/<name>`；
 * 「在不在」按**远端地址**认（工作空间自己的目录名、仓库名都可能和清单里的 name 不一样），
 * 其次才按 `<parent>/<name>` 这个位置认。单个仓库失败不打断其它仓库，最后一起报。
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
  const workerId = workspace.workerId;
  if (workerId === null) return err(invalid('这个工作空间和 hub 同机（没有 workerId），暂不支持同步'));
  const baseDir = parentOf(workspace.path);
  if (baseDir === null) return err(invalid('工作空间路径没有上级目录，无法确定仓库放哪'));
  const git = deps.gateway.git(workerId);

  // 先看一遍同级目录 + 工作空间自己：按远端地址认领，避免「仓库目录名 != 清单里的 name」被重复克隆。
  const known = new Map<string, string | null>([[workspace.path, await remoteOf(git, workspace.path)]]);
  const listed = await deps.gateway.listDirectories(workerId, baseDir);
  if (listed.ok) {
    for (const entry of listed.value.entries) {
      known.set(entry.path, await remoteOf(git, entry.path));
    }
  }

  const added: WorkspaceRepoPlacement[] = [];
  const present: WorkspaceRepoPlacement[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const failed: WorkspaceRepoFailure[] = [];
  const claimed = new Set<string>();
  for (const repo of repos) {
    const match = [...known.entries()].find(([path, remote]) => !claimed.has(path) && remote !== null && sameRepoUrl(remote, repo.url));
    if (match) {
      claimed.add(match[0]);
      present.push({ name: repo.name, path: match[0] });
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
    const authOrNull = (await deps.repoAuth?.forUrl(workerId, repo.url)) ?? null;
    const auth = authOrNull === null ? undefined : authOrNull;
    const cloned = await git.clone({
      repoUrl: repo.url,
      parent: baseDir,
      name: repo.name,
      branch: repo.defaultBranch,
      ...(auth ? { auth } : {})
    });
    if (!cloned.ok) {
      failed.push({ name: repo.name, message: cloned.error.message });
      continue;
    }
    added.push({ name: repo.name, path: cloned.value.path });
    claimed.add(cloned.value.path);
  }
  return ok({ workspace, added, present, skipped, failed });
}

async function remoteOf(git: Pick<WorkspaceGit, 'inspect'>, path: string): Promise<string | null> {
  const inspected = await git.inspect(path);
  return inspected.ok && inspected.value.isGit ? inspected.value.remoteUrl : null;
}
