import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROJECT_CANDIDATE_IMPORT_TOOL_SCOPE,
  PROJECT_MESSAGE_SEND_TOOL_SCOPE,
  PROJECT_READ_TOOL_SCOPE,
  PROJECT_TASK_WRITE_TOOL_SCOPE,
  PROJECT_WORKTREE_OPEN_TOOL_SCOPE,
  asSessionId,
  asUserId,
  err,
  forbidden,
  ok,
  type DomainError,
  type Result,
  type ToolContext,
  type ToolGrant,
  type ToolScope
} from '@agent-hub/domain';
import {
  PROJECT_CANDIDATE_IMPORT_TOOL_NAME,
  PROJECT_SESSION_HANDOFF_TOOL_NAME,
  PROJECT_SESSION_LIST_TOOL_NAME,
  PROJECT_TASK_CREATE_TOOL_NAME,
  PROJECT_WORKTREE_START_TOOL_NAME,
  createProjectSessionToolProvider,
  type ProjectCandidateImportCommand,
  type ProjectCandidateImportSnapshot,
  type ProjectSessionHandoffCommand,
  type ProjectSessionHandoffSnapshot,
  type ProjectSessionListQuery,
  type ProjectSessionSummary,
  type ProjectSessionToolDeps,
  type ProjectTaskCreateCommand,
  type ProjectTaskSnapshot,
  type ProjectWorktreeSnapshot,
  type ProjectWorktreeStartCommand
} from './project-session-tools.ts';

const SESSION_ID = asSessionId('ses-source');
const ACTOR_ID = asUserId('u-actor');
const TASK_SCOPE: ToolScope = PROJECT_TASK_WRITE_TOOL_SCOPE;
const WORKTREE_SCOPE: ToolScope = PROJECT_WORKTREE_OPEN_TOOL_SCOPE;

const TASK_SNAPSHOT: ProjectTaskSnapshot = {
  id: 'tsk-child',
  projectId: 'prj-1',
  parentTaskId: 'tsk-parent',
  status: 'todo'
};

const WORKTREE_SNAPSHOT: ProjectWorktreeSnapshot = {
  delegationId: 'dlg-1',
  executionSessionId: 'ses-exec',
  workspaceId: 'ws-1',
  taskId: 'tsk-child',
  repoId: 'repo-1',
  branch: 'delegation/req-1',
  baseSha: 'a'.repeat(40)
};

function grant(overrides: Partial<ToolGrant> = {}): ToolGrant {
  return {
    id: 'grant-1',
    tokenHash: 'hash',
    taskId: null,
    sessionId: SESSION_ID,
    workerId: 'local',
    scopes: [TASK_SCOPE, WORKTREE_SCOPE],
    createdAt: 1,
    expiresAt: 1_000,
    revokedAt: null,
    actor: { userId: ACTOR_ID, via: 'web' },
    ...overrides
  };
}

function ctx(overrides: Partial<ToolGrant> = {}): ToolContext {
  return { grant: grant(overrides), now: 1 };
}

function world() {
  const taskCommands: ProjectTaskCreateCommand[] = [];
  const worktreeCommands: ProjectWorktreeStartCommand[] = [];
  let taskResult: Result<ProjectTaskSnapshot, DomainError> = ok(TASK_SNAPSHOT);
  let worktreeResult: Result<ProjectWorktreeSnapshot, DomainError> = ok(WORKTREE_SNAPSHOT);

  const deps: ProjectSessionToolDeps = {
    scopes: { taskCreate: TASK_SCOPE, worktreeStart: WORKTREE_SCOPE },
    createTask: async (command) => {
      taskCommands.push(command);
      return taskResult;
    },
    startWorktree: async (command) => {
      worktreeCommands.push(command);
      return worktreeResult;
    }
  };

  return {
    provider: createProjectSessionToolProvider(deps),
    deps,
    taskCommands,
    worktreeCommands,
    setTaskResult: (value: Result<ProjectTaskSnapshot, DomainError>) => {
      taskResult = value;
    },
    setWorktreeResult: (value: Result<ProjectWorktreeSnapshot, DomainError>) => {
      worktreeResult = value;
    }
  };
}

const CANDIDATE_SCOPE: ToolScope = PROJECT_CANDIDATE_IMPORT_TOOL_SCOPE;
const MESSAGE_SCOPE: ToolScope = PROJECT_MESSAGE_SEND_TOOL_SCOPE;
const READ_SCOPE: ToolScope = PROJECT_READ_TOOL_SCOPE;
const TARGET_SESSION_ID = asSessionId('ses-target');
const CANDIDATE_SHA = 'c'.repeat(40);

