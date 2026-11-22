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

/**
 * 一次 git 网络操作要带的 HTTP 鉴权头（`Authorization: Basic …`）。
 * hub 从密钥箱解出来只交给这台机器的 git；**不进日志、不进审计、不回给浏览器**。
 */
export interface GitAuth {
  readonly header: string;
  /**
   * hub 侧解析令牌时绑定的**预期 HTTPS 仓库地址**（`repo.url` 或显式凭据的目标地址）。
   * Worker 只在这个地址与本次操作的目的地一致时才注入头；缺失 = 旧 hub 的未绑定令牌，
   * 新 Worker 一律拒绝使用（失败关闭）。字段可选只为滚动升级时的 wire 兼容。
   */
  readonly url?: string;
}

export interface CloneInput {
  readonly repoUrl: string;
  readonly parent: string;
  readonly name: string;
  readonly branch?: string | null;
  /** 私有 HTTPS 仓库的令牌；SSH / 本地路径不传。 */
  readonly auth?: GitAuth;
  /** true = 递归初始化子模块（项目开关打开时）。省略 / false = 不拉。 */
  readonly recurseSubmodules?: boolean;
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
  /** 私有 HTTPS 仓库的令牌（只在要 fetch origin 时才用得上）。 */
  readonly auth?: GitAuth;
  /** true = 建好后 `submodule update --init --recursive`。 */
  readonly recurseSubmodules?: boolean;
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
  /**
   * 受保护预览的合规标记：true = 这次结果已经按 #269 的敏感路径策略筛选过
   * （可能因为无法保证筛选而整段省略，见 notice）。旧 Worker 不返回这个字段。
   */
  readonly redactedSensitive?: boolean;
  /** 受保护预览无法安全返回内容时给人看的原因；没有省略就省略。 */
  readonly notice?: string;
  /** 工作目录占用（du）；拿不到就省略。 */
  readonly sizeBytes?: number | null;
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

/** Worker 上 gh CLI 建 / 查 / 按分支列 PR（ADR 0027 D3）。gh 没装 / 没登录不是错误：ok=false + 原因。 */
export type GhRequest =
  | { readonly action: 'create'; readonly base: string; readonly head: string; readonly title: string; readonly body: string }
  | { readonly action: 'view'; readonly number: number }
  | { readonly action: 'list'; readonly head: string; readonly repo?: string };
export type GhOutcome =
  | { readonly ok: true; readonly pr: RemotePullRequest }
  | { readonly ok: true; readonly prs: readonly RemotePullRequest[] }
  | { readonly ok: false; readonly reason: string };

/** 托管平台上一个 PR 的状态（gh / REST 都翻成这个）。 */
export interface RemotePullRequest {
  readonly number: number;
  readonly url: string;
  readonly state: 'open' | 'closed' | 'merged';
  readonly headSha: string | null;
  readonly mergedAt: number | null;
  /** PR 的目标分支；按分支列出 / 查详情都能带，拿不到（老 Worker）= undefined。 */
  readonly base?: string | null;
  /**
   * head 所在的仓库（owner/name，fork 时会和 origin 不同）。
   * 自动认领要拿它证明「PR 的 head 就是这条任务 checkout 的 origin」；老 Worker / 老响应不带。
   */
  readonly repo?: string | null;
  /** head 的分支名（`gh pr list --head` 可能带回同名分支的 fork PR）；老 Worker 不带。 */
  readonly headRef?: string | null;
  /** 是不是草稿 PR（docs/design/workspace-delegation.md step B）；老 Worker / 老响应不带。 */
  readonly draft?: boolean;
  /** base 所在的仓库（owner/name；跨 fork 建 PR 时和 origin 不同）；拿不到 = null / 不带。 */
  readonly baseRepo?: string | null;
}

/**
 * 把「已经批准的提交」作为远端分支发布（docs/design/workspace-delegation.md step B）。
 * 和 `push` 的区别：发布的是**明确批准的 SHA**，且只做快进式 ref 更新，不跟随本地分支移动。
 */
export interface PublishRefInput {
  /** 仓库根目录（主仓库或 worktree 都行，必须是 git 顶层）。 */
  readonly path: string;
  /** 要发布到的功能分支名（不带 `refs/heads/`）。 */
  readonly branch: string;
  /** 已获批准、且必须正是本地 HEAD 的完整 40 位提交号。 */
  readonly sha: string;
  /**
   * domain 记录的项目仓库地址：必须与本地 origin 的 fetch / push 目的地（按 git 解析后）完全一致。
   * 不允许 Worker 自己从本地配置推断「要发到哪」。
   */
  readonly expectedUrl: string;
  /** 这次委派记录的 base 分支（可以不是远端默认分支）；远端必须存在。 */
  readonly baseBranch: string;
  /** 目的地的 HTTPS 令牌；HTTPS origin 必填且必须绑定同一个地址。 */
  readonly auth?: GitAuth;
  /** true = 只核验远端状态，不推送。 */
  readonly verifyOnly?: boolean;
}

/** 发布结果。失败关闭（远端已有不同提交等）走 DomainError，不靠字段表达。 */
export interface PublishRefOutcome {
  readonly sha: string;
  readonly branch: string;
  /** 核验结束时远端 `refs/heads/<branch>` 就是这个提交。 */
  readonly published: boolean;
  /** 本次调用真的执行了 push（verifyOnly / 已一致 = false）。 */
  readonly pushed: boolean;
  /** 这次委派记录的 base 分支（输入原样）。 */
  readonly baseBranch: string;
  /** 记录的 base 分支在远端的提交号；不存在就拒绝，不猜。 */
  readonly baseSha: string;
  /** 远端权威默认分支（`ls-remote --symref`）；解析不到就拒绝。 */
  readonly defaultBranch: string;
  /** 发布前远端功能分支的提交号；远端没有这个分支 = null。 */
  readonly remoteSha: string | null;
  /**
   * push 抛错且事后无法用 ls-remote 确认结果（或确认结果与 push 的回报矛盾）：
   * 远端状态未经证明，调用方不能盲目重试，应先查 PR / 远端状态。
   */
  readonly uncertain: boolean;
  readonly reason: string | null;
}

/**
 * 为委派准备一个精确的 worktree（docs/design/workspace-delegation.md step A4）：
 * 从远端选中的 base 分支取当时的提交，在 Worker 算定的路径上开新分支。
 * 和 `addWorktree` 的区别：不采用已有目录 / 已有分支，不跟随本地过期 ref，也不碰源仓库的工作区。
 */
export interface PrepareDelegationWorktreeInput {
  /** 源仓库根目录（主 checkout 或 worktree 的顶层；必须是 git 顶层）。 */
  readonly repoPath: string;
  /** Worker 算定的精确目标目录；必须不存在，且落在 Worker roots 里。 */
  readonly path: string;
  /** 新功能分支名（不带 `refs/heads/`）。 */
  readonly branch: string;
  /** 这次委派选中的 base 分支（可以不是远端默认分支）；远端必须存在。 */
  readonly baseBranch: string;
  /** domain 记录的项目仓库地址；必须与 origin 的 fetch / push 目的地（按 git 解析后）完全一致。 */
  readonly expectedUrl: string;
  /** 远端 HTTPS 凭据；公开仓库可以不传，传了就必须绑定 expectedUrl。 */
  readonly auth?: GitAuth;
}

/** 准备结果：只报实际证明成立的事实。失败（含无法证明）走 DomainError。 */
export interface PrepareDelegationWorktreeOutcome {
  /** 实际创建的 worktree 顶层（realpath 后）。 */
  readonly path: string;
  readonly branch: string;
  /** 实际检出的提交（取自远端 base 分支，40 位小写）。 */
  readonly baseSha: string;
}

/**
 * 把源仓库里一个尚未推送的提交导入同项目的另一个本地 clone（委派 step B 前的本地传递）。
 * 和 `publishRef` 的区别：不联网、不碰远端，只在目标仓库里建一个专用 ref；
 * 传输只允许本机文件路径，且两边都必须是同一项目仓库的 canonical origin。
 */
export interface ImportCommitInput {
  /** 源仓库根目录（真实路径，必须在 Worker roots 里；HEAD 必须正好在 sourceBranch 上）。 */
  readonly sourcePath: string;
  /** 目标仓库根目录（另一个独立 clone，必须真实存在；只在这里建 ref）。 */
  readonly targetPath: string;
  /** 记录下来的源分支；要导入的提交必须从它可达（不退回其它 ref，也不猜）。 */
  readonly sourceBranch: string;
  /** 要导入的完整 40 位小写提交号。 */
  readonly sha: string;
  /** 目标仓库里的专用 ref（`refs/` 开头；不能是 `refs/heads/` 分支）。 */
  readonly ref: string;
  /**
   * domain 记录的项目仓库地址：源 / 目标两个仓库的 origin fetch / push 目的地都必须与它一致。
   * 不允许 Worker 自己从任一侧配置推断「这是同一个项目」。
   */
  readonly expectedUrl: string;
}

/** 导入结果：ref 是实际指向 sha 的专用 ref；alreadyPresent = 这次没有产生任何写入。 */
export interface ImportCommitOutcome {
  readonly ref: string;
  readonly sha: string;
  readonly alreadyPresent: boolean;
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

/** 保存前检查远端仓库（ws.check_repo）：连不连得上、默认分支是什么、填的分支在不在。 */
export interface RepoProbe {
  readonly reachable: boolean;
  /** 远端的默认分支（`git ls-remote --symref <url> HEAD`）；拿不到 = null。 */
  readonly defaultBranch: string | null;
  /** 没填分支 = true（用远端默认分支，永远成立）。 */
  readonly branchExists: boolean;
  /** reachable=false 时的原因（已抹掉 URL 里的凭据）；正常是 null。 */
  readonly message: string | null;
}

/** 预览选项：默认全量（Git 工作流要看见所有改动再决定提交）；`redactSensitive` 只给只读展示用。 */
export interface PreviewOptions {
  /** true = 敏感文件（#269）的路径与内容都不出现在 files / patch 里；旧 Worker 可能忽略。 */
  readonly redactSensitive?: boolean;
}

/**
 * 工作空间的 git / 目录操作（docs/design/workspaces.md §3）。
 * 在目录所在的那台机器上执行：本机直接跑，远端 Worker 走 ws.* RPC。
 * 适配器负责 roots 边界；凭据默认用那台机器自己的（SSH / key / agent）；
 * 私有 HTTPS 仓库可以选择带 `auth`（hub 从密钥箱解出来的头），不传就走机器本机凭据。
 */
export interface WorkspaceGit {
  inspect(path: string): Promise<Result<GitInspection, DomainError>>;
  /** 只读地问远端：不 clone、不碰本地目录。连不上不是错误：reachable=false + message。 */
  checkRepo(repoUrl: string, branch: string | null, auth?: GitAuth): Promise<Result<RepoProbe, DomainError>>;
  clone(input: CloneInput): Promise<Result<{ readonly path: string; readonly branch: string | null }, DomainError>>;
  addWorktree(input: WorktreeInput): Promise<Result<{ readonly path: string; readonly branch: string }, DomainError>>;
  status(path: string): Promise<Result<GitStatus, DomainError>>;
  /** 把所有改动（含未跟踪）提交成一个 WIP 提交，再 `push -u origin <当前分支>`。 */
  saveWip(path: string, message: string, auth?: GitAuth): Promise<Result<SaveWipOutcome, DomainError>>;
  /** ADR 0027 §2：提交前预览（patch 截断到 maxPatchBytes）。只读本地，不需要令牌。默认不隐藏任何改动。 */
  preview(path: string, maxPatchBytes: number, options?: PreviewOptions): Promise<Result<CommitPreview, DomainError>>;
  /** `add -A` + `commit --author`；没改动 = committed:false。 */
  commit(path: string, input: CommitInput): Promise<Result<CommitOutcome, DomainError>>;
  /** `push -u origin <当前分支>`；没 origin / 被拒 = pushed:false + 原因。 */
  push(path: string, auth?: GitAuth): Promise<Result<PushOutcome, DomainError>>;
  /**
   * 把已批准的 SHA 作为远端分支发布（docs/design/workspace-delegation.md step B）：
   * 只允许 create-only（`--force-with-lease=<ref>:`），不跟随本地分支、不覆盖任何已有提交。
   * 老 Worker 没有这个方法 = undefined：hub 必须当成「不支持」而不是退回 `push`。
   */
  publishRef?(input: PublishRefInput): Promise<Result<PublishRefOutcome, DomainError>>;
  /**
   * 为委派严格准备 worktree（docs/design/workspace-delegation.md step A4）：
   * 只从远端权威 base 的提交新开分支，不采用已有目录 / 分支，不改源仓库工作区。
   * 老 Worker 没有这个方法 = undefined：hub 必须当成「不支持」，不能退回 `addWorktree`。
   */
  prepareDelegationWorktree?(input: PrepareDelegationWorktreeInput): Promise<Result<PrepareDelegationWorktreeOutcome, DomainError>>;
  /**
   * 把源仓库里一个尚未推送的提交本地导入目标 clone（委派 step B，不联网）：
   * 只建目标仓库里 domain 指定的专用 ref，用 create-only 或同值幂等，不 checkout、不动 index / HEAD / 分支 / FETCH_HEAD。
   * 老 Worker 没有这个方法 = undefined：hub 必须当成「不支持」，不能退回 `push` / `fetch origin`。
   */
  importCommit?(input: ImportCommitInput): Promise<Result<ImportCommitOutcome, DomainError>>;
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
