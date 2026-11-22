import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyEvent,
  asAgentId,
  asProjectId,
  asSessionId,
  asTaskId,
  createProject,
  createTask,
  deriveSession,
  metadataSearchUseCase,
  type AccessPolicy,
  type MetadataSearchGateway,
  type MetadataSearchQuery,
  type MetadataSearchScope,
  type Principal,
  type ProjectId,
  type Session,
  type User
} from '@agent-hub/domain';
import { createMetadataSearch } from './metadata-search.ts';
import { openSqliteStore } from './store.ts';

const now = 1_700_000_000_000;

function must<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  assert.ok(result.ok);
  return result.value;
}

function scopeOf(ids: readonly ProjectId[]): MetadataSearchScope {
  return { projects: ids, tasks: ids, sessions: ids };
}

/** 测试里大多数用例关心搜索本身；统一补上「全部可见」的 scope。 */
type ScopedSearchGateway = {
  search(query: Omit<MetadataSearchQuery, 'scope'>): ReturnType<MetadataSearchGateway['search']>;
};

function scoped(gateway: MetadataSearchGateway, scope: MetadataSearchScope): ScopedSearchGateway {
  return { search: (query) => gateway.search({ ...query, scope }) };
}

async function seed() {
  const store = openSqliteStore(':memory:');

  const alpha = must(
    createProject({
      id: asProjectId('p-alpha'),
      name: 'Alpha 空项目',
      description: '项目描述里的秘密关键词',
      now,
      createdBy: 'u1'
    })
  );
  const percent = must(createProject({ id: asProjectId('p-percent'), name: '100% 覆盖项目', now, createdBy: 'u1' }));
  const underscore = must(createProject({ id: asProjectId('p-underscore'), name: 'a_b 项目', now, createdBy: 'u1' }));
  const lookalike = must(createProject({ id: asProjectId('p-lookalike'), name: 'axb 项目', now, createdBy: 'u1' }));
  const quote = must(createProject({ id: asProjectId('p-quote'), name: "O'Brien 项目", now, createdBy: 'u1' }));
  const deleted = { ...must(createProject({ id: asProjectId('p-deleted'), name: '已删项目', now })), deletedAt: now + 1 };

  const zeroSessionTask = must(
    createTask({ id: asTaskId('t-zero'), projectId: alpha.id, title: '零会话任务', goal: '目标正文机密', now })
  );
  const task = must(createTask({ id: asTaskId('t-main'), projectId: alpha.id, title: '主任务', goal: '', now }));
  const batchA = must(createTask({ id: asTaskId('t-batch-a'), projectId: alpha.id, title: '批量任务 A', now }));
  const batchB = must(createTask({ id: asTaskId('t-batch-b'), projectId: alpha.id, title: '批量任务 B', now }));
  const batchC = must(createTask({ id: asTaskId('t-batch-c'), projectId: alpha.id, title: '批量任务 C', now }));
  const deletedTask = must(createTask({ id: asTaskId('t-deleted'), projectId: deleted.id, title: '已删项目的任务', now }));

  for (const item of [alpha, percent, underscore, lookalike, quote, deleted]) await store.projects.save(item);
  for (const item of [zeroSessionTask, task, batchA, batchB, batchC, deletedTask]) await store.tasks.save(item);

  const named = must(
    deriveSession({ id: asSessionId('sess-named'), task, agentId: asAgentId('pi'), model: '', now: now + 50 })
  );
  const old = must(
    deriveSession({ id: asSessionId('sess-old-2025'), task, agentId: asAgentId('pi'), model: '', now: now + 10 })
  );
  const container = must(
    deriveSession({ id: asSessionId('sess-container'), agentId: asAgentId('pi'), model: '', now: now + 40, originProjectId: alpha.id })
  );
  const side = must(
    deriveSession({
      id: asSessionId('sess-side'),
      agentId: asAgentId('pi'),
      model: '',
      now: now + 60,
      kind: 'side',
      originProjectId: alpha.id
    })
  );
  const noOrigin = must(
    deriveSession({ id: asSessionId('sess-no-origin'), agentId: asAgentId('pi'), model: '', now: now + 30 })
  );
  const deletedSession = must(
    deriveSession({ id: asSessionId('sess-deleted'), task: deletedTask, agentId: asAgentId('pi'), model: '', now: now + 20 })
  );

  const sessions: readonly [Session, string | null][] = [
    [named, '命名会话标题'],
    [old, null],
    [container, '容器会话'],
    [side, '侧聊会话'],
    [noOrigin, '无源会话'],
    [deletedSession, '已删项目的会话']
  ];
  for (const [session, title] of sessions) {
    await store.sessions.save({ ...session, title, updatedAt: session.updatedAt });
  }

  // 正文投影：元数据搜索绝不该命中它。
  let withText = named;
  const textEvent = { kind: 'text' as const, delta: '会话正文里的唯一词' };
  withText = applyEvent(withText, textEvent, now + 51);
  await store.sessions.append(withText, textEvent, now + 51);

  const scope = scopeOf([alpha.id, percent.id, underscore.id, lookalike.id, quote.id, deleted.id]);
  return { store, scope, alpha, percent, underscore, lookalike, quote, named, old, container, side, noOrigin };
}