const CANDIDATE_SNAPSHOT: ProjectCandidateImportSnapshot = {
  ref: `refs/agent-hub/imports/${TARGET_SESSION_ID}/${CANDIDATE_SHA}`,
  sha: CANDIDATE_SHA,
  alreadyPresent: false,
  targetSessionId: TARGET_SESSION_ID
};

const HANDOFF_SNAPSHOT: ProjectSessionHandoffSnapshot = {
  messageId: 'msg-1',
  targetSessionId: TARGET_SESSION_ID,
  status: 'inbox',
  wake: false
};

const LIST_ROWS: readonly ProjectSessionSummary[] = [
  {
    sessionId: TARGET_SESSION_ID,
    taskId: 'tsk-1',
    title: '目标会话',
    status: 'idle',
    agentId: 'agent-x'
  },
  {
    sessionId: asSessionId('ses-2'),
    taskId: null,
    title: null,
    status: 'working',
    agentId: 'agent-y'
  },
  {
    sessionId: asSessionId('ses-3'),
    taskId: 'tsk-3',
    title: '第三个会话',
    status: 'done',
    agentId: 'agent-z'
  }
];

function fullWorld() {
  const candidateCommands: ProjectCandidateImportCommand[] = [];
  const handoffCommands: ProjectSessionHandoffCommand[] = [];
  const listQueries: ProjectSessionListQuery[] = [];
  let candidateResult: Result<ProjectCandidateImportSnapshot, DomainError> = ok(CANDIDATE_SNAPSHOT);
  let handoffResult: Result<ProjectSessionHandoffSnapshot, DomainError> = ok(HANDOFF_SNAPSHOT);
  let listResult: Result<readonly ProjectSessionSummary[], DomainError> = ok(LIST_ROWS);

  const deps: ProjectSessionToolDeps = {
    scopes: {
      taskCreate: TASK_SCOPE,
      worktreeStart: WORKTREE_SCOPE,
      candidateImport: CANDIDATE_SCOPE,
      handoff: MESSAGE_SCOPE,
      sessionList: READ_SCOPE
    },
    createTask: async () => ok(TASK_SNAPSHOT),
    startWorktree: async () => ok(WORKTREE_SNAPSHOT),
    importCandidate: async (command) => {
      candidateCommands.push(command);
      return candidateResult;
    },
    handoff: async (command) => {
      handoffCommands.push(command);
      return handoffResult;
    },
    listSessions: async (query) => {
      listQueries.push(query);
      return listResult;
    }
  };

  return {
    provider: createProjectSessionToolProvider(deps),
    deps,
    candidateCommands,
    handoffCommands,
    listQueries,
    setCandidateResult: (value: Result<ProjectCandidateImportSnapshot, DomainError>) => {
      candidateResult = value;
    },
    setHandoffResult: (value: Result<ProjectSessionHandoffSnapshot, DomainError>) => {
      handoffResult = value;
    },
    setListResult: (value: Result<readonly ProjectSessionSummary[], DomainError>) => {
      listResult = value;
    }
  };
}

function candidateImportInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request_key: 'req-import-1',
    source_session_id: 'ses-source',
    target_session_id: 'ses-target',
    repo_id: 'repo-1',
    sha: CANDIDATE_SHA,
    ...overrides
  };
}

function handoffInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request_key: 'req-handoff-1',
    target_session_id: 'ses-target',
    body: '请接手这个候选提交。\n不要改部署配置。',
    ...overrides
  };
}

function taskInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request_key: 'req-task-1',
    title: '设置页拆分子任务',
    goal: '把设置页拆成两个组件',
    parent_task_id: 'tsk-parent',
    ...overrides
  };
}

function worktreeInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request_key: 'req-wt-1',
    task_id: 'tsk-child',
    repo_id: 'repo-1',
    base_branch: 'main',
    instructions: '执行子任务，并保留现有路由。\n不要改部署配置。',
    agent_id: 'fake-agent',
    ...overrides
  };
}

test('project sessions provider 暴露两条工具且使用不同的注入 scope', () => {
  const w = world();
  const tools = w.provider.tools();

  assert.deepEqual(
    tools.map((tool) => tool.name),
    [PROJECT_TASK_CREATE_TOOL_NAME, PROJECT_WORKTREE_START_TOOL_NAME]
  );
  assert.equal(tools[0]!.scope, TASK_SCOPE);
  assert.equal(tools[1]!.scope, WORKTREE_SCOPE);
  assert.notEqual(tools[0]!.scope, tools[1]!.scope);
  assert.equal(tools[0]!.inputSchema.additionalProperties, false);
  assert.equal(tools[1]!.inputSchema.additionalProperties, false);
});

