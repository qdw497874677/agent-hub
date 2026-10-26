import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, asAgentId, createProject, createTask, deriveSession, type Session } from '@agent-hub/domain';
import { openSqliteStore } from './store.ts';

/**
 * 搜索的 SQL 只在这个文件里被测——它是唯一知道 LIKE 与 payload 形状的地方。
 * 用例覆盖三件事：命中任务标题、命中会话正文、以及 `%` 不该被当成通配符。
 */
async function seed() {
  const store = openSqliteStore(':memory:');
  const now = 1_700_000_000_000;

  const project = createProject({
    name: 'demo',
    now,
    id: undefined
  });
  assert.ok(project.ok);

  const task = createTask({
    projectId: project.value.id,
    title: '画布上要有血缘线',
    goal: '让 S6.3 可验证',
    now,
    id: undefined
  });
  assert.ok(task.ok);

  const other = createTask({
    projectId: project.value.id,
    title: '100% 覆盖率的假任务',
    now,
    id: undefined
  });
  assert.ok(other.ok);

  const derived = deriveSession({ task: task.value, agentId: asAgentId('pi'), model: '', now });
  assert.ok(derived.ok);
  let session: Session = derived.value;
  await store.projects.save(project.value);
  await store.tasks.save(task.value);
  await store.tasks.save(other.value);
  await store.sessions.save(session);

  // journal 只能通过 append 落盘（事件与游标同一次提交），不能靠 save 伪造
  const events = [
    // 故意把一句话切成三段：真实的流式回复就是这样落盘的
    { kind: 'text' as const, delta: '先把正交' },
    { kind: 'text' as const, delta: '布线做出来，血' },
    { kind: 'text' as const, delta: '缘线用虚线区分分叉。' },
    { kind: 'tool_call' as const, name: 'write', input: '{"path":"canvas.tsx"}' }
  ];
  for (const event of events) {
    session = applyEvent(session, event, now);
    await store.sessions.append(session, event, now);
  }

  return { store, project: project.value, task: task.value, other: other.value, session };
}

test('搜得到任务标题，也搜得到会话里说过的话', async () => {
  const { store, project, session } = await seed();

  const byTitle = await store.search.search({ projectId: project.id, query: '血缘', limit: 20 });
  assert.deepEqual(
    byTitle.map((hit) => hit.kind),
    ['session', 'task'],
    '会话正文与任务标题都命中「血缘」，会话排在前面（更像人想找的东西）'
  );

  const bySessionText = await store.search.search({ projectId: project.id, query: '正交布线', limit: 20 });
  assert.equal(bySessionText.length, 1);
  assert.equal(bySessionText[0]?.kind, 'session');
  assert.equal(bySessionText[0]?.sessionId, session.id);
  assert.match(bySessionText[0]?.snippet ?? '', /正交布线/);

  store.close();
});

test('跨 delta 的一句话能被搜到：搜索的单位是会话文本，不是单条事件', async () => {
  const { store, project } = await seed();

  // 流式回复就是这样落盘的：一句话被拆成几十行 journal
  const hits = await store.search.search({ projectId: project.id, query: '正交布线做出来', limit: 20 });
  assert.equal(hits.length, 1, '「正交布线做出来」跨了三行 journal，按行匹配会漏');
  assert.equal(hits[0]?.kind, 'session');
  store.close();
});

test('同一个会话命中多次只出一条', async () => {
  const { store, project, session } = await seed();
  const repeated = applyEvent(session, { kind: 'text', delta: '血缘线，还是血缘线' }, 1);
  await store.sessions.save(repeated);

  const hits = await store.search.search({ projectId: project.id, query: '血缘', limit: 20 });
  assert.equal(hits.filter((hit) => hit.kind === 'session').length, 1);
  store.close();
});

test('LIKE 的通配符被转义：搜 100% 不会匹配一切', async () => {
  const { store, project, other } = await seed();

  const hits = await store.search.search({ projectId: project.id, query: '100%', limit: 20 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.taskId, other.id);
  store.close();
});

test('按项目隔离：别的项目里的东西搜不到', async () => {
  const { store } = await seed();
  const other = createProject({
    name: '别的',
    now: 1,
    id: undefined
  });
  assert.ok(other.ok);
  await store.projects.save(other.value);

  const hits = await store.search.search({ projectId: other.value.id, query: '血缘', limit: 20 });
  assert.equal(hits.length, 0);
  store.close();
});

test('空搜索词由用例层拒绝，端口本身不做业务判断', async () => {
  const { store, project } = await seed();
  const hits = await store.search.search({ projectId: project.id, query: '', limit: 20 });
  assert.equal(hits.length, 0, '空词没有命中，但这不是端口该报的错');
  store.close();
});
