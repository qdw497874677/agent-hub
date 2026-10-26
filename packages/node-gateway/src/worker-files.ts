import { constants } from 'node:fs';
import { mkdir, open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { DirectoryEntry } from '@agent-hub/domain';
import { createLocalFs } from './local-fs.ts';
import { makeDirectoryWithin } from './make-directory.ts';

/**
 * Worker 这一侧的文件操作，全部过 WORKER_ROOTS 这道边界。
 *
 * hub 只能通过 Worker 摸到那台机器的文件（目录浏览、`@` 引用、附件、产出物大小），
 * 所以边界就设在这里：Worker 只替 hub 碰 roots 里面的东西。
 * 判断用 realpath，软链接指到外面也算外面。
 */
export interface WorkerFiles {
  readonly roots: readonly string[];
  /** false = 不设边界（hub 自己拉起的本机 Worker 且没配 WORKER_ROOTS：hub 本来就在这台机器上）。 */
  readonly enforced: boolean;
  /** 在边界外时返回给人看的错误（带怎么放开）；在里面返回 null。 */
  check(path: string): Promise<string | null>;
  listDirectories(path: string): Promise<{ path: string; exists: boolean; entries: DirectoryEntry[] }>;
  listFiles(root: string, limit: number): Promise<{ files: string[]; truncated: boolean }>;
  readFile(path: string, maxBytes: number): Promise<Uint8Array | null>;
  writeFile(path: string, content: Uint8Array): Promise<void>;
  stat(path: string): Promise<number | null>;
  /** 在 parent 下建一层文件夹。不管 enforced 与否都只允许在 roots 里建（hub 远程建目录是新能力，默认收紧）。 */
  makeDirectory(parent: string, name: string): Promise<string>;
}

export class OutsideRootsError extends Error {}

export function boundaryHint(path: string, roots: readonly string[]): string {
  return (
    `「${path}」不在这台 Worker 允许访问的目录里（WORKER_ROOTS：${roots.join(':') || '未设置'}）。` +
    '要放开：在那台机器的 ~/.config/agent-hub/worker.env 里把目录加进 WORKER_ROOTS（冒号分隔），' +
    '再执行 systemctl --user restart agent-hub-worker'
  );
}

/** 不存在的路径就往上找最近存在的祖先再 realpath：新建的附件目录也得能判断。 */
async function real(path: string): Promise<string> {
  let current = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      const head = await realpath(current);
      return tail.length === 0 ? head : resolve(head, ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      tail.push(current.slice(parent.length).replace(/^[/\\]+/, ''));
      current = parent;
    }
  }
}

export function createWorkerFiles(options: { readonly roots: readonly string[]; readonly enforced: boolean }): WorkerFiles {
  const fs = createLocalFs();
  const roots = options.roots.map((root) => resolve(root));
  const realRoots = Promise.all(roots.map(real));

  async function check(path: string): Promise<string | null> {
    if (!options.enforced) return null;
    const target = await real(path);
    const inside = (await realRoots).some((root) => target === root || target.startsWith(root.endsWith(sep) ? root : root + sep));
    return inside ? null : boundaryHint(resolve(path), roots);
  }

  async function guard(path: string): Promise<void> {
    const problem = await check(path);
    if (problem !== null) throw new OutsideRootsError(problem);
  }

  /**
   * 先查后开之间，路径上的某一段可能被换成软链接（TOCTOU）。做法：
   * 1. 先把路径解析成真实路径并检查边界（合法的库内软链接照常能用）；
   * 2. 用 O_NOFOLLOW 打开这个真实路径：最后一段此刻若变成软链接就直接失败；
   * 3. 打开后再解析一次，必须还是同一个路径，且指向手里这个 fd（dev+ino 相同），
   *    中间某级目录被换掉也能发现。
   */
  async function openGuarded(path: string, flags: number): Promise<FileHandle> {
    const target = await real(path);
    await guard(target);
    const handle = await open(target, flags | constants.O_NOFOLLOW, 0o644);
    try {
      const opened = await handle.stat();
      const again = await realpath(target);
      const now = await stat(again);
      if (again !== target || now.dev !== opened.dev || now.ino !== opened.ino) {
        throw new OutsideRootsError(`「${resolve(path)}」在检查期间被替换，已拒绝`);
      }
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  return {
    roots,
    enforced: options.enforced,
    check,
    async listDirectories(path) {
      const absolute = resolve(path);
      await guard(absolute);
      if (!(await fs.directoryExists(absolute))) return { path: absolute, exists: false, entries: [] };
      return { path: absolute, exists: true, entries: [...(await fs.listDirectories(absolute))] };
    },
    async listFiles(root, limit) {
      await guard(root);
      const listed = await fs.listFiles(resolve(root), limit);
      return { files: [...listed.files], truncated: listed.truncated };
    },
    async readFile(path, maxBytes) {
      let handle: FileHandle;
      try {
        handle = await openGuarded(path, constants.O_RDONLY);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
      try {
        const info = await handle.stat();
        if (!info.isFile()) return null;
        if (info.size > maxBytes) throw new Error(`文件太大（${info.size} 字节，上限 ${maxBytes}）`);
        return new Uint8Array(await handle.readFile());
      } finally {
        await handle.close();
      }
    },
    async writeFile(path, content) {
      await guard(path);
      await mkdir(dirname(await real(path)), { recursive: true });
      const handle = await openGuarded(path, constants.O_WRONLY | constants.O_CREAT);
      try {
        await handle.truncate(0);
        await handle.writeFile(content);
      } finally {
        await handle.close();
      }
    },
    async makeDirectory(parent, name) {
      const made = await makeDirectoryWithin(parent, name, roots);
      if (!made.ok) throw new Error(made.error.message);
      return made.value;
    },
    async stat(path) {
      if ((await check(path)) !== null) return null;
      return fs.stat(path);
    }
  };
}