test('project.task.create 把上下文绑定和规范化参数交给回调，不泄漏 title/goal', async () => {
  const w = world();
  const result = await w.provider.call(
    PROJECT_TASK_CREATE_TOOL_NAME,
    taskInput({ title: '  设置页拆分子任务  ', goal: '  把设置页拆成两个组件  ' }),
    ctx()
  );

  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(w.taskCommands.length, 1);
  assert.deepEqual(w.taskCommands[0], {
    actorId: ACTOR_ID,
    actorVia: 'web',
    sessionId: SESSION_ID,
    requestKey: 'req-task-1',
    title: '设置页拆分子任务',
    goal: '把设置页拆成两个组件',
    parentTaskId: 'tsk-parent'
  });

  const payload = JSON.stringify(result.value);
  assert.equal(payload.includes('设置页拆分子任务'), false);
  assert.equal(payload.includes('把设置页拆成两个组件'), false);
  assert.deepEqual(result.value, {
    task: { id: 'tsk-child', projectId: 'prj-1', parentTaskId: 'tsk-parent', status: 'todo' }
  });

  // 创建任务绝不隐式派工。
  assert.equal(w.worktreeCommands.length, 0);
  assert.equal(payload.includes('executionSessionId'), false);
});

test('project.task.create 的 goal 与 parent_task_id 可省略，空 goal 归一为 null', async () => {
  const w = world();
  const omitted = await w.provider.call(
    PROJECT_TASK_CREATE_TOOL_NAME,
    { request_key: 'req-task-2', title: '只有标题' },
    ctx()
  );
  assert.ok(omitted.ok, JSON.stringify(omitted));
  assert.equal(w.taskCommands[0]!.goal, null);
  assert.equal(w.taskCommands[0]!.parentTaskId, null);

  const empty = await w.provider.call(
    PROJECT_TASK_CREATE_TOOL_NAME,
    { request_key: 'req-task-3', title: '空目标', goal: '   ', parent_task_id: null },
    ctx()
  );
  assert.ok(empty.ok, JSON.stringify(empty));
  assert.equal(w.taskCommands[1]!.goal, null);
  assert.equal(w.taskCommands[1]!.parentTaskId, null);
});

test('project.worktree.start 原样交付 instructions，并透传可选 model/profile', async () => {
  const w = world();
  const input = worktreeInput({ model: 'model-x', profile_id: 'profile-y' });
  const result = await w.provider.call(PROJECT_WORKTREE_START_TOOL_NAME, input, ctx());

  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(w.worktreeCommands.length, 1);
  assert.deepEqual(w.worktreeCommands[0], {
    actorId: ACTOR_ID,
    actorVia: 'web',
    sessionId: SESSION_ID,
    requestKey: 'req-wt-1',
    taskId: 'tsk-child',
    repoId: 'repo-1',
    baseBranch: 'main',
    instructions: '执行子任务，并保留现有路由。\n不要改部署配置。',
    agentId: 'fake-agent',
    model: 'model-x',
    profileId: 'profile-y'
  });

  const payload = JSON.stringify(result.value);
  assert.equal(payload.includes('执行子任务'), false);
  assert.equal(payload.includes('instructions'), false);
  assert.deepEqual(result.value, {
    worktree: {
      delegationId: 'dlg-1',
      executionSessionId: 'ses-exec',
      workspaceId: 'ws-1',
      taskId: 'tsk-child',
      repoId: 'repo-1',
      branch: 'delegation/req-1',
      baseSha: 'a'.repeat(40)
    }
  });
  // 开 worktree 不隐式建任务。
  assert.equal(w.taskCommands.length, 0);
});

test('project.worktree.start 未提供 model/profile 时传 null', async () => {
  const w = world();
  const result = await w.provider.call(PROJECT_WORKTREE_START_TOOL_NAME, worktreeInput(), ctx());

  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(w.worktreeCommands[0]!.model, null);
  assert.equal(w.worktreeCommands[0]!.profileId, null);
});

test('两个工具都拒绝身份 / 项目 / 路径 / 凭据参数，且诊断不回显值', async () => {
  const w = world();
  const taskAttempt = await w.provider.call(
    PROJECT_TASK_CREATE_TOOL_NAME,
    taskInput({
      actor: 'u-other',
      project_id: 'prj-other',
      token: 'SECRET-TOKEN',
      worktree_path: '/tmp/elsewhere',
      goal: 'GOAL-SECRET'
    }),
    ctx()
  );

  assert.equal(taskAttempt.ok, false);
  assert.equal(taskAttempt.ok === false ? taskAttempt.error.code : null, 'invalid');
  assert.equal(w.taskCommands.length, 0);
  const taskError = JSON.stringify(taskAttempt);
  assert.match(taskError, /actor/);
  assert.match(taskError, /project_id/);
  assert.equal(taskError.includes('SECRET-TOKEN'), false);
  assert.equal(taskError.includes('/tmp/elsewhere'), false);
  assert.equal(taskError.includes('GOAL-SECRET'), false);

  const worktreeAttempt = await w.provider.call(
    PROJECT_WORKTREE_START_TOOL_NAME,
    worktreeInput({
      actor: 'u-other',
      repo_url: 'https://github.com/acme/other.git',
      remote: 'origin',
      instructions: 'INSTR-SECRET'
    }),
    ctx()
  );

  assert.equal(worktreeAttempt.ok, false);
  assert.equal(worktreeAttempt.ok === false ? worktreeAttempt.error.code : null, 'invalid');
  assert.equal(w.worktreeCommands.length, 0);
  const worktreeError = JSON.stringify(worktreeAttempt);
  assert.match(worktreeError, /repo_url/);
  assert.equal(worktreeError.includes('INSTR-SECRET'), false);
  assert.equal(worktreeError.includes('https://github.com/acme/other.git'), false);
});

