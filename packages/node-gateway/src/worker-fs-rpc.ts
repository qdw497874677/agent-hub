import { RpcFailure, fsListDirectories, fsListFiles, fsMakeDirectory, fsReadFile, type RpcPort } from '@agent-hub/contract';
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
}
