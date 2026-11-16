import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDescriptor } from '../agent.ts';
import { asAgentId, type SessionId, type TaskId } from '../ids.ts';
import { capabilityMatrix, available } from '../capability.ts';
import type { ToolContext } from '../ports/tool-provider.ts';
import type { ToolScope } from '../tool.ts';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { createProjectUseCase } from '../use-cases/projects.ts';
import { createTaskUseCase } from '../use-cases/tasks.ts';
import { deriveSessionUseCase } from '../use-cases/sessions.ts';
import { ARTIFACT_TOOLS, ARTIFACT_LIMITS, createArtifactToolProvider } from './artifact-tools.ts';

const agent: AgentDescriptor = {
  id: asAgentId('fake'),
  label: 'Fake',
  capabilities: capabilityMatrix({ prompt: available, interrupt: available, fork: available, resume: available, tool_calls: available, artifacts: available, structured_events: available, attachments: available }),
  models: ['m1'],
  defaultModel: 'm1',
  options: []
};

async function world() {
  // 默认时钟每次 +1：list 的倒序断言才稳定。
  const w = inMemoryDeps();
  w.agents.push(agent);
  const project = await createProjectUseCase(w.deps, { name: 'demo', rootPath: '/tmp/demo/' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: '主任务' });
  assert.ok(task.ok);
  const other = await createTaskUseCase(w.deps, { projectId: project.value.id, title: '别的任务' });
  assert.ok(other.ok);
  const session = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  assert.ok(session.ok);
  const otherSession = await deriveSessionUseCase(w.deps, { taskId: other.value.id, agentId: 'fake', model: 'm1' });
  assert.ok(otherSession.ok);
  const provider = createArtifactToolProvider({
    sessions: w.deps.sessions,
    artifacts: w.deps.artifacts,
    tasks: w.deps.tasks,
    workLog: w.deps.workLog,
    now: () => w.deps.now()
  });
  return { ...w, provider, project: project.value, task: task.value, other: other.value, session: session.value, otherSession: otherSession.value };
}

const ctx = (sessionId: SessionId, taskId: TaskId | null, scopes: ToolScope[]): ToolContext => ({
  grant: { id: 'g1', tokenHash: 'h', taskId, sessionId, workerId: null, scopes, createdAt: 0, expiresAt: 1e12, revokedAt: null },
  now: 1000
});

const full: ToolScope[] = ['artifact', 'task:read', 'task:log:write'];

test('工具清单：三个 artifact 工具，中文四段描述与限流', () => {
  assert.deepEqual(ARTIFACT_TOOLS.map((tool) => tool.name), ['artifact.list', 'artifact.add', 'artifact.get']);
  for (const tool of ARTIFACT_TOOLS) {
    assert.equal(tool.scope, 'artifact');
    assert.equal(tool.perMinute, 12);
    assert.equal(tool.version, 1);
    for (const section of ['何时用', '参数', '返回', '下一步与错误']) assert.ok(tool.description.includes(section), `${tool.name} 缺 ${section}`);
  }
  const add = ARTIFACT_TOOLS.find((tool) => tool.name === 'artifact.add')!;
  assert.deepEqual(add.inputSchema['required'], ['title', 'url']);
  assert.equal(ARTIFACT_LIMITS.title, 200);
  assert.equal(ARTIFACT_LIMITS.description, 2000);
});

test('artifact.add 落一行引用产物 + 一条 system 日志；list 倒序、get 读得回', async () => {
  const w = await world();
  const c = ctx(w.session.id, w.task.id, full);
  // 建任务 / 开会话都会写系统日志，先记下条数，只看这两次 add 留下的。
  const before = (await w.deps.workLog.list(w.task.id, { limit: 50 })).length;
  const first = await w.provider.call('artifact.add', { title: '设计稿', url: 'https://example.com/design', description: '这版是最终稿' }, c);
  assert.ok(first.ok);
  const one = first.value as Record<string, unknown>;
  assert.equal(one['title'], '设计稿');
  assert.equal(one['url'], 'https://example.com/design');
  assert.equal(one['type'], 'link');
  assert.equal(one['size'], 0);
  assert.equal(one['task_id'], w.task.id);
  assert.equal(one['logged'], true);

  const second = await w.provider.call('artifact.add', { title: '周报', url: 'http://example.com/weekly' }, c);
  assert.ok(second.ok);

  const rows = await w.deps.artifacts.byTask(w.task.id);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => [row.path, row.bytes, row.label, row.sessionId]),
    [
      ['https://example.com/design', 0, '设计稿', w.session.id],
      ['http://example.com/weekly', 0, '周报', w.session.id]
    ]
  );

  const log = await w.deps.workLog.list(w.task.id, { limit: 50 });
  assert.equal(log.length, before + 2);
  const [weekly, design] = log;
  assert.deepEqual([weekly!.author.kind, design!.author.kind], ['system', 'system']);
  assert.equal(design!.body, '这版是最终稿');
  assert.deepEqual(design!.links, [
    { kind: 'artifact', ref: one['id'] as string, label: '设计稿' },
    { kind: 'url', ref: 'https://example.com/design', label: '设计稿' }
  ]);
  // 没有说明时用一句话记下链接。
  assert.equal(weekly!.body, '引用产物「周报」：http://example.com/weekly');

  const list = await w.provider.call('artifact.list', {}, c);
  assert.ok(list.ok);
  const listed = (list.value as { artifacts: Array<Record<string, unknown>> }).artifacts;
  assert.deepEqual(listed.map((row) => row['title']), ['周报', '设计稿']);
  assert.equal(listed[0]!['link'], 'http://example.com/weekly');
  assert.equal(listed[0]!['type'], 'link');
  assert.equal(listed[0]!['session_id'], w.session.id);

  const got = await w.provider.call('artifact.get', { id: one['id'] }, c);
  assert.ok(got.ok);
  assert.equal((got.value as Record<string, unknown>)['title'], '设计稿');
  assert.equal((got.value as Record<string, unknown>)['task_id'], w.task.id);
});

