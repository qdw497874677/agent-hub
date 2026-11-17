import type { GitAuth } from './workspace-git.ts';

/**
 * 项目仓库的 HTTPS 令牌解析口（私有 GitLab / Gitea / 自建 HTTPS 仓库）。
 *
 * 只有 hub 侧实现（查项目 `repos[].tokenSecret` → 密钥箱）；domain 用例只声明自己要用。
 * 令牌本身**只以 `GitAuth` 的形式交给那台机器的 git**：不进日志、不进审计 detail、不回浏览器。
 * 没配 / 地址是 SSH 或本地路径 → 返回 null（让 git 用机器自己的 key / agent）。
 */
export interface RepoAuthPort {
  /**
   * 按仓库地址找（clone / 保存前检查）。
   * `workerId` null = hub 本机；找不到匹配的仓库或没配令牌 = null。
   */
  forUrl(workerId: string | null, url: string): Promise<GitAuth | null>;
  /**
   * 按工作空间路径找（push / save_wip / add_worktree）：用 `Workspace.repoUrl` 反查仓库。
   */
  forPath(workerId: string | null, path: string): Promise<GitAuth | null>;
}
