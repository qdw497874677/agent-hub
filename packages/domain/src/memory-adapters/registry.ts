import type { MemoryDistiller, MemoryIndex, MemoryMaintenanceJob, MemoryPolicy, MemoryRanker, MemoryRetriever, MemorySecretFilter, MemorySource, MemoryStore } from '../ports/memory.ts';
import { composePolicies, createDefaultMemoryPolicy, createRrfRetriever, createSpotCheckJob, expireJob, patternSecretFilter, rrfRanker, ruleDistiller } from './builtin.ts';

/**
 * 记忆适配器注册表（memory.md §16）：每一块（来源 / 提炼 / 检索 + 排序 / 维护任务 / 治理）都按端口注册，
 * build() 产出 createMemoryService 要的那几个依赖。服务只认端口，不知道具体适配器。
 *
 * 同 id 再注册 = 替换（比如用模型版提炼器替换 rule）；来源、维护任务、写入策略、密钥过滤可以有多个。
 */
export interface MemoryAdapters {
  readonly sources: readonly MemorySource[];
  readonly distiller: MemoryDistiller;
  readonly jobs: readonly MemoryMaintenanceJob[];
  readonly policy: MemoryPolicy;
  readonly secretFilter: MemorySecretFilter;
  readonly retriever: MemoryRetriever;
}

export interface MemoryRegistry {
  source(adapter: MemorySource): MemoryRegistry;
  distiller(adapter: MemoryDistiller): MemoryRegistry;
  job(adapter: MemoryMaintenanceJob): MemoryRegistry;
  policy(id: string, adapter: MemoryPolicy): MemoryRegistry;
  secretFilter(adapter: MemorySecretFilter): MemoryRegistry;
  ranker(adapter: MemoryRanker): MemoryRegistry;
  /** 换整个检索器（向量 / Graphiti / Mem0）；不给就用「索引 + 排序器」。 */
  retriever(factory: (deps: { index: MemoryIndex; store: MemoryStore; sources: readonly MemorySource[]; ranker: MemoryRanker }) => MemoryRetriever): MemoryRegistry;
  /** 注册了哪些（给界面 / 诊断看）。 */
  describe(): Record<'sources' | 'distiller' | 'jobs' | 'policies' | 'secretFilters' | 'ranker', string[]>;
  build(deps: { index: MemoryIndex; store: MemoryStore }): MemoryAdapters;
}

const upsert = <T extends { id: string }>(list: T[], item: T) => {
  const at = list.findIndex((x) => x.id === item.id);
  if (at >= 0) list[at] = item;
  else list.push(item);
};

export function createMemoryRegistry(): MemoryRegistry {
  const sources: MemorySource[] = [];
  const jobs: MemoryMaintenanceJob[] = [];
  const policies: { id: string; policy: MemoryPolicy }[] = [];
  const filters: MemorySecretFilter[] = [];
  let distiller: MemoryDistiller | null = null;
  let ranker: MemoryRanker | null = null;
  let retrieverFactory: Parameters<MemoryRegistry['retriever']>[0] | null = null;
  const registry: MemoryRegistry = {
    source: (a) => (upsert(sources, a), registry),
    distiller: (a) => ((distiller = a), registry),
    job: (a) => (upsert(jobs, a), registry),
    policy: (id, policy) => (upsert(policies as { id: string; policy: MemoryPolicy }[], { id, policy }), registry),
    secretFilter: (a) => (upsert(filters, a), registry),
    ranker: (a) => ((ranker = a), registry),
    retriever: (f) => ((retrieverFactory = f), registry),
    describe: () => ({
      sources: sources.map((s) => s.id),
      distiller: distiller ? [distiller.id] : [],
      jobs: jobs.map((j) => j.id),
      policies: policies.map((p) => p.id),
      secretFilters: filters.map((f) => f.id),
      ranker: ranker ? [ranker.id] : []
    }),
    build({ index, store }) {
      if (!distiller) throw new Error('记忆注册表：没有提炼器');
      if (policies.length === 0) throw new Error('记忆注册表：没有写入策略');
      if (filters.length === 0) throw new Error('记忆注册表：没有密钥过滤');
      const rank = ranker ?? rrfRanker;
      const list = [...filters];
      return {
        sources: [...sources],
        distiller,
        jobs: [...jobs],
        policy: policies.length === 1 ? policies[0]!.policy : composePolicies(...policies.map((p) => p.policy)),
        secretFilter: { id: list.map((f) => f.id).join('+'), check: (text) => list.reduce<string | null>((hit, f) => hit ?? f.check(text), null) },
        retriever: retrieverFactory ? retrieverFactory({ index, store, sources, ranker: rank }) : createRrfRetriever({ index, store, sources, ranker: rank })
      };
    }
  };
  return registry;
}

/** hub 默认装配：规则提炼、RRF、默认写入策略、模式表密钥过滤、过期 + 每周抽查。来源由调用方注册。 */
export function defaultMemoryRegistry(): MemoryRegistry {
  return createMemoryRegistry()
    .distiller(ruleDistiller)
    .ranker(rrfRanker)
    .policy('default', createDefaultMemoryPolicy())
    .secretFilter(patternSecretFilter)
    .job(expireJob)
    .job(createSpotCheckJob());
}
