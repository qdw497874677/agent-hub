import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDescriptor } from '../agent.ts';
import { asAgentId } from '../ids.ts';
import { available, capabilityMatrix } from '../capability.ts';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { createProjectUseCase } from './projects.ts';
import { prepareLongLivedWorkspaceUseCase } from './workspaces.ts';
import { createTaskUseCase } from './tasks.ts';
import { deriveSessionUseCase } from './sessions.ts';
import { ingestWorkerEvent, promptSessionUseCase } from './conversation.ts';
import { listProjectFiles } from './attachments.ts';
import { HANDOFF_LIMIT, continueElsewhereUseCase, handoffBrief } from './continue-elsewhere.ts';

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

test('换个地方继续：到另一台机器的已有工作空间，项目不变，交接带工作日志背景', async () => {
  const w = await world();
  const there = await prepareLongLivedWorkspaceUseCase(w.deps, { projectId: w.project.id, workerId: 'studio', plan: { mode: 'link', path: '/srv/demo' }, home: '/home/me' });
  assert.ok(there.ok, JSON.stringify(there));
  const before = await w.deps.projects.byId(w.project.id);
  const moved = await continueElsewhereUseCase(w.deps, { sessionId: w.session.id, target: { kind: 'workspace', workspaceId: there.value.id }, home: '/home/me' });
  assert.ok(moved.ok, JSON.stringify(moved));
  assert.deepEqual(await w.deps.projects.byId(w.project.id), before);
  assert.equal(moved.value.workerId, 'studio');
  assert.equal(moved.value.workspaceId, there.value.id);
  assert.deepEqual(moved.value.origin, { kind: 'fork', fromSessionId: w.session.id, atSeq: w.session.lastSeq + 4 });

  // 新开（不 resume），目录用目标工作空间的；第一条消息是任务背景 + 交接摘要
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
  assert.match(prompt.text, /代码改动留在原机器上的 \/tmp\/demo/);
  assert.match(prompt.text, /任务/);

  const files = await listProjectFiles(w.deps, w.project.id, '', moved.value.id);
  assert.ok(files.ok && files.value.files.includes('on-studio.ts'));
});

test('换个地方继续：原模型目标机器上没有，就用目标机器上这个 agent 的默认模型', async () => {
  const w = await world();
  w.workers[1] = { ...w.workers[1]!, agentModels: [{ agentId: 'fake', models: ['far-a', 'far-b'], defaultModel: 'far-b' }] };
  const there = await prepareLongLivedWorkspaceUseCase(w.deps, { projectId: w.project.id, workerId: 'studio', plan: { mode: 'link', path: '/srv/demo' }, home: '/home/me' });
  assert.ok(there.ok, JSON.stringify(there));
  const moved = await continueElsewhereUseCase(w.deps, { sessionId: w.session.id, target: { kind: 'workspace', workspaceId: there.value.id }, home: '/home/me' });
  assert.ok(moved.ok, JSON.stringify(moved));
  assert.equal(moved.value.model, 'far-b');
  const start = w.dispatched.filter((c) => c.kind === 'start_session').at(-1);
  assert.ok(start?.kind === 'start_session' && start.options.model === 'far-b');
});

test('派生会话：点名的模型落点机器上没有，直接拒绝，不发一条注定失败的会话', async () => {
  const w = await world();
  w.workers[1] = { ...w.workers[1]!, agentModels: [{ agentId: 'fake', models: ['far-a'], defaultModel: 'far-a' }] };
  const there = await prepareLongLivedWorkspaceUseCase(w.deps, { projectId: w.project.id, workerId: 'studio', plan: { mode: 'link', path: '/srv/demo' }, home: '/home/me' });
  assert.ok(there.ok, JSON.stringify(there));
  const before = w.dispatched.length;
  const denied = await deriveSessionUseCase(w.deps, { taskId: w.session.taskId, agentId: 'fake', model: 'm1', workspaceId: there.value.id });
  assert.ok(!denied.ok && denied.error.code === 'conflict');
  assert.match(denied.error.message, /工作站.*没有模型 m1/);
  assert.equal(w.dispatched.length, before);
  const fine = await deriveSessionUseCase(w.deps, { taskId: w.session.taskId, agentId: 'fake', model: 'far-a', workspaceId: there.value.id });
  assert.ok(fine.ok, JSON.stringify(fine));
  assert.equal(fine.value.workerId, 'studio');
  // 空串 = 用 agent 自己的默认，总是放行
  const blank = await deriveSessionUseCase(w.deps, { taskId: w.session.taskId, agentId: 'fake', model: '', workspaceId: there.value.id });
  assert.ok(blank.ok, JSON.stringify(blank));
});

