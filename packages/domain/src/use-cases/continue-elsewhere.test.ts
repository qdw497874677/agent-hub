import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDescriptor } from '../agent.ts';
import { asAgentId } from '../ids.ts';
import { available, capabilityMatrix } from '../capability.ts';
import { workspaceFor } from '../project.ts';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { createProjectUseCase } from './projects.ts';
import { createTaskUseCase } from './tasks.ts';
import { deriveSessionUseCase } from './sessions.ts';
import { ingestWorkerEvent, promptSessionUseCase } from './conversation.ts';
import { listProjectFiles } from './attachments.ts';
import { HANDOFF_LIMIT, NEEDS_DIRECTORY, continueElsewhereUseCase, handoffBrief } from './continue-elsewhere.ts';

const fake: AgentDescriptor = {
  id: asAgentId('fake'),
  label: 'Fake',
  capabilities: capabilityMatrix({
    prompt: available,
    interrupt: available,
    fork: available,
    resume: available,
    tool_calls: available,
    artifacts: available,
    structured_events: available,
    attachments: available
  }),
  models: ['m1'],
  defaultModel: 'm1',
  options: []
};

async function world() {
  const w = inMemoryDeps();
  w.agents.push(fake);
  w.workers.push({ workerId: 'studio', label: '工作站', origin: 'remote', state: 'online', roots: ['/srv'] });
  const project = await createProjectUseCase(w.deps, { name: 'demo', rootPath: '/tmp/demo' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: 't' });
  assert.ok(task.ok);
  const session = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  assert.ok(session.ok);
  assert.ok((await promptSessionUseCase(w.deps, { sessionId: session.value.id, text: '把登录页改成暗色' })).ok);
  await ingestWorkerEvent(w.deps, session.value.id, { kind: 'text', delta: '好的，' });
  await ingestWorkerEvent(w.deps, session.value.id, { kind: 'text', delta: '改了 login.css' });
  await ingestWorkerEvent(w.deps, session.value.id, { kind: 'ended', outcome: 'done' });
  return { ...w, project: project.value, session: session.value };
}

test('换台机器继续：目标机器没登记目录时先要目录；给了就登记到项目上', async () => {
  const w = await world();
  const missing = await continueElsewhereUseCase(w.deps, { sessionId: w.session.id, workerId: 'studio' });
  assert.ok(!missing.ok && missing.error.message === NEEDS_DIRECTORY);
  const relative = await continueElsewhereUseCase(w.deps, { sessionId: w.session.id, workerId: 'studio', directory: 'srv/demo' });
  assert.ok(!relative.ok);

  const moved = await continueElsewhereUseCase(w.deps, { sessionId: w.session.id, workerId: 'studio', directory: '/srv/demo' });
  assert.ok(moved.ok, JSON.stringify(moved));
  const project = await w.deps.projects.byId(w.project.id);
  assert.deepEqual(project?.directories, { studio: '/srv/demo' });
  assert.equal(moved.value.workerId, 'studio');
  assert.deepEqual(moved.value.origin, { kind: 'fork', fromSessionId: w.session.id, atSeq: w.session.lastSeq + 4 });

  // 新开（不 resume），目录用那台的；第一条消息是交接摘要
  const start = w.dispatched.filter((c) => c.kind === 'start_session').at(-1);
  assert.ok(start?.kind === 'start_session');
  assert.equal(start.workerId, 'studio');
  assert.equal(start.workspaceRoot, '/srv/demo');
  assert.equal(start.resume, null);
  const prompt = w.dispatched.at(-1);
  assert.ok(prompt?.kind === 'prompt' && prompt.sessionId === moved.value.id);
  assert.match(prompt.text, /把登录页改成暗色/);
  assert.match(prompt.text, /好的，改了 login\.css/);
  assert.match(prompt.text, /无法带过来/);

  // 第二次去同一台不用再选目录；在新会话里 @ 列的是那台机器上的目录
  const again = await continueElsewhereUseCase(w.deps, { sessionId: w.session.id, workerId: 'studio' });
  assert.ok(again.ok);
  const files = await listProjectFiles(w.deps, w.project.id, '', moved.value.id);
  assert.ok(files.ok && files.value.files.includes('on-studio.ts'));
});

test('换台机器继续：离线、同一台、空会话都说清楚', async () => {
  const w = await world();
  const same = await continueElsewhereUseCase(w.deps, { sessionId: w.session.id, workerId: 'local' });
  assert.ok(!same.ok && /已经在这台/.test(same.error.message));
  w.workers[1] = { ...w.workers[1]!, state: 'offline' };
  const offline = await continueElsewhereUseCase(w.deps, { sessionId: w.session.id, workerId: 'studio', directory: '/srv/demo' });
  assert.ok(!offline.ok && offline.error.code === 'unavailable');
});

test('workspaceFor：会话在登记过的机器上用那台的目录，否则用项目目录', () => {
  const project = { id: 'p' as never, name: 'p', rootPath: '/a/', workerId: null, directories: { w2: '/b' }, repo: null, createdAt: 0 };
  assert.deepEqual(workspaceFor(project, 'w2'), { workerId: 'w2', root: '/b' });
  assert.deepEqual(workspaceFor(project, 'local'), { workerId: null, root: '/a' });
  assert.deepEqual(workspaceFor(project, null), { workerId: null, root: '/a' });
});

test('交接摘要：太长时保留开头和最近，并说明省略了多少', () => {
  const long = 'x'.repeat(HANDOFF_LIMIT * 2);
  const brief = handoffBrief(
    [
      { kind: 'prompt', text: '目标：重构' },
      { kind: 'text', delta: long },
      { kind: 'prompt', text: '最后一句' }
    ],
    { from: 'A', to: 'B', root: '/r' }
  );
  assert.match(brief, /目标：重构/);
  assert.match(brief, /最后一句/);
  assert.match(brief, /中间省略 \d+ 字/);
  assert.ok(brief.length < HANDOFF_LIMIT + 1000);
});
