import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  asAgentId,
  asSessionId,
  asWorkspaceId,
  createProjectUseCase,
  createTaskUseCase,
  deriveSessionUseCase,
  prepareTemporaryWorkspaceUseCase,
  type AccessPolicy,
  type AgentDescriptor,
  type DomainError,
  type Result,
  type Subject
} from '@agent-hub/domain';
import { fakeAgentProfiles, inMemoryDeps } from '@agent-hub/domain/testing';
import { resolveSpawnWorker, spawnAgentAction, type SpawnAgentContext } from './wire-tools.ts';

const owner = {
  user: { id: 'u1', teamId: 'team1', role: 'member', disabledAt: null, deletedAt: null, clusterAdmin: false },
  loginId: 'l1'
} as unknown as Subject;

const agent: AgentDescriptor = {
  id: asAgentId('fake'),
  label: 'Fake',
  capabilities: {
    prompt: { state: 'available' },
    interrupt: { state: 'available' },
    fork: { state: 'available' },
    resume: { state: 'available' },
    tool_calls: { state: 'available' },
    artifacts: { state: 'available' },
    structured_events: { state: 'available' },
    attachments: { state: 'available' }
  },
  models: ['m1', 'm2'],
  defaultModel: 'm1',
  options: []
};

const allowTeam = (denied: readonly string[] = []): AccessPolicy => ({
  context: async () => ({ hubTeamId: 'team1', settings: { membersCanAddMachines: false } }) as never,
  worker: async (workerId) => ({
    kind: 'worker',
    id: workerId ?? 'local',
    teamId: denied.includes(workerId ?? '') ? 'team2' : 'team1',
    createdBy: null
  })
});

const bus: SpawnAgentContext['messageBus'] = {
  setHandle: async () => ({ ok: true, value: { handle: 'child' } }),
  handleOf: async () => 'child'
};

const context: SpawnAgentContext = {
  subjectOf: async () => owner,
  checkModel: async () => ({ ok: true, value: null }),
  messageBus: bus,
  home: () => '/tmp'
};

function failure(result: Result<unknown, DomainError>): DomainError {
  assert.equal(result.ok, false, JSON.stringify(result));
  if (result.ok) throw new Error('unreachable');
  return result.error;
}

async function world(options: { access?: AccessPolicy; repos?: { id: string; name: string; url: string; defaultBranch: string }[] } = {}) {
  const w = inMemoryDeps({
    agentProfiles: fakeAgentProfiles(),
    links: {
      listByProject: async () => [],
      forSession: async () => [],
      areLinked: async () => false,
      save: async () => {},
      remove: async () => {},
      removeByProject: async () => {}
    },
    ...(options.access ? { access: options.access } : {})
  });
  w.agents.push(agent);
  w.workers.push(
    { workerId: 'remote-a', label: 'Remote A', origin: 'remote', state: 'online' },
    { workerId: 'remote-b', label: 'Remote B', origin: 'remote', state: 'online' },
    { workerId: 'remote-off', label: 'Remote Offline', origin: 'remote', state: 'offline' }
  );

  const project = await createProjectUseCase(w.deps, {
    name: 'spawn',
    actor: owner,
    ...(options.repos ? { repos: options.repos, primaryRepoId: options.repos[0]?.id } : {})
  });
  assert.ok(project.ok, JSON.stringify(project));
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: '编排' });
  assert.ok(task.ok, JSON.stringify(task));

  const callerWorkspace = await prepareTemporaryWorkspaceUseCase(w.deps, {
    projectId: project.value.id,
    taskId: task.value.id,
    workerId: 'remote-a',
    home: '/tmp',
    mode: 'empty',
    actor: owner
  });
  assert.ok(callerWorkspace.ok, JSON.stringify(callerWorkspace));

  const caller = await deriveSessionUseCase(w.deps, {
    taskId: task.value.id,
    agentId: 'fake',
    model: 'm1',
    workspaceId: callerWorkspace.value.id,
    createdBy: 'u1',
    actor: owner
  });
  assert.ok(caller.ok, JSON.stringify(caller));
  assert.equal(caller.value.workerId, 'remote-a');

  return { w, project: project.value, task: task.value, caller: caller.value, callerWorkspace: callerWorkspace.value };
}

