import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { DomainError, Result } from '@agent-hub/domain';
import { conflict, invalid, unavailable } from '@agent-hub/domain';

/**
 * 组合工作空间（docs/design/multi-repo.md §11.3 / §12.5）的容器目录。
 *
 * 容器根不是 git 仓库，只放成员子目录和 `.agent-hub/group.json`（只存 `{ id }`，删前核对用；
 * 成员清单以 DB 为唯一真相）。三个不变量：
 * - 容器路径由这里算（`<WORKER_GROUPS_DIR>/<slug>/<name>`），hub 只给段名：段名限 `[a-z0-9-]+`，
 *   所以拼出来的路径必然严格落在 `WORKER_GROUPS_DIR` 下（容器根本身不算）；
 * - 容器的任何一个祖先都不能是 git 仓库根：否则容器根上的 `git add -A` 会写进外层仓库；
 * - 删除只认带同样 marker 的真实目录（不 realpath、不跟符号链接）。
 */

/** 容器目录里的元数据目录；工作空间文件浏览必须跳过（§12.5）。 */
export const GROUP_MARKER_DIR = '.agent-hub';
/** 容器标记文件（相对容器根）。 */
export const GROUP_MARKER_FILE = join(GROUP_MARKER_DIR, 'group.json');
const GROUP_FILE_NAME = 'group.json';
/** 默认的 groups 目录名：`<WORKER_ROOTS 第一个>/agent-hub-groups`。 */
export const DEFAULT_GROUPS_DIR_NAME = 'agent-hub-groups';

/** 没显式配 `WORKER_GROUPS_DIR` 时的默认位置。 */
export function defaultGroupsDir(roots: readonly string[]): string {
  return join(roots[0] ?? '/', DEFAULT_GROUPS_DIR_NAME);
}

/**
 * `target` 是不是 `groupsDir` 的严格子路径（不含 groupsDir 自己）。
 * 用 `relative()` 按路径段比较，不会把 `agent-hub-groups-evil` 误判成在 `agent-hub-groups` 里。
 */
