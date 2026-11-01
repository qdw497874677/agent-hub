import { RpcFailure, filesChanged, filesChanges, filesDiff, filesFind, filesHead, filesList, filesRead, filesUnwatch, filesWatch, type RpcChannel, type RpcOutcome } from '@agent-hub/contract';
import type { DomainError, FileChangeNotice, Result, WorkspaceBrowser } from '@agent-hub/domain';
import { newId } from '@agent-hub/domain';

/**
 * hub 侧：远端 Worker 上的 WorkspaceBrowser（ADR 0025）——每个调用都是一次 files.* RPC。
 * 订阅表在这里：Worker 报 files.changed 按 watchId 找回调；机器断线时给所有订阅发 reset，浏览器据此重开 SSE。
 */
export interface RemoteBrowsers {
  browser(workerId: string): WorkspaceBrowser;
  /** 新连接建好时调：在通道上接 files.changed。 */
  serve(workerId: string, channel: RpcChannel): void;
  /** 机器掉线时调。 */
  workerGone(workerId: string): void;
}

export function createRemoteBrowsers(deps: {
  readonly channelOf: (workerId: string) => RpcChannel | null;
  readonly offline: (workerId: string) => { ok: false; error: DomainError };
  readonly toDomain: <T>(outcome: RpcOutcome<T>, what: string, workerId: string) => Result<T, DomainError>;
}): RemoteBrowsers {
  const watches = new Map<string, { workerId: string; onChange: (notice: FileChangeNotice) => void }>();
  const timeout = { timeoutMs: 10_000 };

  return {
    serve(workerId, channel) {
      channel.handle(filesChanged, async ({ watchId, paths }) => {
        const watch = watches.get(watchId);
        if (!watch || watch.workerId !== workerId) throw new RpcFailure('not_found', '没有这个订阅');
        watch.onChange({ paths });
        return {};
      });
    },
    workerGone(workerId) {
      for (const [id, watch] of watches) {
        if (watch.workerId !== workerId) continue;
        watches.delete(id);
        watch.onChange({ paths: [], reset: true });
      }
    },
    browser(workerId) {
      const call = async <T>(run: (channel: RpcChannel) => Promise<RpcOutcome<T>>, what: string): Promise<Result<T, DomainError>> => {
        const channel = deps.channelOf(workerId);
        if (!channel) return deps.offline(workerId);
        return deps.toDomain(await run(channel), what, workerId);
      };
      const map = <A, B>(r: Result<A, DomainError>, f: (a: A) => B): Result<B, DomainError> => (r.ok ? { ok: true, value: f(r.value) } : r);
      return {
        list: async (root, path, { limit }) => call((c) => c.request(filesList, { root, path, limit }, timeout), '目录'),
        read: async (root, path, maxBytes) =>
          map(await call((c) => c.request(filesRead, { root, path, maxBytes }, { timeoutMs: maxBytes > 2 * 1024 * 1024 ? 60_000 : 10_000 }), '文件'), ({ data, ...rest }) => ({
            ...rest,
            bytes: new Uint8Array(Buffer.from(data, 'base64'))
          })),
        find: async (root, query, limit) => map(await call((c) => c.request(filesFind, { root, query, limit }, timeout), '文件搜索'), (v) => v.files),
        changes: async (root, base) => map(await call((c) => c.request(filesChanges, { root, base }, timeout), '改动列表'), (v) => v.files),
        diff: async (root, path, base, maxBytes) => call((c) => c.request(filesDiff, { root, path, base, maxBytes }, timeout), 'diff'),
        head: async (root) => map(await call((c) => c.request(filesHead, { root }, timeout), 'HEAD'), (v) => v.head),
        watch: async (root, paths, onChange) => {
          const watchId = newId();
          watches.set(watchId, { workerId, onChange });
          const started = await call((c) => c.request(filesWatch, { watchId, root, paths: [...paths] }, timeout), '订阅变化');
          if (!started.ok) {
            watches.delete(watchId);
            return started;
          }
          return {
            ok: true,
            value: () => {
              if (!watches.delete(watchId)) return;
              void deps.channelOf(workerId)?.request(filesUnwatch, { watchId }, timeout);
            }
          };
        }
      };
    }
  };
}

/** 通道还没就绪时的占位：每个调用都如实报不可用（决定 8：不缓存、不假装）。 */
export function offlineWorkspaceBrowser(message: string): WorkspaceBrowser {
  const no = async () => ({ ok: false as const, error: { code: 'unavailable' as const, message } });
  return { list: no, read: no, find: no, changes: no, diff: no, head: no, watch: no };
}
