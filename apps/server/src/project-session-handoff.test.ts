import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  asAgentId,
  asLoginId,
  asSessionId,
  asTeamId,
  asUserId,
  asWorkspaceId,
  createProjectUseCase,
  createTask,
  err,
  notFound,
  ok,
  type Accepted,
  type AccessPolicy,
  type DomainError,
  type Principal,
  type Project,
  type ProjectRepo,
  type ProjectSessionGrant,
  type Result,
  type Session,
  type WorkspaceDelegation
} from '@agent-hub/domain';
import { inMemoryDeps } from '@agent-hub/domain/testing';
import type { ProjectHandoffCommand } from '@agent-hub/domain';
import type { ProjectSessionHandoffCommand } from './project-session-tools.ts';
import type { ProjectSessionGrantService } from './project-session-grant.ts';
import {
  PROJECT_CANDIDATE_PART_SCHEMA,
  createProjectSessionHandoffActions,
  type ProjectSessionHandoffActions
} from './project-session-handoff.ts';

const OWNER_ID = 'u-owner';
const OTHER_USER_ID = 'u-other';
const TEAM_ID = 't1';
const SHA = '1'.repeat(40);
const REPO_URL = 'https://github.com/acme/app.git';
const OTHER_REPO_URL = 'https://github.com/acme/other.git';

const CALLER = asSessionId('ses-caller');
const ALPHA = asSessionId('ses-alpha');
const BETA = asSessionId('ses-beta');
const INVISIBLE = asSessionId('ses-invisible');
const CONFLICT = asSessionId('ses-conflict');
const TASKLESS = asSessionId('ses-taskless');
const TASKLESS_SAME = asSessionId('ses-taskless-same');
const TASKLESS_CROSS = asSessionId('ses-taskless-cross');
const TASKLESS_LEGACY = asSessionId('ses-taskless-legacy');
const SOURCE = asSessionId('ses-source');
const RESTRICTED = asSessionId('ses-restricted');
const TARGET_OTHER = asSessionId('ses-other-project');

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function person(id: string = OWNER_ID): Principal {
  return {
    user: {
      id: asUserId(id),
      email: `${id}@example.com`,
      displayName: id,
      role: 'member',
      passwordHash: null,
      emailVerifiedAt: 1,
      disabledAt: null,
      createdAt: 1,
      teamId: asTeamId(TEAM_ID),
      clusterAdmin: false,
      deletedAt: null
    },
    loginId: asLoginId(id)
  };
}

/** 成员只读自己的会话：`session.read = own`，别人建的会话不可见。 */
function accessPolicy(): AccessPolicy {
  return {
    async context() {
      return { hubTeamId: asTeamId(TEAM_ID), settings: { membersCanAddMachines: false } };
    },
    async worker(workerId) {
      return { kind: 'worker', id: workerId ?? 'local', teamId: asTeamId(TEAM_ID), createdBy: null, local: true };
    }
  };
}

function sessionOf(input: {
  id: ReturnType<typeof asSessionId>;
  taskId: Session['taskId'];
  createdBy?: string;
  title?: string;
  updatedAt?: number;
  originProjectId?: Project['id'];
  workspaceId?: string;
}): Session {
  return {
    id: input.id,
    taskId: input.taskId,
    agentId: asAgentId('fake-agent'),
    model: 'fake-model',
    origin: { kind: 'derive' },
    status: 'stopped',
    lastSeq: 0,
    turn: 1,
    agentSessionRef: null,
    options: {},
    optionSpec: [],
    workerId: 'local',
    workspaceId: asWorkspaceId(input.workspaceId ?? `ws-${input.id}`),
    mcpDisabled: [],
    createdBy: input.createdBy ?? OWNER_ID,
    createdAt: 1,
    updatedAt: input.updatedAt ?? 1,
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.originProjectId === undefined ? {} : { originProjectId: input.originProjectId })
  };
}

interface Harness {
  readonly actions: ProjectSessionHandoffActions;
  readonly project: Project;
  readonly otherProject: Project;
  readonly repo: ProjectRepo;
  readonly taskId: Session['taskId'];
  readonly handoffs: ProjectHandoffCommand[];
  readonly grantCalls: Array<{ sessionId: string; scope: string }>;
  readonly actorCalls: string[];
  readonly delegations: Map<string, Mutable<WorkspaceDelegation>>;
  readonly sourceDelegation: Mutable<WorkspaceDelegation>;
  readonly listCalls: () => number;
  readonly tasklessCalls: string[];
  readonly stored: (id: ReturnType<typeof asSessionId>) => Session | undefined;
  setGrantError(error: DomainError | null): void;
  setGrantAccountId(accountId: string): void;
  setHandoffResult(
    run: ((command: ProjectHandoffCommand) => Promise<Result<Accepted, DomainError>>) | null
  ): void;
}

