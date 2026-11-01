import { distillSummary, effectiveStatus, scopeKey, secretKind } from '../memory.ts';
import type {
  MemoryDistiller,
  MemoryHit,
  MemoryIndex,
  MemoryMaintenanceJob,
  MemoryPolicy,
  MemoryQuery,
  MemoryRanker,
  MemoryRetriever,
  MemorySecretFilter,
  MemorySource,
  MemoryStore,
  WriteContext,
  WriteDecision
} from '../ports/memory.ts';

/**
 * hub 自带的记忆适配器（纯函数，不碰存储细节，只经端口）。服务本身不 import 这里——
 * 由注册表（memory-registry.ts）装配后作为依赖传进去，换 / 加适配器不改服务。
 */

/** 规则版提炼（不调模型）：见 memory.ts distillSummary。 */
export const ruleDistiller: MemoryDistiller = {
  id: 'rule',
  distill: async (input) => distillSummary(input.summary, { sessionId: input.sessionId, seq: input.seq })
};

/** RRF（k=60）融合。只有一路时原样返回（保留原始分数）。 */
export const rrfRanker: MemoryRanker = {
  id: 'rrf',
  fuse(lists) {
    if (lists.length === 1) return [...(lists[0] as MemoryHit[])];
    const fused = new Map<string, { hit: MemoryHit; score: number }>();
    for (const list of lists) {
      list.forEach((hit, rank) => {
        const current = fused.get(hit.key);
        fused.set(hit.key, { hit: current?.hit ?? hit, score: (current?.score ?? 0) + 1 / (60 + rank + 1) });
      });
    }
    return [...fused.values()].sort((a, b) => b.score - a.score).map(({ hit, score }) => ({ ...hit, score }));
  }
};

/** 默认密钥过滤（memory.ts secretKind 的模式表）。 */
export const patternSecretFilter: MemorySecretFilter = { id: 'patterns', check: (text) => secretKind(text) };

/** 过期物化：读时算出来的过期（staged 30 天、validTo 到期）写成 expired，并从索引里拿掉。 */
export const expireJob: MemoryMaintenanceJob = {
  id: 'expire',
  async run({ now, store, index }) {
    let count = 0;
    for (const entry of await store.list(null, { status: ['staged', 'proposed', 'active'], limit: 10_000 })) {
      if (effectiveStatus(entry, now) !== 'expired') continue;
      const updated = await store.update({ ...entry, status: 'expired', updatedAt: now, version: entry.version + 1 }, entry.version);
      if (!updated) continue;
      await index.remove([`entry:${entry.id}`]);
      count += 1;
    }
    return { count };
  }
};

/**
 * 每周抽查（§9.1 第 7 条）：最近 7 天自动转正（没经过人）的提炼条目里随机抽 5%（3–20 条）回确认队列。
 * 用标签 spot-check 记「这周抽过了」，重启也不会重抽。random 可注入（契约测试用）。
 */
export function createSpotCheckJob(random: () => number = Math.random): MemoryMaintenanceJob {
  return {
    id: 'spot-check',
    async run({ now, store, index, indexDoc }) {
      const week = 7 * 86_400_000;
      const live = await store.list(null, { status: ['active', 'proposed'], limit: 10_000 });
      if (live.some((entry) => entry.tags.includes('spot-check') && now - entry.updatedAt < week)) return { count: 0 };
      const pool = live.filter(
        (entry) => entry.status === 'active' && entry.provenance.via === 'distill' && !entry.provenance.reviewedBy && now - entry.updatedAt < week && !entry.tags.includes('spot-check')
      );
      if (pool.length === 0) return { count: 0 };
      const want = Math.min(pool.length, Math.max(3, Math.min(20, Math.ceil(pool.length * 0.05))));
      const picked = [...pool].sort(() => random() - 0.5).slice(0, want);
      let count = 0;
      for (const entry of picked) {
        const updated = await store.update({ ...entry, status: 'proposed', tags: [...entry.tags, 'spot-check'].slice(0, 10), updatedAt: now, version: entry.version + 1 }, entry.version);
        if (!updated) continue;
        await index.upsert([indexDoc(updated)]);
        count += 1;
      }
      return { count };
    }
  };
}

/** 写入策略组合：依次问，第一个 reject 立刻返回，否则第一个 review，否则 accept。 */
export function composePolicies(...policies: readonly MemoryPolicy[]): MemoryPolicy {
  return {
    async onWrite(entry, ctx) {
      let review: WriteDecision | null = null;
      for (const policy of policies) {
        const decision = await policy.onWrite(entry, ctx);
        if (decision.action === 'reject') return decision;
        if (decision.action === 'review' && !review) review = decision;
      }
      return review ?? { action: 'accept' };
    }
  };
}

/** 默认策略（设计 §6）。 */
export function createDefaultMemoryPolicy(): MemoryPolicy {
  return {
    async onWrite(entry, ctx: WriteContext): Promise<WriteDecision> {
      // 工作方式 / 检查清单：agent 写的一律要人确认；人自己写的就是确认过的
      if (entry.kind === 'procedural' && ctx.author === 'agent') return { action: 'review', reason: '工作方式（procedural）要人确认' };
      switch (entry.scope.kind) {
        case 'user':
          return ctx.author === 'human' && ctx.own ? { action: 'accept' } : { action: 'review', reason: '替本人记的要本人确认' };
        case 'role':
          return { action: 'accept' };
        case 'project':
          if (ctx.projectMode === 'review' && !(ctx.author === 'human' && ctx.canReview)) return { action: 'review', reason: '这个项目的记忆要审核' };
          return { action: 'accept' };
        case 'group':
        case 'session':
          return { action: 'accept' };
      }
    }
  };
}


/** 默认检索：索引 + 自带检索的存储 / 来源，交给排序器融合（默认 RRF）。 */
export function createRrfRetriever(deps: { index: MemoryIndex; store?: MemoryStore; sources?: readonly MemorySource[]; ranker?: MemoryRanker }): MemoryRetriever {
  const ranker = deps.ranker ?? rrfRanker;
  return {
    async retrieve(query: MemoryQuery): Promise<MemoryHit[]> {
      const include = query.include ?? ['entries', 'sources'];
      const origins = (['entry', 'source'] as const).filter((origin) => include.includes(origin === 'entry' ? 'entries' : 'sources'));
      const lists: MemoryHit[][] = [];
      const indexed = await deps.index.query({ text: query.text, scopeKeys: query.scopes.map(scopeKey), origins, kinds: query.kinds, limit: query.limit * 3 });
      lists.push(
        indexed.map((hit) => ({
          key: hit.key,
          origin: hit.origin,
          scopeKey: hit.scopeKey,
          score: hit.relevance,
          title: hit.title,
          snippet: hit.snippet,
          trust: hit.trust,
          updatedAt: hit.updatedAt,
          ...(hit.origin === 'entry' ? { entryId: hit.key.slice('entry:'.length) } : {}),
          ...(hit.ref ? { ref: hit.ref } : {})
        }))
      );
      if (deps.store?.search && include.includes('entries')) lists.push(await deps.store.search(query));
      for (const source of deps.sources ?? []) if (source.search && include.includes('sources')) lists.push(await source.search(query));
      return ranker.fuse(lists);
    }
  };
}