test('工作空间文件（path 不是 http）标成 file；容器会话没人任务，add 拒绝', async () => {
  const w = await world();
  const c = ctx(w.session.id, w.task.id, full);
  await w.deps.artifacts.save({ id: 'a-file' as never, sessionId: w.session.id, taskId: w.task.id, path: 'dist/report.pdf', bytes: 2048, label: 'report.pdf', createdAt: 5 });
  const list = await w.provider.call('artifact.list', {}, c);
  assert.ok(list.ok);
  const listed = (list.value as { artifacts: Array<Record<string, unknown>> }).artifacts;
  assert.deepEqual(listed.map((row) => [row['type'], row['path'], row['size']]), [['file', 'dist/report.pdf', 2048]]);
  assert.equal(listed[0]!['link'], undefined);

  const container = await w.provider.call('artifact.add', { title: 't', url: 'https://e.co' }, ctx(w.session.id, null, full));
  assert.equal(container.ok, false);
  assert.equal((container as { error: { code: string } }).error.code, 'forbidden');
});

test('权限：list/get 要 task:read；add 要 task:log:write；网关外再查一层', async () => {
  const w = await world();
  const bare = ctx(w.session.id, w.task.id, ['artifact']);
  assert.equal(((await w.provider.call('artifact.list', {}, bare)) as { error?: { code: string } }).error?.code, 'forbidden');
  assert.equal(((await w.provider.call('artifact.get', { id: 'a' }, bare)) as { error?: { code: string } }).error?.code, 'forbidden');
  const noLog = ctx(w.session.id, w.task.id, ['artifact', 'task:read']);
  const added = await w.provider.call('artifact.add', { title: 't', url: 'https://e.co' }, noLog);
  assert.equal(added.ok, false);
  assert.equal((added as { error: { code: string } }).error.code, 'forbidden');
  assert.equal((await w.deps.artifacts.byTask(w.task.id)).length, 0);
});

test('参数校验与未知工具：invalid / notFound 都是中文', async () => {
  const w = await world();
  const c = ctx(w.session.id, w.task.id, full);
  const cases: Array<[string, Record<string, unknown>]> = [
    ['artifact.add', { url: 'https://e.co' }],
    ['artifact.add', { title: '   ', url: 'https://e.co' }],
    ['artifact.add', { title: 'x'.repeat(ARTIFACT_LIMITS.title + 1), url: 'https://e.co' }],
    ['artifact.add', { title: 't' }],
    ['artifact.add', { title: 't', url: 'ftp://e.co' }],
    ['artifact.add', { title: 't', url: 'e.co' }],
    ['artifact.add', { title: 't', url: 'https://e.co', description: 'x'.repeat(ARTIFACT_LIMITS.description + 1) }],
    ['artifact.add', { title: 't', url: 'https://e.co', extra: 1 }],
    ['artifact.get', {}]
  ];
  for (const [name, input] of cases) {
    const got = await w.provider.call(name, input, c);
    assert.equal(got.ok, false, `${name} ${JSON.stringify(input)} 应该被拒`);
    assert.equal((got as { error: { code: string } }).error.code, 'invalid', JSON.stringify(input));
  }
  const unknown = await w.provider.call('artifact.delete', {}, c);
  assert.equal((unknown as { error: { code: string } }).error.code, 'not_found');
  assert.equal((unknown as { error: { message: string } }).error.message, '没有这个工具：artifact.delete');
});

test('artifact.get 跨任务 / 别的会话一律 notFound', async () => {
  const w = await world();
  const mine = await w.provider.call('artifact.add', { title: '我的', url: 'https://e.co/a' }, ctx(w.session.id, w.task.id, full));
  assert.ok(mine.ok);
  const id = (mine.value as { id: string }).id;

  const otherTask = ctx(w.otherSession.id, w.other.id, full);
  const stolen = await w.provider.call('artifact.get', { id }, otherTask);
  assert.equal(stolen.ok, false);
  assert.equal((stolen as { error: { code: string } }).error.code, 'not_found');
  const empty = await w.provider.call('artifact.list', {}, otherTask);
  assert.ok(empty.ok);
  assert.deepEqual((empty.value as { artifacts: unknown[] }).artifacts, []);

  const missing = await w.provider.call('artifact.get', { id: 'nope' }, ctx(w.session.id, w.task.id, full));
  assert.equal((missing as { error: { code: string } }).error.code, 'not_found');
});

test('会话不存在：notFound，不写产物', async () => {
  const w = await world();
  const ghost = ctx('s-ghost' as SessionId, w.task.id, full);
  const got = await w.provider.call('artifact.add', { title: 't', url: 'https://e.co' }, ghost);
  assert.equal((got as { error: { code: string } }).error.code, 'not_found');
  assert.equal((await w.deps.artifacts.byTask(w.task.id)).length, 0);
});