test('参数严格校验：必填、首尾空白、控制字符、分支与超长 request_key', async () => {
  const w = world();

  const noKey = await w.provider.call(PROJECT_TASK_CREATE_TOOL_NAME, { title: '缺请求键' }, ctx());
  assert.equal(noKey.ok === false ? noKey.error.code : null, 'invalid');

  const paddedKey = await w.provider.call(
    PROJECT_TASK_CREATE_TOOL_NAME,
    taskInput({ request_key: ' req-padded ' }),
    ctx()
  );
  assert.equal(paddedKey.ok === false ? paddedKey.error.code : null, 'invalid');

  const tooLong = await w.provider.call(
    PROJECT_TASK_CREATE_TOOL_NAME,
    taskInput({ request_key: 'k'.repeat(201) }),
    ctx()
  );
  assert.equal(tooLong.ok === false ? tooLong.error.code : null, 'invalid');

  const control = await w.provider.call(
    PROJECT_TASK_CREATE_TOOL_NAME,
    taskInput({ request_key: 'req\nkey' }),
    ctx()
  );
  assert.equal(control.ok === false ? control.error.code : null, 'invalid');

  for (const baseBranch of ['feat branch', 'a..b', 'main~1', '/main', 'main/']) {
    const badBranch = await w.provider.call(
      PROJECT_WORKTREE_START_TOOL_NAME,
      worktreeInput({ base_branch: baseBranch }),
      ctx()
    );
    assert.equal(badBranch.ok === false ? badBranch.error.code : null, 'invalid', baseBranch);
  }

  const missingInstructions = await w.provider.call(
    PROJECT_WORKTREE_START_TOOL_NAME,
    worktreeInput({ instructions: '   ' }),
    ctx()
  );
  assert.equal(missingInstructions.ok === false ? missingInstructions.error.code : null, 'invalid');

  const nullRequired = await w.provider.call(
    PROJECT_WORKTREE_START_TOOL_NAME,
    worktreeInput({ agent_id: null }),
    ctx()
  );
  assert.equal(nullRequired.ok === false ? nullRequired.error.code : null, 'invalid');

  assert.equal(w.taskCommands.length, 0);
  assert.equal(w.worktreeCommands.length, 0);
});

test('没有冻结 actor（或 userId 为空）时拒绝，且不调用任何回调', async () => {
  const w = world();

  const noActor = await w.provider.call(PROJECT_TASK_CREATE_TOOL_NAME, taskInput(), ctx({ actor: undefined }));
  assert.equal(noActor.ok === false ? noActor.error.code : null, 'forbidden');

  const nullUser = await w.provider.call(
    PROJECT_TASK_CREATE_TOOL_NAME,
    taskInput(),
    ctx({ actor: { userId: null, via: 'web' } })
  );
  assert.equal(nullUser.ok === false ? nullUser.error.code : null, 'forbidden');

  const noActorWorktree = await w.provider.call(
    PROJECT_WORKTREE_START_TOOL_NAME,
    worktreeInput(),
    ctx({ actor: undefined })
  );
  assert.equal(noActorWorktree.ok === false ? noActorWorktree.error.code : null, 'forbidden');

  assert.equal(w.taskCommands.length, 0);
  assert.equal(w.worktreeCommands.length, 0);
});

test('只识别自己的工具名，未知工具不触发回调', async () => {
  const w = world();
  const result = await w.provider.call('project.task.start', taskInput(), ctx());

  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.error.code : null, 'not_found');
  assert.equal(w.taskCommands.length, 0);
  assert.equal(w.worktreeCommands.length, 0);
});

