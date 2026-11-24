import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import {
  asAgentId,
  asLoginId,
  asSessionId,
  asTaskId,
  asTeamId,
  asUserId,
  asWorkspaceId,
  createProjectUseCase,
  createTask,
  err,
  forbidden,
  newSessionId,
  ok,
  otherEnd,
  proposeWorkspaceDelegationUseCase,
  repoTokenKey,
  type AccessPolicy,
  type AgentDescriptor,
  type DelegateWorkspaceCommand,
  type DelegationDirectAuthorizeInput,
  type DirectDelegateWorkspaceCommand,
  type Principal,
  type Role,
  type Session,
  type Subject,
  type WorkspaceGit
} from '@agent-hub/domain';
import { fakeSessionLinks, inMemoryDeliveries, inMemoryDeps } from '@agent-hub/domain/testing';
import {
  createSqliteWorkspaceCoordinators,
  createSqliteWorkspaceDelegations
} from '@agent-hub/storage-sqlite';
import { installCoordinatorRoutes, type CoordinatorDeps } from './workspace-coordinator.ts';
import { installDelegationRoutes, createWorkspaceDelegationBridges, runWorkspaceDelegationDirect, type DelegationDeps } from './workspace-delegation.ts';
import { authHeaderFor } from './repo-auth.ts';

const fake: AgentDescriptor = {
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
  models: ['m1'],
  defaultModel: 'm1',
  options: []
};

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

type PreparedCall = Parameters<NonNullable<WorkspaceGit['prepareDelegationWorktree']>>[0];

interface DelegationBody {
  created: boolean;
  claimed: boolean;
  delegation: {
    id: string;
    coordinatorSessionId: string;
    taskId: string;
    executionSessionId: string;
    worktreePath: string;
    branch: string;
    state: string;
    baseSha: string | null;
    instructions: string;
    canConfirm: boolean;
    executionSessionExists: boolean;
    startup: { agentId: string; model: string | null; profileId: string | null } | null;
  };
}

interface ListBody {
  delegations: Array<Record<string, unknown>>;
}

