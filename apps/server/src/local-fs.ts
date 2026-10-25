import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DirectoryEntry, DomainError, Result, WorkspaceFS } from '@agent-hub/domain';
import { unavailable } from '@agent-hub/domain';

/**
 * 真实文件系统。端口把它挡在外面，所以测试里可以换成内存实现。
 * 产出物落在 `<workspaceRoot>/.agent-hub/artifacts/<sessionId>`：
 * 跟项目一起走，删项目就一起删，不会在用户家目录里撒垃圾。
 */
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
    }
  };
}
