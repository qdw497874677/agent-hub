import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DomainError, Result, WorkspaceFS } from '@agent-hub/domain';
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
