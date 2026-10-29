/**
 * 目录选择器的纯规则：新建文件夹的名字、项目托管目录、路径在不在边界里。
 * 只做字符串运算，不碰文件系统——真正落盘和 realpath 校验在适配器（Worker / 本机 fs）里。
 */

/** 新建文件夹只允许「一段名字」：不能带斜杠、不能是 . / ..、不能有控制字符。返回问题描述，没问题返回 null。 */
export function folderNameProblem(name: string): string | null {
  if (name.trim() === '') return '文件夹名不能为空';
  if (name !== name.trim()) return '文件夹名首尾不能有空格';
  if (name === '.' || name === '..') return '文件夹名不能是 . 或 ..';
  if (name.includes('/') || name.includes('\\')) return '文件夹名不能包含斜杠，只能建一层';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return '文件夹名不能包含控制字符';
  if (new TextEncoder().encode(name).byteLength > 255) return '文件夹名太长';
  return null;
}

/** 项目名 → 目录名：小写、非字母数字（含中文以外的符号）换成 -，去掉首尾 -。空了就给 null。 */
export function projectSlug(name: string): string | null {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug === '' ? null : slug;
}

/**
 * hub 托管的目录都放在 `<roots[0]>/agent-hub-workspaces/` 下（项目目录、临时工作空间 `.tmp/`）。
 * 早先叫 `agent-hub/`，和 Worker 默认安装目录 `~/agent-hub` 撞在一起，托管目录就落进了 agent-hub 自己的 git 仓库。
 * 老数据记的是绝对路径，照旧可用，不搬。
 */
export const MANAGED_DIR = 'agent-hub-workspaces';

/** 项目托管目录：`<roots[0]>/agent-hub-workspaces/<slug>`（设计文档 §5）。 */
export function managedDirectory(roots: readonly string[], slug: string): string | null {
  const root = roots[0];
  if (root === undefined) return null;
  return `${trimSlash(root)}/${MANAGED_DIR}/${slug}`;
}

/** `path` 是否在某个 root 里（含 root 本身）。纯字符串判断，调用方先规范化。 */
export function insideRoots(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const base = trimSlash(root);
    return path === base || path.startsWith(base === '' ? '/' : `${base}/`) || base === '';
  });
}

/** 隐藏目录的规则和各家文件管理器一致：名字以 `.` 开头。不按名字猜「噪音」，猜错了人就找不到自己的目录。 */
export function isHiddenName(name: string): boolean {
  return name.startsWith('.');
}

/**
 * 选择器里的顺序：可见的在前、隐藏的在后；同一组里最近修改的在前，时间相同按名字。
 * 刚建的、刚用过的项目目录最可能是要找的。
 */
export function sortDirectoryEntries<T extends { readonly name: string; readonly modifiedAt?: number; readonly hidden?: boolean }>(
  entries: readonly T[]
): T[] {
  return [...entries].sort(
    (left, right) =>
      Number(left.hidden === true) - Number(right.hidden === true) ||
      (right.modifiedAt ?? 0) - (left.modifiedAt ?? 0) ||
      left.name.localeCompare(right.name)
  );
}

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path === '/' ? '' : path;
}