test('回调返回的额外字段（goal / instructions / title）不会进入响应', async () => {
  const w = world();
  w.setTaskResult(
    ok({
      ...TASK_SNAPSHOT,
      title: 'TITLE-LEAK',
      goal: 'GOAL-LEAK',
      instructions: 'INSTR-LEAK'
    } as ProjectTaskSnapshot)
  );
  w.setWorktreeResult(
    ok({
      ...WORKTREE_SNAPSHOT,
      instructions: 'INSTR-LEAK',
      goal: 'GOAL-LEAK'
    } as ProjectWorktreeSnapshot)
  );

  const task = await w.provider.call(PROJECT_TASK_CREATE_TOOL_NAME, taskInput(), ctx());
  assert.ok(task.ok, JSON.stringify(task));
  const taskPayload = JSON.stringify(task.value);
  assert.equal(taskPayload.includes('TITLE-LEAK'), false);
  assert.equal(taskPayload.includes('GOAL-LEAK'), false);
  assert.equal(taskPayload.includes('INSTR-LEAK'), false);

  const worktree = await w.provider.call(PROJECT_WORKTREE_START_TOOL_NAME, worktreeInput(), ctx());
  assert.ok(worktree.ok, JSON.stringify(worktree));
  const worktreePayload = JSON.stringify(worktree.value);
  assert.equal(worktreePayload.includes('GOAL-LEAK'), false);
  assert.equal(worktreePayload.includes('INSTR-LEAK'), false);
});

test('回调拒绝时原样返回错误，且不调用另一个回调', async () => {
  const w = world();
  w.setTaskResult(err(forbidden('任务写权限已撤销')));
  const task = await w.provider.call(PROJECT_TASK_CREATE_TOOL_NAME, taskInput(), ctx());
  assert.equal(task.ok, false);
  assert.equal(task.ok === false ? task.error.code : null, 'forbidden');
  assert.equal(task.ok === false ? task.error.message : null, '任务写权限已撤销');
  assert.equal(w.worktreeCommands.length, 0);

  w.setWorktreeResult(err(forbidden('开工授权已撤销')));
  const worktree = await w.provider.call(PROJECT_WORKTREE_START_TOOL_NAME, worktreeInput(), ctx());
  assert.equal(worktree.ok, false);
  assert.equal(worktree.ok === false ? worktree.error.code : null, 'forbidden');
  assert.equal(worktree.ok === false ? worktree.error.message : null, '开工授权已撤销');
  assert.equal(w.taskCommands.length, 1);
});

test('同一请求原样重放时由回调负责幂等（provider 不改写请求键）', async () => {
  const w = world();
  const first = await w.provider.call(PROJECT_TASK_CREATE_TOOL_NAME, taskInput(), ctx());
  const second = await w.provider.call(PROJECT_TASK_CREATE_TOOL_NAME, taskInput(), ctx());

  assert.ok(first.ok, JSON.stringify(first));
  assert.ok(second.ok, JSON.stringify(second));
  assert.equal(w.taskCommands.length, 2);
  assert.equal(w.taskCommands[0]!.requestKey, 'req-task-1');
  assert.equal(w.taskCommands[1]!.requestKey, 'req-task-1');
  assert.deepEqual(w.taskCommands[0], w.taskCommands[1]);
});

test('装配时强制两个工具使用不同 scope', () => {
  const callbacks: Pick<ProjectSessionToolDeps, 'createTask' | 'startWorktree'> = {
    createTask: async () => ok(TASK_SNAPSHOT),
    startWorktree: async () => ok(WORKTREE_SNAPSHOT)
  };

  assert.throws(
    () =>
      createProjectSessionToolProvider({
        scopes: { taskCreate: TASK_SCOPE, worktreeStart: TASK_SCOPE },
        ...callbacks
      }),
    /distinct/
  );

  assert.throws(
    () =>
      createProjectSessionToolProvider({
        scopes: { taskCreate: '' as ToolScope, worktreeStart: WORKTREE_SCOPE },
        ...callbacks
      }),
    /both/
  );
});

test('可选能力全部启用时暴露五条工具，每条使用各自注入的 scope', () => {
  const w = fullWorld();
  const tools = w.provider.tools();

  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      PROJECT_TASK_CREATE_TOOL_NAME,
      PROJECT_WORKTREE_START_TOOL_NAME,
      PROJECT_CANDIDATE_IMPORT_TOOL_NAME,
      PROJECT_SESSION_HANDOFF_TOOL_NAME,
      PROJECT_SESSION_LIST_TOOL_NAME
    ]
  );
  assert.deepEqual(
    tools.map((tool) => tool.scope),
    [TASK_SCOPE, WORKTREE_SCOPE, CANDIDATE_SCOPE, MESSAGE_SCOPE, READ_SCOPE]
  );
  assert.equal(new Set(tools.map((tool) => tool.scope)).size, 5);
  assert.notEqual(CANDIDATE_SCOPE, TASK_SCOPE);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  }
});

