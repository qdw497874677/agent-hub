import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  asAgentId,
  asLoginId,
  asSessionId,
  asTaskId,
  asTeamId,
  asUserId,
  createProjectUseCase,
  createTask,
  err,
  forbidden,
  newWorkspace,
  ok,
  type DelegationDirectAuthorizeInput,
  type DelegationRun,
  type DomainError,
  type Principal,
  type Project,
  type ProjectRepo,
  type ProjectSessionGrant,
  type ProjectSessionGrantScope,
  type Result,
  type Session,
  type Task,
  type TaskCreationOutcome,
  type TaskCreationStore,
  type Workspace,
  type WorkspaceDelegation,
  type WorkspaceId
} from '@agent-hub/domain';
import { inMemoryDeps } from '@agent-hub/domain/testing';
import { createSqliteWorkspaceDelegations } from '@agent-hub/storage-sqlite';
import type { DelegationDeps } from './workspace-delegation.ts';
import type { ProjectSessionGrantService } from './project-session-grant.ts';
import {
  createProjectSessionActions,
  type ProjectDirectRunner,
  type ProjectSessionActionDeps
} from './project-session-actions.ts';

const SESSION_ID = asSessionId('ses-source');
const EXEC_SESSION_ID = asSessionId('ses-exec');
const OWNER_ID = 'u-owner';
const REQUEST_KEY = 'req-worktree-1';
const INSTRUCTIONS = '不要把这个派工说明回显给模型。\n只改设置页。';
const GOAL = '把设置页拆成两个组件';

const UNIVERSAL_RAW = 'raw bridge text never returned';

function person(): Principal {
  return {
    user: {
      id: asUserId(OWNER_ID),
      email: 'owner@example.com',
      displayName: 'owner',
      role: 'owner',
      passwordHash: null,
      emailVerifiedAt: 1,
      disabledAt: null,
      createdAt: 1,
      teamId: asTeamId('t1'),
      clusterAdmin: false,
      deletedAt: null
    },
    loginId: asLoginId('owner')
  };
}

async function makeProject(deps: ReturnType<typeof inMemoryDeps>['deps'], name: string): Promise<Project> {
  const created = await createProjectUseCase(
    { ...deps, access: undefined },
    {
      name,
      rootPath: '',
      actor: person(),
      repoUrl: 'https://github.com/acme/app.git',
      defaultBranch: 'main'
    }
  );
  assert.ok(created.ok, JSON.stringify(created));
  return created.value;
}

function repoOf(project: Project): ProjectRepo {
  const repo = project.repos[0];
  assert.ok(repo);
  return repo;
}

function taskOf(project: Project, title: string, parentTaskId: ReturnType<typeof asTaskId> | null = null): Task {
  const task = createTask({
    projectId: project.id,
    title,
    ...(parentTaskId === null ? {} : { parentTaskId }),
    now: 1
  });
  assert.ok(task.ok);
  return task.value;
}

function sessionOf(input: {
  id: ReturnType<typeof asSessionId>;
  taskId: ReturnType<typeof asTaskId> | null;
  workspaceId: WorkspaceId | null;
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
    workspaceId: input.workspaceId,
    mcpDisabled: [],
    createdBy: OWNER_ID,
    createdAt: 1,
    updatedAt: 1
  };
}

function grantOf(project: Project, scope: ProjectSessionGrantScope): ProjectSessionGrant {
  return {
    id: `grant-${scope}`,
    accountId: OWNER_ID,
    sessionId: SESSION_ID,
    projectId: project.id,
    scopes: [scope],
    createdBy: OWNER_ID,
    createdAt: 1,
    expiresAt: null,
    revokedAt: null,
    revokedBy: null
  };
}

function receiptStore(tasks: ReturnType<typeof inMemoryDeps>['deps']['tasks']): TaskCreationStore & {
  readonly calls: Array<Parameters<TaskCreationStore['createWithReplay']>[0]>;
} {
  const calls: Array<Parameters<TaskCreationStore['createWithReplay']>[0]> = [];
  const seen = new Map<string, { fingerprint: string; task: Task }>();
  return {
    calls,
    async createWithReplay(intent): Promise<TaskCreationOutcome> {
      calls.push(intent);
      const prior = seen.get(intent.key);
      if (prior) {
        return prior.fingerprint === intent.fingerprint
          ? { status: 'replayed', task: prior.task }
          : { status: 'conflict' };
      }
      seen.set(intent.key, { fingerprint: intent.fingerprint, task: intent.task });
      await tasks.save(intent.task);
      return { status: 'created', task: intent.task };
    },
    async listByParent() {
      return [];
    }
  };
}

