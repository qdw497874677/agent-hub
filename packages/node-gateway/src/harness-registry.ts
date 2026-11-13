import type { AgentReadiness, HarnessProbe, HarnessReadiness, HarnessSelfCheck, ModelCheck } from '@agent-hub/domain';

/**
 * 把各 harness 的就绪探测适配器组合起来。加一个 harness = 往列表里加一个适配器，这里不认识任何具体 harness。
 * - 每个探测各自超时、各自兜底：一个卡住或抛错不影响其它；
 * - 并发调用合并成一次（连上、定时、「重新检测」可能撞在一起）。
 */
export interface HarnessRegistry {
  probeAll(): Promise<ReadonlyMap<string, HarnessProbe>>;
  /** 上一次探测的结果；还没探测过是空表（= 都当 ready，和老 worker 一样）。 */
  latest(): ReadonlyMap<string, HarnessProbe>;
  /**
   * 模型自检：每个进程只跑一次（重复调用返回同一个结果），只对探测为 ready 的 harness 跑。
   * 结果并进 latest() 的 ready.check；返回本次新得到的结果（没跑任何自检是空表）。
   */
  selfCheckOnce(): Promise<ReadonlyMap<string, ModelCheck>>;
  /**
   * 换一套 harness（自定义运行时别名热应用，CAP-1）：重建探测列表并立刻探测一轮。
   * 旧的模型自检结果、进行中的探测 / 自检一起清掉——不能把上一个配置的结论串到新配置上。
   * 正在跑的会话不受影响：它们拿着的 runtime 对象不会被换。
   */
  replace(probes: readonly HarnessReadiness[], selfChecks?: readonly HarnessSelfCheck[]): Promise<void>;
}

export function createHarnessRegistry(
  probes: readonly HarnessReadiness[],
  options: { readonly timeoutMs?: number; readonly selfChecks?: readonly HarnessSelfCheck[] } = {}
): HarnessRegistry {
  const timeoutMs = options.timeoutMs ?? 20_000;
  let sources = probes;
  let selfChecks = options.selfChecks ?? [];
  let current: ReadonlyMap<string, HarnessProbe> = new Map();
  let inflight: Promise<ReadonlyMap<string, HarnessProbe>> | null = null;
  const checks = new Map<string, ModelCheck>();
  let selfChecking: Promise<ReadonlyMap<string, ModelCheck>> | null = null;
  /** 把自检结果并进 ready 的就绪状态（不可用的不并：先修好装 / 登录）。 */
  const merged = (): ReadonlyMap<string, HarnessProbe> => {
    if (checks.size === 0) return current;
    const out = new Map<string, HarnessProbe>();
    for (const [id, probe] of current) {
      const check = checks.get(id);
      out.set(id, check && probe.readiness.state === 'ready' ? { ...probe, readiness: { ...probe.readiness, check } } : probe);
    }
    return out;
  };

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
    latest: merged,
    selfCheckOnce() {
      selfChecking ??= (async () => {
        const fresh = new Map<string, ModelCheck>();
        const ready = (id: string) => current.get(id)?.readiness.state === 'ready';
        // 一个一个跑：同时拉起几个 agent 会抢启动资源，而且自检不急
        for (const check of selfChecks) {
          if (!ready(check.agentId)) continue;
          const result = await check.run().catch((error: unknown) => ({ ok: false, model: '', reason: `自检出错：${error instanceof Error ? error.message : String(error)}`, at: Date.now() }));
          checks.set(check.agentId, result);
          fresh.set(check.agentId, result);
        }
        return fresh;
      })();
      return selfChecking;
    },
    probeAll() {
      inflight ??= Promise.all(sources.map(async (probe) => [probe.agentId, await one(probe)] as const))
        .then((entries) => {
          current = new Map(entries);
          return merged();
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
    async replace(next, nextChecks) {
      sources = next;
      selfChecks = nextChecks ?? [];
      checks.clear();
      selfChecking = null;
      inflight = null;
      current = new Map();
      await (this as HarnessRegistry).probeAll();
    }
  };
}

/** 两次探测的就绪状态是否一样（决定要不要再报一次 agent 清单）。 */
export function sameReadiness(a: ReadonlyMap<string, HarnessProbe>, b: ReadonlyMap<string, HarnessProbe>): boolean {
  if (a.size !== b.size) return false;
  const key = (r: AgentReadiness | undefined): string =>
    r ? (r.state === 'ready' ? `ready:${(r.lacks ?? []).join(',')}:${r.check ? `${r.check.ok}:${r.check.at}` : ''}` : `x:${r.reason}:${r.hint ?? ''}`) : '';
  for (const [id, probe] of a) if (key(probe.readiness) !== key(b.get(id)?.readiness)) return false;
  return true;
}

/**
 * 给「未安装」补一句怎么修：命令是组合根用 resolveCommand 找的，找不到时它知道该提示哪个环境变量。
 * 只包一层，不碰具体 harness 的探测逻辑。
 */
export function withMissingHint(probe: HarnessReadiness, hint: string | null): HarnessReadiness {
  if (hint === null) return probe;
  return {
    agentId: probe.agentId,
    async probe() {
      const result = await probe.probe();
      const readiness = result.readiness;
      return readiness.state === 'unavailable' && readiness.reason === '未安装' ? { ...result, readiness: { ...readiness, hint } } : result;
    }
  };
}
