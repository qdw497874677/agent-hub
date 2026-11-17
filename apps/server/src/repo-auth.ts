import { isHttpRepoUrl, type GitAuth, type ProjectRepository, type SecretVault, type WorkspaceRepository } from '@agent-hub/domain';

/**
 * 项目仓库的 HTTPS 令牌解析（私有 GitLab / Gitea / 自建 HTTPS 仓库）。
 *
 * 令牌以 `repo-git:<repoId>` 存在密钥箱里，项目仓库上只记这个名字（`ProjectRepo.tokenSecret`）。
 * 这里的出口只有 `GitAuth`（一个 `Authorization: Basic …` 头）：
 * **不打印、不写审计 detail、不回 HTTP**；地址不是 http(s) 就一律返回 null（SSH / 本地路径走机器自己的 key / agent）。
 */
export interface RepoAuthDeps {
  readonly projects: Pick<ProjectRepository, 'byId' | 'list'>;
  /** 按路径反查要用工作空间登记（Workspace.repoUrl）；不给 = 只支持按 URL。 */
  readonly workspaces?: Pick<WorkspaceRepository, 'onMachine'>;
  readonly secrets: Pick<SecretVault, 'reveal'>;
}

/** 明文令牌 → git 的 `Authorization` 头。用户名固定 x-access-token（GitLab / Gitea / GitHub 都认这种 PAT）。 */
export function authHeaderFor(token: string): GitAuth {
  return { header: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` };
}

/** 拿到密钥名 → 解出明文 → 头。密钥箱里没有这条（被清掉了）= null。 */
async function reveal(deps: RepoAuthDeps, name: string | null | undefined): Promise<GitAuth | null> {
  if (!name) return null;
  const value = (await deps.secrets.reveal([name]))[name];
  return value ? authHeaderFor(value) : null;
}

/**
 * 按仓库地址找：项目清单里 url 相等的那个仓库，配了令牌就解出来。
 * `projectId` 给了就先只看这个项目（保存 / 检查时就是它），找不到再全量找。
 * `workerId` 只作语义说明（令牌是项目级的，同一 URL 在哪台机器上都能用）。
 */
export async function repoAuthForUrl(
  deps: RepoAuthDeps,
  _workerId: string | null,
  url: string,
  projectId?: string | null
): Promise<GitAuth | null> {
  if (!isHttpRepoUrl(url)) return null;
  const target = url.trim();
  if (projectId) {
    const project = await deps.projects.byId(projectId as never);
    const hit = project?.repos.find((repo) => repo.url === target && repo.tokenSecret);
    if (hit) return reveal(deps, hit.tokenSecret);
  }
  for (const project of await deps.projects.list()) {
    const hit = project.repos.find((repo) => repo.url === target && repo.tokenSecret);
    if (hit) return reveal(deps, hit.tokenSecret);
  }
  return null;
}

/**
 * 按工作空间路径找：`workspaces.onMachine(workerId)` 里最长的那个「路径本身或它的祖先」，
 * 用它的 `repoUrl` 反查项目仓库。组合工作空间成员各自登记过，所以成员路径也命中。
 */
export async function repoAuthForPath(deps: RepoAuthDeps, workerId: string | null, path: string): Promise<GitAuth | null> {
  if (!deps.workspaces) return null;
  const target = path.trim();
  if (target === '') return null;
  const rows = await deps.workspaces.onMachine(workerId);
  const match = rows
    .filter((workspace) => typeof workspace.repoUrl === 'string' && isHttpRepoUrl(workspace.repoUrl))
    .filter((workspace) => target === workspace.path || target.startsWith(`${workspace.path.replace(/\/+$/, '')}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (!match?.repoUrl) return null;
  return repoAuthForUrl(deps, workerId, match.repoUrl, match.projectId);
}

/** 把上面两个函数打成 domain 的 `RepoAuthPort`，挂到 `Deps.repoAuth` 上给用例用。 */
export function createRepoAuth(deps: RepoAuthDeps): {
  forUrl(workerId: string | null, url: string): Promise<GitAuth | null>;
  forPath(workerId: string | null, path: string): Promise<GitAuth | null>;
} {
  return {
    forUrl: (workerId, url) => repoAuthForUrl(deps, workerId, url),
    forPath: (workerId, path) => repoAuthForPath(deps, workerId, path)
  };
}

/** 检查 / 保存接口里显式传来的明文令牌（`credential`）：非空才成头，空串 / 省略 = null。 */
export function repoAuthFromCredential(credential: string | null | undefined): GitAuth | null {
  const token = typeof credential === 'string' ? credential.trim() : '';
  return token === '' ? null : authHeaderFor(token);
}