async function harness(
  options: { callerOriginConflict?: boolean; tasklessQuery?: 'throw' | 'rows' } = {}
): Promise<Harness> {
  const world = inMemoryDeps();
  const deps = { ...world.deps, access: accessPolicy() };

  const createProject = async (name: string, repoUrl: string): Promise<Project> => {
    const created = await createProjectUseCase(
      { ...deps, access: undefined },
      { name, rootPath: '', actor: person(), repoUrl, defaultBranch: 'main' }
    );
    assert.ok(created.ok, JSON.stringify(created));
    return created.value;
  };

  const project = await createProject('handoff-project', REPO_URL);
  const otherProject = await createProject('other-project', OTHER_REPO_URL);
  const repo = project.repos[0];
  assert.ok(repo);

  const createTaskIn = async (projectId: Project['id'], title: string) => {
    const created = createTask({ projectId, title, now: 1 });
    assert.ok(created.ok);
    await deps.tasks.save(created.value);
    return created.value;
  };
  const task = await createTaskIn(project.id, '主任务');
  const sourceTask = await createTaskIn(project.id, '候选来源任务');
  const otherTask = await createTaskIn(otherProject.id, '别的项目任务');

  const saved = new Map<string, Session>();
  const saveSession = async (session: Session): Promise<void> => {
    saved.set(session.id, session);
    await deps.sessions.save(session);
  };

  await saveSession(
    sessionOf({
      id: CALLER,
      taskId: task.id,
      updatedAt: 10,
      workspaceId: 'ws-caller',
      ...(options.callerOriginConflict === true ? { originProjectId: otherProject.id } : {})
    })
  );
  await saveSession(
    sessionOf({ id: ALPHA, taskId: task.id, title: 'Alpha 会话', updatedAt: 30 })
  );
  await saveSession(sessionOf({ id: BETA, taskId: task.id, updatedAt: 20 }));
  await saveSession(
    sessionOf({ id: INVISIBLE, taskId: task.id, createdBy: OTHER_USER_ID, updatedAt: 40 })
  );
  await saveSession(
    sessionOf({ id: CONFLICT, taskId: task.id, originProjectId: otherProject.id, updatedAt: 50 })
  );
  await saveSession(sessionOf({ id: TASKLESS, taskId: null, updatedAt: 60 }));
  await saveSession(
    sessionOf({ id: SOURCE, taskId: sourceTask.id, updatedAt: 5, workspaceId: 'ws-source' })
  );
  await saveSession(sessionOf({ id: RESTRICTED, taskId: task.id, updatedAt: 4 }));
  await saveSession(
    sessionOf({ id: TARGET_OTHER, taskId: otherTask.id, updatedAt: 70 })
  );
  await saveSession(
    sessionOf({
      id: TASKLESS_SAME,
      taskId: null,
      originProjectId: project.id,
      title: '同源无任务会话',
      updatedAt: 25
    })
  );
  await saveSession(
    sessionOf({ id: TASKLESS_CROSS, taskId: null, originProjectId: otherProject.id, updatedAt: 65 })
  );
  await saveSession(sessionOf({ id: TASKLESS_LEGACY, taskId: null, updatedAt: 66 }));

  const delegationOf = (
    executionSessionId: ReturnType<typeof asSessionId>,
    taskId: Session['taskId'],
    id: string,
    worktreePath: string
  ): Mutable<WorkspaceDelegation> => ({
    id,
    accountId: OWNER_ID,
    coordinatorSessionId: CALLER,
    mode: 'direct',
    requestKey: id,
    requestFingerprint: 'fingerprint',
    projectId: project.id,
    taskId: taskId as NonNullable<Session['taskId']>,
    repoId: repo.id,
    repoUrl: repo.url,
    workerId: 'local',
    baseBranch: 'main',
    baseSha: null,
    instructions: '',
    startup: null,
    executionSessionId,
    worktreePath,
    branch: `delegation/${id}`,
    state: 'prepared',
    claim: null,
    failure: null,
    createdAt: 1,
    updatedAt: 1
  });

  const sourceDelegation = delegationOf(SOURCE, sourceTask.id, 'dlg-source', '/tmp/source');
  const restrictedDelegation = delegationOf(
    RESTRICTED,
    task.id,
    'dlg-restricted',
    '/tmp/restricted'
  );
  const delegations = new Map<string, Mutable<WorkspaceDelegation>>([
    [SOURCE, sourceDelegation],
    [RESTRICTED, restrictedDelegation]
  ]);

  let grantError: DomainError | null = null;
  let grantAccountId = OWNER_ID;
  const grantCalls: Harness['grantCalls'] = [];
  const grants: Pick<ProjectSessionGrantService, 'authorize'> = {
    async authorize(input) {
      grantCalls.push({ sessionId: input.sessionId, scope: input.scope });
      if (grantError !== null) return err(grantError);
      const grant: ProjectSessionGrant = {
        id: 'grant-1',
        accountId: grantAccountId,
        sessionId: input.sessionId,
        projectId: project.id,
        scopes: [input.scope],
        createdBy: OWNER_ID,
        createdAt: 1,
        expiresAt: null,
        revokedAt: null,
        revokedBy: null
      };
      return ok(grant);
    }
  };

  const actorCalls: string[] = [];
  const loadActor = async (accountId: string): Promise<Principal | null> => {
    actorCalls.push(accountId);
    return accountId === OWNER_ID ? person(OWNER_ID) : null;
  };

  let listCalls = 0;
  const sessions = {
    ...deps.sessions,
    async listByProject(projectId: Project['id']) {
      listCalls += 1;
      return deps.sessions.listByProject(projectId);
    }
  };

  const handoffs: ProjectHandoffCommand[] = [];
  let handoffResult:
    | ((command: ProjectHandoffCommand) => Promise<Result<Accepted, DomainError>>)
    | null = null;
  const messageBus = {
    async handoff(command: ProjectHandoffCommand): Promise<Result<Accepted, DomainError>> {
      handoffs.push(command);
      if (handoffResult !== null) return handoffResult(command);
      return ok({
        messageId: 'msg-1',
        traceId: 'trace-1',
        status: command.wake ? ('queued' as const) : ('done' as const),
        targetSessionId: command.targetSessionId
      });
    }
  };

  const tasklessCalls: string[] = [];
  const tasklessQuery = options.tasklessQuery;
  const tasklessDeps =
    tasklessQuery === undefined
      ? {}
      : {
          async listTasklessByOriginProject(projectId: string): Promise<readonly Session[]> {
            tasklessCalls.push(projectId);
            if (tasklessQuery === 'throw') throw new Error('taskless query failed');
            return [TASKLESS_SAME, ALPHA, TASKLESS_CROSS, TASKLESS_LEGACY]
              .map((id) => saved.get(id))
              .filter((session): session is Session => session !== undefined);
          }
        };

  const actions = createProjectSessionHandoffActions({
    grants,
    access: deps.access,
    projects: deps.projects,
    sessions,
    tasks: deps.tasks,
    delegations: {
      async byExecutionSession(sessionId) {
        return delegations.get(sessionId) ?? null;
      }
    },
    messageBus,
    loadActor,
    ...tasklessDeps
  });

  return {
    actions,
    project,
    otherProject,
    repo,
    taskId: task.id,
    handoffs,
    grantCalls,
    actorCalls,
    delegations,
    sourceDelegation,
    listCalls: () => listCalls,
    tasklessCalls,
    stored: (id) => saved.get(id),
    setGrantError(error) {
      grantError = error;
    },
    setGrantAccountId(accountId) {
      grantAccountId = accountId;
    },
    setHandoffResult(run) {
      handoffResult = run;
    }
  };
}

