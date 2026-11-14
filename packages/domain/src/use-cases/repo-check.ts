/**
 * 保存项目仓库清单前先检查（POST /api/projects/:projectId/repos/check）。
 *
 * 过去只在派生任务时才 clone，默认分支写死 main 而仓库是 master 的时候，
 * 要等用户点了「开始」才看到 `fatal: Remote branch main not found`。
 * 这里把检查提前到保存时：能不能连、默认分支是什么、填的分支在不在。
 *
 * 纯用例：不碰网络、不依赖 node。真正的 git 探测由调用方注入（本机 / 远端 Worker 各走各的）。
 */

/** 要检查的一个仓库：name 只用于回报，url + branch 才是探测的目标。 */
export interface RepoCheckTarget {
  readonly name: string;
  readonly url: string;
  /** null = 用远端默认分支。 */
  readonly branch: string | null;
}

export interface RepoCheckResult extends RepoCheckTarget {
  readonly ok: boolean;
  readonly defaultBranch: string | null;
  /** 给人看的说明：没问题时 null；有问题时是一句能照着改的话。 */
  readonly message: string | null;
}

/** 单次检查的结果形状（与 WorkspaceGit.checkRepo 的 RepoProbe 对齐，但不 import 端口）。 */
export interface RepoCheckProbe {
  readonly reachable: boolean;
  readonly defaultBranch: string | null;
  readonly branchExists: boolean;
  readonly message: string | null;
}

/** 一个项目最多 8 个仓库（PROJECT_REPOS_MAX）；再多也不打满机器，串行检查。 */
const MAX_REPOS = 8;

/**
 * 顺序检查（不并发）：每次 ls-remote 都要走网络，串行既省机器也避免同时弹一堆凭据提示。
 * 失败不抛：结果里 ok=false + message。
 */
export async function checkReposUseCase(
  deps: { readonly checkRepo: (target: RepoCheckTarget) => Promise<RepoCheckProbe> },
  targets: readonly RepoCheckTarget[]
): Promise<RepoCheckResult[]> {
  const results: RepoCheckResult[] = [];
  for (const target of targets.slice(0, MAX_REPOS)) {
    let probe: RepoCheckProbe;
    try {
      probe = await deps.checkRepo(target);
    } catch (error) {
      // 注入方理论上不抛（worker 侧已经翻成 reachable=false），这里兜底一句，别让整批检查挂掉。
      probe = { reachable: false, defaultBranch: null, branchExists: false, message: error instanceof Error ? error.message : String(error) };
    }
    const ok = probe.reachable && probe.branchExists;
    results.push({
      ...target,
      ok,
      defaultBranch: probe.defaultBranch,
      message: ok ? null : problemMessage(target, probe)
    });
  }
  return results;
}

/** 把探测结果翻成用户能照着做的话：分支写错时直接告诉他默认分支是什么。 */
function problemMessage(target: RepoCheckTarget, probe: RepoCheckProbe): string {
  if (!probe.reachable) return probe.message ?? '连不上这个仓库';
  if (!probe.branchExists && target.branch !== null && target.branch !== '') {
    return `仓库里没有分支 ${target.branch}，默认分支是 ${probe.defaultBranch ?? '未知'}`;
  }
  // reachable 且 branchExists 之外没有别的失败情形；兜底保留原 message。
  return probe.message ?? '仓库检查没通过';
}
