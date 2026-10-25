import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DirectoryEntry, DomainError, Result, WorkspaceFS } from '@agent-hub/domain';
import { unavailable } from '@agent-hub/domain';

/**
 * 真实文件系统。端口把它挡在外面，所以测试里可以换成内存实现。
 * 产出物落在 `<workspaceRoot>/.agent-hub/artifacts/<sessionId>`：
 * 跟项目一起走，删项目就一起删，不会在用户家目录里撒垃圾。
 */
/** 依赖、构建产物：@ 引用里没人想翻这些，扫进来只会拖慢选择器。 */
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'build', 'target', 'coverage', '__pycache__', 'vendor']);

export function createLocalFs(): WorkspaceFS {
  return {
    async directoryExists(path: string): Promise<boolean> {
      try {
        return (await stat(path)).isDirectory();
      } catch {
        return false;
      }
    },
    async listDirectories(path: string): Promise<readonly DirectoryEntry[]> {
      // 只看目录：用户挑的是「任务活在哪」，不是挑文件。点开头的默认藏起来，
      // 但 `~/.config` 这种真要用的人知道自己在找什么，会自己打进去。
      const entries = await readdir(path, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => ({ name: entry.name, path: join(path, entry.name) }))
        .sort((left, right) => left.name.localeCompare(right.name));
    },
    artifactDir(workspaceRoot: string, sessionId: string): string {
      return join(workspaceRoot, '.agent-hub', 'artifacts', sessionId);
    },
    async writeFile(path: string, content: Uint8Array): Promise<Result<number, DomainError>> {
      try {
        await mkdir(join(path, '..'), { recursive: true });
        await writeFile(path, content);
        return { ok: true, value: content.byteLength };
      } catch (error) {
        const failure: Result<number, DomainError> = {
          ok: false,
          error: unavailable(`写文件失败：${(error as Error).message}`)
        };
        return failure;
      }
    },
    async stat(path: string): Promise<number | null> {
      try {
        return (await stat(path)).size;
      } catch {
        return null;
      }
    },
    async readFile(path: string): Promise<Uint8Array | null> {
      try {
        return new Uint8Array(await readFile(path));
      } catch {
        return null;
      }
    },
    async listFiles(root: string, limit: number) {
      // 广度优先：浅层文件先进清单，扫到上限时丢的是深处的文件，不是 README。
      const files: string[] = [];
      const queue: string[] = [''];
      while (queue.length > 0) {
        const relative = queue.shift() ?? '';
        let entries;
        try {
          entries = await readdir(join(root, relative), { withFileTypes: true });
        } catch {
          continue;
        }
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
          if (entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) continue;
          const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
          if (entry.isDirectory()) queue.push(path);
          else if (entry.isFile()) {
            if (files.length >= limit) return { files, truncated: true };
            files.push(path);
          }
        }
      }
      return { files, truncated: false };
    }
  };
}