const binding = (sessionId: ReturnType<typeof asSessionId> = CALLER) => ({
  actorId: OWNER_ID,
  actorVia: 'tool' as const,
  sessionId
});

const handoffCommand = (
  overrides: Partial<ProjectSessionHandoffCommand> = {}
): ProjectSessionHandoffCommand => ({
  ...binding(),
  requestKey: 'req-1',
  targetSessionId: ALPHA,
  body: '请接手这条任务。',
  wake: false,
  candidate: null,
  ...overrides
});

const errorCode = (result: Result<unknown, DomainError>): string | null =>
  result.ok ? null : result.error.code;

test('listSessions 只给同项目且当前会话可读的会话，白名单字段且顺序稳定', async () => {
  const h = await harness();
  const result = await h.actions.listSessions({ ...binding(), limit: 10 });
  assert.ok(result.ok, JSON.stringify(result));

  assert.deepEqual(
    result.value.map((session) => session.sessionId),
    [ALPHA, BETA, CALLER, SOURCE, RESTRICTED]
  );

  assert.deepEqual(result.value[0], {
    sessionId: ALPHA,
    taskId: h.taskId,
    title: 'Alpha 会话',
    status: 'stopped',
    agentId: 'fake-agent'
  });
  assert.deepEqual(Object.keys(result.value[0]!).sort(), [
    'agentId',
    'sessionId',
    'status',
    'taskId',
    'title'
  ]);

  const payload = JSON.stringify(result.value);
  assert.equal(payload.includes('/tmp'), false);
  assert.equal(payload.includes(REPO_URL), false);
  assert.equal(payload.includes(OTHER_USER_ID), false);
  assert.equal(payload.includes('createdBy'), false);
});

