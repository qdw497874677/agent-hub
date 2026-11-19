import type { ProjectRepo } from '@agent-hub/domain';

/** 出站仓库形状：**没有 `tokenSecret`**，只有「配没配令牌」这个布尔，以及未配置时的提示。 */
export const REPO_TOKEN_HINT =
  '未配置仓库令牌。HTTPS 推送请用 project_repos 写入 credential（只写不回，按仓库存在密钥箱 repo-git:<repoId>）；SSH 远程则依赖机器上的密钥。';

export type ProjectRepoDto = Omit<ProjectRepo, 'tokenSecret'> & {
  readonly hasToken: boolean;
  readonly tokenHint?: string;
};

type WithRepos = { readonly repos: readonly ProjectRepo[] };

/**
 * 项目对象的出站投影（HTTP 响应用的唯一出口）。
 * 令牌名和明文都不出 server：仓库上的 `tokenSecret` 换成 `hasToken`。
 * 别的字段原样带过去（`ProjectSummary` 的 taskCount 之类）。
 */
export function projectDto<T extends WithRepos>(
  project: T
): Omit<T, 'repos'> & { readonly repos: ProjectRepoDto[]; readonly gitTokenHint?: string } {
  const { repos, ...rest } = project;
  const mapped: ProjectRepoDto[] = repos.map(({ tokenSecret, ...repo }) => {
    const hasToken = Boolean(tokenSecret);
    return hasToken ? { ...repo, hasToken } : { ...repo, hasToken, tokenHint: REPO_TOKEN_HINT };
  });
  const missing = mapped.some((repo) => !repo.hasToken);
  return {
    ...rest,
    repos: mapped,
    ...(missing ? { gitTokenHint: REPO_TOKEN_HINT } : {})
  } as Omit<T, 'repos'> & { readonly repos: ProjectRepoDto[]; readonly gitTokenHint?: string };
}