interface Harness {
  readonly actions: ReturnType<typeof createProjectSessionActions>;
  readonly project: Project;
  readonly repo: ProjectRepo;
  readonly parent: Task;
  readonly target: Task;
  readonly workspace: Workspace;
  readonly execSession: Session;
  readonly tasks: ReturnType<typeof inMemoryDeps>['deps']['tasks'];
  readonly receipts: ReturnType<typeof receiptStore>;
  readonly grantCalls: Array<{ sessionId: ReturnType<typeof asSessionId>; scope: ProjectSessionGrantScope }>;
  readonly actorCalls: string[];
  readonly runCommands: Parameters<ProjectDirectRunner>[3][];
  readonly authorizerSteps: DelegationDirectAuthorizeInput['step'][];
  setGrantFailureAfter(value: number | null): void;
  setRunResult(value: Result<DelegationRun, DomainError>): void;
}

async function harness(options: { targetState?: WorkspaceDelegation['state']; runResult?: Result<DelegationRun, DomainError> } = {}): Promise<Harness> {
  const world = inMemoryDeps();
  const deps = { ...world.deps, access: undefined };
  const project = await makeProject(world.deps, 'project-a');
  const repo = repoOf(project);

  const parent = taskOf(project, '父任务');
  await deps.tasks.save(parent);
  const target = taskOf(project, '子任务');
  await deps.tasks.save(target);

  const sourceWorkspace = newWorkspace({
    projectId: project.id,
    workerId: 'local',
    path: '/tmp/project-a',
    kind: 'temporary',
    source: 'worktree',
    ownerTaskId: parent.id,
    branch: 'task/parent',
    now: 1
  });
  assert.ok(sourceWorkspace.ok);
  await deps.workspaces.save(sourceWorkspace.value);

  const workspace = newWorkspace({
    projectId: project.id,
    workerId: 'local',
    path: `/tmp/project-a/.worktrees/${REQUEST_KEY}`,
    kind: 'temporary',
    source: 'worktree',
    ownerTaskId: target.id,
    branch: `delegation/${REQUEST_KEY}`,
    now: 2
  });
  assert.ok(workspace.ok);
  await deps.workspaces.save(workspace.value);

  const execSession = sessionOf({ id: EXEC_SESSION_ID, taskId: target.id, workspaceId: workspace.value.id });
  await deps.sessions.save(execSession);
  await deps.sessions.save(
    sessionOf({ id: SESSION_ID, taskId: parent.id, workspaceId: sourceWorkspace.value.id })
  );

  const grantCalls: Harness['grantCalls'] = [];
  let grantFailureAfter: number | null = null;
  const grants: Pick<ProjectSessionGrantService, 'authorize'> = {
    async authorize(input) {
      grantCalls.push({ sessionId: input.sessionId, scope: input.scope });
      if (grantFailureAfter !== null && grantCalls.length > grantFailureAfter) {
        return err(forbidden('项目授权已撤销或已过期'));
      }
      return ok(grantOf(project, input.scope));
    }
  };

  const actorCalls: string[] = [];
  const loadActorResult: Principal | null = person();

  const receipts = receiptStore(deps.tasks);
  const delegations = createSqliteWorkspaceDelegations(new DatabaseSync(':memory:'));
  const runCommands: Harness['runCommands'] = [];
  const authorizerSteps: DelegationDirectAuthorizeInput['step'][] = [];
  const record: WorkspaceDelegation = {
    id: 'dlg-1',
    accountId: OWNER_ID,
    coordinatorSessionId: SESSION_ID,
    mode: 'direct',
    requestKey: REQUEST_KEY,
    requestFingerprint: 'fingerprint',
    projectId: project.id,
    taskId: target.id,
    repoId: repo.id,
    repoUrl: repo.url,
    workerId: 'local',
    baseBranch: 'main',
    baseSha: 'a'.repeat(40),
    instructions: INSTRUCTIONS,
    startup: null,
    executionSessionId: EXEC_SESSION_ID,
    worktreePath: workspace.value.path,
    branch: workspace.value.branch ?? `delegation/${REQUEST_KEY}`,
    state: options.targetState ?? 'prepared',
    claim: null,
    failure: null,
    createdAt: 1,
    updatedAt: 1
  };

  let runResult: Result<DelegationRun, DomainError> =
    options.runResult ?? ok({ record, allocation: 'created', claimed: true });
  const runDirect: ProjectDirectRunner = async (_deps, _delegations, authorize, command) => {
    runCommands.push(command);
    // 模拟领域用例在 create 之前会调用一次；测试里四个步骤都走一遍，
    // 确认动作层把同一个强制谓词交给领域，而且谓词能独立拒绝。
    for (const step of ['create', 'prepare', 'start', 'instruction'] as const) {
      authorizerSteps.push(step);
      const result = await authorize(authorizerInput(command, {
        project,
        repo,
        task: target,
        record,
        prepared: step === 'start' || step === 'instruction'
          ? { workspaceId: workspace.value.id, baseSha: record.baseSha as string }
          : null,
        started: step === 'instruction'
          ? { sessionId: EXEC_SESSION_ID, taskId: target.id, workspaceId: workspace.value.id }
          : null
      }));
      if (!result.ok) return result;
    }
    return runResult;
  };

  const actionDeps: ProjectSessionActionDeps = {
    grants,
    delegationDeps: deps as unknown as DelegationDeps,
    delegations,
    taskCreations: receipts,
    loadActor: async (accountId) => {
      actorCalls.push(accountId);
      return loadActorResult;
    },
    runDirect
  };

  return {
    actions: createProjectSessionActions(actionDeps),
    project,
    repo,
    parent,
    target,
    workspace: workspace.value,
    execSession,
    tasks: deps.tasks,
    receipts,
    grantCalls,
    actorCalls,
    runCommands,
    authorizerSteps,
    setGrantFailureAfter: (value) => {
      grantFailureAfter = value;
    },
    setRunResult: (value) => {
      runResult = value;
    }
  };
}