test('项目按名字命中：含空项目；% / _ / 引号按字面值；回收站不出现', async () => {
  const { store, alpha, percent, scope } = await seed();
  const search = scoped(createMetadataSearch(store.db), scope);

  const empty = await search.search({ query: '空项目', limitPerGroup: 10 });
  assert.deepEqual(empty.projects.map((item) => item.projectId), [alpha.id]);

  const literalPercent = await search.search({ query: '100%', limitPerGroup: 10 });
  assert.deepEqual(literalPercent.projects.map((item) => item.projectId), [percent.id], '% 不是通配符');

  const literalUnderscore = await search.search({ query: 'a_b', limitPerGroup: 10 });
  assert.deepEqual(literalUnderscore.projects.map((item) => item.projectId), [asProjectId('p-underscore')], '_ 不是单字符通配符');

  const quotes = await search.search({ query: "O'Brien", limitPerGroup: 10 });
  assert.deepEqual(quotes.projects.map((item) => item.projectId), [asProjectId('p-quote')], '引号走绑定参数，不拼 SQL');

  const deleted = await search.search({ query: '已删', limitPerGroup: 10 });
  assert.deepEqual(deleted.projects, []);

  store.close();
});

test('任务只搜标题：零会话任务可命中，目标正文不命中', async () => {
  const { store, scope } = await seed();
  const search = scoped(createMetadataSearch(store.db), scope);

  const byTitle = await search.search({ query: '零会话', limitPerGroup: 10 });
  assert.deepEqual(byTitle.tasks.map((item) => item.taskId), [asTaskId('t-zero')]);
  assert.equal(byTitle.tasks[0]?.projectId, asProjectId('p-alpha'));

  const byGoal = await search.search({ query: '目标正文机密', limitPerGroup: 10 });
  assert.deepEqual(byGoal.tasks, []);
  assert.deepEqual(byGoal.sessions, []);
  assert.deepEqual(byGoal.projects, []);

  const byDescription = await search.search({ query: '项目描述里的秘密关键词', limitPerGroup: 10 });
  assert.deepEqual(byDescription.projects, [], '项目描述不进快速跳转搜索');
  assert.deepEqual(byDescription.tasks, []);
  assert.deepEqual(byDescription.sessions, []);

  store.close();
});

