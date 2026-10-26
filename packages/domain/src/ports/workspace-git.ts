import type { DomainError } from '../errors.ts';
import type { Result } from '../result.ts';

/** 某个目录的 git 情况（ws.inspect）。目录不存在不是错误：exists=false。 */
export interface GitInspection {
  readonly exists: boolean;
  readonly isGit: boolean;
  /** origin 的地址；没有 origin 是 null。 */
  readonly remoteUrl: string | null;
  readonly branch: string | null;
}

/** 清理前的检查（ws.status）。非 git 目录 dirty 为 null：平台说不清里面有没有要紧的东西。 */
export interface GitStatus {
  readonly dirty: boolean | null;
  /** 未跟踪的文件数。 */
  readonly untracked: number;
  /** 只在这个分支上、别处（其它分支、远端）都没有的提交数：删了就找不回来。 */
  readonly unpushed: number;
  readonly branch: string | null;
  readonly upstream: string | null;
}

export interface CloneInput {
  readonly repoUrl: string;
  readonly parent: string;
  readonly name: string;
  readonly branch?: string | null;
}

export interface WorktreeInput {
  /** 主仓库目录（长期工作空间）。 */
  readonly repoPath: string;
  readonly path: string;
  readonly branch: string;
  /** 新分支从哪儿长出来；省略 = 主仓库当前 HEAD。远端已有同名分支时一律基于 origin/<branch>。 */
  readonly base?: string | null;
}

export type RemoveKind = 'worktree' | 'directory';

/** force：人已经二次确认过会丢掉的东西，不再检查改动。 */
export interface RemoveOptions {
  readonly force?: boolean;
}

/** 删除的结果：被拒（有改动）不是错误，原因写在 reason 里，hub 据此标 kept。 */
export type RemoveOutcome = { readonly removed: true } | { readonly removed: false; readonly reason: string };

/**
 * 工作空间的 git / 目录操作（docs/design/workspaces.md §3）。
 * 在目录所在的那台机器上执行：本机直接跑，远端 Worker 走 ws.* RPC。
 * 适配器负责 roots 边界；git 凭据用那台机器自己的，hub 不存 token。
 */
export interface WorkspaceGit {
  inspect(path: string): Promise<Result<GitInspection, DomainError>>;
  clone(input: CloneInput): Promise<Result<{ readonly path: string; readonly branch: string | null }, DomainError>>;
  addWorktree(input: WorktreeInput): Promise<Result<{ readonly path: string; readonly branch: string }, DomainError>>;
  status(path: string): Promise<Result<GitStatus, DomainError>>;
  /** worktree 用 `git worktree remove`（不 --force，分支保留）；directory 只删平台建的临时目录。删之前再查一次。 */
  remove(path: string, kind: RemoveKind, options?: RemoveOptions): Promise<Result<RemoveOutcome, DomainError>>;
}