function authorizerInput(
  command: Parameters<ProjectDirectRunner>[3],
  input: {
    project: Project;
    repo: ProjectRepo;
    task: Task;
    record: WorkspaceDelegation;
    prepared: DelegationDirectAuthorizeInput['prepared'];
    started: DelegationDirectAuthorizeInput['started'];
  }
): DelegationDirectAuthorizeInput {
  return {
    step: 'create',
    actor: person(),
    source: {
      sessionId: command.sourceSessionId,
      projectId: input.project.id,
      taskId: input.task.id,
      accountId: OWNER_ID
    },
    project: input.project,
    task: input.task,
    repo: input.repo,
    plan: {
      workerId: 'local',
      baseBranch: command.baseBranch,
      worktreePath: input.record.worktreePath,
      branch: input.record.branch
    },
    record: input.record,
    prepared: input.prepared,
    started: input.started
  };
}

function taskCommand(overrides: Record<string, unknown> = {}): Parameters<ReturnType<typeof createProjectSessionActions>['createTask']>[0] {
  return {
    actorId: OWNER_ID,
    actorVia: 'web',
    sessionId: SESSION_ID,
    requestKey: 'req-task-1',
    title: '拆分子任务',
    goal: GOAL,
    parentTaskId: null,
    ...overrides
  } as Parameters<ReturnType<typeof createProjectSessionActions>['createTask']>[0];
}

function worktreeCommand(overrides: Record<string, unknown> = {}): Parameters<ReturnType<typeof createProjectSessionActions>['startWorktree']>[0] {
  return {
    actorId: OWNER_ID,
    actorVia: 'web',
    sessionId: SESSION_ID,
    requestKey: REQUEST_KEY,
    taskId: 'will-be-replaced',
    repoId: 'will-be-replaced',
    baseBranch: 'main',
    instructions: INSTRUCTIONS,
    agentId: 'fake-agent',
    model: null,
    profileId: null,
    ...overrides
  } as Parameters<ReturnType<typeof createProjectSessionActions>['startWorktree']>[0];
}

