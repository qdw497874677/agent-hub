import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MEMORY_GUIDANCE,
  MEMORY_GUIDANCE_TOKEN_LIMIT,
  MEMORY_TOOLS,
  TOKEN_NEVER_GRANTABLE,
  asAgentId,
  defaultMemoryRegistry,
  createMemoryService,
  createMemoryToolProvider,
  createProject,
  createTask,
  deriveSession,
  estimateTokens,
  type MemoryDistiller,
  type MemoryServiceDeps,
  type MemorySource,
  type Principal,
  type User
} from '@agent-hub/domain';
import { inMemoryDeps } from '@agent-hub/domain/testing';
import { openSqliteStore } from './store.ts';
import { ftsTerms } from './memory.ts';

const DAY = 24 * 60 * 60 * 1000;
const user = (id: string, role: string): User => ({ id, email: `${id}@x.test`, displayName: id, role, teamId: 'T', disabledAt: null, deletedAt: null, clusterAdmin: false }) as unknown as User;

async function world(extra: { distiller?: MemoryDistiller; checkDistillModel?: MemoryServiceDeps['checkDistillModel'] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mem-'));
  const store = openSqliteStore(join(dir, 'hub.db'));
  let clock = 10 * DAY;
  const deps = inMemoryDeps({ now: () => clock }).deps;
  const users = new Map(['alice:member', 'bob:member', 'vicky:viewer', 'olga:owner', 'adam:admin'].map((s) => s.split(':') as [string, string]).map(([id, role]) => [id, user(id, role)]));
  const principal = (id: string) => ({ user: users.get(id), loginId: 'l' }) as unknown as Principal;
  const project = createProject({ name: 'p', now: 1, teamId: 'T', createdBy: 'alice' });
  assert.ok(project.ok);
  await deps.projects.save(project.value);
  const task = createTask({ projectId: project.value.id, title: 't', goal: '', now: 1 });
  assert.ok(task.ok);
  await deps.tasks.save(task.value);
  const session = deriveSession({ task: task.value, agentId: asAgentId('pi'), model: '', now: 1, createdBy: 'alice' });
  assert.ok(session.ok);
  await deps.sessions.save(session.value);
  const docs = new Map([['docs/a.md', { text: '部署要先做数据库快照 snapshot', hash: 'h1' }]]);
  const source: MemorySource = {
    id: 'docs',
    scopeKinds: ['project'],
    async scan() {
      return { partial: false, docs: [...docs].map(([uri, d]) => ({ ref: { source: 'docs', uri, hash: d.hash }, title: uri, text: d.text, updatedAt: 1 })) };
    },
    async read(_scope, ref) {
      return docs.get(ref.uri) ?? null;
    }
  };
  const audits: { action: string; detail: string }[] = [];
  const service = createMemoryService({
    now: () => clock,
    sessions: deps.sessions,
    tasks: deps.tasks,
    projects: deps.projects,
    ...store.memory,
    ...defaultMemoryRegistry().source(source).build({ index: store.memory.index, store: store.memory.store }),
    ...(extra.distiller ? { distiller: extra.distiller } : {}),
    ...(extra.checkDistillModel ? { checkDistillModel: extra.checkDistillModel } : {}),
    audit: { append: async (entry) => void audits.push(entry) },
    principalOf: async (id) => (users.has(id) ? principal(id) : null),
    sourceTtlMs: 0
  });
  const agent = { kind: 'session', sessionId: session.value.id } as const;
  const human = (id: string) => ({ kind: 'user', principal: principal(id) }) as const;
  const pkey = `project:${project.value.id}`;
  return { service, agent, human, principal, pkey, projectId: project.value.id, docs, audits, tick: (ms: number) => (clock += ms), close: () => (store.close(), rmSync(dir, { recursive: true, force: true })) };
}

test('agent 写项目记忆：只追加默认直接生效但不可信；搜索结果包 untrusted；看不到项目的人搜不到', async () => {
  const w = await world();
  const wrote = await w.service.write(w.agent, { scope: 'project', kind: 'semantic', title: '部署约定', body: '上线前必须做数据库快照，再 ff-only 合并' });
  assert.ok(wrote.ok);
  assert.equal(wrote.value.status, 'active');
  assert.equal(wrote.value.trust, 'untrusted');
  const found = await w.service.search(w.agent, { query: '数据库快照', include: ['entries'] });
  assert.ok(found.ok);
  assert.equal(found.value.length, 1);
  assert.match(found.value[0]!.snippet, /^<memory trust="untrusted" source="entry:/);
  const viewer = await w.service.search(w.human('vicky'), { query: '数据库快照', scopes: [w.pkey], include: ['entries'] });
  assert.ok(viewer.ok);
  assert.equal(viewer.value.length, 1);
  const bob = await w.service.search(w.human('bob'), { query: '数据库快照', scopes: [w.pkey] });
  assert.ok(bob.ok);
  assert.equal(bob.value.length, 0);
  assert.ok(w.audits.some((a) => a.action === 'memory.write'));
  w.close();
});

test('审核模式：agent 写进 proposed，搜不到；owner 通过后变 active + trusted；成员不能审', async () => {
  const w = await world();
  assert.equal((await w.service.setProjectMode(w.principal('alice'), w.projectId, 'review')).ok, false);
  assert.ok((await w.service.setProjectMode(w.principal('olga'), w.projectId, 'review')).ok);
  const wrote = await w.service.write(w.agent, { scope: 'project', kind: 'semantic', title: '命名', body: '分支用 feat/ 前缀命名' });
  assert.ok(wrote.ok);
  assert.equal(wrote.value.status, 'proposed');
  const before = await w.service.search(w.agent, { query: '分支用', include: ['entries'] });
  assert.ok(before.ok);
  assert.equal(before.value.length, 0);
  assert.equal((await w.service.review(w.principal('alice'), wrote.value.id, true)).ok, false);
  assert.equal((await w.service.pending(w.principal('olga'))).length, 1);
  const approved = await w.service.review(w.principal('olga'), wrote.value.id, true);
  assert.ok(approved.ok);
  assert.equal(approved.value.status, 'active');
  assert.equal(approved.value.trust, 'trusted');
  const after = await w.service.search(w.agent, { query: '分支用', include: ['entries'] });
  assert.ok(after.ok);
  assert.equal(after.value.length, 1);
  assert.doesNotMatch(after.value[0]!.snippet, /untrusted/);
  assert.equal(after.value[0]!.trust, 'trusted');
  w.close();
});

test('procedural 要人确认；user 作用域 agent 写的要本人确认', async () => {
  const w = await world();
  const proc = await w.service.write(w.agent, { scope: 'project', kind: 'procedural', title: '发版清单', body: '1. ci 2. e2e 3. 快照' });
  assert.ok(proc.ok);
  assert.equal(proc.value.status, 'proposed');
  const pref = await w.service.write(w.agent, { scope: 'user', kind: 'preference', title: '语言', body: 'PR 用中文写' });
  assert.ok(pref.ok);
  assert.equal(pref.value.status, 'proposed');
  assert.ok((await w.service.review(w.principal('alice'), pref.value.id, true)).ok);
  const own = await w.service.write(w.human('alice'), { scope: 'user:alice', kind: 'preference', title: '缩进', body: '两个空格' });
  assert.ok(own.ok);
  assert.equal(own.value.status, 'active');
  w.close();
});

test('写入限制：密钥拒绝并审计，超过 4k 拒绝；agent 不能用完整作用域键', async () => {
  const w = await world();
  const secret = await w.service.write(w.agent, { scope: 'project', kind: 'semantic', title: 'key', body: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789' });
  assert.equal(secret.ok, false);
  assert.ok(w.audits.some((a) => a.action === 'memory.reject'));
  const long = await w.service.write(w.agent, { scope: 'project', kind: 'semantic', title: 'x', body: 'a'.repeat(4001) });
  assert.equal(long.ok, false);
  const raw = await w.service.write(w.agent, { scope: 'user:bob', kind: 'semantic', title: 'x', body: 'y' });
  assert.equal(raw.ok, false);
  w.close();
});

test('取代：旧条目 superseded、搜不到；只能取代同作用域里有效的', async () => {
  const w = await world();
  const old = await w.service.write(w.agent, { scope: 'project', kind: 'semantic', title: '端口', body: '服务监听端口 17800' });
  assert.ok(old.ok);
  const next = await w.service.write(w.agent, { scope: 'project', kind: 'semantic', title: '端口', body: '服务监听端口 17900', supersedes: [old.value.id] });
  assert.ok(next.ok);
  const found = await w.service.search(w.agent, { query: '监听端口', include: ['entries'] });
  assert.ok(found.ok);
  assert.deepEqual(found.value.map((r) => r.id), [next.value.id]);
  const again = await w.service.write(w.agent, { scope: 'project', kind: 'semantic', title: '端口', body: '再改', supersedes: [old.value.id] });
  assert.equal(again.ok, false);
  w.close();
});

test('忘掉：别人看不到就是 not found；本人可以；episodic 90 天后过期', async () => {
  const w = await world();
  const ep = await w.service.write(w.agent, { scope: 'project', kind: 'episodic', title: '故障', body: '昨天构建超时了一次' });
  assert.ok(ep.ok);
  const bob = await w.service.forget(w.human('bob'), ep.value.id, '错的');
  assert.equal(bob.ok, false);
  w.tick(91 * DAY);
  const found = await w.service.search(w.agent, { query: '构建超时', include: ['entries'] });
  assert.ok(found.ok);
  assert.equal(found.value.length, 0);
  const forgot = await w.service.forget(w.human('alice'), ep.value.id, '没用了');
  assert.ok(forgot.ok);
  assert.equal(forgot.value.status, 'forgotten');
  w.close();
});

test('来源就地索引：搜得到、包 untrusted；出处变一次 stale，变两次 invalidated', async () => {
  const w = await world();
  const hits = await w.service.search(w.agent, { query: '快照', include: ['sources'] });
  assert.ok(hits.ok);
  assert.equal(hits.value.length, 1);
  assert.equal(hits.value[0]!.origin, 'source');
  assert.match(hits.value[0]!.snippet, /<memory trust="untrusted" source="docs:docs\/a.md">/);
  const wrote = await w.service.write(w.human('alice'), { scope: w.pkey, kind: 'semantic', title: '部署', body: '看 docs/a.md', sources: [{ source: 'docs', uri: 'docs/a.md', hash: 'h1' }] });
  assert.ok(wrote.ok);
  w.docs.set('docs/a.md', { text: '部署要先做快照（改过）', hash: 'h2' });
  await w.service.reindex(w.projectId);
  const once = await w.service.get(w.agent, { id: wrote.value.id });
  assert.ok(once.ok);
  assert.equal((once.value as { stale: boolean }).stale, true);
  assert.equal((once.value as { status: string }).status, 'active');
  w.docs.set('docs/a.md', { text: '又改了', hash: 'h3' });
  await w.service.reindex(w.projectId);
  const twice = await w.service.get(w.agent, { id: wrote.value.id });
  assert.ok(twice.ok);
  assert.equal((twice.value as { status: string }).status, 'invalidated');
  const read = await w.service.get(w.agent, { ref: { source: 'docs', uri: 'docs/a.md' } });
  assert.ok(read.ok);
  assert.match((read.value as { text: string }).text, /又改了/);
  w.close();
});

test('彻底删除只给 owner；审核和彻底删除令牌拿不到', async () => {
  const w = await world();
  const wrote = await w.service.write(w.human('alice'), { scope: w.pkey, kind: 'semantic', title: 'x', body: 'y' });
  assert.ok(wrote.ok);
  assert.equal((await w.service.purge(w.principal('adam'), wrote.value.id)).ok, false);
  assert.ok((await w.service.purge(w.principal('olga'), wrote.value.id)).ok);
  assert.ok(TOKEN_NEVER_GRANTABLE.has('memory.purge'));
  assert.ok(TOKEN_NEVER_GRANTABLE.has('memory.review'));
  w.close();
});

test('MCP 工具：描述要求先搜；工具调用走会话身份；静态引导不超过 80 token', async () => {
  const w = await world();
  const search = MEMORY_TOOLS.find((t) => t.name === 'memory.search');
  assert.match(search!.description, /FIRST/);
  assert.deepEqual(MEMORY_TOOLS.map((t) => t.name).sort(), ['memory.forget', 'memory.get', 'memory.list', 'memory.search', 'memory.write']);
  assert.ok(estimateTokens(MEMORY_GUIDANCE) <= MEMORY_GUIDANCE_TOKEN_LIMIT);
  const provider = createMemoryToolProvider(w.service);
  const ctx = { grant: { sessionId: w.agent.sessionId }, now: 0 } as never;
  const wrote = await provider.call('memory.write', { scope: 'session', kind: 'episodic', title: '进度', body: '做完第一步了' }, ctx);
  assert.ok(wrote.ok);
  const listed = await provider.call('memory.list', { scope: 'session' }, ctx);
  assert.ok(listed.ok);
  assert.equal((listed.value as unknown[]).length, 1);
  w.close();
});

test('FTS 查询词：短词走 LIKE，标点当分隔', () => {
  assert.deepEqual(ftsTerms('快照 deploy'), { match: '"deploy"', short: ['快照'] });
  assert.equal(ftsTerms('a"bcd').match, '"bcd"');
});

test('P2 压缩摘要：session: 一条生效，项目层 staged 一条 + 工作方式候选进待审；同一代只跑一次；默认搜不到 staged', async () => {
  const w = await world();
  const summary = '# 修好了登录重定向\n- 约定：上线前必须做数据库快照\n- 改了 auth.ts 的回调地址';
  const first = await w.service.ingestCompaction(w.agent.sessionId, { seq: 7, summary, tokensBefore: 50_000 });
  assert.equal(first.written, 3);
  const again = await w.service.ingestCompaction(w.agent.sessionId, { seq: 7, summary, tokensBefore: 50_000 });
  assert.equal(again.written, 0);
  const session = await w.service.list(w.human('alice'), { scope: `session:${w.agent.sessionId}` });
  assert.ok(session.ok);
  assert.equal(session.value.length, 1);
  assert.equal(session.value[0]!.status, 'active');
  assert.equal(session.value[0]!.provenance.via, 'compaction');
  const project = await w.service.list(w.human('alice'), { scope: w.pkey });
  assert.ok(project.ok);
  assert.deepEqual(project.value.map((e) => `${e.kind}:${e.status}:${e.trust}`).sort(), ['episodic:staged:untrusted', 'procedural:proposed:untrusted']);
  const hidden = await w.service.search(w.human('alice'), { query: '登录重定向', scopes: [w.pkey], include: ['entries'] });
  assert.ok(hidden.ok);
  assert.equal(hidden.value.length, 0);
  const shown = await w.service.search(w.human('alice'), { query: '登录重定向', scopes: [w.pkey], include: ['entries'], includeStaged: true });
  assert.ok(shown.ok);
  assert.equal(shown.value[0]!.status, 'staged');
  const pending = await w.service.pending(w.principal('olga'));
  assert.equal(pending.length, 2);
  w.close();
});

test('P2 提炼的护栏：太短不提炼、含密钥整条不写、HUB_MEMORY_DISTILL=0 关掉', async () => {
  const w = await world();
  const short = await w.service.ingestCompaction(w.agent.sessionId, { seq: 1, summary: '小改动', tokensBefore: 500 });
  assert.equal(short.written, 1);
  assert.match(short.skipped ?? '', /太短/);
  const secret = await w.service.ingestCompaction(w.agent.sessionId, { seq: 2, summary: 'API_KEY=abcdef1234567890 记一下', tokensBefore: 50_000 });
  assert.equal(secret.written, 0);
  process.env.HUB_MEMORY_DISTILL = '0';
  try {
    const off = await w.service.ingestCompaction(w.agent.sessionId, { seq: 3, summary: '大改动', tokensBefore: 50_000 });
    assert.equal(off.written, 1);
    assert.match(off.skipped ?? '', /关闭/);
  } finally {
    delete process.env.HUB_MEMORY_DISTILL;
  }
  w.close();
});

test('P2 staged：别人写同标题就印证转正；有人采纳转 active+trusted；30 天没人理过期，后台整理物化', async () => {
  const w = await world();
  await w.service.ingestCompaction(w.agent.sessionId, { seq: 1, summary: '部署流程梳理', tokensBefore: 50_000 });
  const staged = (await w.service.list(w.human('alice'), { scope: w.pkey, status: ['staged'] }));
  assert.ok(staged.ok);
  const id = staged.value[0]!.id;
  // 印证：人写一条同标题（归一化后相同）
  const wrote = await w.service.write(w.human('alice'), { scope: w.pkey, kind: 'episodic', title: '会话摘要：部署流程梳理！', body: '确认过' });
  assert.ok(wrote.ok);
  const promoted = await w.service.list(w.human('alice'), { scope: w.pkey, status: ['active'] });
  assert.ok(promoted.ok);
  assert.ok(promoted.value.some((e) => e.id === id));

  await w.service.ingestCompaction(w.agent.sessionId, { seq: 2, summary: '第二件事：缓存失效', tokensBefore: 50_000 });
  const second = (await w.service.list(w.human('alice'), { scope: w.pkey, status: ['staged'] }));
  assert.ok(second.ok);
  const adopted = await w.service.review(w.principal('olga'), second.value[0]!.id, true);
  assert.ok(adopted.ok);
  assert.equal(adopted.value.status, 'active');
  assert.equal(adopted.value.trust, 'trusted');

  await w.service.ingestCompaction(w.agent.sessionId, { seq: 3, summary: '第三件事：没人理', tokensBefore: 50_000 });
  w.tick(31 * DAY);
  const swept = await w.service.sweep();
  assert.ok(swept.expired >= 1);
  const expired = await w.service.list(w.human('alice'), { scope: w.pkey, status: ['expired'] });
  assert.ok(expired.ok);
  assert.ok(expired.value.some((e) => e.title.includes('没人理')));
  w.close();
});

test('P2 冲突提示：写相似条目时给出同作用域里当前有效的相似条目，不自动合并', async () => {
  const w = await world();
  const a = await w.service.write(w.agent, { scope: 'project', kind: 'semantic', title: '部署前做数据库快照', body: '一' });
  assert.ok(a.ok);
  const b = await w.service.write(w.agent, { scope: 'project', kind: 'semantic', title: '部署前先做数据库快照', body: '二' });
  assert.ok(b.ok);
  const similar = await w.service.similar(w.agent, b.value.id);
  assert.deepEqual(similar.map((s) => s.id), [a.value.id]);
  const still = await w.service.list(w.human('alice'), { scope: w.pkey, status: ['active'] });
  assert.ok(still.ok);
  assert.equal(still.value.length, 2);
  w.close();
});

test('P2 导入：JSONL 一律 untrusted + 待审；坏行报出来；含密钥跳过；没写权限拒绝', async () => {
  const w = await world();
  const jsonl = [
    JSON.stringify({ kind: 'semantic', title: '导入的约定', body: '用 ff-only 合并', tags: ['x'] }),
    'not json',
    JSON.stringify({ kind: 'semantic', title: '密钥', body: 'API_KEY=abcdef1234567890' }),
    JSON.stringify({ kind: 'nope', title: 't', body: 'b' })
  ].join('\n');
  const result = await w.service.importEntries(w.principal('alice'), w.pkey, jsonl);
  assert.ok(result.ok);
  assert.equal(result.value.imported, 1);
  assert.deepEqual(result.value.problems.map((p) => p.line), [2, 3, 4]);
  const pending = await w.service.list(w.human('alice'), { scope: w.pkey, status: ['proposed'] });
  assert.ok(pending.ok);
  assert.equal(pending.value[0]!.trust, 'untrusted');
  assert.equal(pending.value[0]!.provenance.via, 'import');
  const viewer = await w.service.importEntries(w.principal('vicky'), w.pkey, jsonl);
  assert.equal(viewer.ok, false);
  w.close();
});

test('P2 每周抽查：最近 7 天自动转正的提炼条目抽 5%（至少 3 条）回待审；同一周不重抽', async () => {
  const w = await world();
  for (let i = 0; i < 4; i++) {
    await w.service.ingestCompaction(w.agent.sessionId, { seq: i + 1, summary: `第 ${i} 件事`, tokensBefore: 50_000 });
  }
  const staged = await w.service.list(w.human('alice'), { scope: w.pkey, status: ['staged'] });
  assert.ok(staged.ok);
  for (const entry of staged.value) await w.service.write(w.human('alice'), { scope: w.pkey, kind: 'episodic', title: entry.title, body: '印证' });
  const first = await w.service.sweep();
  assert.equal(first.spotChecked, 3);
  const back = await w.service.list(w.human('alice'), { scope: w.pkey, status: ['proposed'] });
  assert.ok(back.ok);
  assert.equal(back.value.filter((e) => e.tags.includes('spot-check')).length, 3);
  const second = await w.service.sweep();
  assert.equal(second.spotChecked, 0);
  w.close();
});

test('模型版提炼器：只在要提炼时才调；session: 仍是规则版摘要；active / 含密钥的候选被服务端丢掉', async () => {
  const calls: string[] = [];
  const distiller: MemoryDistiller = {
    id: 'model',
    async distill(input) {
      calls.push(input.projectId);
      return [
        { status: 'staged', draft: { kind: 'episodic', title: '模型摘要', body: '模型写的摘要' } },
        { status: 'active' as never, draft: { kind: 'semantic', title: '越权', body: '想直接生效' } },
        { status: 'proposed', draft: { kind: 'procedural', title: '带密钥', body: 'API_KEY=abcdef1234567890' } },
        { status: 'proposed', draft: { kind: 'procedural', title: '上线前快照', body: '上线前必须先做数据库快照' } }
      ];
    }
  };
  const w = await world({ distiller });
  try {
    const short = await w.service.ingestCompaction(w.agent.sessionId, { seq: 1, summary: '小改动', tokensBefore: 500 });
    assert.equal(calls.length, 0, '太短的会话不调模型');
    assert.equal(short.written, 1);
    const prev = process.env.HUB_MEMORY_DISTILL;
    process.env.HUB_MEMORY_DISTILL = '0';
    try {
      await w.service.ingestCompaction(w.agent.sessionId, { seq: 2, summary: '大改动', tokensBefore: 50_000 });
    } finally {
      if (prev === undefined) delete process.env.HUB_MEMORY_DISTILL;
      else process.env.HUB_MEMORY_DISTILL = prev;
    }
    assert.equal(calls.length, 0, '全局关了不调模型');
    const got = await w.service.ingestCompaction(w.agent.sessionId, { seq: 3, summary: '部署流程梳理完了', tokensBefore: 50_000 });
    assert.deepEqual(calls, [w.projectId]);
    assert.equal(got.written, 3, 'session 摘要 + staged + 一条 proposed');
    const listed = await w.service.list(w.human('alice'), { scope: w.pkey, status: ['active', 'staged', 'proposed'] });
    assert.ok(listed.ok);
    const titles = listed.value.map((e) => `${e.title}:${e.status}`).sort();
    assert.ok(titles.includes('模型摘要:staged'));
    assert.ok(titles.includes('上线前快照:proposed'));
    assert.ok(!titles.some((t) => t.startsWith('越权') || t.startsWith('带密钥')));
  } finally {
    w.close();
  }
});

test('项目提炼模型设置：要 memory.review，要过 hub 核对；改了记审计', async () => {
  const checked: string[] = [];
  const w = await world({ checkDistillModel: async (_p, _project, model) => (checked.push(model), model === 'hub-x/ok' ? { ok: true, value: true } : { ok: false, error: { code: 'invalid', message: '不能用' } }) });
  try {
    const empty = await w.service.distillSettings(w.principal('olga'), w.projectId);
    assert.ok(empty.ok);
    assert.equal(empty.value.model, null);
    const bad = await w.service.setDistillModel(w.principal('olga'), w.projectId, 'hub-x/no');
    assert.ok(!bad.ok);
    const set = await w.service.setDistillModel(w.principal('olga'), w.projectId, 'hub-x/ok');
    assert.ok(set.ok, JSON.stringify(set));
    assert.equal((await w.service.distillSettings(w.principal('olga'), w.projectId)).ok && set.value.model, 'hub-x/ok');
    assert.ok(w.audits.some((a) => a.action === 'memory.settings' && a.detail.includes('hub-x/ok')));
    const back = await w.service.setDistillModel(w.principal('olga'), w.projectId, null);
    assert.ok(back.ok && back.value.model === null);
    const outsider = await w.service.setDistillModel(w.principal('vicky'), w.projectId, 'hub-x/ok');
    assert.ok(!outsider.ok);
  } finally {
    w.close();
  }
});