test('未配置的可选工具不会凭空出现，调用按未知工具拒绝', async () => {
  const w = world();
  assert.equal(w.provider.tools().length, 2);

  const result = await w.provider.call(
    PROJECT_CANDIDATE_IMPORT_TOOL_NAME,
    candidateImportInput(),
    ctx()
  );
  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.error.code : null, 'not_found');
  assert.equal(w.taskCommands.length, 0);
  assert.equal(w.worktreeCommands.length, 0);
});

test('project.candidate.import 只接受绑定身份与五个精确参数', async () => {
  const w = fullWorld();
  const result = await w.provider.call(
    PROJECT_CANDIDATE_IMPORT_TOOL_NAME,
    candidateImportInput(),
    ctx()
  );

  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(w.candidateCommands.length, 1);
  assert.deepEqual(w.candidateCommands[0], {
    actorId: ACTOR_ID,
    actorVia: 'web',
    sessionId: SESSION_ID,
    requestKey: 'req-import-1',
    sourceSessionId: SESSION_ID,
    targetSessionId: TARGET_SESSION_ID,
    repoId: 'repo-1',
    sha: CANDIDATE_SHA
  });
  assert.deepEqual(result.value, {
    ref: CANDIDATE_SNAPSHOT.ref,
    sha: CANDIDATE_SHA,
    alreadyPresent: false,
    targetSessionId: TARGET_SESSION_ID
  });

  // 导入不隐式建任务、开工或发消息。
  assert.equal(w.handoffCommands.length, 0);
  assert.equal(w.listQueries.length, 0);
});

test('project.candidate.import 拒绝未知参数、坏 SHA 与相同会话，且不回显敏感值', async () => {
  const w = fullWorld();
  const attempts = [
    candidateImportInput({ path: '/tmp/LEAK-PATH', token: 'LEAK-TOKEN', ref: 'refs/heads/main' }),
    candidateImportInput({ sha: 'C'.repeat(40) }),
    candidateImportInput({ sha: 'c'.repeat(39) }),
    candidateImportInput({ sha: null }),
    candidateImportInput({ target_session_id: 'ses-source' }),
    candidateImportInput({ request_key: ' req-padded ' }),
    candidateImportInput({ source_session_id: 'ses\nsource' })
  ];

  const results: unknown[] = [];
  for (const input of attempts) {
    const result = await w.provider.call(PROJECT_CANDIDATE_IMPORT_TOOL_NAME, input, ctx());
    assert.equal(result.ok === false ? result.error.code : null, 'invalid');
    results.push(result);
  }

  assert.equal(w.candidateCommands.length, 0);
  const diagnostics = JSON.stringify(results);
  assert.match(diagnostics, /path/);
  assert.match(diagnostics, /token/);
  assert.equal(diagnostics.includes('LEAK-PATH'), false);
  assert.equal(diagnostics.includes('LEAK-TOKEN'), false);
  assert.equal(diagnostics.includes('/tmp/LEAK-PATH'), false);
});

test('project.candidate.import 只回白名单结果，无法核实的结果不透传', async () => {
  const w = fullWorld();
  w.setCandidateResult(
    ok({
      ...CANDIDATE_SNAPSHOT,
      path: '/tmp/LEAK',
      token: 'TOKEN-LEAK',
      body: 'BODY-LEAK'
    } as ProjectCandidateImportSnapshot)
  );

  const result = await w.provider.call(
    PROJECT_CANDIDATE_IMPORT_TOOL_NAME,
    candidateImportInput(),
    ctx()
  );
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(result.value, {
    ref: CANDIDATE_SNAPSHOT.ref,
    sha: CANDIDATE_SHA,
    alreadyPresent: false,
    targetSessionId: TARGET_SESSION_ID
  });
  const payload = JSON.stringify(result.value);
  assert.equal(payload.includes('LEAK'), false);

  for (const mismatch of [
    { ...CANDIDATE_SNAPSHOT, sha: 'd'.repeat(40) },
    { ...CANDIDATE_SNAPSHOT, ref: 'refs/heads/main' },
    { ...CANDIDATE_SNAPSHOT, ref: `refs/agent-hub/imports/other/${CANDIDATE_SHA}` },
    { ...CANDIDATE_SNAPSHOT, targetSessionId: asSessionId('ses-other') }
  ]) {
    w.setCandidateResult(ok(mismatch));
    const bad = await w.provider.call(
      PROJECT_CANDIDATE_IMPORT_TOOL_NAME,
      candidateImportInput(),
      ctx()
    );
    assert.equal(bad.ok === false ? bad.error.code : null, 'unavailable');
  }
});