test('listSessions 过滤掉来源冲突、看不见和别的项目的会话', async () => {
  const h = await harness();
  const result = await h.actions.listSessions({ ...binding(), limit: 50 });
  assert.ok(result.ok, JSON.stringify(result));
  const ids = result.value.map((session) => session.sessionId);
  assert.equal(ids.includes(CONFLICT), false, '任务项目与不可变来源冲突');
  assert.equal(ids.includes(INVISIBLE), false, '当前成员读不到别人建的会话');
  assert.equal(ids.includes(TARGET_OTHER), false, '别的项目的会话');
  assert.equal(ids.includes(TASKLESS), false, '没有任务也没有不可变来源');
});

test('listSessions 通过专用回调并入同源无任务会话，跨项目与旧数据被拒绝', async () => {
  const h = await harness({ tasklessQuery: 'rows' });
  const result = await h.actions.listSessions({ ...binding(), limit: 10 });
  assert.ok(result.ok, JSON.stringify(result));

  assert.deepEqual(h.tasklessCalls, [h.project.id]);
  assert.deepEqual(
    result.value.map((session) => session.sessionId),
    [ALPHA, TASKLESS_SAME, BETA, CALLER, SOURCE, RESTRICTED]
  );
  assert.equal(
    result.value.filter((session) => session.sessionId === ALPHA).length,
    1,
    '任务行与无任务回调返回同一会话时只保留一份'
  );
  assert.equal(
    result.value.some((session) => session.sessionId === TASKLESS_CROSS),
    false,
    '不可变来源指向别的项目'
  );
  assert.equal(
    result.value.some((session) => session.sessionId === TASKLESS_LEGACY),
    false,
    '没有不可变来源的旧无任务会话'
  );
  assert.deepEqual(
    result.value.find((session) => session.sessionId === TASKLESS_SAME),
    {
      sessionId: TASKLESS_SAME,
      taskId: null,
      title: '同源无任务会话',
      status: 'stopped',
      agentId: 'fake-agent'
    }
  );
});

test('listSessions 无任务查询失败时整次失败，不返回半份列表', async () => {
  const h = await harness({ tasklessQuery: 'throw' });
  const result = await h.actions.listSessions({ ...binding(), limit: 10 });
  assert.equal(errorCode(result), 'unavailable');
  assert.deepEqual(h.tasklessCalls, [h.project.id]);
});

test('listSessions 输出至多 limit+1 条，让 provider 能判断截断', async () => {
  const h = await harness();
  const result = await h.actions.listSessions({ ...binding(), limit: 2 });
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(
    result.value.map((session) => session.sessionId),
    [ALPHA, BETA, CALLER]
  );

  const one = await h.actions.listSessions({ ...binding(), limit: 1 });
  assert.ok(one.ok);
  assert.deepEqual(
    one.value.map((session) => session.sessionId),
    [ALPHA, BETA]
  );
});