test('createTask 用授权里的项目建任务，参数与请求键原样落到幂等回执', async () => {
  const h = await harness();
  const command = taskCommand({ parentTaskId: h.parent.id });

  const result = await h.actions.createTask(command);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.value.projectId, h.project.id);
  assert.equal(result.value.parentTaskId, h.parent.id);
  assert.equal(result.value.status, 'todo');

  assert.equal(h.grantCalls.length, 1);
  assert.equal(h.grantCalls[0]!.scope, 'task:write');
  assert.equal(h.actorCalls.length, 1);
  assert.equal(h.receipts.calls.length, 1);
  const receipt = h.receipts.calls[0]!;
  assert.equal(receipt.actorId, OWNER_ID);
  assert.equal(receipt.sourceSessionId, SESSION_ID);
  assert.equal(receipt.projectId, h.project.id);
  assert.equal(receipt.operation, 'task.create');
  assert.match(receipt.key, /req-task-1/);
  assert.equal(receipt.task.title, '拆分子任务');
  assert.equal(receipt.task.goal, GOAL);
  assert.equal(receipt.task.ownerId, OWNER_ID);
  assert.equal(receipt.task.parentTaskId, h.parent.id);
});

test('createTask 同键同参回放原任务，同键异参冲突且不泄露请求内容', async () => {
  const h = await harness();
  const first = await h.actions.createTask(taskCommand());
  assert.ok(first.ok);

  const replay = await h.actions.createTask(taskCommand());
  assert.ok(replay.ok);
  assert.equal(replay.value.id, first.value.id);

  const conflict = await h.actions.createTask(taskCommand({ title: '另一个标题', goal: '另一段目标' }));
  assert.equal(conflict.ok, false);
  if (!conflict.ok) {
    assert.equal(conflict.error.code, 'conflict');
    assert.equal(conflict.error.message.includes('另一个标题'), false);
    assert.equal(conflict.error.message.includes('另一段目标'), false);
  }
});

test('createTask 对不存在或跨项目的父任务给同一个中性错误，且没有写回执', async () => {
  const h = await harness();
  const other = await makeProject(inMemoryDeps().deps, 'project-b');
  const foreign = taskOf(other, '别的项目的父任务');

  for (const parentTaskId of [foreign.id, 'tsk-missing']) {
    const result = await h.actions.createTask(taskCommand({ parentTaskId }));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'invalid');
      assert.equal(result.error.message, 'parent_task_id 无效');
    }
  }
  assert.equal(h.receipts.calls.length, 0);
});

test('createTask 在授权失败或账号停用时不会写任务', async () => {
  const h = await harness();
  h.setGrantFailureAfter(0);
  const denied = await h.actions.createTask(taskCommand());
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.error.code, 'forbidden');

  h.setGrantFailureAfter(null);
  const h2 = await harness();
  // 通过把 loadActor 改为 null 太侵入；这里用同一注入点覆盖停用账号的分支。
  const actionDeps: ProjectSessionActionDeps = {
    grants: {
      async authorize(input) {
        return ok(grantOf(h2.project, input.scope));
      }
    },
    delegationDeps: (inMemoryDeps().deps as unknown) as DelegationDeps,
    delegations: createSqliteWorkspaceDelegations(new DatabaseSync(':memory:')),
    taskCreations: h2.receipts,
    loadActor: async () => null,
    runDirect: async () => {
      throw new Error('不应调用派工');
    }
  };
  const actions = createProjectSessionActions(actionDeps);
  const disabled = await actions.createTask(taskCommand());
  assert.equal(disabled.ok, false);
  if (!disabled.ok) assert.equal(disabled.error.code, 'forbidden');
});

test('startWorktree 把命令交给直接车道，并在 prepared 时从精确执行会话取 workspace id', async () => {
  const h = await harness();
  const command = worktreeCommand({ taskId: h.target.id, repoId: h.repo.id });

  const result = await h.actions.startWorktree(command);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.value.delegationId, 'dlg-1');
  assert.equal(result.value.executionSessionId, EXEC_SESSION_ID);
  assert.equal(result.value.workspaceId, h.workspace.id);
  assert.equal(result.value.taskId, h.target.id);
  assert.equal(result.value.repoId, h.repo.id);
  assert.equal(result.value.branch, h.workspace.branch);
  assert.equal(result.value.baseSha, 'a'.repeat(40));

  assert.equal(h.runCommands.length, 1);
  const sent = h.runCommands[0]!;
  assert.equal(sent.sourceSessionId, SESSION_ID);
  assert.equal(sent.requestKey, REQUEST_KEY);
  assert.equal(sent.taskId, h.target.id);
  assert.equal(sent.repoId, h.repo.id);
  assert.equal(sent.baseBranch, 'main');
  assert.equal(sent.instructions, INSTRUCTIONS);
  assert.equal(sent.agentId, 'fake-agent');
  assert.equal(sent.model, null);
  assert.equal(sent.profileId, null);

  // 初始 worktree:open 一次，领域四步各一次。
  assert.deepEqual(h.grantCalls.map((call) => call.scope), [
    'worktree:open',
    'worktree:open',
    'worktree:open',
    'worktree:open',
    'worktree:open'
  ]);
  assert.deepEqual(h.authorizerSteps, ['create', 'prepare', 'start', 'instruction']);
});

