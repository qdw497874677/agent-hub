import type { SessionHosting } from '@agent-hub/domain';

/** 单 server 进程的托管登记：内存表就够（会话 → 托管它的 Worker），重启后由 resume 补回来。 */
export function createMemoryHosting(): SessionHosting {
  return (() => {
  const live = new Map<string, string | null>();
  return {
    live,
    has: (id: string) => live.has(id),
    add: (id: string, workerId: string | null) => void live.set(id, workerId),
    drop: (id: string) => void live.delete(id),
    dropWorker: (workerId: string) => {
      let dropped = 0;
      for (const [id, owner] of live) {
        if (owner !== null && owner !== workerId) continue;
        live.delete(id);
        dropped += 1;
      }
      return dropped;
    },
    clear: () => live.clear()
  };
})();
}
