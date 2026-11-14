import type { ProjectDto } from '@agent-hub/contract';

/**
 * 项目仓库清单（docs/design/multi-repo.md §2 §7）的产品层逻辑：草稿行、就地校验、PATCH body。
 *
 * 这里是纯函数，不碰 DOM，也不 import shell/api.ts —— 根 tsconfig 会编 `apps/web/src/**\/*.test.ts`，
 * 那边没有 DOM 类型。字段形状直接取契约（ProjectDto.repos），读取仍然防御：老项目没有 repos。
 */
export const PROJECT_REPOS_MAX = 8;
/** 仓库名 = 组合工作空间里的子目录名，所以形状和后端一致：小写字母开头，最多 41 个字符。 */
export const REPO_NAME_PATTERN = /^[a-z][a-z0-9-]{0,40}$/;
/**
 * 留空默认分支时写 null：让 git 用仓库自己的默认分支。
 * 早先这里写死 `main`，克隆 `master` 为默认分支的仓库会报
 * 「fatal: Remote branch main not found in upstream origin」。
 */
export const REPO_DEFAULT_BRANCH: null = null;

/** 设置页手里的一行草稿：id 空 = 还没保存过的新行。 */
export interface ProjectRepoRow {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly defaultBranch: string;
}

/** PATCH `{ repos }` 里的一项（id 只在原本就有时回传，避免换掉已有仓库的身份）。 */
export interface ProjectRepoValue {
  readonly id?: string;
  readonly name: string;
  readonly url: string;
  readonly defaultBranch: string | null;
}

/**
 * 能接受的仓库地址：http(s)://、ssh://，以及 `git@host:path` 这类 scp 写法（本质也是 ssh）。
 * 不认本地路径 —— 组合工作空间要在 Worker 上 clone，路径只在某台机器上有意义。
 */
const REPO_URL_PATTERN = /^(?:https?:\/\/|ssh:\/\/|[a-z0-9._-]+@[a-z0-9.-]+:)/i;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** 项目（或任意 JSON）→ 草稿行；没有 repos 返回空清单（= 不绑仓库）。 */
export function repoRowsFrom(project: unknown): readonly ProjectRepoRow[] {
  const raw = typeof project === 'object' && project !== null ? (project as { repos?: unknown }).repos : null;
  if (!Array.isArray(raw)) return [];
  const rows: ProjectRepoRow[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const repo = item as Record<string, unknown>;
    rows.push({
      id: text(repo.id),
      name: text(repo.name),
      url: text(repo.url),
      defaultBranch: text(repo.defaultBranch)
    });
  }
  return rows;
}

/** 「加一个仓库」的那一行：空着，等用户填。 */
export function emptyRepoRow(): ProjectRepoRow {
  return { id: '', name: '', url: '', defaultBranch: '' };
}

/**
 * 从仓库地址猜一个子目录名（`https://host/acme/api.git` / `git@host:acme/api.git` → `api`）。
 * 只在「用户还没自己起名」时用它预填，猜不出来就返回空串。
 */
export function repoNameFromUrl(url: string): string {
  const tail = url.trim().replace(/\/+$/, '').split(/[/:]/).filter(Boolean).pop() ?? '';
  const bare = tail.replace(/\.git$/i, '');
  // 剩下带点的说明这不是仓库名（比如只写了主机 `github.com`），别猜
  if (bare.includes('.')) return '';
  const name = bare
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 41);
  return /^[a-z][a-z0-9-]*$/.test(name) ? name : '';
}

/**
 * 改地址时的补丁：仓库名还是空的、或者正好等于上一个地址猜出来的名字，就跟着新地址走；
 * 用户自己改过名字之后就不再动它。
 */
export function repoUrlPatch(row: ProjectRepoRow, url: string): Partial<ProjectRepoRow> {
  const name = row.name.trim();
  const auto = name === '' || name === repoNameFromUrl(row.url);
  const next = auto ? repoNameFromUrl(url) : '';
  return next === '' ? { url } : { url, name: next };
}

/**
 * 就地校验一行；null = 没问题。错误文案直接给用户看，别只标红一个框。
 * 重名按整份清单判断，所以同一份清单里两个同名行都会报（不猜用户想留哪个）。
 */
export function repoRowProblem(row: ProjectRepoRow, rows: readonly ProjectRepoRow[]): string | null {
  if (rows.length > PROJECT_REPOS_MAX) return `一个项目最多 ${PROJECT_REPOS_MAX} 个仓库`;
  const name = row.name.trim();
  if (name === '') return '写上仓库名（会用作组合工作空间里的子目录名）';
  if (!REPO_NAME_PATTERN.test(name)) return '仓库名只能用小写字母、数字和 -，并且以字母开头';
  if (rows.filter((item) => item.name.trim() === name).length > 1) return `仓库名重复：${name}`;
  const url = row.url.trim();
  if (url === '') return '写上仓库地址';
  if (!REPO_URL_PATTERN.test(url)) return '仓库地址要以 http(s):// 或 ssh:// 开头';
  const branch = row.defaultBranch.trim();
  if (branch !== '' && !/^[\w./-]+$/.test(branch)) return '默认分支只能有字母、数字和 . _ / -';
  return null;
}

