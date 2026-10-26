import {
  RpcFailure,
  fsListDirectories,
  fsListFiles,
  fsMakeDirectory,
  fsReadFile,
  wsAddWorktree,
  wsClone,
  wsInspect,
  wsRemove,
  wsStatus,
  type RpcPort
} from '@agent-hub/contract';
import type { DomainError, Result } from '@agent-hub/domain';
import { createGitWorkspace } from './git-workspace.ts';
import type { WorkerFiles } from './worker-files.ts';

/**
 * Worker 侧文件操作适配器：RPC 端口上的 fs.* 方法 → WorkerFiles（WORKER_ROOTS 边界在它里面）。
 * 不认识传输；没有 files 就一律答「这台不支持」。
 */
export function serveWorkerFiles(port: RpcPort, files: WorkerFiles | undefined, fallbackRoots: readonly string[] = []): void {
  const need = (what: string): WorkerFiles => {
    if (!files) throw new RpcFailure('unsupported', `这台 Worker 不支持${what}`);
    return files;
  };
  port.handle(fsListDirectories, async ({ path }) => {
    const target = path === '' ? (files?.roots[0] ?? fallbackRoots[0] ?? '/') : path;
    return need('浏览目录').listDirectories(target);
  });
  port.handle(fsMakeDirectory, async ({ parent, name }) => {
    const fs = need('新建文件夹');
    try {
      return { path: await fs.makeDirectory(parent, name) };
    } catch (error) {
      throw new RpcFailure('invalid', error instanceof Error ? error.message : String(error));
    }
  });
  port.handle(fsListFiles, async ({ root, limit }) => need('列文件').listFiles(root, limit));
  port.handle(fsReadFile, async ({ path, maxBytes }) => {
    const bytes = await need('读文件').readFile(path, maxBytes);
    return { data: bytes === null ? null : Buffer.from(bytes).toString('base64') };
  });

  serveWorkspaceGit(port, files);
}

/** ws.*：工作空间的 git / 目录操作，边界和 fs.* 一样是 WORKER_ROOTS（没有 files 就整组不支持）。 */
function serveWorkspaceGit(port: RpcPort, files: WorkerFiles | undefined): void {
  const git = files ? createGitWorkspace((path) => files.check(path)) : null;
  const need = () => {
    if (!git) throw new RpcFailure('unsupported', '这台 Worker 不支持工作空间操作');
    return git;
  };
  const unwrap = <T>(result: Result<T, DomainError>): T => {
    if (result.ok) return result.value;
    throw new RpcFailure(result.error.code === 'invalid' || result.error.code === 'conflict' ? result.error.code : 'failed', result.error.message);
  };
  port.handle(wsInspect, async ({ path }) => unwrap(await need().inspect(path)));
  port.handle(wsClone, async (input) => unwrap(await need().clone(input)));
  port.handle(wsAddWorktree, async (input) => unwrap(await need().addWorktree(input)));
  port.handle(wsStatus, async ({ path }) => unwrap(await need().status(path)));
  port.handle(wsRemove, async ({ path, kind }) => unwrap(await need().remove(path, kind)));
}