test('listSessions 负向授权：没有授权、账号不符、账号失效都失败且不查列表', async () => {
  const noGrant = await harness();
  noGrant.setGrantError(notFound('没有项目授权'));
  const denied = await noGrant.actions.listSessions({ ...binding(), limit: 10 });
  assert.equal(errorCode(denied), 'not_found');
  assert.equal(noGrant.listCalls(), 0);

  const mismatch = await harness();
  mismatch.setGrantAccountId(OTHER_USER_ID);
  const rejected = await mismatch.actions.listSessions({ ...binding(), limit: 10 });
  assert.equal(errorCode(rejected), 'forbidden');
  assert.equal(mismatch.listCalls(), 0);

  const ghost = await harness();
  const unknownActor = await ghost.actions.listSessions({
    ...binding(),
    actorId: 'u-ghost',
    limit: 10
  });
  assert.equal(errorCode(unknownActor), 'forbidden');
  assert.equal(ghost.listCalls(), 0);
  assert.deepEqual(ghost.grantCalls.map((call) => call.scope), ['project:read']);
});

test('handoff 负向授权：授权、调用会话绑定与目标可见性都先于发送', async () => {
  const noGrant = await harness();
  noGrant.setGrantError(notFound('没有项目授权'));
  assert.equal(errorCode(await noGrant.actions.handoff(handoffCommand())), 'not_found');
  assert.equal(noGrant.handoffs.length, 0);
  assert.deepEqual(noGrant.grantCalls.map((call) => call.scope), ['message:send']);

  const callerConflict = await harness({ callerOriginConflict: true });
  assert.equal(
    errorCode(await callerConflict.actions.handoff(handoffCommand())),
    'forbidden',
    '调用会话的任务项目与不可变来源冲突'
  );
  assert.equal(callerConflict.handoffs.length, 0);

  const h = await harness();
  assert.equal(
    errorCode(await h.actions.handoff(handoffCommand({ targetSessionId: TARGET_OTHER }))),
    'forbidden',
    '目标在别的项目'
  );
  assert.equal(
    errorCode(await h.actions.handoff(handoffCommand({ targetSessionId: CONFLICT }))),
    'forbidden',
    '目标任务项目与不可变来源冲突'
  );
  assert.equal(
    errorCode(await h.actions.handoff(handoffCommand({ targetSessionId: TASKLESS }))),
    'forbidden',
    '无任务目标没有不可变来源'
  );
  assert.equal(
    errorCode(await h.actions.handoff(handoffCommand({ targetSessionId: INVISIBLE }))),
    'forbidden',
    '目标会话不可见'
  );
  assert.equal(
    errorCode(await h.actions.handoff(handoffCommand({ targetSessionId: CALLER }))),
    'invalid',
    '目标不能是自己'
  );
  assert.equal(h.handoffs.length, 0);
});

test('handoff 默认只进收件箱，wake=true 才排队唤醒，不会隐式升级', async () => {
  const h = await harness();
  const inboxOnly = await h.actions.handoff(handoffCommand());
  assert.ok(inboxOnly.ok, JSON.stringify(inboxOnly));
  assert.equal(h.handoffs[0]!.wake, false);
  assert.equal(h.handoffs[0]!.fromSessionId, CALLER);
  assert.equal(h.handoffs[0]!.actorId, OWNER_ID);
  assert.equal(inboxOnly.value.wake, false);
  assert.equal(inboxOnly.value.status, 'done');

  const explicitWake = await h.actions.handoff(handoffCommand({ wake: true, requestKey: 'req-2' }));
  assert.ok(explicitWake.ok);
  assert.equal(h.handoffs[1]!.wake, true);
  assert.equal(explicitWake.value.wake, true);
  assert.equal(explicitWake.value.status, 'queued');

  assert.deepEqual(Object.keys(h.actions).sort(), ['handoff', 'listSessions']);
});

test('handoff 对受限子会话拒绝 wake=false，要求显式 wake=true', async () => {
  const h = await harness();
  const refused = await h.actions.handoff(handoffCommand({ targetSessionId: RESTRICTED }));
  assert.equal(errorCode(refused), 'invalid');
  assert.match(refused.ok ? '' : refused.error.message, /wake=true/);
  assert.equal(h.handoffs.length, 0);

  const woken = await h.actions.handoff(
    handoffCommand({ targetSessionId: RESTRICTED, wake: true })
  );
  assert.ok(woken.ok, JSON.stringify(woken));
  assert.equal(h.handoffs[0]!.wake, true);
  assert.equal(h.handoffs[0]!.targetSessionId, RESTRICTED);
});

