import type { ProjectRepo } from '@agent-hub/domain';

/** 出站仓库形状：**没有 `tokenSecret`**，只有「配没配令牌」这个布尔。 */
export type ProjectRepoDto = Omit<ProjectRepo, 'tokenSecret'> & { readonly hasToken: boolean };

type WithRepos = { readonly repos: readonly ProjectRepo[] };

/**
 * 项目对象的出站投影（HTTP 响应用的唯一出口）。
 * 令牌名和明文都不出 server：仓库上的 `tokenSecret` 换成 `hasToken`。
 * 别的字段原样带过去（`ProjectSummary` 的 taskCount 之类）。
 */
export function projectDto<T extends WithRepos>(project: T): Omit<T, 'repos'> & { readonly repos: ProjectRepoDto[] } {
  const { repos, ...rest } = project;
  return {
    ...rest,
    repos: repos.map(({ tokenSecret, ...repo }) => ({ ...repo, hasToken: Boolean(tokenSecret) }))
  } as Omit<T, 'repos'> & { readonly repos: ProjectRepoDto[] };
}
