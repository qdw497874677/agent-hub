import { isHttpsRepoUrl, repoTokenKey, sameRepoUrl, type GitAuth, type ProjectRepository, type SecretVault, type WorkspaceRepository } from '@agent-hub/domain';

/**
 * 项目仓库的 HTTPS 令牌解析（私有 GitLab / Gitea / 自建 HTTPS 仓库）。
 *
 * 令牌以 `repo-git:<projectId>:<repoId>` 存在密钥箱里，项目仓库上只记这个名字（`ProjectRepo.tokenSecret`）。
 * 这里的出口只有 `GitAuth`（一个 `Authorization: Basic …` 头）：
 * **不打印、不写审计 detail、不回 HTTP**；地址不是 HTTPS 就一律返回 null
 * （明文 http 会把 Authorization 头暴露在同网段；SSH / 本地路径走机器自己的 key / agent）。
 *
 * 注意 `sameRepoUrl` 故意忽略 scheme，所以「目标地址」和「项目里登记的地址」都要各自过
 * `isHttpsRepoUrl`：只判断一边的话 `http://host/path` 会命中 `https://host/path` 的令牌。
 */
export interface RepoAuthDeps {
  readonly projects: Pick<ProjectRepository, 'byId' | 'list'>;
  /** 按路径反查要用工作空间登记（Workspace.repoUrl）；不给 = 只支持按 URL。 */
  readonly workspaces?: Pick<WorkspaceRepository, 'onMachine'>;
  readonly secrets: Pick<SecretVault, 'reveal'>;
}

/**
 * 明文令牌 → git 的 `Authorization` 头，并绑定解析时用的 HTTPS 目标地址。
 * 用户名固定 x-access-token（GitLab / Gitea / GitHub 都认这种 PAT）。
 * Worker 只在与 `url` 一致的操作目的地上使用这个头；没带 `url` 的旧令牌不会被新 Worker 使用。
 */
export function authHeaderFor(token: string, url: string): GitAuth {
  return { header: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`, url: url.trim() };
}

/** 拿到密钥名 → 解出明文 → 头（绑定到项目里登记的仓库地址）。密钥箱里没有这条（被清掉了）= null。 */
async function reveal(deps: RepoAuthDeps, name: string | null | undefined, url: string): Promise<GitAuth | null> {
  if (!name) return null;
  const value = (await deps.secrets.reveal([name]))[name];
  return value ? authHeaderFor(value, url) : null;
}

/**
 * 按仓库地址找：只看当前项目的仓库清单（#233：禁止按 URL 跨项目解出别的项目的令牌）。
 * URL 比较用 `sameRepoUrl`（忽略 .git、userinfo、大小写），但两边都必须是 HTTPS。
 * 没有 projectId 就不猜：避免「任意 URL 扫全部项目」。
 * 只认 `repo-git:<projectId>:<repoId>` 规范键：旧格式 / 别的项目的键一律当没配，用户需重新输入。
 * `workerId` 只作语义说明（令牌是项目级的，同一 URL 在哪台机器上都能用）。
 */
export async function repoAuthForUrl(
  deps: RepoAuthDeps,
  _workerId: string | null,
  url: string,
  projectId?: string | null
): Promise<GitAuth | null> {
  if (!isHttpsRepoUrl(url)) return null;
  if (!projectId) return null;
  const project = await deps.projects.byId(projectId as never);
  if (!project) return null;
  const hit = project.repos.find(
    (repo) =>
      isHttpsRepoUrl(repo.url) &&
      sameRepoUrl(repo.url, url) &&
      repo.tokenSecret === repoTokenKey(project.id, repo.id)
  );
  return hit ? reveal(deps, hit.tokenSecret, hit.url) : null;
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
    .filter((workspace) => typeof workspace.repoUrl === 'string' && isHttpsRepoUrl(workspace.repoUrl))
    .filter((workspace) => target === workspace.path || target.startsWith(`${workspace.path.replace(/\/+$/, '')}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (!match?.repoUrl) return null;
  return repoAuthForUrl(deps, workerId, match.repoUrl, match.projectId);
}

/** 把上面两个函数打成 domain 的 `RepoAuthPort`，挂到 `Deps.repoAuth` 上给用例用。 */
export function createRepoAuth(deps: RepoAuthDeps): {
  forUrl(workerId: string | null, url: string, projectId?: string | null): Promise<GitAuth | null>;
  forPath(workerId: string | null, path: string): Promise<GitAuth | null>;
} {
  return {
    forUrl: (workerId, url, projectId) => repoAuthForUrl(deps, workerId, url, projectId),
    forPath: (workerId, path) => repoAuthForPath(deps, workerId, path)
  };
}

/**
 * 检查 / 保存接口里显式传来的明文令牌（`credential`）：非空才成头，空串 / 省略 = null。
 * 必须同时给出目标地址，且只有 HTTPS 才返回：令牌不能脱离目的地单独流通。
 */
export function repoAuthFromCredential(credential: string | null | undefined, url: string): GitAuth | null {
  if (!isHttpsRepoUrl(url)) return null;
  const token = typeof credential === 'string' ? credential.trim() : '';
  return token === '' ? null : authHeaderFor(token, url);
}
