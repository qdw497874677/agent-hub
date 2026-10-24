import type { AgentCatalog, AgentDescriptor, AgentId } from '@agent-hub/domain';
import { toDescriptor } from '@agent-hub/node-gateway';
import type { AgentDto } from '@agent-hub/contract';

export interface LiveCatalog extends AgentCatalog {
  upsert(workerId: string, agents: readonly AgentDto[]): void;
  removeWorker(workerId: string): void;
  workerOf(agentId: AgentId): string | null;
}

/**
 * agent 列表由 worker 报上来，server 从不自己猜。
 * 好处是多机时画布能如实显示「Pi 在 A 机、OpenCode 在 B 机」；
 * 代价是拔掉最后一台 worker 后列表会空——这是诚实的空，不是 bug。
 */
export function createLiveCatalog(): LiveCatalog {
  const byWorker = new Map<string, AgentDescriptor[]>();

  const all = (): AgentDescriptor[] => {
    const seen = new Map<string, AgentDescriptor>();
    for (const descriptors of byWorker.values()) {
      for (const descriptor of descriptors) {
        if (!seen.has(descriptor.id)) seen.set(descriptor.id, descriptor);
      }
    }
    return [...seen.values()];
  };

  return {
    list(): readonly AgentDescriptor[] {
      return all();
    },
    descriptor(id: AgentId): AgentDescriptor | null {
      return all().find((descriptor) => descriptor.id === id) ?? null;
    },
    upsert(workerId: string, agents: readonly AgentDto[]): void {
      byWorker.set(workerId, agents.map((agent) => toDescriptor(agent)));
    },
    removeWorker(workerId: string): void {
      byWorker.delete(workerId);
    },
    workerOf(agentId: AgentId): string | null {
      for (const [workerId, descriptors] of byWorker) {
        if (descriptors.some((descriptor) => descriptor.id === agentId)) return workerId;
      }
      return null;
    }
  };
}