test('会话：命名标题可搜，老会话按精确 id 可搜；正文、侧聊、无出生项目不入结果', async () => {
  const { store, named, old, container, alpha, scope } = await seed();
  const search = scoped(createMetadataSearch(store.db), scope);

  const byTitle = await search.search({ query: '命名会话', limitPerGroup: 10 });
  assert.deepEqual(byTitle.sessions.map((item) => item.sessionId), [named.id]);
  assert.equal(byTitle.sessions[0]?.title, '命名会话标题');

  const byId = await search.search({ query: 'sess-old-2025', limitPerGroup: 10 });
  assert.deepEqual(byId.sessions.map((item) => item.sessionId), [old.id]);
  assert.equal(byId.sessions[0]?.title, null, '老会话没命名：界面用 id 兜底');
  assert.equal(byId.sessions[0]?.taskTitle, '主任务');

  const transcript = await search.search({ query: '会话正文里的唯一词', limitPerGroup: 10 });
  assert.deepEqual(transcript.sessions, [], '不读 session_text');

  const side = await search.search({ query: '侧聊', limitPerGroup: 10 });
  assert.deepEqual(side.sessions, [], '侧聊不进常规跳转');

  const noOrigin = await search.search({ query: '无源', limitPerGroup: 10 });
  assert.deepEqual(noOrigin.sessions, [], '来源项目无法证明时失败关闭');

  const containerHit = await search.search({ query: '容器', limitPerGroup: 10 });
  assert.deepEqual(containerHit.sessions.map((item) => item.sessionId), [container.id]);
  assert.equal(containerHit.sessions[0]?.taskId, null);
  assert.equal(containerHit.sessions[0]?.projectId, null, '容器会话的 projectId 不是任务项目');
  assert.equal(containerHit.sessions[0]?.originProjectId, alpha.id);

  store.close();
});

test('会话按更新时间倒序，id 做稳定兜底；每组条数上限生效', async () => {
  const { store, scope } = await seed();
  const search = scoped(createMetadataSearch(store.db), scope);

  const ordered = await search.search({ query: '会话', limitPerGroup: 10 });
  assert.deepEqual(ordered.sessions.map((item) => item.sessionId), [
    asSessionId('sess-named'),
    asSessionId('sess-container')
  ]);

  const batch = await search.search({ query: '批量任务', limitPerGroup: 2 });
  assert.equal(batch.tasks.length, 2);
  assert.deepEqual(batch.tasks.map((item) => item.taskId), [asTaskId('t-batch-a'), asTaskId('t-batch-b')]);

  const clampedLow = await search.search({ query: '批量任务', limitPerGroup: 0 });
  assert.equal(clampedLow.tasks.length, 1);
  const clampedHigh = await search.search({ query: '批量任务', limitPerGroup: 500 });
  assert.equal(clampedHigh.tasks.length, 3, '实际只有 3 条；上限不放大结果');

  store.close();
});