const input = (overrides: Partial<Parameters<typeof spawnAgentAction>[2]>) => ({
  taskId: '',
  agentId: 'fake',
  model: 'm2',
  options: { mode: 'plan' },
  createdBy: 'u1',
  callerSessionId: '',
  ...overrides
});

test('resolveSpawnWorker：默认跟随发起会话记录的远端 Worker', async () => {
  const { w, project, caller } = await world();
  const target = await resolveSpawnWorker(w.deps, { callerSessionId: caller.id, projectId: project.id });
  assert.ok(target.ok, JSON.stringify(target));
  assert.deepEqual(target.value, { workerId: 'remote-a', source: 'session' });
});

test('resolveSpawnWorker：会话没记 Worker 时才用其工作空间绑定，并拒绝互相矛盾的记录', async () => {
  const { w, project, task, caller } = await world();
  await w.deps.sessions.save({ ...caller, workerId: null });
  const fromWorkspace = await resolveSpawnWorker(w.deps, { callerSessionId: caller.id, projectId: project.id });
  assert.ok(fromWorkspace.ok, JSON.stringify(fromWorkspace));
  assert.deepEqual(fromWorkspace.value, { workerId: 'remote-a', source: 'workspace' });

  const other = await prepareTemporaryWorkspaceUseCase(w.deps, {
    projectId: project.id,
    taskId: task.id,
    workerId: 'remote-b',
    home: '/tmp',
    mode: 'empty',
    actor: owner
  });
  assert.ok(other.ok, JSON.stringify(other));
  await w.deps.sessions.save({ ...caller, workerId: 'remote-a', workspaceId: other.value.id });
  const mismatch = failure(await resolveSpawnWorker(w.deps, { callerSessionId: caller.id, projectId: project.id }));
  assert.match(mismatch.message, /不一致/);
  assert.match(mismatch.message, /worker_id/);
});

test('resolveSpawnWorker：没有记录或记录已失效时明确要求 worker_id，不回退 Hub 本机', async () => {
  const { w, project, caller } = await world();
  await w.deps.sessions.save({ ...caller, workerId: null, workspaceId: null });
  const missing = failure(await resolveSpawnWorker(w.deps, { callerSessionId: caller.id, projectId: project.id }));
  assert.match(missing.message, /worker_id/);
  assert.match(missing.message, /Hub 本机/);

  await w.deps.sessions.save({ ...caller, workerId: 'ghost' });
  const unknown = failure(await resolveSpawnWorker(w.deps, { callerSessionId: caller.id, projectId: project.id }));
  assert.match(unknown.message, /ghost/);
  assert.match(unknown.message, /worker_id/);

  const offline = failure(
    await resolveSpawnWorker(w.deps, { callerSessionId: caller.id, projectId: project.id, requestedWorkerId: 'remote-off' })
  );
  assert.match(offline.message, /离线/);
  assert.match(offline.message, /worker_id/);
});

test('agent.spawn：未传 worker_id 的隔离空间落到发起会话的远端 Worker，并保留模型/选项/任务', async () => {
  const { w, project, task, caller } = await world();
  const beforeSessions = (await w.deps.sessions.listAll()).length;
  const result = await spawnAgentAction(w.deps, context, input({
    taskId: task.id,
    callerSessionId: caller.id,
    workspaceMode: 'isolated'
  }));
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.value.taskId, task.id);
  assert.equal(result.value.model, 'm2');

  const child = await w.deps.sessions.byId(asSessionId(result.value.sessionId));
  assert.ok(child);
  assert.equal(child.workerId, 'remote-a', '不能落到 Hub 本机或别的机器');
  assert.deepEqual(child.options, { mode: 'plan' });
  assert.equal(child.taskId, task.id);
  assert.equal((await w.deps.sessions.listAll()).length, beforeSessions + 1);

  const workspace = await w.deps.workspaces.byId(asWorkspaceId(result.value.workspaceId!));
  assert.ok(workspace);
  assert.equal(workspace.workerId, 'remote-a');
  assert.equal(workspace.projectId, project.id);
});