test('候选引用按 project-candidate/v1 结构化提示发出，不含路径或远端', async () => {
  const h = await harness();
  const result = await h.actions.handoff(
    handoffCommand({
      candidate: { sourceSessionId: SOURCE, repoId: h.repo.id, sha: SHA }
    })
  );
  assert.ok(result.ok, JSON.stringify(result));

  assert.equal(h.handoffs.length, 1);
  const parts = h.handoffs[0]!.parts as Array<{
    type: string;
    schema: string;
    data: Record<string, unknown>;
  }>;
  assert.equal(parts.length, 1);
  assert.equal(parts[0]!.type, 'data');
  assert.equal(parts[0]!.schema, PROJECT_CANDIDATE_PART_SCHEMA);
  assert.equal(PROJECT_CANDIDATE_PART_SCHEMA, 'project-candidate/v1');
  assert.deepEqual(Object.keys(parts[0]!.data).sort(), [
    'notice',
    'projectId',
    'repoId',
    'sha',
    'sourceSessionId'
  ]);
  assert.equal(parts[0]!.data.projectId, h.project.id);
  assert.equal(parts[0]!.data.sourceSessionId, SOURCE);
  assert.equal(parts[0]!.data.repoId, h.repo.id);
  assert.equal(parts[0]!.data.sha, SHA);
  assert.equal(typeof parts[0]!.data.notice, 'string');
  assert.match(parts[0]!.data.notice as string, /提示/);

  const payload = JSON.stringify(parts);
  assert.equal(payload.includes('/tmp'), false);
  assert.equal(payload.includes(REPO_URL), false);
  assert.equal(payload.includes('worktreePath'), false);
});

test('候选引用必须指向同项目、同仓库、已 prepared 的本人派工', async () => {
  const candidate = (h: Harness) => ({
    sourceSessionId: SOURCE,
    repoId: h.repo.id,
    sha: SHA
  });

  const pending = await harness();
  pending.sourceDelegation.state = 'pending';
  assert.equal(
    errorCode(await pending.actions.handoff(handoffCommand({ candidate: candidate(pending) }))),
    'conflict'
  );
  assert.equal(pending.handoffs.length, 0);

  const foreign = await harness();
  foreign.sourceDelegation.accountId = OTHER_USER_ID;
  assert.equal(
    errorCode(await foreign.actions.handoff(handoffCommand({ candidate: candidate(foreign) }))),
    'forbidden'
  );

  const otherProject = await harness();
  otherProject.sourceDelegation.projectId = otherProject.otherProject.id;
  assert.equal(
    errorCode(
      await otherProject.actions.handoff(handoffCommand({ candidate: candidate(otherProject) }))
    ),
    'forbidden'
  );

  const otherRepo = await harness();
  otherRepo.sourceDelegation.repoId = 'repo-other';
  assert.equal(
    errorCode(await otherRepo.actions.handoff(handoffCommand({ candidate: candidate(otherRepo) }))),
    'forbidden'
  );

  const badUrl = await harness();
  badUrl.sourceDelegation.repoUrl = 'https://evil.example/app.git';
  assert.equal(
    errorCode(await badUrl.actions.handoff(handoffCommand({ candidate: candidate(badUrl) }))),
    'forbidden'
  );

  const wrongSha = await harness();
  assert.equal(
    errorCode(
      await wrongSha.actions.handoff(
        handoffCommand({ candidate: { ...candidate(wrongSha), sha: 'ABC' } })
      )
    ),
    'invalid'
  );

  const noDelegation = await harness();
  noDelegation.delegations.delete(SOURCE);
  assert.equal(
    errorCode(
      await noDelegation.actions.handoff(handoffCommand({ candidate: candidate(noDelegation) }))
    ),
    'not_found'
  );

  for (const h of [pending, foreign, otherProject, otherRepo, badUrl, wrongSha, noDelegation]) {
    assert.equal(h.handoffs.length, 0);
  }
});

test('handoff 把无法核实的投递结果与异常都收成 unavailable', async () => {
  const drift = await harness();
  drift.setHandoffResult(async () =>
    ok({ messageId: 'msg-x', traceId: 'trace-x', targetSessionId: BETA, status: 'done' })
  );
  assert.equal(errorCode(await drift.actions.handoff(handoffCommand())), 'unavailable');

  const thrown = await harness();
  thrown.setHandoffResult(async () => {
    throw new Error('boom');
  });
  assert.equal(errorCode(await thrown.actions.handoff(handoffCommand())), 'unavailable');

  const failed = await harness();
  failed.setHandoffResult(async () => err(notFound('目标会话不存在')));
  assert.equal(errorCode(await failed.actions.handoff(handoffCommand())), 'not_found');
});