test('project.session.handoff 默认只投收件箱，正文原样交付且不在响应回显', async () => {
  const w = fullWorld();
  const body = '请接手这个候选提交。\n不要改部署配置。';
  const result = await w.provider.call(
    PROJECT_SESSION_HANDOFF_TOOL_NAME,
    handoffInput({ body }),
    ctx()
  );

  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(w.handoffCommands.length, 1);
  assert.deepEqual(w.handoffCommands[0], {
    actorId: ACTOR_ID,
    actorVia: 'web',
    sessionId: SESSION_ID,
    requestKey: 'req-handoff-1',
    targetSessionId: TARGET_SESSION_ID,
    body,
    wake: false,
    candidate: null
  });
  assert.deepEqual(result.value, {
    messageId: 'msg-1',
    targetSessionId: TARGET_SESSION_ID,
    status: 'inbox',
    wake: false
  });

  const payload = JSON.stringify(result.value);
  assert.equal(payload.includes('候选提交'), false);
  assert.equal(payload.includes('不要改部署配置'), false);
  assert.equal(w.candidateCommands.length, 0);
});

test('project.session.handoff 显式 wake 与候选引用按结构透传', async () => {
  const w = fullWorld();
  w.setHandoffResult(ok({ ...HANDOFF_SNAPSHOT, status: 'queued', wake: true }));

  const result = await w.provider.call(
    PROJECT_SESSION_HANDOFF_TOOL_NAME,
    handoffInput({
      wake: true,
      candidate: {
        source_session_id: 'ses-source',
        repo_id: 'repo-1',
        sha: CANDIDATE_SHA
      }
    }),
    ctx()
  );

  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(w.handoffCommands[0]!.wake, true);
  assert.deepEqual(w.handoffCommands[0]!.candidate, {
    sourceSessionId: SESSION_ID,
    repoId: 'repo-1',
    sha: CANDIDATE_SHA
  });
  assert.deepEqual(result.value, {
    messageId: 'msg-1',
    targetSessionId: TARGET_SESSION_ID,
    status: 'queued',
    wake: true
  });
});

test('project.session.handoff 严格拒绝嵌套未知字段、空正文与非布尔 wake', async () => {
  const w = fullWorld();
  const attempts = [
    handoffInput({
      candidate: {
        source_session_id: 'ses-source',
        repo_id: 'repo-1',
        sha: CANDIDATE_SHA,
        path: '/tmp/LEAK-PATH'
      }
    }),
    handoffInput({
      candidate: { source_session_id: 'ses-source', repo_id: 'repo-1', sha: 'x'.repeat(40) }
    }),
    handoffInput({ body: '   ' }),
    handoffInput({ wake: 'true' }),
    handoffInput({ actor: 'u-other', token: 'LEAK-TOKEN' })
  ];

  const results: unknown[] = [];
  for (const input of attempts) {
    const result = await w.provider.call(PROJECT_SESSION_HANDOFF_TOOL_NAME, input, ctx());
    assert.equal(result.ok === false ? result.error.code : null, 'invalid');
    results.push(result);
  }

  assert.equal(w.handoffCommands.length, 0);
  const diagnostics = JSON.stringify(results);
  assert.match(diagnostics, /path/);
  assert.equal(diagnostics.includes('LEAK-PATH'), false);
  assert.equal(diagnostics.includes('LEAK-TOKEN'), false);
});

test('project.session.handoff 只回消息标识与状态，无法核实的结果不透传', async () => {
  const w = fullWorld();
  w.setHandoffResult(
    ok({
      ...HANDOFF_SNAPSHOT,
      body: 'BODY-LEAK',
      path: '/tmp/LEAK',
      token: 'TOKEN-LEAK'
    } as ProjectSessionHandoffSnapshot)
  );

  const result = await w.provider.call(
    PROJECT_SESSION_HANDOFF_TOOL_NAME,
    handoffInput(),
    ctx()
  );
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(result.value, {
    messageId: 'msg-1',
    targetSessionId: TARGET_SESSION_ID,
    status: 'inbox',
    wake: false
  });
  const payload = JSON.stringify(result.value);
  assert.equal(payload.includes('LEAK'), false);

  for (const mismatch of [
    { ...HANDOFF_SNAPSHOT, wake: true },
    { ...HANDOFF_SNAPSHOT, targetSessionId: asSessionId('ses-other') },
    { ...HANDOFF_SNAPSHOT, status: '' }
  ]) {
    w.setHandoffResult(ok(mismatch));
    const bad = await w.provider.call(
      PROJECT_SESSION_HANDOFF_TOOL_NAME,
      handoffInput(),
      ctx()
    );
    assert.equal(bad.ok === false ? bad.error.code : null, 'unavailable');
  }
});

test('project.session.list 绑定身份、默认有界并按白名单返回', async () => {
  const w = fullWorld();
  const result = await w.provider.call(PROJECT_SESSION_LIST_TOOL_NAME, {}, ctx());

  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(w.listQueries[0], {
    actorId: ACTOR_ID,
    actorVia: 'web',
    sessionId: SESSION_ID,
    limit: 20
  });
  assert.deepEqual(result.value, { sessions: LIST_ROWS, truncated: false });
});

