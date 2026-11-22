import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  asLoginId,
  asSessionId,
  asTeamId,
  asUserId,
  createProjectUseCase,
  createTask,
  proposeWorkspaceDelegationUseCase,
  WORKSPACE_DELEGATE_SCOPE,
  type AccessPolicy,
  type DelegationCoordinator,
  type Principal,
  type Role,
  type Session,
  type SessionId,
  type ToolGrant,
  type ToolContext,
  type WorkspaceDelegationProposalBridges
} from '@agent-hub/domain';
import { inMemoryDeps } from '@agent-hub/domain/testing';
import { createSqliteWorkspaceDelegations } from '@agent-hub/storage-sqlite';
import {
  createWorkspaceDelegateScopeResolver,
  createWorkspaceDelegationToolProvider
} from './workspace-delegation-tool.ts';

function person(role: Role, teamId: string, id: string): Principal {
  return {
    user: {
      id: asUserId(id),
      email: `${id}@example.com`,
      displayName: id,
      role,
      passwordHash: null,
      emailVerifiedAt: 1,
      disabledAt: null,
      createdAt: 1,
      teamId: asTeamId(teamId),
      clusterAdmin: false,
      deletedAt: null
    },
    loginId: asLoginId(id)
  };
}

function policy(): AccessPolicy {
  return {
    context: async () => ({ hubTeamId: 't1', settings: { membersCanAddMachines: false } }),
    worker: async (workerId) => ({ kind: 'worker', id: workerId ?? 'local', teamId: 't1', local: false })
  };
}

async function world() {
  const w = inMemoryDeps();
  const owner = person('owner', 't1', 'u-owner');
  const access = policy();
  const deps = { ...w.deps, access };

  const created = await createProjectUseCase(deps, {
    name: 'hub',
    rootPath: '/tmp/hub',
    actor: owner,
    repoUrl: 'https://github.com/acme/app.git',
    defaultBranch: 'main'
  });
  assert.ok(created.ok, JSON.stringify(created));
  const project = created.value;

  const task = createTask({ projectId: project.id, title: '设置页拆分', now: 20 });
  assert.ok(task.ok);
  await deps.tasks.save(task.value);

  const coordinatorSessionId = asSessionId('ses-coordinator');
  const delegations = createSqliteWorkspaceDelegations(new DatabaseSync(':memory:'));

  let sessionCreatedBy: string | null | undefined = owner.user.id;
  let active = true;
  let coordinator: DelegationCoordinator | null = {
    sessionId: coordinatorSessionId,
    projectId: project.id,
    accountId: owner.user.id
  };
  const resolveCalls: SessionId[] = [];
  const planCalls: string[] = [];

  const bridgesFor = (command: { baseBranch: string; agentId: string }): WorkspaceDelegationProposalBridges => ({
    resolveCoordinator: async (sessionId) => {
      resolveCalls.push(sessionId);
      return coordinator;
    },
    plan: async (input) => {
      planCalls.push(input.requestKey);
      return {
        workerId: 'local',
        baseBranch: command.baseBranch,
        worktreePath: `/tmp/hub/.worktrees/${input.requestKey}`,
        branch: `delegation/${input.requestKey}`
      };
    }
  });

  const sessionById = async (id: SessionId): Promise<Session | null> =>
    id === coordinatorSessionId
      ? ({ id, createdBy: sessionCreatedBy } as Session)
      : null;
  const loadActor = async (userId: string): Promise<Principal | null> =>
    active && userId === owner.user.id ? owner : null;

  const provider = createWorkspaceDelegationToolProvider({
    sessions: { byId: sessionById },
    bridgesFor,
    propose: (command, bridges) => proposeWorkspaceDelegationUseCase(deps, delegations, bridges, command),
    loadActor
  });

  const scopeResolver = createWorkspaceDelegateScopeResolver({
    sessions: { byId: sessionById },
    resolveCoordinator: async (sessionId) => {
      resolveCalls.push(sessionId);
      return coordinator;
    },
    loadActor
  });

  const validInput = () => ({
    request_key: 'Proposal/01 Keep Case',
    task_id: task.value.id,
    repo_id: project.repos[0]!.id,
    base_branch: 'main',
    instructions: '把设置页拆成两个组件，并保留现有路由。',
    agent_id: 'fake'
  });

  const grant = (overrides: Partial<ToolGrant> = {}): ToolGrant => ({
    id: 'grant-1',
    tokenHash: 'hash',
    taskId: null,
    sessionId: coordinatorSessionId,
    workerId: 'local',
    scopes: [WORKSPACE_DELEGATE_SCOPE],
    createdAt: 1,
    expiresAt: 1_000,
    revokedAt: null,
    actor: { userId: owner.user.id, via: 'web' },
    ...overrides
  });
  const ctx = (overrides: Partial<ToolGrant> = {}): ToolContext => ({ grant: grant(overrides), now: 1 });

  return {
    owner,
    deps,
    project,
    task: task.value,
    coordinatorSessionId,
    delegations,
    provider,
    scopeResolver,
    validInput,
    grant,
    ctx,
    planCalls,
    resolveCalls,
    rows: () => delegations.byCoordinator(coordinatorSessionId),
    setSessionCreatedBy: (value: string | null | undefined) => {
      sessionCreatedBy = value;
    },
    setActive: (value: boolean) => {
      active = value;
    },
    setCoordinator: (value: DelegationCoordinator | null) => {
      coordinator = value;
    }
  };
}

