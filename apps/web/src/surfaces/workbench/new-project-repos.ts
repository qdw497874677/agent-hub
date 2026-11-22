import { emptyRepoRow, repoRowProblem, type ProjectRepoRow } from './project-repos.ts';

/**
 * 新建项目的仓库草稿（docs/design/multi-repo.md §11.2）。
 *
 * 设置页的仓库行靠服务端 id 判断主仓库；新建时项目还不存在，所以这里先给每行
 * 一个客户端 id，创建请求里原样带上，`primaryRepoId` 就能稳定地指向同一行。
 * 后端 `normalizeRepos` 会保留客户端给的 id，建完后不用再换算。
 */
export const NEW_PROJECT_REPO_ID_PREFIX = 'repo_new_';

/** 新的空行：id 按现有行往后排，删掉再加也不会和当前清单里的 id 撞。 */
export function newProjectRepoRow(rows: readonly ProjectRepoRow[]): ProjectRepoRow {
  const used = new Set(rows.map((row) => row.id));
  let next = rows.length + 1;
  while (used.has(`${NEW_PROJECT_REPO_ID_PREFIX}${next}`)) next += 1;
  return { ...emptyRepoRow(), id: `${NEW_PROJECT_REPO_ID_PREFIX}${next}` };
}

/**
 * 地址里是不是直接写了账号 / 密码 / 令牌。
 *
 * HTTP(S) 里用户名也可能是 token（`https://token@host/repo`），一并拒绝；
 * SSH 里的 `git@host` 是普通用户名，只有显式密码才算凭据。
 * 这类地址会被持久化、回显、进日志，凭据必须走行内的访问令牌。
 */
export function newProjectRepoUrlHasCredentials(url: string): boolean {
  const trimmed = url.trim();
  if (!/^(?:https?|ssh):\/\//i.test(trimmed)) return false;
  try {
    const parsed = new URL(trimmed);
    if (parsed.password !== '') return true;
    return /^https?:$/.test(parsed.protocol) && parsed.username !== '';
  } catch {
    return false;
  }
}

/** 一行的创建期校验：先跑设置页那套，再拒绝把凭据写进地址。 */
export function newProjectRepoRowProblem(row: ProjectRepoRow, rows: readonly ProjectRepoRow[]): string | null {
  const problem = repoRowProblem(row, rows);
  if (problem !== null) return problem;
  if (newProjectRepoUrlHasCredentials(row.url)) {
    return '地址里不要写账号、密码或令牌；私有 HTTPS 仓库把令牌填到下面的「访问令牌」。';
  }
  return null;
}

/** 整份草稿的第一个问题；null = 可以创建。 */
export function newProjectReposProblem(rows: readonly ProjectRepoRow[]): string | null {
  for (const row of rows) {
    const problem = newProjectRepoRowProblem(row, rows);
    if (problem !== null) return problem;
  }
  return null;
}

/** 主仓库可选；只要选了，就必须还在清单里。 */
export function newProjectPrimaryProblem(rows: readonly ProjectRepoRow[], primaryRepoId: string | null): string | null {
  if (primaryRepoId === null || primaryRepoId === '') return null;
  return rows.some((row) => row.id === primaryRepoId) ? null : '主仓库不在清单里，请重新选择';
}

/**
 * 折叠状态的那行摘要：只显示个数和仓库名，**永远不显示地址**。
 * 地址可能带 userinfo，折叠时露出来就违背了「凭据不预览」。
 */
export function newProjectReposSummary(rows: readonly ProjectRepoRow[]): string {
  if (rows.length === 0) return '';
  return `${rows.length} 个 · ${rows.map((row) => row.name.trim() || '未命名').join(' · ')}`;
}