test('agent.spawn：shared 准备在会话没记 Worker 时采用已验证的工作空间绑定', async () => {
  const { w, task, caller } = await world();
  await w.deps.sessions.save({ ...caller, workerId: null });
  const result = await spawnAgentAction(w.deps, context, input({
    taskId: task.id,
    callerSessionId: caller.id,
    workspaceMode: 'shared'
  }));
  assert.ok(result.ok, JSON.stringify(result));
  const child = await w.deps.sessions.byId(asSessionId(result.value.sessionId));
  assert.equal(child?.workerId, 'remote-a');
  const workspace = await w.deps.workspaces.byId(asWorkspaceId(result.value.workspaceId!));
  assert.equal(workspace?.workerId, 'remote-a');
});

test('agent.spawn：显式且已授权的 worker_id 覆盖会话默认机器', async () => {
  const { w, task, caller } = await world({ access: allowTeam() });
  const result = await spawnAgentAction(w.deps, context, input({
    taskId: task.id,
    callerSessionId: caller.id,
    workspaceMode: 'shared',
    workerId: 'remote-b'
  }));
  assert.ok(result.ok, JSON.stringify(result));
  const child = await w.deps.sessions.byId(asSessionId(result.value.sessionId));
  assert.equal(child?.workerId, 'remote-b');
  const workspace = await w.deps.workspaces.byId(asWorkspaceId(result.value.workspaceId!));
  assert.equal(workspace?.workerId, 'remote-b');
});

test('agent.spawn：不认识的机器和未授权的显式覆盖都在准备前失败，不产生会话/工作空间', async () => {
  const { w, project, task, caller } = await world({ access: allowTeam(['remote-b']) });
  const sessionsBefore = (await w.deps.sessions.listAll()).length;
  const workspacesBefore = (await w.deps.workspaces.byProject(project.id)).length;
  const gitBefore = [...w.git.calls];

  const unknown = failure(await spawnAgentAction(w.deps, context, input({
    taskId: task.id,
    callerSessionId: caller.id,
    workspaceMode: 'isolated',
    workerId: 'nope'
  })));
  assert.match(unknown.message, /worker_id/);

  const denied = failure(await spawnAgentAction(w.deps, context, input({
    taskId: task.id,
    callerSessionId: caller.id,
    workspaceMode: 'isolated',
    workerId: 'remote-b'
  })));
  assert.match(denied.message, /机器/);

  const nullCaller = { ...caller, workerId: null, workspaceId: null };
  await w.deps.sessions.save(nullCaller);
  const missing = failure(await spawnAgentAction(w.deps, context, input({
    taskId: task.id,
    callerSessionId: nullCaller.id,
    workspaceMode: 'isolated'
  })));
  assert.match(missing.message, /worker_id/);

  assert.equal((await w.deps.sessions.listAll()).length, sessionsBefore);
  assert.equal((await w.deps.workspaces.byProject(project.id)).length, workspacesBefore);
  assert.deepEqual(w.git.calls, gitBefore);
});

test('agent.spawn：repo_id 在发起会话的远端 Worker 上开 worktree', async () => {
  const { w, task, caller } = await world({
    repos: [{ id: 'repo_api', name: 'api', url: 'https://example.com/acme/api.git', defaultBranch: 'main' }]
  });
  const result = await spawnAgentAction(w.deps, context, input({
    taskId: task.id,
    callerSessionId: caller.id,
    repoId: 'repo_api'
  }));
  assert.ok(result.ok, JSON.stringify(result));
  const workspace = await w.deps.workspaces.byId(asWorkspaceId(result.value.workspaceId!));
  assert.ok(workspace);
  assert.equal(workspace.workerId, 'remote-a');
  assert.equal(workspace.kind, 'temporary');
  assert.equal(workspace.isGit, true);
  assert.ok(w.git.calls.some((call) => call.startsWith('remote-a:worktree:')), w.git.calls.join('\n'));
  assert.ok(!w.git.calls.some((call) => call.startsWith('local:')), '不能在 Hub 本机执行 git');
  const child = await w.deps.sessions.byId(asSessionId(result.value.sessionId));
  assert.equal(child?.workerId, 'remote-a');
});