test('workspace.delegate 只登记 pending 提案，同键重放复用且不重新规划', async () => {
  const w = await world();
  assert.deepEqual(w.provider.tools().map((descriptor) => descriptor.name), ['workspace.delegate']);
  assert.equal(w.provider.tools()[0]!.scope, WORKSPACE_DELEGATE_SCOPE);
  const sessionsBefore = (await w.deps.sessions.listAll()).length;
  const workspacesBefore = (await w.deps.workspaces.byProject(w.project.id)).length;
  const first = await w.provider.call('workspace.delegate', w.validInput(), w.ctx());

  assert.ok(first.ok, JSON.stringify(first));
  const created = first.value as {
    created: boolean;
    allocation: string;
    delegation: { state: string; requestKey: string; canConfirm: boolean };
  };
  assert.equal(created.created, true);
  assert.equal(created.allocation, 'created');
  assert.equal(created.delegation.state, 'pending');
  assert.equal(created.delegation.requestKey, 'Proposal/01 Keep Case');
  assert.equal(created.delegation.canConfirm, true);

  const rows = await w.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.state, 'pending');
  assert.equal(rows[0]!.claim, null);
  assert.equal(w.planCalls.length, 1);
  assert.ok(w.resolveCalls.length >= 1);
  // 提案车道只有登记，没有执行会话 / 工作树等外部副作用。
  assert.equal((await w.deps.sessions.listAll()).length, sessionsBefore);
  assert.equal((await w.deps.workspaces.byProject(w.project.id)).length, workspacesBefore);
  assert.ok(w.resolveCalls.every((id) => id === w.coordinatorSessionId));

  const replay = await w.provider.call('workspace.delegate', w.validInput(), w.ctx());
  assert.ok(replay.ok, JSON.stringify(replay));
  const reused = replay.value as { created: boolean; allocation: string; delegation: { state: string } };
  assert.equal(reused.created, false);
  assert.equal(reused.allocation, 'reused');
  assert.equal(reused.delegation.state, 'pending');

  // 同键重放不重新规划、不新增记录，也没有任何领取 / 准备 / 启动。
  assert.equal(w.planCalls.length, 1);
  assert.equal((await w.rows()).length, 1);
  assert.equal((await w.rows())[0]!.claim, null);
});

test('workspace.delegate 拒绝没有冻结 actor 的普通授权', async () => {
  const w = await world();
  const result = await w.provider.call('workspace.delegate', w.validInput(), w.ctx({ actor: undefined }));

  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.error.code : null, 'forbidden');
  assert.equal((await w.rows()).length, 0);
  assert.equal(w.planCalls.length, 0);
});

test('workspace.delegate 拒绝 bot 身份，即使 userId 与会话归属人一致', async () => {
  const w = await world();
  const result = await w.provider.call(
    'workspace.delegate',
    w.validInput(),
    w.ctx({ actor: { userId: w.owner.user.id, via: 'bot' } })
  );

  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.error.code : null, 'forbidden');
  assert.equal((await w.rows()).length, 0);
});

test('workspace.delegate 拒绝与会话归属人不一致的冻结身份', async () => {
  const w = await world();
  const result = await w.provider.call(
    'workspace.delegate',
    w.validInput(),
    w.ctx({ actor: { userId: asUserId('u-other'), via: 'web' } })
  );

  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.error.code : null, 'forbidden');
  assert.equal((await w.rows()).length, 0);
  assert.equal(w.planCalls.length, 0);
});