export function insideGroups(groupsDir: string, target: string): boolean {
  const base = resolve(groupsDir);
  const path = resolve(target);
  const rel = relative(base, path);
  if (rel === '' || isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${sep}`);
}

export interface GroupDirOptions {
  /** `WORKER_GROUPS_DIR`（绝对路径，已确认在某个 WORKER_ROOTS 里）。 */
  readonly groupsDir: string;
  /** 目录边界检查：返回 null = 允许，否则是给人看的原因（和 git 的 check 同一套）。 */
  readonly check?: (path: string) => Promise<string | null>;
}

export interface GroupDir {
  /**
   * 建容器目录，根由这里算：`<groupsDir>/<slug>/<name>`。
   * hub 只给段名，不给路径——`WORKER_GROUPS_DIR` 只有这台机器知道。
   */
  init(input: {
    readonly slug: string;
    readonly name: string;
    readonly id: string;
  }): Promise<Result<{ readonly root: string }, DomainError>>;
  remove(input: { readonly root: string; readonly id: string }): Promise<Result<{ readonly removed: boolean }, DomainError>>;
}

/** 容器路径的一段：小写字母、数字、连字符；不能是 `.`/`..`、不能带分隔符（等于不许逃出 groupsDir）。 */
const SEGMENT = /^[a-z0-9-]+$/;

export function createGroupDir(options: GroupDirOptions): GroupDir {
  const groupsDir = resolve(options.groupsDir);
  const check = options.check ?? (async () => null);
  const failed = (what: string, error: unknown): Result<never, DomainError> => ({
    ok: false,
    error: unavailable(`${what}失败：${messageOf(error)}`)
  });
  /** 绝对路径 + roots 边界 + groups 前缀，三件事一起判。 */
  const place = async (root: string): Promise<{ readonly path: string } | { readonly error: DomainError }> => {
    if (!root.startsWith('/')) return { error: invalid('容器目录必须是绝对路径') };
    const path = resolve(root);
    const problem = await check(path);
    if (problem !== null) return { error: invalid(problem) };
    if (!insideGroups(groupsDir, path)) return { error: invalid(`容器目录必须放在 ${groupsDir} 下面：${path}`) };
    return { path };
  };
  /** 段名先过字符集，再拼路径：拼出来的东西一定在 groupsDir 里、且不是 `..` 这类。 */
  const segment = (label: string, value: string): { readonly text: string } | { readonly error: DomainError } => {
    const text = value.trim();
    if (text === '') return { error: invalid(`组合工作空间的 ${label} 不能为空`) };
    if (text === '.' || text === '..' || !SEGMENT.test(text)) {
      return { error: invalid(`组合工作空间的 ${label} 只能用小写字母、数字和连字符：${text}`) };
    }
    return { text };
  };

  return {
    async init({ slug, name, id }) {
      const slugged = segment('slug', slug);
      if ('error' in slugged) return { ok: false, error: slugged.error };
      const named = segment('name', name);
      if ('error' in named) return { ok: false, error: named.error };

      const placed = await place(join(groupsDir, slugged.text, named.text));
      if ('error' in placed) return { ok: false, error: placed.error };
      const path = placed.path;
      const markerId = id.trim();
      if (markerId === '') return { ok: false, error: invalid('组合工作空间 id 不能为空') };

      // 已存在（哪怕空目录）一律 conflict：重试走「继续用已有容器」的分支，不再 init（§12.5）
      if (await lstat(path).catch(() => null)) return { ok: false, error: conflict(`「${path}」已经存在`) };

      const ancestor = await nearestExisting(path);
      if (ancestor.kind === 'file') return { ok: false, error: invalid(`「${ancestor.path}」不是目录：容器建不出来`) };
      if (ancestor.kind === 'none') return { ok: false, error: invalid(`找不到可用的父目录：${path}`) };
      if ((await gitToplevel(ancestor.path)) !== null) {
        return { ok: false, error: conflict(`「${path}」在 git 仓库「${ancestor.path}」里面：组合工作空间容器不能落在仓库里`) };
      }

      try {
        const dir = join(path, GROUP_MARKER_DIR);
        await mkdir(dir, { recursive: true });
        // 先写临时文件再 rename：中途被杀不会留下半个 group.json
        const temp = join(dir, `${GROUP_FILE_NAME}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
        await writeFile(temp, `${JSON.stringify({ id: markerId })}\n`, 'utf8');
        await rename(temp, join(path, GROUP_MARKER_FILE));
      } catch (error) {
        // 建了一半：路径本来不存在，整棵删掉，重试还能再 init
        await rm(path, { recursive: true, force: true }).catch(() => undefined);
        return failed('建组合工作空间目录', error);
      }
      return { ok: true, value: { root: path } };
    },

    async remove({ root, id }) {
      const placed = await place(root);
      if ('error' in placed) return { ok: false, error: placed.error };
      const path = placed.path;
      // 不 realpath：链接指到别处时也不能让删除跟过去
      const stat = await lstat(path).catch(() => null);
      if (stat === null) return { ok: true, value: { removed: true } }; // 已经没了：目标状态已满足
      if (stat.isSymbolicLink() || !stat.isDirectory()) return { ok: false, error: conflict('不是组合工作空间目录') };
      if ((await markerIdOf(path)) !== id.trim()) return { ok: false, error: conflict('不是组合工作空间目录') };
      try {
        await rm(path, { recursive: true, force: true });
      } catch (error) {
        return failed('删组合工作空间目录', error);
      }
      return { ok: true, value: { removed: true } };
    }
  };
}

/** 读 `.agent-hub/group.json` 的 id；没有、读不出、不是对象都回 null。 */
async function markerIdOf(root: string): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(root, GROUP_MARKER_FILE), 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return null;
    const id = (parsed as { id?: unknown }).id;
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
}

type Ancestor = { readonly kind: 'dir'; readonly path: string } | { readonly kind: 'file'; readonly path: string } | { readonly kind: 'none' };

/** 最近一个存在的祖先（root 自己也算）：路径本身不存在时往上找。 */
async function nearestExisting(path: string): Promise<Ancestor> {
  let current = path;
  for (;;) {
    const stat = await lstat(current).catch(() => null);
    if (stat) return stat.isDirectory() ? { kind: 'dir', path: current } : { kind: 'file', path: current };
    const parent = dirname(current);
    if (parent === current) return { kind: 'none' };
    current = parent;
  }
}

/** 这个目录所在的 git 仓库根；不在仓库里（或没有 git）返回 null。 */
function gitToplevel(dir: string): Promise<string | null> {
  return new Promise((done) => {
    execFile('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { timeout: 10_000, maxBuffer: 1 << 20 }, (error, stdout) => {
      const top = String(stdout).trim();
      done(error || top === '' ? null : top);
    });
  });
}

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // git 的报错可能带上 URL 里的凭据：抹掉 user:token@
  return text.replace(/\/\/[^/@\s]+@/g, '//***@').trim().split('\n').slice(0, 3).join(' ');
}