/**
 * 克隆/准备失败的常见原因 → 一句能照着做的话。原文照旧展示，这句只是补在下面。
 * 最常踩的是「默认分支写死成 main」而仓库用的是 master。
 */
export function cloneErrorHint(message: string): string | null {
  if (/Remote branch \S+ not found/i.test(message)) {
    return '仓库里没有这个分支：把项目设置的「默认分支」清空（就会用仓库自己的默认分支），或者填成实际存在的分支。';
  }
  if (/Could not resolve host|Temporary failure in name resolution/i.test(message)) {
    return '机器解析不了这个域名：换成能访问的镜像地址，或者先在机器上把仓库 clone 好，再「关联 git 目录」。';
  }
  if (/Authentication failed|could not read Username|Permission denied \(publickey\)/i.test(message)) {
    return '这台机器上没有可用的 git 凭据：先在 worker 机器上配好 SSH key / token。';
  }
  return null;
}

/** 整份草稿的第一个问题；null = 可以保存。 */
export function repoRowsProblem(rows: readonly ProjectRepoRow[]): string | null {
  for (const row of rows) {
    const problem = repoRowProblem(row, rows);
    if (problem !== null) return problem;
  }
  return null;
}

/** 草稿 → PATCH `{ repos }` 的数组；默认分支留空写 null（= 用仓库自己的默认分支）。 */
export function repoRowsValue(rows: readonly ProjectRepoRow[]): readonly ProjectRepoValue[] {
  return rows.map((row) => {
    const id = row.id.trim();
    const branch = row.defaultBranch.trim();
    return {
      ...(id === '' ? {} : { id }),
      name: row.name.trim(),
      url: row.url.trim(),
      defaultBranch: branch === '' ? REPO_DEFAULT_BRANCH : branch
    };
  });
}

/** 草稿和已保存的值有没有差别（都按保存后的形状比，空默认分支不会误报「改过」）。 */
export function reposDirty(draft: readonly ProjectRepoRow[], saved: readonly ProjectRepoRow[]): boolean {
  return JSON.stringify(repoRowsValue(draft)) !== JSON.stringify(repoRowsValue(saved));
}

/**
 * 保存前的一次仓库检查（POST /api/projects/:id/repos/check）里一项的结果。
 * 形状跟后端约定好的字段一一对应；`message` 已经是能直接给用户看的话。
 */
export interface RepoCheckResult {
  readonly name: string;
  readonly url: string;
  readonly branch: string | null;
  readonly ok: boolean;
  readonly defaultBranch: string | null;
  readonly message: string | null;
}

/** 整份检查结果。`unavailable` 非空 = 没检查成（比如没有在线的机器），不代表仓库有问题。 */
export interface ReposCheck {
  readonly workerId: string | null;
  readonly workerLabel: string | null;
  readonly unavailable: string | null;
  readonly results: readonly RepoCheckResult[];
}

/**
 * 一条检查结果 → 一行状态文字（null = 没有要说的）。
 * 成功且本来就没指定分支时顺手告诉用户实际用的是哪个默认分支 —— 这正是「写死 main」踩过的坑。
 */
export function repoCheckLine(result: RepoCheckResult): string | null {
  const branch = result.branch?.trim() ?? '';
  if (result.ok && branch === '') {
    return `可以访问，默认分支是 ${result.defaultBranch ?? '未知'}`;
  }
  return result.message;
}

/** 检查结果的总结：没检查成原样转述；有失败就说几个要处理；全通过返回 null。 */
export function repoCheckSummary(check: ReposCheck): string | null {
  if (check.unavailable !== null && check.unavailable !== '') return check.unavailable;
  const failed = check.results.filter((result) => !result.ok).length;
  return failed === 0 ? null : `有 ${failed} 个仓库需要先处理`;
}

/**
 * 检查结果要不要挡保存：只有「确实查了、且有仓库失败」才算。
 * 没机器可用（unavailable）时不能挡 —— 否则离线就等于不能改项目设置。
 */
export function repoCheckBlocksSave(check: ReposCheck): boolean {
  if (check.unavailable !== null && check.unavailable !== '') return false;
  return check.results.some((result) => !result.ok);
}

/** 契约里的仓库形状 → 草稿行（项目列表拿到的就是完整的 ProjectDto）。 */
export type ProjectReposFromProject = ProjectDto['repos'];