test('换个地方继续：先提交 WIP 并推送，目标新开临时工作空间沿用同一分支', async () => {
  const w = await world();
  await w.deps.projects.save({ ...w.project, repo: { url: 'git@example.com:me/demo.git', defaultBranch: 'main' } });
  const [source] = await w.deps.workspaces.byProject(w.project.id);
  assert.ok(source);
  await w.deps.workspaces.save({ ...source, isGit: true, branch: 'feat/dark' });
  w.git.statuses.set('/tmp/demo', { dirty: true, untracked: 1, unpushed: 0, branch: 'feat/dark', upstream: null });

  const moved = await continueElsewhereUseCase(w.deps, { sessionId: w.session.id, target: { kind: 'temporary', workerId: 'studio' }, saveWip: true, home: '/home/me' });
  assert.ok(moved.ok, JSON.stringify(moved));
  assert.ok(w.git.calls.some((c) => c.startsWith('local:save_wip:/tmp/demo:WIP')));
  assert.ok(w.git.calls.some((c) => c.startsWith('studio:worktree:') && c.includes('@feat/dark:existing')));
  const target = await w.deps.workspaces.byId(moved.value.workspaceId!);
  assert.equal(target?.kind, 'temporary');
  assert.equal(target?.branch, 'feat/dark');
  const prompt = w.dispatched.at(-1);
  assert.ok(prompt?.kind === 'prompt' && /推送到分支 feat\/dark，这里检出的就是这个分支/.test(prompt.text));
});

test('换个地方继续：同一台机器推送 WIP 后，新临时工作空间开新分支、从 WIP 分支长出来', async () => {
  const w = await world();
  const [source] = await w.deps.workspaces.byProject(w.project.id);
  await w.deps.workspaces.save({ ...source!, isGit: true, branch: 'feat/dark' });
  w.git.statuses.set('/tmp/demo', { dirty: true, untracked: 0, unpushed: 0, branch: 'feat/dark', upstream: null });
  const moved = await continueElsewhereUseCase(w.deps, { sessionId: w.session.id, target: { kind: 'temporary', workerId: null }, saveWip: true, home: '/home/me' });
  assert.ok(moved.ok, JSON.stringify(moved));
  const call = w.git.calls.find((c) => c.startsWith('local:worktree:'));
  assert.ok(call && !call.includes(':existing') && call.endsWith('<feat/dark'), call);
  const prompt = w.dispatched.at(-1);
  assert.ok(prompt?.kind === 'prompt' && /推送到分支 feat\/dark，这里的新分支 agent-hub\/.+ 就是从它长出来的/.test(prompt.text));
});

test('换个地方继续：非 git 项目新开临时目录；同一个工作空间、离线、空会话都说清楚', async () => {
  const w = await world();
  const [source] = await w.deps.workspaces.byProject(w.project.id);
  const same = await continueElsewhereUseCase(w.deps, { sessionId: w.session.id, target: { kind: 'workspace', workspaceId: source!.id }, home: '/home/me' });
  assert.ok(!same.ok && /已经在这个工作空间/.test(same.error.message));

  const plain = await continueElsewhereUseCase(w.deps, { sessionId: w.session.id, target: { kind: 'temporary', workerId: 'studio' }, saveWip: true, home: '/home/me' });
  assert.ok(plain.ok, JSON.stringify(plain));
  const target = await w.deps.workspaces.byId(plain.value.workspaceId!);
  assert.equal(target?.source, 'created');
  assert.match(target!.path, /^\/srv\/agent-hub-workspaces\/\.tmp\//);
  assert.ok(!w.git.calls.some((c) => c.includes('save_wip')));

  w.workers[1] = { ...w.workers[1]!, state: 'offline' };
  const offline = await continueElsewhereUseCase(w.deps, { sessionId: w.session.id, target: { kind: 'temporary', workerId: 'studio' }, home: '/home/me' });
  assert.ok(!offline.ok && offline.error.code === 'unavailable');
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
