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
  wsSaveWip,
  wsStatus,
  filesChanged,
  filesChanges,
  filesDiff,
  filesFind,
  filesHead,
  filesList,
  filesRead,
  filesUnwatch,
  filesWatch,
  type RpcPort
} from '@agent-hub/contract';
import type { DomainError, Result } from '@agent-hub/domain';
import { createGitWorkspace } from './git-workspace.ts';
import { createWorkspaceBrowser } from './workspace-browser.ts';
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
  serveWorkspaceBrowser(port, files);
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
  port.handle(wsSaveWip, async ({ path, message }) => unwrap(await need().saveWip(path, message)));
  port.handle(wsRemove, async ({ path, kind, force }) => unwrap(await need().remove(path, kind, { force: force === true })));
}

/**
 * files.*：工作空间文件浏览（ADR 0025）。根要在 WORKER_ROOTS 里，相对路径由 WorkspaceBrowser 用 realpath 关住。
 * 变化经 files.changed 报给 hub；hub 说不认识这个订阅（或连接断了）就自己停掉，免得重连后留下孤儿 watcher。
 */
function serveWorkspaceBrowser(port: RpcPort, files: WorkerFiles | undefined): void {
  const browser = files ? createWorkspaceBrowser({ guard: (root) => files.check(root) }) : null;
  const need = () => {
    if (!browser) throw new RpcFailure('unsupported', '这台 Worker 不支持浏览工作空间文件');
    return browser;
  };
  const unwrap = <T>(result: Result<T, DomainError>): T => {
    if (result.ok) return result.value;
    const code = result.error.code;
    throw new RpcFailure(code === 'invalid' || code === 'conflict' ? code : code === 'not_found' ? 'not_found' : 'failed', result.error.message);
  };
  const watches = new Map<string, () => void>();
  port.handle(filesList, async ({ root, path, limit }) => {
    const page = unwrap(await need().list(root, path, { limit }));
    return { ...page, entries: [...page.entries] };
  });
  port.handle(filesRead, async ({ root, path, maxBytes }) => {
    const { bytes, ...rest } = unwrap(await need().read(root, path, maxBytes));
    return { ...rest, data: Buffer.from(bytes).toString('base64') };
  });
  port.handle(filesFind, async ({ root, query, limit }) => ({ files: [...unwrap(await need().find(root, query, limit))] }));
  port.handle(filesChanges, async ({ root, base }) => ({ files: unwrap(await need().changes(root, base)).map((f) => ({ ...f })) }));
  port.handle(filesDiff, async ({ root, path, base, maxBytes }) => unwrap(await need().diff(root, path, base, maxBytes)));
  port.handle(filesHead, async ({ root }) => ({ head: unwrap(await need().head(root)) }));
  port.handle(filesWatch, async ({ watchId, root, paths }) => {
    watches.get(watchId)?.();
    const stop = unwrap(
      await need().watch(root, paths, (notice) => {
        void port.request(filesChanged, { watchId, paths: [...notice.paths].slice(0, 1000) }).then((sent) => {
          if (!sent.ok) {
            watches.get(watchId)?.();
            watches.delete(watchId);
          }
        });
      })
    );
    watches.set(watchId, stop);
    return {};
  });
  port.handle(filesUnwatch, async ({ watchId }) => {
    watches.get(watchId)?.();
    watches.delete(watchId);
    return {};
  });
}
