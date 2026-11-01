import { scopeKey, type MemoryEntry, type MemoryScope } from '../memory.ts';
import type { IndexDoc, MemoryDistiller, MemoryIndex, MemoryMaintenanceJob, MemoryPolicy, MemoryRanker, MemorySecretFilter, MemorySource, MemoryStore } from '../ports/memory.ts';

/**
 * 记忆适配器契约（memory.md §16）：每个新适配器都要过对应的一组。
 * 不依赖测试框架：返回 {name, run}，run 失败就 throw；测试文件用 node:test 逐个跑。
 */
export interface ContractCase {
  readonly name: string;
  run(): Promise<void>;
}
const must = (ok: unknown, message: string) => {
  if (!ok) throw new Error(`契约不满足：${message}`);
};
const SECRET = 'sk-' + 'a'.repeat(40);

/** 来源：scan 返回的文档能 read 回来，哈希一致；不认识的 ref 返回 null；只声明的作用域才扫。 */
export function memorySourceContract(name: string, make: () => Promise<{ source: MemorySource; scope: MemoryScope }>): ContractCase[] {
  return [
    {
      name: `${name}：scan 出来的文档 read 得回来，哈希一致`,
      async run() {
        const { source, scope } = await make();
        must(source.scopeKinds.includes(scope.kind), '作用域在 scopeKinds 里');
        const changes = await source.scan(scope);
        must(Array.isArray(changes.docs) && typeof changes.partial === 'boolean', 'scan 返回 {docs, partial}');
        for (const doc of changes.docs.slice(0, 5)) {
          must(doc.ref.source === source.id, `ref.source = ${source.id}`);
          const read = await source.read(scope, doc.ref);
          must(read && read.hash === doc.ref.hash, `read(${doc.ref.uri}) 的哈希和 scan 一致`);
        }
      }
    },
    {
      name: `${name}：不认识的 ref 返回 null`,
      async run() {
        const { source, scope } = await make();
        must((await source.read(scope, { source: source.id, uri: '__no_such_doc__' })) === null, 'read 不存在的 → null');
      }
    }
  ];
}

/** 提炼器：含密钥的摘要不出候选；空摘要不出候选；候选都是 staged / proposed，标题不空。 */
export function distillerContract(name: string, distiller: MemoryDistiller): ContractCase[] {
  return [
    {
      name: `${name}：含密钥 / 空摘要不出候选`,
      async run() {
        must((await distiller.distill({ summary: `部署用 ${SECRET}`, sessionId: 's', seq: 1 })).length === 0, '含密钥 → 空');
        must((await distiller.distill({ summary: '   ', sessionId: 's', seq: 1 })).length === 0, '空 → 空');
      }
    },
    {
      name: `${name}：候选格式`,
      async run() {
        const out = await distiller.distill({ summary: '修好了登录。约定：上线前必须先做数据库快照。', sessionId: 's', seq: 2 });
        must(out.length > 0, '正常摘要至少一条');
        for (const c of out) must((c.status === 'staged' || c.status === 'proposed') && c.draft.title.trim() !== '', 'status ∈ {staged, proposed}，标题不空');
      }
    }
  ];
}

/** 索引：upsert 后按作用域查得到、别的作用域查不到；remove 后查不到。 */
export function memoryIndexContract(name: string, make: () => Promise<MemoryIndex>): ContractCase[] {
  const doc = (key: string, scope: string, title: string): IndexDoc => ({ key, scopeKey: scope, origin: 'entry', title, text: `${title} 正文`, kind: 'semantic', trust: 'untrusted', updatedAt: 1, ref: null });
  return [
    {
      name: `${name}：作用域隔离、remove 生效`,
      async run() {
        const index = await make();
        await index.upsert([doc('entry:a', 'project:p1', 'deploy snapshot rule'), doc('entry:b', 'project:p2', 'deploy snapshot rule')]);
        const hits = await index.query({ text: 'snapshot', scopeKeys: ['project:p1'], origins: ['entry'], limit: 10 });
        must(hits.some((h) => h.key === 'entry:a') && !hits.some((h) => h.key === 'entry:b'), '只返回请求的作用域');
        must(hits.every((h) => h.relevance >= 0 && h.relevance <= 1), 'relevance 在 0–1');
        await index.remove(['entry:a']);
        must(!(await index.query({ text: 'snapshot', scopeKeys: ['project:p1'], origins: ['entry'], limit: 10 })).some((h) => h.key === 'entry:a'), 'remove 后查不到');
      }
    }
  ];
}

