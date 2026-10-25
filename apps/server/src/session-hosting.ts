import type { SessionHosting } from '@agent-hub/domain';

/** 单 server 进程的托管登记：内存集合就够，重启后由 resume 补回来。 */
export function createMemoryHosting(): SessionHosting {
  const live = new Set<string>();
  return {
    has: (id) => live.has(id),
    add: (id) => void live.add(id),
    drop: (id) => void live.delete(id),
    clear: () => live.clear()
  };
}
