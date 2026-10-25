import { lstat, mkdir, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { DomainError, Result } from '@agent-hub/domain';
import { folderNameProblem, invalid, unavailable } from '@agent-hub/domain';

/**
 * 在 parent 下建一层文件夹，边界用 realpath 判断：
 * - 名字只能是一段（不含斜杠、不是 . / ..）
 * - parent 的真实路径必须在某个 root 的真实路径里（软链接指到外面算外面）
 * - 目标已存在：是真目录就算成功；是软链接或文件就拒绝（不跟着软链接走出去）
 * - 建完再 realpath 一次确认仍在里面（防 parent 被并发换成软链接）
 */
export async function makeDirectoryWithin(
  parent: string,
  name: string,
  roots: readonly string[]
): Promise<Result<string, DomainError>> {
  const problem = folderNameProblem(name);
  if (problem !== null) return { ok: false, error: invalid(problem) };
  let realParent: string;
  try {
    realParent = await realpath(resolve(parent));
  } catch {
    return { ok: false, error: invalid(`父目录不存在：${parent}`) };
  }
  const realRoots = await Promise.all(roots.map((root) => realpath(resolve(root)).catch(() => null)));
  const inside = (path: string) =>
    realRoots.some((root) => root !== null && (path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)));
  if (!inside(realParent)) return { ok: false, error: invalid(`「${parent}」不在允许新建文件夹的目录里（${roots.join(':')}）`) };
  const target = join(realParent, name);
  try {
    const existing = await lstat(target).catch(() => null);
    if (existing !== null) {
      if (existing.isSymbolicLink()) return { ok: false, error: invalid(`「${name}」已存在且是软链接`) };
      if (!existing.isDirectory()) return { ok: false, error: invalid(`「${name}」已存在且不是文件夹`) };
    } else {
      await mkdir(target);
    }
    const realTarget = await realpath(target);
    if (!inside(realTarget)) return { ok: false, error: invalid(`「${name}」解析到了允许范围之外`) };
    return { ok: true, value: realTarget };
  } catch (error) {
    return { ok: false, error: unavailable(`新建文件夹失败：${(error as Error).message}`) };
  }
}
