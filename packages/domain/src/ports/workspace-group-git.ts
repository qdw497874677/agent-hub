import type { DomainError } from '../errors.ts';
import type { Result } from '../result.ts';

/**
 * 组合工作空间在机器上的目录操作（docs/design/multi-repo.md §11.3）：
 * 建/删容器目录，以及在容器里给每个仓库开新分支 worktree。由那台 Worker 执行，
 * 受它的 WORKER_GROUPS_DIR 与 WORKER_ROOTS 双重约束。
 */
export interface WorkspaceGroupGit {
  /**
   * 建容器目录并写 `.agent-hub/group.json`：根路径由**那台机器**用它的 WORKER_GROUPS_DIR 算
   * （hub 不猜），所以只传段名。已存在 = conflict（重试时继续用已有容器）。
   */
  init(input: { readonly slug: string; readonly name: string; readonly id: string }): Promise<Result<{ readonly root: string }, DomainError>>;
  /** 只删带同样 marker 的真实目录；不存在视为已删。 */
  remove(input: { readonly root: string; readonly id: string }): Promise<Result<{ readonly removed: boolean }, DomainError>>;
  /** 在容器内路径上开一条新分支的 worktree（不走 relocate，落点只信调用方算好的路径）。 */
  newWorktree(input: {
    readonly repoPath: string;
    readonly path: string;
    readonly branch: string;
    readonly base?: string | null;
  }): Promise<Result<{ readonly path: string; readonly branch: string }, DomainError>>;
}