test('授权范围在 LIMIT 之前过滤：超过上限的不可见命中不挤掉可读结果和精确 id', async () => {
  const store = openSqliteStore(':memory:');
  const allowed = must(
    createProject({ id: asProjectId('p-allowed'), name: '回归关键词项目 ZZZ 可见', now, createdBy: 'u1' })
  );
  await store.projects.save(allowed);

  const allowedTask = must(
    createTask({ id: asTaskId('t-allowed'), projectId: allowed.id, title: '回归关键词任务 ZZZ 可见', now })
  );
  await store.tasks.save({ ...allowedTask, updatedAt: now + 50 });

  const hiddenIds: ProjectId[] = [];
  for (let index = 0; index < 25; index++) {
    const suffix = String(index).padStart(2, '0');
    const hidden = must(
      createProject({
        id: asProjectId(`p-hidden-${suffix}`),
        name: `回归关键词项目 ${suffix}`,
        now,
        createdBy: 'u1'
      })
    );
    hiddenIds.push(hidden.id);
    await store.projects.save(hidden);

    const task = must(
      createTask({
        id: asTaskId(`t-hidden-${suffix}`),
        projectId: hidden.id,
        title: `回归关键词任务 ${suffix}`,
        now
      })
    );
    // 比可见任务新：没有 scope 时它们会先占满 LIMIT。
    await store.tasks.save({ ...task, updatedAt: now + 100 + index });

    const session = must(
      deriveSession({
        id: asSessionId(`sess-hidden-${suffix}`),
        agentId: asAgentId('pi'),
        model: '',
        now: now + 100 + index,
        originProjectId: hidden.id
      })
    );
    await store.sessions.save({
      ...session,
      title: `回归关键词会话 sess-metadata-target-2024 ${suffix}`,
      updatedAt: now + 100 + index
    });
  }

  const allowedSession = must(
    deriveSession({
      id: asSessionId('sess-metadata-target-2024'),
      agentId: asAgentId('pi'),
      model: '',
      now: now + 50,
      originProjectId: allowed.id
    })
  );
  await store.sessions.save({
    ...allowedSession,
    title: '回归关键词会话 ZZZ 可见',
    updatedAt: now + 50
  });

  // 先证明夹具确实会触发旧问题：全量 scope 下，25 条不可见命中占满前 10 条。
  const allSearch = scoped(createMetadataSearch(store.db), scopeOf([allowed.id, ...hiddenIds]));
  const crowded = await allSearch.search({ query: 'sess-metadata-target-2024', limitPerGroup: 10 });
  assert.equal(crowded.sessions.length, 10);
  assert.ok(crowded.sessions.every((hit) => hit.sessionId !== allowedSession.id), '旧行为会把精确 id 挤掉');

  const visibleSearch = scoped(createMetadataSearch(store.db), scopeOf([allowed.id]));
  const byExactId = await visibleSearch.search({ query: 'sess-metadata-target-2024', limitPerGroup: 10 });
  assert.deepEqual(byExactId.sessions.map((hit) => hit.sessionId), [allowedSession.id], 'scope 先过滤，精确 id 不被挤掉');

  const byProject = await visibleSearch.search({ query: '回归关键词项目', limitPerGroup: 10 });
  assert.deepEqual(byProject.projects.map((hit) => hit.projectId), [allowed.id]);

  const byTask = await visibleSearch.search({ query: '回归关键词任务', limitPerGroup: 10 });
  assert.deepEqual(byTask.tasks.map((hit) => hit.taskId), [allowedTask.id]);

  const bySessionTitle = await visibleSearch.search({ query: '回归关键词会话', limitPerGroup: 10 });
  assert.deepEqual(bySessionTitle.sessions.map((hit) => hit.sessionId), [allowedSession.id]);

  store.close();
});

test('真实 SQLite + 正常授权：空项目、零会话任务可命中；容器只认出生项目，任务会话认任务项目', async () => {
  const store = openSqliteStore(':memory:');
  const visible = must(
    createProject({ id: asProjectId('p-meta-visible'), name: '权限可见空项目', now, createdBy: 'mem' })
  );
  const privateProject = must(
    createProject({ id: asProjectId('p-meta-private'), name: '权限私密项目', now, createdBy: 'other' })
  );
  await store.projects.save(visible);
  await store.projects.save(privateProject);

  const visibleTask = must(
    createTask({ id: asTaskId('t-meta-visible'), projectId: visible.id, title: '权限零会话任务', now })
  );
  const privateTask = must(
    createTask({ id: asTaskId('t-meta-private'), projectId: privateProject.id, title: '权限私密任务', now })
  );
  await store.tasks.save(visibleTask);
  await store.tasks.save(privateTask);

  const sessions = [
    // 容器会话：只认不可变出生项目。
    must(deriveSession({ id: asSessionId('s-meta-container'), agentId: asAgentId('pi'), model: '', now: now + 20, originProjectId: visible.id })),
    must(deriveSession({ id: asSessionId('s-meta-container-private'), agentId: asAgentId('pi'), model: '', now: now + 21, originProjectId: privateProject.id })),
    // 有任务：任务项目优先，出生项目可见也不能反向洗白。
    must(deriveSession({ id: asSessionId('s-meta-task'), task: visibleTask, agentId: asAgentId('pi'), model: '', now: now + 22, originProjectId: privateProject.id })),
    must(deriveSession({ id: asSessionId('s-meta-task-reverse'), task: privateTask, agentId: asAgentId('pi'), model: '', now: now + 23, originProjectId: visible.id })),
    must(deriveSession({ id: asSessionId('s-meta-side'), agentId: asAgentId('pi'), model: '', kind: 'side', now: now + 24, originProjectId: visible.id }))
  ];
  for (const session of sessions) {
    await store.sessions.save({ ...session, title: `权限命名 ${session.id}`, updatedAt: session.updatedAt });
  }

  const ctx = { hubTeamId: 'hub', settings: { membersCanAddMachines: false } } as const;
  const policy: AccessPolicy = { context: async () => ctx, worker: async (id) => ({ kind: 'worker', id: id ?? 'local', teamId: 'hub', createdBy: null }) };
  const member = {
    user: { id: 'mem', email: 'mem@b.co', role: 'member' as User['role'], disabledAt: null, deletedAt: null, teamId: 'hub', clusterAdmin: false },
    loginId: 'l-mem'
  } as unknown as Principal;

  const result = await metadataSearchUseCase(
    { projects: store.projects, metadataSearch: store.metadataSearch, access: policy },
    member,
    { query: '权限', limitPerGroup: 10 }
  );
  assert.ok(result.ok);
  assert.deepEqual(result.value.projects.map((hit) => hit.projectId), [visible.id], '只看得到自己的项目');
  assert.deepEqual(result.value.tasks.map((hit) => hit.taskId), [visibleTask.id], '空项目里的零会话任务可见');
  assert.deepEqual(
    result.value.sessions.map((hit) => hit.sessionId),
    [asSessionId('s-meta-task'), asSessionId('s-meta-container')],
    '容器只认出生项目；任务会话认任务项目；私密与反向都不放行；侧聊不返回'
  );

  store.close();
});