test('project.session.list 按 limit 截断并丢弃额外字段与控制字符', async () => {
  const w = fullWorld();
  w.setListResult(
    ok([
      {
        ...LIST_ROWS[0]!,
        title: '目标\n会话',
        path: '/tmp/LEAK',
        body: 'BODY-LEAK',
        token: 'TOKEN-LEAK'
      },
      LIST_ROWS[1]!,
      LIST_ROWS[2]!
    ] as readonly ProjectSessionSummary[])
  );

  const result = await w.provider.call(PROJECT_SESSION_LIST_TOOL_NAME, { limit: 2 }, ctx());
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(w.listQueries[0]!.limit, 2);

  const value = result.value as {
    sessions: readonly ProjectSessionSummary[];
    truncated: boolean;
  };
  assert.equal(value.sessions.length, 2);
  assert.equal(value.truncated, true);
  assert.equal(value.sessions[0]!.title, '目标 会话');
  assert.deepEqual(value.sessions[1], LIST_ROWS[1]);

  const payload = JSON.stringify(result.value);
  assert.equal(payload.includes('LEAK'), false);
});

test('project.session.list 拒绝非法 limit 与无法核实的条目', async () => {
  const w = fullWorld();
  for (const limit of [0, 51, 1.5, '2']) {
    const result = await w.provider.call(PROJECT_SESSION_LIST_TOOL_NAME, { limit }, ctx());
    assert.equal(result.ok === false ? result.error.code : null, 'invalid', String(limit));
  }
  assert.equal(w.listQueries.length, 0);

  w.setListResult(
    ok([
      {
        sessionId: TARGET_SESSION_ID,
        taskId: null,
        title: null,
        status: 'idle'
      } as unknown as ProjectSessionSummary
    ])
  );
  const broken = await w.provider.call(PROJECT_SESSION_LIST_TOOL_NAME, {}, ctx());
  assert.equal(broken.ok === false ? broken.error.code : null, 'unavailable');
});

test('可选工具同样要求冻结身份，未授权时不调用回调', async () => {
  const w = fullWorld();
  const calls: ReadonlyArray<readonly [string, unknown]> = [
    [PROJECT_CANDIDATE_IMPORT_TOOL_NAME, candidateImportInput()],
    [PROJECT_SESSION_HANDOFF_TOOL_NAME, handoffInput()],
    [PROJECT_SESSION_LIST_TOOL_NAME, {}]
  ];

  for (const [name, input] of calls) {
    const result = await w.provider.call(name, input, ctx({ actor: undefined }));
    assert.equal(result.ok === false ? result.error.code : null, 'forbidden', name);
  }
  assert.equal(w.candidateCommands.length, 0);
  assert.equal(w.handoffCommands.length, 0);
  assert.equal(w.listQueries.length, 0);
});

test('可选工具必须 scope + 回调成对出现，且所有启用 scope 互不相同', () => {
  const callbacks = {
    createTask: async () => ok(TASK_SNAPSHOT),
    startWorktree: async () => ok(WORKTREE_SNAPSHOT),
    importCandidate: async () => ok(CANDIDATE_SNAPSHOT),
    handoff: async () => ok(HANDOFF_SNAPSHOT),
    listSessions: async () => ok(LIST_ROWS)
  };

  assert.throws(
    () =>
      createProjectSessionToolProvider({
        scopes: {
          taskCreate: TASK_SCOPE,
          worktreeStart: WORKTREE_SCOPE,
          candidateImport: CANDIDATE_SCOPE
        },
        ...callbacks
      }),
    /both/
  );

  assert.throws(
    () =>
      createProjectSessionToolProvider({
        scopes: { taskCreate: TASK_SCOPE, worktreeStart: WORKTREE_SCOPE },
        ...callbacks
      }),
    /both/
  );

  assert.throws(
    () =>
      createProjectSessionToolProvider({
        scopes: {
          taskCreate: TASK_SCOPE,
          worktreeStart: WORKTREE_SCOPE,
          candidateImport: TASK_SCOPE,
          handoff: MESSAGE_SCOPE,
          sessionList: READ_SCOPE
        },
        ...callbacks
      }),
    /distinct/
  );

  assert.throws(
    () =>
      createProjectSessionToolProvider({
        scopes: {
          taskCreate: TASK_SCOPE,
          worktreeStart: WORKTREE_SCOPE,
          candidateImport: CANDIDATE_SCOPE,
          handoff: READ_SCOPE,
          sessionList: READ_SCOPE
        },
        ...callbacks
      }),
    /distinct/
  );
});
