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
  /** 当前 HEAD 提交号（ADR 0027 §3：squash 合并按「HEAD == PR 最后的 head_sha」判定）。老 Worker 不报 = undefined。 */
  readonly head?: string | null;
  /** 目录占多大（字节，清理报告用）；量不出来 / 老 Worker = undefined / null。 */
  readonly sizeBytes?: number | null;
  /** 不是 git 仓库时（dirty = null）目录里有几个文件（递归，封顶 10000）；git 仓库 / 老 Worker = undefined。 */
  readonly files?: number | null;
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
  /** true = 分支已经有了（换个地方继续沿用原分支）：直接检出它，不新开。 */
  readonly existing?: boolean;
}

/** 「先提交 WIP 并推送分支」的结果。没推上去不是错误：reason 说明为什么（没有 origin、推送被拒…）。 */
export interface SaveWipOutcome {
  readonly committed: boolean;
  readonly pushed: boolean;
  readonly branch: string | null;
  readonly reason: string | null;
}

/** 提交前看一眼（ADR 0027 §2）：分支、远端、改了哪些、diff（截断）。 */
export interface CommitPreview {
  readonly isGit: boolean;
  readonly branch: string | null;
  /** origin 的默认分支（origin/HEAD）；拿不到退回 main / master 里存在的那个；都没有 null。 */
  readonly defaultBranch: string | null;
  readonly remoteUrl: string | null;
  readonly upstream: string | null;
  /** 本地有、upstream 没有的提交数（没 upstream = 相对默认分支）。 */
  readonly ahead: number;
  readonly head: string | null;
  /** 工作区的改动（含未跟踪，showUntrackedFiles=normal）。 */
  readonly files: readonly { readonly path: string; readonly status: string }[];
  readonly patch: string;
  readonly truncated: boolean;
}

export interface CommitInput {
  readonly message: string;
  /** 操作人 hub 账号的身份（ADR 0027 D5）；committer 仍是这台机器的 git 身份。 */
  readonly authorName: string;
  readonly authorEmail: string;
}

export interface CommitOutcome {
  readonly committed: boolean;
  readonly sha: string | null;
  readonly reason: string | null;
}

export interface PushOutcome {
  readonly pushed: boolean;
  readonly branch: string | null;
  readonly reason: string | null;
}

/** Worker 上 gh CLI 建 / 查 PR（ADR 0027 D3）。gh 没装 / 没登录不是错误：ok=false + 原因。 */
export type GhRequest =
  | { readonly action: 'create'; readonly base: string; readonly head: string; readonly title: string; readonly body: string }
  | { readonly action: 'view'; readonly number: number };
export type GhOutcome =
  | { readonly ok: true; readonly pr: RemotePullRequest }
  | { readonly ok: false; readonly reason: string };

/** 托管平台上一个 PR 的状态（gh / REST 都翻成这个）。 */
export interface RemotePullRequest {
  readonly number: number;
  readonly url: string;
  readonly state: 'open' | 'closed' | 'merged';
  readonly headSha: string | null;
  readonly mergedAt: number | null;
}

export type RemoveKind = 'worktree' | 'directory';

/** force：人已经二次确认过会丢掉的东西，不再检查改动。 */
export interface RemoveOptions {
  readonly force?: boolean;
  /**
   * ADR 0027 §3：PR 已被 squash / rebase 合并时，本地提交在远端「看起来没合并」。
   * 给了这个提交号且 HEAD 正好是它 → 不把「未推送的提交」当成删除的理由（未提交 / 未跟踪仍然保护）。
   */
  readonly mergedHead?: string;
}

/** 删除的结果：被拒（有改动）不是错误，原因写在 reason 里，hub 据此标 kept。 */
export type RemoveOutcome = { readonly removed: true } | { readonly removed: false; readonly reason: string };

/** 准备命令的输入：目录、命令、超时。 */
export interface RunSetupInput {
  readonly path: string;
  readonly command: string;
  readonly timeoutMs: number;
  /** 额外注入的环境变量（AGENT_HUB_PROJECT_ROOT 等）；worker 只放行白名单里的键。 */
  readonly env?: Readonly<Record<string, string>>;
}

/** 准备命令的结果：超时也走 ok，timedOut=true + exitCode 124。 */
export interface RunSetupOutcome {
  readonly exitCode: number;
  /** 最后 8KB（已抹 `user:token@`）。 */
  readonly output: string;
  readonly timedOut: boolean;
}

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
  /** 把所有改动（含未跟踪）提交成一个 WIP 提交，再 `push -u origin <当前分支>`。 */
  saveWip(path: string, message: string): Promise<Result<SaveWipOutcome, DomainError>>;
  /** ADR 0027 §2：提交前预览（patch 截断到 maxPatchBytes）。 */
  preview(path: string, maxPatchBytes: number): Promise<Result<CommitPreview, DomainError>>;
  /** `add -A` + `commit --author`；没改动 = committed:false。 */
  commit(path: string, input: CommitInput): Promise<Result<CommitOutcome, DomainError>>;
  /** `push -u origin <当前分支>`；没 origin / 被拒 = pushed:false + 原因。 */
  push(path: string): Promise<Result<PushOutcome, DomainError>>;
  /** 用这台机器上已登录的 gh。 */
  gh(path: string, request: GhRequest): Promise<Result<GhOutcome, DomainError>>;
  /** worktree 用 `git worktree remove`（不 --force，分支保留）；directory 只删平台建的临时目录。删之前再查一次。 */
  remove(path: string, kind: RemoveKind, options?: RemoveOptions): Promise<Result<RemoveOutcome, DomainError>>;
  /**
   * 在 path 里跑项目的准备命令（docs/design/worktree.md §4）：
   * worker 用户身份、`sh -lc`、超时杀整个进程组、输出只留最后 8KB 并抹掉 `user:token@`。
   */
  runSetup(input: RunSetupInput): Promise<Result<RunSetupOutcome, DomainError>>;
}