test('workspace.delegate 拒绝没有归属人的会话，不回退到按会话猜身份', async () => {
  const w = await world();
  w.setSessionCreatedBy(null);

  const result = await w.provider.call('workspace.delegate', w.validInput(), w.ctx());

  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.error.code : null, 'forbidden');
  assert.equal((await w.rows()).length, 0);
});

test('workspace.delegate 拒绝已删除 / 已停用账号', async () => {
  const w = await world();
  w.setActive(false);

  const result = await w.provider.call('workspace.delegate', w.validInput(), w.ctx());

  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.error.code : null, 'forbidden');
  assert.equal((await w.rows()).length, 0);
});

test('workspace.delegate 拒绝不在登记簿里的会话（无普通工具回退）', async () => {
  const w = await world();
  w.setCoordinator(null);

  const result = await w.provider.call('workspace.delegate', w.validInput(), w.ctx());

  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.error.code : null, 'not_found');
  assert.equal((await w.rows()).length, 0);
  assert.equal(w.planCalls.length, 0);
});

test('workspace.delegate 拒绝登记簿指向另一条会话的漂移记录', async () => {
  const w = await world();
  w.setCoordinator({
    sessionId: asSessionId('ses-somebody-else'),
    projectId: w.project.id,
    accountId: w.owner.user.id
  });

  const result = await w.provider.call('workspace.delegate', w.validInput(), w.ctx());

  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.error.code : null, 'not_found');
  assert.equal((await w.rows()).length, 0);
});

test('workspace.delegate 拒绝 payload 里的 actor / coordinatorSessionId / 启动选项', async () => {
  const w = await world();
  const smuggled = {
    ...w.validInput(),
    actor: { userId: 'u-other' },
    coordinatorSessionId: 'ses-other',
    model: 'm1',
    options: { token: 'secret' }
  };

  const result = await w.provider.call('workspace.delegate', smuggled, w.ctx());

  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.error.code : null, 'invalid');
  assert.equal((await w.rows()).length, 0);
  assert.equal(w.planCalls.length, 0);
});

test('workspace.delegate 只接受本工具名', async () => {
  const w = await world();
  const result = await w.provider.call('workspace.delegate.publish', w.validInput(), w.ctx());

  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.error.code : null, 'not_found');
  assert.equal((await w.rows()).length, 0);
});


test('workspace:delegate scope 只发给经登记簿核实、且归属人一致的真人 Web 会话', async () => {
  const w = await world();
  const session = { id: w.coordinatorSessionId, taskId: null, workerId: 'local' };
  const scopes = await w.scopeResolver({ session, actor: { userId: w.owner.user.id, via: 'web' } });

  assert.deepEqual(scopes, [WORKSPACE_DELEGATE_SCOPE]);
  assert.deepEqual(w.resolveCalls, [w.coordinatorSessionId]);
});

test('workspace:delegate scope 不发给普通授权、bot、外来身份或没有归属人的会话', async () => {
  const w = await world();
  const session = { id: w.coordinatorSessionId, taskId: null, workerId: 'local' };

  assert.deepEqual(await w.scopeResolver({ session }), []);
  assert.deepEqual(
    await w.scopeResolver({ session, actor: { userId: w.owner.user.id, via: 'bot' } }),
    []
  );
  assert.deepEqual(
    await w.scopeResolver({ session, actor: { userId: asUserId('u-other'), via: 'web' } }),
    []
  );

  w.setSessionCreatedBy(null);
  assert.deepEqual(
    await w.scopeResolver({ session, actor: { userId: w.owner.user.id, via: 'web' } }),
    []
  );
});

test('workspace:delegate scope 不发给已停用账号、未登记或已漂移的主会话', async () => {
  const w = await world();
  const session = { id: w.coordinatorSessionId, taskId: null, workerId: 'local' };
  const actor = { userId: w.owner.user.id, via: 'web' as const };

  w.setActive(false);
  assert.deepEqual(await w.scopeResolver({ session, actor }), []);
  w.setActive(true);

  w.setCoordinator(null);
  assert.deepEqual(await w.scopeResolver({ session, actor }), []);

  w.setCoordinator({
    sessionId: asSessionId('ses-somebody-else'),
    projectId: w.project.id,
    accountId: w.owner.user.id
  });
  assert.deepEqual(await w.scopeResolver({ session, actor }), []);
});