/** 排序器：不丢不重；单路原样。 */
export function rankerContract(name: string, ranker: MemoryRanker): ContractCase[] {
  const hit = (key: string, score: number) => ({ key, origin: 'entry' as const, scopeKey: 'project:p', score, title: key, snippet: '', trust: 'trusted' as const, updatedAt: 1 });
  return [
    {
      name: `${name}：多路融合不丢不重`,
      async run() {
        const out = ranker.fuse([[hit('a', 1), hit('b', 0.5)], [hit('b', 1), hit('c', 0.2)]]);
        must(new Set(out.map((h) => h.key)).size === out.length && out.length === 3, '三条、不重复');
        must(out[0]!.key === 'b', '两路都有的排最前');
        must(ranker.fuse([[hit('x', 0.3)]])[0]!.score === 0.3, '单路原样');
      }
    }
  ];
}

/** 维护任务：空库返回 0；跑两次不出错（幂等，不会把同一批再处理一遍）。 */
export function maintenanceJobContract(name: string, job: MemoryMaintenanceJob, make: () => Promise<{ store: MemoryStore; index: MemoryIndex; seed?: (store: MemoryStore) => Promise<void>; now: number }>): ContractCase[] {
  const indexDoc = (entry: MemoryEntry): IndexDoc => ({ key: `entry:${entry.id}`, scopeKey: scopeKey(entry.scope), origin: 'entry', title: entry.title, text: entry.body, kind: entry.kind, trust: entry.trust, updatedAt: entry.updatedAt, ref: null });
  return [
    {
      name: `${name}：空库 0 条；第二次跑不重复处理`,
      async run() {
        const empty = await make();
        must((await job.run({ now: empty.now, store: empty.store, index: empty.index, indexDoc })).count === 0, '空库 0 条');
        const seeded = await make();
        await seeded.seed?.(seeded.store);
        await job.run({ now: seeded.now, store: seeded.store, index: seeded.index, indexDoc });
        must((await job.run({ now: seeded.now, store: seeded.store, index: seeded.index, indexDoc })).count === 0, '第二次 0 条');
      }
    }
  ];
}

/** 治理：密钥过滤认得常见密钥、放过普通文字；写入策略对 agent 写 procedural 不能直接 accept。 */
export function governanceContract(name: string, pieces: { secretFilter?: MemorySecretFilter; policy?: MemoryPolicy }): ContractCase[] {
  const out: ContractCase[] = [];
  if (pieces.secretFilter) {
    const f = pieces.secretFilter;
    out.push({
      name: `${name}：密钥过滤`,
      async run() {
        must(f.check(`token ${SECRET}`) !== null, '认得 sk- 密钥');
        must(f.check('上线前做数据库快照') === null, '放过普通文字');
      }
    });
  }
  if (pieces.policy) {
    const p = pieces.policy;
    out.push({
      name: `${name}：agent 写工作方式要人确认`,
      async run() {
        const d = await p.onWrite({ scope: { kind: 'project', projectId: 'p' as never }, kind: 'procedural', title: 't', body: 'b' }, { author: 'agent', own: false, canReview: false, projectMode: 'open' } as never);
        must(d.action !== 'accept', 'procedural by agent ≠ accept');
      }
    });
  }
  return out;
}
