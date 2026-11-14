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
/** 留空默认分支时写这个：后端把空串读成 null，但界面上「默认就是 main」更好懂。 */
export const REPO_DEFAULT_BRANCH = 'main';

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
  readonly defaultBranch: string;
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

/** 整份草稿的第一个问题；null = 可以保存。 */
export function repoRowsProblem(rows: readonly ProjectRepoRow[]): string | null {
  for (const row of rows) {
    const problem = repoRowProblem(row, rows);
    if (problem !== null) return problem;
  }
  return null;
}

/** 草稿 → PATCH `{ repos }` 的数组；默认分支留空按 main 写。 */
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

/** 契约里的仓库形状 → 草稿行（项目列表拿到的就是完整的 ProjectDto）。 */
export type ProjectReposFromProject = ProjectDto['repos'];