test('startWorktree 在后续步骤授权被撤销时拒绝，且响应不带 instructions', async () => {
  const h = await harness();
  h.setGrantFailureAfter(1);

  const result = await h.actions.startWorktree(worktreeCommand({ taskId: h.target.id, repoId: h.repo.id }));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'forbidden');
    assert.equal(result.error.message.includes(INSTRUCTIONS), false);
    assert.equal(result.error.message.includes('不要把这个派工说明'), false);
  }
  assert.equal(h.grantCalls.length, 2);
});

test('startWorktree 不向响应回显原始 bridge 失败文本或非 prepared 状态', async () => {
  const h = await harness();
  h.setRunResult(err({ code: 'unavailable', message: `git clone failed at /tmp/secret-token: ${INSTRUCTIONS}` }));

  const failed = await h.actions.startWorktree(worktreeCommand({ taskId: h.target.id, repoId: h.repo.id }));
  assert.equal(failed.ok, false);
  if (!failed.ok) {
    assert.equal(failed.error.code, 'unavailable');
    assert.equal(failed.error.message.includes('/tmp/secret-token'), false);
    assert.equal(failed.error.message.includes(INSTRUCTIONS), false);
  }

  const uncertain = await harness({ targetState: 'uncertain' });
  const result = await uncertain.actions.startWorktree(worktreeCommand({ taskId: uncertain.target.id, repoId: uncertain.repo.id }));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'unavailable');
    assert.equal(result.error.message.includes(UNIVERSAL_RAW), false);
  }
});

test('startWorktree 执行会话没有工作区时失败，不伪造 id', async () => {
  const h = await harness();
  // 把执行会话改成没有 workspaceId；prepared 记录仍在，但动作层不能猜。
  const noWorkspace: Session = { ...h.execSession, workspaceId: null };
  const deps = inMemoryDeps();
  await deps.deps.tasks.save(h.target);
  await deps.deps.sessions.save(noWorkspace);

  const actionDeps: ProjectSessionActionDeps = {
    grants: {
      async authorize(input) {
        return ok(grantOf(h.project, input.scope));
      }
    },
    delegationDeps: (deps.deps as unknown) as DelegationDeps,
    delegations: createSqliteWorkspaceDelegations(new DatabaseSync(':memory:')),
    taskCreations: h.receipts,
    loadActor: async () => person(),
    runDirect: async (_deps, _delegations, _authorize, command) =>
      ok({
        record: {
          id: 'dlg-2',
          accountId: OWNER_ID,
          coordinatorSessionId: command.sourceSessionId,
          mode: 'direct',
          requestKey: command.requestKey,
          requestFingerprint: 'fp',
          projectId: h.project.id,
          taskId: h.target.id,
          repoId: h.repo.id,
          repoUrl: h.repo.url,
          workerId: 'local',
          baseBranch: 'main',
          baseSha: 'b'.repeat(40),
          instructions: command.instructions,
          startup: null,
          executionSessionId: EXEC_SESSION_ID,
          worktreePath: '/tmp/x',
          branch: 'delegation/x',
          state: 'prepared',
          claim: null,
          failure: null,
          createdAt: 1,
          updatedAt: 1
        },
        allocation: 'created',
        claimed: true
      })
  };
  const actions = createProjectSessionActions(actionDeps);
  const result = await actions.startWorktree(worktreeCommand({ taskId: h.target.id, repoId: h.repo.id }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'unavailable');
  assert.equal(JSON.stringify(result).includes('ws-'), false);
});
