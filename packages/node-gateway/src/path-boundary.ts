import { isAbsolute, relative, sep } from 'node:path';

/**
 * 纯词法路径边界判断：只看路径分段，不碰文件系统。
 *
 * 唯一实现：网关内部直接 import 本文件，Worker（apps/worker）经 `@agent-hub/node-gateway`
 * 的导出复用同一份，避免两边各写一套分隔符 / 前缀比较。
 *
 * 不做 realpath / lstat / access，也不改大小写：调用方各自决定要不要先解析软链接。
 * 用 `relative()` 按段比较，所以 `/a/b-evil` 不会被当成 `/a/b` 里面；
 * root 带不带尾部分隔符、root 是不是 `/` 结果都一致。
 * 绝对 / 相对混搭直接拒绝（`relative()` 会拿 cwd 凑结果）。
 */

function lexicallyWithin(root: string, target: string, allowEqual: boolean): boolean {
  if (root === '' || target === '') return false;
  if (isAbsolute(root) !== isAbsolute(target)) return false;
  const rel = relative(root, target);
  if (rel === '') return allowEqual;
  if (isAbsolute(rel)) return false; // Windows 不同盘符
  return rel !== '..' && !rel.startsWith(`..${sep}`);
}

/** target 等于 root，或落在 root 之下（root 是 `/` 时任何绝对路径都算，包括 `/` 自己）。 */
export function isEqualOrDescendantPath(root: string, target: string): boolean {
  return lexicallyWithin(root, target, true);
}

/** target 严格落在 root 之下；等于 root 不算。 */
export function isStrictDescendantPath(root: string, target: string): boolean {
  return lexicallyWithin(root, target, false);
}
