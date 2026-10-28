import type { AgentReadiness, HarnessProbe, HarnessReadiness } from '@agent-hub/domain';

/**
 * 把各 harness 的就绪探测适配器组合起来。加一个 harness = 往列表里加一个适配器，这里不认识任何具体 harness。
 * - 每个探测各自超时、各自兜底：一个卡住或抛错不影响其它；
 * - 并发调用合并成一次（连上、定时、「重新检测」可能撞在一起）。
 */
export interface HarnessRegistry {
  probeAll(): Promise<ReadonlyMap<string, HarnessProbe>>;
  /** 上一次探测的结果；还没探测过是空表（= 都当 ready，和老 worker 一样）。 */
  latest(): ReadonlyMap<string, HarnessProbe>;
}

export function createHarnessRegistry(
  probes: readonly HarnessReadiness[],
  options: { readonly timeoutMs?: number } = {}
): HarnessRegistry {
  const timeoutMs = options.timeoutMs ?? 20_000;
  let current: ReadonlyMap<string, HarnessProbe> = new Map();
  let inflight: Promise<ReadonlyMap<string, HarnessProbe>> | null = null;

  const failed = (reason: string): HarnessProbe => ({ readiness: { state: 'unavailable', reason }, models: [], defaultModel: '' });

  async function one(probe: HarnessReadiness): Promise<HarnessProbe> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<HarnessProbe>((resolve) => {
      timer = setTimeout(() => resolve(failed('检测超时')), timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([probe.probe().catch(() => failed('检测失败')), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    latest: () => current,
    probeAll() {
      inflight ??= Promise.all(probes.map(async (probe) => [probe.agentId, await one(probe)] as const))
        .then((entries) => {
          current = new Map(entries);
          return current;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    }
  };
}

/** 两次探测的就绪状态是否一样（决定要不要再报一次 agent 清单）。 */
export function sameReadiness(a: ReadonlyMap<string, HarnessProbe>, b: ReadonlyMap<string, HarnessProbe>): boolean {
  if (a.size !== b.size) return false;
  const key = (r: AgentReadiness | undefined): string => (r ? (r.state === 'ready' ? `ready:${(r.lacks ?? []).join(',')}` : `x:${r.reason}`) : '');
  for (const [id, probe] of a) if (key(probe.readiness) !== key(b.get(id)?.readiness)) return false;
  return true;
}