async function world() {
  const w = inMemoryDeps();
  w.agents.push(fake);
  const owner = person('owner', 't1', 'u-owner');
  const access = policy();
  const base = { ...w.deps, access };

  const created = await createProjectUseCase(base, {
    name: 'hub',
    rootPath: '/tmp/hub',
    actor: owner,
    repoUrl: 'https://github.com/acme/app.git',
    defaultBranch: 'main'
  });
  assert.ok(created.ok, JSON.stringify(created));
  const project = created.value;
  const [workspace] = await w.deps.workspaces.byProject(project.id);
  assert.ok(workspace);

  // createProjectUseCase 关联目录时不写 repoUrl；派工的基线校验需要这条 origin 元数据。
  const patched = await w.deps.workspaces.save({
    ...workspace,
    repoUrl: 'https://github.com/acme/app.git',
    isGit: true
  });
  assert.equal(patched.status, 'saved');
  const coordinatorWorkspace = patched.status === 'saved' ? patched.workspace : workspace;

  const task = createTask({ projectId: project.id, title: '设置页拆分', now: 20 });
  assert.ok(task.ok);
  await w.deps.tasks.save(task.value);

  const prepareCalls: PreparedCall[] = [];
  const git: WorkspaceGit = {
    ...w.deps.git,
    async prepareDelegationWorktree(input) {
      prepareCalls.push(input);
      return ok({ path: input.path, branch: input.branch, baseSha: 'b'.repeat(40) });
    }
  };
  const links = fakeSessionLinks();
  const deliveries = inMemoryDeliveries();
  const deps: DelegationDeps = { ...base, git, links, deliveries };
  const coordinatorDeps: CoordinatorDeps = { ...base };

  const coordinators = createSqliteWorkspaceCoordinators(new DatabaseSync(':memory:'));
  const delegationDb = new DatabaseSync(':memory:');
  const delegations = createSqliteWorkspaceDelegations(delegationDb);
  let subject: Subject | null = owner;
  const app = new Hono();
  installCoordinatorRoutes(app, { deps: coordinatorDeps, coordinators }, () => subject);
  installDelegationRoutes(app, { deps, delegations, coordinators }, () => subject);

  const coordinatorResponse = await app.request('/api/coordinators', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: project.id, workspaceId: coordinatorWorkspace.id, agentId: 'fake' })
  });
  assert.equal(coordinatorResponse.status, 201);
  const opened = (await coordinatorResponse.json()) as { session: { id: string } };
  const coordinatorSessionId = asSessionId(opened.session.id);

  // 普通任务会话：项目只来自任务，直接车道不要求它登记为主会话。
  const taskSessionId = newSessionId();
  const taskSession: Session = {
    id: taskSessionId,
    taskId: task.value.id,
    agentId: asAgentId('fake'),
    model: 'm1',
    origin: { kind: 'derive' },
    status: 'stopped',
    lastSeq: 0,
    turn: 0,
    agentSessionRef: null,
    options: {},
    optionSpec: [],
    workerId: 'local',
    workspaceId: coordinatorWorkspace.id,
    createdBy: owner.user.id,
    mcpDisabled: [],
    createdAt: 30,
    updatedAt: 30
  };
  await w.deps.sessions.save(taskSession);

  const post = (payload: Record<string, unknown>) =>
    app.request(`/api/coordinators/${coordinatorSessionId}/delegations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
  const get = () => app.request(`/api/coordinators/${coordinatorSessionId}/delegations`);
  const body = (extra: Record<string, unknown> = {}) => ({
    requestKey: 'req-1',
    taskId: task.value.id,
    repoId: project.repos[0]!.id,
    baseBranch: 'main',
    instructions: '把设置页拆成两个组件，并保留现有路由。',
    agentId: 'fake',
    model: 'm1',
    ...extra
  });
  const command = (extra: Partial<DelegateWorkspaceCommand> = {}): DelegateWorkspaceCommand => ({
    actor: owner,
    requestKey: 'proposal-1',
    coordinatorSessionId,
    taskId: task.value.id,
    repoId: project.repos[0]!.id,
    baseBranch: 'main',
    instructions: '把设置页拆成两个组件，并保留现有路由。',
    agentId: 'fake',
    model: 'm1',
    ...extra
  });
  const confirm = (delegationId: string, raw?: string) =>
    app.request(`/api/coordinators/${coordinatorSessionId}/delegations/${delegationId}/confirm`, {
      method: 'POST',
      ...(raw === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: raw })
    });

  return {
    ...w,
    owner,
    project,
    task: task.value,
    coordinatorWorkspace,
    coordinatorSessionId,
    taskSessionId,
    deps,
    links,
    deliveries,
    prepareCalls,
    coordinators,
    delegations,
    delegationDb,
    post,
    get,
    confirm,
    body,
    command,
    setSubject: (next: Subject | null) => {
      subject = next;
    }
  };
}

test('POST 建派工：固定计划、临时工作区、执行会话、双向连线与一次说明', async () => {
  const w = await world();
  const response = await w.post(w.body());
  assert.equal(response.status, 201);
  const payload = (await response.json()) as DelegationBody;
  assert.equal(payload.created, true);
  assert.equal(payload.claimed, true);
  assert.equal(payload.delegation.state, 'prepared');
  assert.equal(payload.delegation.coordinatorSessionId, w.coordinatorSessionId);
  assert.match(payload.delegation.branch, /^delegation\/[0-9a-f]{24}$/);
  assert.equal(
    payload.delegation.worktreePath,
    `/tmp/hub.delegation-${payload.delegation.branch.slice('delegation/'.length)}`
  );
  assert.equal(payload.delegation.baseSha, 'b'.repeat(40));

  assert.equal(w.prepareCalls.length, 1);
  assert.deepEqual(w.prepareCalls[0], {
    repoPath: '/tmp/hub',
    path: payload.delegation.worktreePath,
    branch: payload.delegation.branch,
    baseBranch: 'main',
    expectedUrl: 'https://github.com/acme/app.git'
  });

  const execution = await w.deps.sessions.byId(asSessionId(payload.delegation.executionSessionId));
  assert.ok(execution);
  assert.equal(execution.taskId, w.task.id);
  assert.equal(execution.parentSessionId ?? null, null);
  assert.equal(execution.kind ?? 'chat', 'chat');

  const temporary = await w.deps.workspaces.byId(asWorkspaceId(execution.workspaceId!));
  assert.ok(temporary);
  assert.equal(temporary.kind, 'temporary');
  assert.equal(temporary.source, 'worktree');
  assert.equal(temporary.ownerTaskId, w.task.id);
  assert.equal(temporary.baseWorkspaceId, w.coordinatorWorkspace.id);
  assert.equal(temporary.workerId, 'local');
  assert.equal(temporary.branch, payload.delegation.branch);
  assert.equal(temporary.path, payload.delegation.worktreePath);
  assert.equal(temporary.setup, null);

  const taskAfter = await w.deps.tasks.byId(asTaskId(w.task.id));
  assert.equal(taskAfter?.branch, w.task.branch);

  const edges = await w.links.forSession(execution.id);
  assert.ok(edges.some((edge) => otherEnd(edge, execution.id) === w.coordinatorSessionId));

  const prompts = (await w.deps.sessions.tail(execution.id, 20)).filter((entry) => entry.event.kind === 'prompt');
  assert.equal(prompts.length, 1);
  const event = prompts[0]!.event;
  assert.equal(event.kind, 'prompt');
  if (event.kind !== 'prompt') return;
  assert.equal(event.clientMessageId, `delegation:${payload.delegation.id}`);
  assert.match(event.text, /把设置页拆成两个组件/);

  const deliveries = await w.deliveries.recent(execution.id, 10);
  assert.equal(deliveries.filter((row) => row.kind === 'prompt').length, 1);
});

test('同 key 复用固定计划；不同 key 生成不同路径与分支', async () => {
  const w = await world();
  const first = (await (await w.post(w.body())).json()) as DelegationBody;
  const repeated = await w.post(w.body());
  assert.equal(repeated.status, 200);
  const same = (await repeated.json()) as DelegationBody;
  assert.equal(same.created, false);
  assert.equal(same.claimed, false);
  assert.equal(same.delegation.id, first.delegation.id);
  assert.equal(same.delegation.worktreePath, first.delegation.worktreePath);
  assert.equal(same.delegation.branch, first.delegation.branch);
  assert.equal(w.prepareCalls.length, 1);

  const second = (await (await w.post(w.body({ requestKey: 'req-2' }))).json()) as DelegationBody;
  assert.notEqual(second.delegation.executionSessionId, first.delegation.executionSessionId);
  assert.notEqual(second.delegation.worktreePath, first.delegation.worktreePath);
  assert.notEqual(second.delegation.branch, first.delegation.branch);
  assert.equal(w.prepareCalls.length, 2);
});

test('主会话没有缓存 repoUrl 时仍交给严格 Worker 校验；缓存不一致则在副作用前失败', async () => {
  const w = await world();
  const uncached = await w.deps.workspaces.save({
    ...w.coordinatorWorkspace,
    repoUrl: null,
    isGit: true
  });
  assert.equal(uncached.status, 'saved');

  const created = await w.post(w.body({ requestKey: 'req-uncached' }));
  assert.equal(created.status, 201);
  assert.equal(w.prepareCalls.length, 1);
  assert.equal(w.prepareCalls[0]?.expectedUrl, 'https://github.com/acme/app.git');

  const mismatched = await w.deps.workspaces.save({
    ...w.coordinatorWorkspace,
    repoUrl: 'https://github.com/acme/other.git',
    isGit: true
  });
  assert.equal(mismatched.status, 'saved');
  const denied = await w.post(w.body({ requestKey: 'req-mismatch' }));
  assert.equal(denied.status, 503);
  assert.equal(w.prepareCalls.length, 1, '缓存不一致必须在任何 Git 副作用之前失败');
});

test('仓库凭据只按请求里的 repoId 取，同 URL 的另一条仓库不会串用', async () => {
  const w = await world();
  const primary = w.project.repos[0]!;
  const second = {
    ...primary,
    id: 'repo_second',
    name: 'second',
    tokenSecret: repoTokenKey(w.project.id, 'repo_second')
  };
  await w.deps.projects.save({ ...w.project, repos: [primary, second] });
  await w.deps.secrets.put(second.tokenSecret, 'secret-second', 1);

  const withSecond = await w.post(w.body({ requestKey: 'req-second', repoId: second.id }));
  assert.equal(withSecond.status, 201);
  assert.deepEqual(
    w.prepareCalls[0]?.auth,
    authHeaderFor('secret-second', 'https://github.com/acme/app.git')
  );

  // 主仓库没配令牌；按 URL 扫会错误地命中上面那条仓库的令牌。
  const withoutToken = await w.post(w.body({ requestKey: 'req-primary', repoId: primary.id }));
  assert.equal(withoutToken.status, 201);
  assert.equal(w.prepareCalls[1]?.auth, undefined);
});

async function seedProposal(
  w: Awaited<ReturnType<typeof world>>,
  extra: Partial<DelegateWorkspaceCommand> = {}
) {
  const command = w.command(extra);
  const proposed = await proposeWorkspaceDelegationUseCase(
    w.deps,
    w.delegations,
    createWorkspaceDelegationBridges(w.deps, w.coordinators, {
      baseBranch: command.baseBranch,
      agentId: command.agentId,
      model: command.model ?? null,
      profileId: command.profileId ?? null,
      options: command.options
    }),
    command
  );
  assert.ok(proposed.ok, JSON.stringify(proposed));
  return proposed.value.record;
}

test('confirm：从服务端冻结配置确认提案，返回脱敏 startup，重复确认不重放', async () => {
  const w = await world();
  const proposal = await seedProposal(w, {
    requestKey: 'proposal-confirm',
    options: { reasoning: 'high', sandbox: true }
  });
  assert.equal(proposal.state, 'pending');
  assert.ok(proposal.startup);

  const listed = await w.get();
  const listBody = (await listed.json()) as ListBody;
  const pending = listBody.delegations.find((row) => row.id === proposal.id);
  assert.ok(pending);
  assert.equal(pending.canConfirm, true);
  assert.deepEqual(pending.startup, { agentId: 'fake', model: 'm1', profileId: null });
  assert.equal('options' in (pending.startup as object), false, 'options 不能出现在视图里');

  const withBody = await w.confirm(proposal.id, JSON.stringify({ agentId: 'other' }));
  assert.equal(withBody.status, 400);
  assert.equal(w.prepareCalls.length, 0);

  const confirmed = await w.confirm(proposal.id);
  assert.equal(confirmed.status, 200);
  const payload = (await confirmed.json()) as DelegationBody;
  assert.equal(payload.created, false);
  assert.equal(payload.claimed, true);
  assert.equal(payload.delegation.state, 'prepared');
  assert.equal(payload.delegation.canConfirm, false);
  assert.equal(w.prepareCalls.length, 1);
  assert.equal(w.prepareCalls[0]?.baseBranch, 'main');

  const execution = await w.deps.sessions.byId(asSessionId(payload.delegation.executionSessionId));
  assert.ok(execution);
  assert.equal(execution.agentId, asAgentId('fake'));
  assert.equal(execution.model, 'm1');
  assert.equal(execution.options.reasoning, 'high');
  assert.equal(execution.options.sandbox, true);

  const repeated = await w.confirm(proposal.id);
  assert.equal(repeated.status, 200);
  const same = (await repeated.json()) as DelegationBody;
  assert.equal(same.claimed, false);
  assert.equal(same.delegation.executionSessionId, payload.delegation.executionSessionId);
  assert.equal(w.prepareCalls.length, 1, '重复确认不能再次准备或启动');
});

test('confirm：别人的派工不能确认，缺少冻结配置时不产生任何副作用', async () => {
  const w = await world();
  const proposal = await seedProposal(w, { requestKey: 'proposal-foreign' });

  w.setSubject(person('member', 't2', 'u-other'));
  const foreign = await w.confirm(proposal.id);
  assert.equal(foreign.status, 403);
  assert.equal(w.prepareCalls.length, 0);

  w.setSubject(w.owner);
  w.delegationDb.prepare(
    `UPDATE workspace_delegation
     SET startup_agent_id = NULL, startup_model = NULL, startup_profile_id = NULL, startup_options_json = NULL
     WHERE id = ?`
  ).run(proposal.id);
  const absent = await w.confirm(proposal.id);
  assert.equal(absent.status, 409);
  assert.equal(w.prepareCalls.length, 0);

  const listed = (await (await w.get()).json()) as ListBody;
  const view = listed.delegations.find((row) => row.id === proposal.id);
  assert.equal(view?.canConfirm, false);
});

test('confirm：已领取 / 进行中的派工拒绝确认，不产生第二个执行会话', async () => {
  const w = await world();
  const proposal = await seedProposal(w, { requestKey: 'proposal-inflight' });
  const claimed = await w.delegations.claim(proposal.id, {
    owner: 'delegation:test',
    token: 'claim-token',
    at: 1,
    expiresAt: 10_000
  });
  assert.equal(claimed.outcome, 'claimed');

  const response = await w.confirm(proposal.id);
  assert.equal(response.status, 409);
  assert.equal(w.prepareCalls.length, 0);
});

test('POST 只许人；GET 先按项目 session.read 授权，返回脱敏视图', async () => {
  const w = await world();
  const created = (await (await w.post(w.body())).json()) as DelegationBody;

  w.setSubject(null);
  assert.equal((await w.post(w.body({ requestKey: 'req-anon' }))).status, 403);
  assert.equal((await w.get()).status, 403);

  w.setSubject({
    ...w.owner,
    via: { tokenId: 'tk', name: 'service', kind: 'service', permissions: [] }
  });
  assert.equal((await w.post(w.body({ requestKey: 'req-token' }))).status, 403);

  w.setSubject(w.owner);
  const listed = await w.get();
  assert.equal(listed.status, 200);
  const payload = (await listed.json()) as ListBody;
  assert.equal(payload.delegations.length, 1);
  const view = payload.delegations[0]!;
  assert.equal(view.id, created.delegation.id);
  for (const hidden of ['requestFingerprint', 'claim', 'accountId', 'repoUrl']) {
    assert.equal(hidden in view, false, `${hidden} 必须脱敏`);
  }

  w.setSubject(person('member', 't2', 'u-other'));
  const denied = await w.get();
  assert.ok(denied.status === 403 || denied.status === 404, `expected auth failure, got ${denied.status}`);
  assert.equal(((await denied.json()) as { error?: { message?: string } }).error?.message?.includes('把设置页'), false);
});

test('GET：同项目非 owner 不能读取派工说明、路径与 canConfirm；归属的 owner 可以', async () => {
  const w = await world();
  const proposal = await seedProposal(w, { requestKey: 'proposal-read-owner' });
  assert.equal(proposal.state, 'pending');

  // 同项目的普通成员：项目 `session.read` 通过，但派工明细仍只归发起人。
  const member = person('member', 't1', 'u-member');
  await w.deps.projects.save({ ...w.project, members: [member.user.id] });
  w.setSubject(member);
  const denied = await w.get();
  assert.equal(denied.status, 403);
  const denial = await denied.text();
  assert.match(denial, /主会话的创建者/);
  assert.equal(denial.includes('把设置页'), false);
  assert.equal(denial.includes(proposal.worktreePath), false);
  assert.equal(denial.includes('canConfirm'), false);

  // 服务令牌也不行：原始说明和工作树路径只给当前登录的人。
  w.setSubject({
    ...w.owner,
    via: { tokenId: 'tk', name: 'service', kind: 'service', permissions: ['session.read'] }
  });
  assert.equal((await w.get()).status, 403);

  // owner 正例：仍然能看到自己的原始说明、工作树路径和待确认标记。
  w.setSubject(w.owner);
  const listed = await w.get();
  assert.equal(listed.status, 200);
  const payload = (await listed.json()) as ListBody;
  const view = payload.delegations.find((row) => row.id === proposal.id);
  assert.ok(view);
  assert.equal(view.instructions, '把设置页拆成两个组件，并保留现有路由。');
  assert.equal(view.worktreePath, proposal.worktreePath);
  assert.equal(view.canConfirm, true);
});

async function listedDelegation(w: Awaited<ReturnType<typeof world>>, id: string) {
  const response = await w.get();
  assert.equal(response.status, 200);
  const payload = (await response.json()) as ListBody;
  return payload.delegations.find((row) => row.id === id);
}

test('executionSessionExists：pending 预留 ID 为 false，确认出真实会话后同一记录为 true', async () => {
  const w = await world();
  const proposal = await seedProposal(w, { requestKey: 'presence-pending' });
  assert.equal(proposal.state, 'pending');
  assert.equal(
    await w.deps.sessions.byId(asSessionId(proposal.executionSessionId)),
    null,
    'pending 的 executionSessionId 只是预留，还没有会话'
  );

  const before = await listedDelegation(w, proposal.id);
  assert.ok(before);
  assert.equal(before.executionSessionExists, false);

  const confirmed = await w.confirm(proposal.id);
  assert.equal(confirmed.status, 200);
  const payload = (await confirmed.json()) as DelegationBody;
  assert.equal(payload.delegation.state, 'prepared');
  assert.equal(payload.delegation.executionSessionExists, true);
  assert.ok(await w.deps.sessions.byId(asSessionId(payload.delegation.executionSessionId)));

  const after = await listedDelegation(w, proposal.id);
  assert.ok(after);
  assert.equal(after.executionSessionExists, true);

  const repeated = (await (await w.confirm(proposal.id)).json()) as DelegationBody;
  assert.equal(repeated.delegation.executionSessionExists, true, '重复确认也按读取时真实会话判断');
});

test('executionSessionExists：POST 新建 prepared 派工时来自真实执行会话', async () => {
  const w = await world();
  const response = await w.post(w.body());
  assert.equal(response.status, 201);
  const payload = (await response.json()) as DelegationBody;
  assert.equal(payload.delegation.state, 'prepared');
  assert.equal(payload.delegation.executionSessionExists, true);
  assert.ok(await w.deps.sessions.byId(asSessionId(payload.delegation.executionSessionId)));
});

test('executionSessionExists：执行会话被删除后 GET 与幂等 confirm 都是 false，且不报错', async () => {
  const w = await world();
  const created = (await (await w.post(w.body())).json()) as DelegationBody;
  assert.equal(created.delegation.executionSessionExists, true);
  await w.deps.sessions.remove(asSessionId(created.delegation.executionSessionId));

  const listed = await listedDelegation(w, created.delegation.id);
  assert.ok(listed);
  assert.equal(listed.executionSessionExists, false);
  assert.equal('executionSessionError' in listed, false, '不暴露读取失败原因');

  const repeated = await w.confirm(created.delegation.id);
  assert.equal(repeated.status, 200);
  assert.equal(((await repeated.json()) as DelegationBody).delegation.executionSessionExists, false);
});

test('executionSessionExists：读取执行会话抛错时按不存在处理，200 且不带错误细节', async () => {
  const w = await world();
  const created = (await (await w.post(w.body())).json()) as DelegationBody;
  const target = asSessionId(created.delegation.executionSessionId);
  const original = w.deps.sessions.byId;
  w.deps.sessions.byId = async (id) => {
    if (id === target) throw new Error('delegation session unavailable');
    return original(id);
  };
  try {
    const response = await w.get();
    assert.equal(response.status, 200);
    const text = await response.text();
    const payload = JSON.parse(text) as ListBody;
    const view = payload.delegations.find((row) => row.id === created.delegation.id);
    assert.ok(view);
    assert.equal(view.executionSessionExists, false);
    assert.equal(text.includes('delegation session unavailable'), false);
  } finally {
    w.deps.sessions.byId = original;
  }
});

test('executionSessionExists：任务或创建者与派工记录不一致的会话不算执行会话', async () => {
  const w = await world();
  const created = (await (await w.post(w.body())).json()) as DelegationBody;
  const session = await w.deps.sessions.byId(asSessionId(created.delegation.executionSessionId));
  assert.ok(session);

  await w.deps.sessions.save({ ...session, createdBy: 'u-someone-else' });
  const driftedCreator = await listedDelegation(w, created.delegation.id);
  assert.equal(driftedCreator?.executionSessionExists, false);

  await w.deps.sessions.save({ ...session });
  const restored = await listedDelegation(w, created.delegation.id);
  assert.equal(restored?.executionSessionExists, true, '恢复归属后重新可读');

  await w.deps.sessions.save({ ...session, taskId: asTaskId('task-unrelated') });
  const driftedTask = await listedDelegation(w, created.delegation.id);
  assert.equal(driftedTask?.executionSessionExists, false);
});

function directCommand(
  w: Awaited<ReturnType<typeof world>>,
  extra: Partial<DirectDelegateWorkspaceCommand> = {}
): DirectDelegateWorkspaceCommand {
  return {
    actor: w.owner,
    requestKey: 'direct-1',
    sourceSessionId: w.coordinatorSessionId,
    taskId: w.task.id,
    repoId: w.project.repos[0]!.id,
    baseBranch: 'main',
    instructions: '直接在这个项目里开一条独立工作树会话。',
    agentId: 'fake',
    model: 'm1',
    ...extra
  };
}

function directAuthorizer(
  deny: DelegationDirectAuthorizeInput['step'] | null = null,
  seen: DelegationDirectAuthorizeInput[] = []
) {
  return async (input: DelegationDirectAuthorizeInput) => {
    seen.push(input);
    return input.step === deny ? err(forbidden('当前授权已失效')) : ok(undefined);
  };
}

test('直接执行：无任务来源会话按不可变项目直接建链，重放不重复准备', async () => {
  const w = await world();
  const seen: DelegationDirectAuthorizeInput[] = [];
  const result = await runWorkspaceDelegationDirect(
    w.deps,
    w.delegations,
    directAuthorizer(null, seen),
    directCommand(w)
  );
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.value.record.mode, 'direct');
  assert.equal(result.value.record.state, 'prepared');
  assert.equal(result.value.claimed, true);
  assert.equal(result.value.record.taskId, w.task.id);
  assert.equal(w.prepareCalls.length, 1);
  assert.deepEqual(
    seen.map((input) => input.step),
    ['create', 'prepare', 'start', 'instruction']
  );
  assert.equal(seen[0]?.source.taskId, null);

  const stored = await w.delegations.byCoordinatorRequest(w.coordinatorSessionId, 'direct-1', 'direct');
  assert.equal(stored?.id, result.value.record.id);
  assert.equal((await w.delegations.byCoordinatorRequest(w.coordinatorSessionId, 'direct-1', 'proposal')), null);

  const replay = await runWorkspaceDelegationDirect(
    w.deps,
    w.delegations,
    directAuthorizer(),
    directCommand(w)
  );
  assert.ok(replay.ok, JSON.stringify(replay));
  assert.equal(replay.value.claimed, false);
  assert.equal(replay.value.record.id, result.value.record.id);
  assert.equal(w.prepareCalls.length, 1);
});

test('直接执行：任务来源会话按任务项目直接建链', async () => {
  const w = await world();
  const result = await runWorkspaceDelegationDirect(
    w.deps,
    w.delegations,
    directAuthorizer(),
    directCommand(w, { sourceSessionId: w.taskSessionId })
  );
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.value.record.state, 'prepared');
  assert.equal(result.value.record.mode, 'direct');
  assert.equal(w.prepareCalls.length, 1);
});

async function directFailure(
  w: Awaited<ReturnType<typeof world>>,
  extra: Partial<DirectDelegateWorkspaceCommand> = {}
) {
  const result = await runWorkspaceDelegationDirect(
    w.deps,
    w.delegations,
    directAuthorizer(),
    directCommand(w, extra)
  );
  assert.equal(result.ok, false, JSON.stringify(result));
  return result.ok ? null : result.error;
}

test('直接执行：聊天 / 临时工作空间只对主人给出可行动原因', async () => {
  const w = await world();
  const session = await w.deps.sessions.byId(w.coordinatorSessionId);
  assert.ok(session);
  await w.deps.sessions.save({ ...session, workspaceId: null });
  const chat = await directFailure(w);
  assert.equal(chat?.code, 'not_found');
  assert.match(chat?.message ?? '', /没有可复用的长期工作空间/);
  assert.equal(w.prepareCalls.length, 0);

  await w.deps.sessions.save(session);
  const temporary = await w.deps.workspaces.save({ ...w.coordinatorWorkspace, kind: 'temporary' });
  assert.equal(temporary.status, 'saved');
  const temp = await directFailure(w, { requestKey: 'direct-temp' });
  assert.equal(temp?.code, 'not_found');
  assert.match(temp?.message ?? '', /没有可复用的长期工作空间/);
  assert.equal(w.prepareCalls.length, 0);
});

test('直接执行：工作空间缺失 / 未就绪 / 未关联分别给出安全原因', async () => {
  const w = await world();
  const original = w.deps.workspaces.byId;
  w.deps.workspaces.byId = async (id) =>
    id === w.coordinatorWorkspace.id ? null : original(id);
  try {
    const missing = await directFailure(w);
    assert.equal(missing?.code, 'not_found');
    assert.match(missing?.message ?? '', /工作空间已不存在/);
  } finally {
    w.deps.workspaces.byId = original;
  }

  const failed = await w.deps.workspaces.save({ ...w.coordinatorWorkspace, state: 'failed' });
  assert.equal(failed.status, 'saved');
  const notReady = await directFailure(w, { requestKey: 'direct-not-ready' });
  assert.equal(notReady?.code, 'not_found');
  assert.match(notReady?.message ?? '', /尚未就绪/);

  const restored = await w.deps.workspaces.save({ ...w.coordinatorWorkspace, state: 'ready' });
  assert.equal(restored.status, 'saved');
  await w.deps.workspaces.unlink(w.project.id, w.coordinatorWorkspace.id);
  const unlinked = await directFailure(w, { requestKey: 'direct-unlinked' });
  assert.equal(unlinked?.code, 'not_found');
  assert.match(unlinked?.message ?? '', /未关联到当前项目/);
  assert.equal(w.prepareCalls.length, 0);
});

test('直接执行：来源会话与工作空间 Worker 不一致时给出可行动原因', async () => {
  const w = await world();
  const session = await w.deps.sessions.byId(w.coordinatorSessionId);
  assert.ok(session);
  await w.deps.sessions.save({ ...session, workerId: 'remote-other' });
  const error = await directFailure(w);
  assert.equal(error?.code, 'not_found');
  assert.match(error?.message ?? '', /不同的 Worker/);
  assert.equal(w.prepareCalls.length, 0);
});

test('直接执行：非主人只看到中性 notFound，不能探测来源状态', async () => {
  const w = await world();
  const session = await w.deps.sessions.byId(w.coordinatorSessionId);
  assert.ok(session);
  await w.deps.sessions.save({ ...session, workspaceId: null });
  const stranger: Principal = {
    ...w.owner,
    user: { ...w.owner.user, id: asUserId('u-stranger') }
  };
  const error = await directFailure(w, { actor: stranger });
  assert.equal(error?.code, 'not_found');
  assert.equal(error?.message, '直接执行的来源会话不存在或不可用');
  assert.equal(w.prepareCalls.length, 0);
});

async function sshWorld(url: string) {
  const w = await world();
  const repo = w.project.repos[0]!;
  await w.deps.projects.save({ ...w.project, repos: [{ ...repo, url }] });
  const workspace = await w.deps.workspaces.save({ ...w.coordinatorWorkspace, repoUrl: url, isGit: true });
  assert.equal(workspace.status, 'saved');
  return { w, repo };
}

test('直接执行：已登记的 SSH 仓库交给严格 Worker，且绝不读取 / 转发 HTTPS 凭据', async () => {
  const url = 'git@github.com:acme/app.git';
  const { w, repo } = await sshWorld(url);
  let reveals = 0;
  const originalReveal = w.deps.secrets.reveal.bind(w.deps.secrets);
  const deps: DelegationDeps = {
    ...w.deps,
    secrets: {
      ...w.deps.secrets,
      reveal: async (keys: Parameters<typeof originalReveal>[0]) => {
        reveals += 1;
        return originalReveal(keys);
      }
    }
  };
  // 用规范键登记 tokenSecret 也不该被读取：SSH 只使用 Worker 机器身份。
  await deps.projects.save({
    ...w.project,
    repos: [{ ...w.project.repos[0]!, id: repo.id, url, tokenSecret: repoTokenKey(w.project.id, repo.id) }]
  });

  const result = await runWorkspaceDelegationDirect(
    deps,
    w.delegations,
    directAuthorizer(),
    directCommand(w)
  );
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(w.prepareCalls.length, 1);
  assert.equal(w.prepareCalls[0]?.expectedUrl, url);
  assert.equal(w.prepareCalls[0]?.auth, undefined);
  assert.equal(reveals, 0);
});

test('直接执行：缓存 SSH origin 与登记原文不一致时在 Git 副作用之前失败', async () => {
  const url = 'git@github.com:acme/app.git';
  const { w } = await sshWorld(url);
  const workspace = await w.deps.workspaces.save({
    ...w.coordinatorWorkspace,
    repoUrl: 'git@github.com:acme/other.git',
    isGit: true
  });
  assert.equal(workspace.status, 'saved');
  const result = await runWorkspaceDelegationDirect(
    w.deps,
    w.delegations,
    directAuthorizer(),
    directCommand(w)
  );
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error.code, 'unavailable');
  assert.match(!result.ok ? result.error.message : '', /SSH origin 不一致/);
  assert.equal(w.prepareCalls.length, 0);
});

test('直接执行：准备前撤销授权 → failed/fatal 且不准备；同键可安全重试', async () => {
  const w = await world();
  const denied = await runWorkspaceDelegationDirect(
    w.deps,
    w.delegations,
    directAuthorizer('prepare'),
    directCommand(w, { requestKey: 'direct-revoked' })
  );
  assert.equal(denied.ok, false);
  assert.equal(!denied.ok && denied.error.code, 'forbidden');
  assert.equal(w.prepareCalls.length, 0);
  const record = await w.delegations.byCoordinatorRequest(w.coordinatorSessionId, 'direct-revoked', 'direct');
  assert.equal(record?.state, 'failed');
  assert.equal(record?.failure?.kind, 'fatal');

  const retry = await runWorkspaceDelegationDirect(
    w.deps,
    w.delegations,
    directAuthorizer(),
    directCommand(w, { requestKey: 'direct-revoked' })
  );
  assert.ok(retry.ok, JSON.stringify(retry));
  assert.equal(retry.value.record.state, 'prepared');
  assert.equal(w.prepareCalls.length, 1);
});

test('直接执行：启动前撤销授权 → uncertain，不创建执行会话，也不盲目重试', async () => {
  const w = await world();
  const denied = await runWorkspaceDelegationDirect(
    w.deps,
    w.delegations,
    directAuthorizer('start'),
    directCommand(w, { requestKey: 'direct-start-revoked' })
  );
  assert.equal(denied.ok, false);
  assert.equal(!denied.ok && denied.error.code, 'forbidden');
  assert.equal(w.prepareCalls.length, 1);
  const record = await w.delegations.byCoordinatorRequest(w.coordinatorSessionId, 'direct-start-revoked', 'direct');
  assert.equal(record?.state, 'uncertain');
  assert.equal(record?.failure?.kind, 'uncertain');
  assert.equal(await w.deps.sessions.byId(record!.executionSessionId), null);

  const retry = await runWorkspaceDelegationDirect(
    w.deps,
    w.delegations,
    directAuthorizer(),
    directCommand(w, { requestKey: 'direct-start-revoked' })
  );
  assert.ok(retry.ok, JSON.stringify(retry));
  assert.equal(retry.value.claimed, false);
  assert.equal(retry.value.record.state, 'uncertain');
  assert.equal(w.prepareCalls.length, 1);
});

test('直接执行：说明送达前撤销授权 → uncertain，执行会话保留但不重放', async () => {
  const w = await world();
  const denied = await runWorkspaceDelegationDirect(
    w.deps,
    w.delegations,
    directAuthorizer('instruction'),
    directCommand(w, { requestKey: 'direct-instruction-revoked' })
  );
  assert.equal(denied.ok, false);
  assert.equal(!denied.ok && denied.error.code, 'forbidden');
  assert.equal(w.prepareCalls.length, 1);
  const record = await w.delegations.byCoordinatorRequest(w.coordinatorSessionId, 'direct-instruction-revoked', 'direct');
  assert.equal(record?.state, 'uncertain');
  assert.ok(await w.deps.sessions.byId(record!.executionSessionId));

  const retry = await runWorkspaceDelegationDirect(
    w.deps,
    w.delegations,
    directAuthorizer(),
    directCommand(w, { requestKey: 'direct-instruction-revoked' })
  );
  assert.ok(retry.ok, JSON.stringify(retry));
  assert.equal(retry.value.claimed, false);
  assert.equal(retry.value.record.state, 'uncertain');
  assert.equal(w.prepareCalls.length, 1);
});