test('会话 scope 用任务项目 / 不可变出生项目：不因另一边可见而放行', async () => {
  const store = openSqliteStore(':memory:');
  const visible = must(createProject({ id: asProjectId('p-visible'), name: '可见项目', now, createdBy: 'u1' }));
  const hidden = must(createProject({ id: asProjectId('p-hidden'), name: '隐藏项目', now, createdBy: 'u1' }));
  await store.projects.save(visible);
  await store.projects.save(hidden);

  const visibleTask = must(createTask({ id: asTaskId('t-visible'), projectId: visible.id, title: '可见任务', now }));
  const hiddenTask = must(createTask({ id: asTaskId('t-hidden'), projectId: hidden.id, title: '隐藏任务', now }));
  await store.tasks.save(visibleTask);
  await store.tasks.save(hiddenTask);

  const taskInHidden = must(
    deriveSession({
      id: asSessionId('sess-task-hidden'),
      task: hiddenTask,
      agentId: asAgentId('pi'),
      model: '',
      now: now + 10,
      originProjectId: visible.id
    })
  );
  const taskInVisible = must(
    deriveSession({
      id: asSessionId('sess-task-visible'),
      task: visibleTask,
      agentId: asAgentId('pi'),
      model: '',
      now: now + 11,
      originProjectId: hidden.id
    })
  );
  const container = must(
    deriveSession({
      id: asSessionId('sess-container-visible'),
      agentId: asAgentId('pi'),
      model: '',
      now: now + 12,
      originProjectId: visible.id
    })
  );
  for (const session of [taskInHidden, taskInVisible, container]) {
    await store.sessions.save({ ...session, title: `范围会话 ${session.id}`, updatedAt: session.updatedAt });
  }

  const search = scoped(createMetadataSearch(store.db), scopeOf([visible.id]));
  const result = await search.search({ query: '范围会话', limitPerGroup: 10 });
  assert.deepEqual(
    result.sessions.map((hit) => hit.sessionId),
    [asSessionId('sess-container-visible'), asSessionId('sess-task-visible')],
    '任务项目优先；容器会话只认出生项目；另一边可见不能洗白'
  );

  store.close();
});

test('空词、超长词、回收站项目及其下任务/会话都不返回', async () => {
  const { store, scope } = await seed();
  const search = scoped(createMetadataSearch(store.db), scope);

  for (const query of ['', '   ', 'x'.repeat(161)]) {
    assert.deepEqual(await search.search({ query, limitPerGroup: 10 }), { projects: [], tasks: [], sessions: [] });
  }

  const deleted = await search.search({ query: '已删', limitPerGroup: 10 });
  assert.deepEqual(deleted.projects, []);
  assert.deepEqual(deleted.tasks, []);
  assert.deepEqual(deleted.sessions, []);

  store.close();
});
