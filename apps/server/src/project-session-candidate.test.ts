import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  asAgentId,
  asLoginId,
  asProjectId,
  asSessionId,
  asTeamId,
  asUserId,
  asWorkspaceId,
  createProjectUseCase,
  createTask,
  err,
  forbidden,
  newWorkspace,
  ok,
  unavailable,
  type DomainError,
  type OperationCompleteInput,
  type OperationCompleteOutcome,
  type OperationReceiptPayload,
  type OperationReceiptStore,
  type OperationReleaseInput,
  type OperationReleaseOutcome,
  type OperationReserveIntent,
  type OperationReserveOutcome,
  type Principal,
  type Project,
  type ProjectRepo,
  type ProjectSessionGrant,
  type Result,
  type Session,
  type Task,
  type Workspace,
  type WorkspaceDelegation,
  type WorkspaceGit
} from '@agent-hub/domain';
import { inMemoryDeps } from '@agent-hub/domain/testing';
import type { ProjectSessionGrantService } from './project-session-grant.ts';
import {
  CANDIDATE_IMPORT_OPERATION,
  candidateImportRef,
  importProjectCandidate,
  type ProjectCandidateImportCommand,
  type ProjectCandidateImportDeps
} from './project-session-candidate.ts';

const OWNER_ID = 'u-owner';
const SOURCE_SESSION_ID = asSessionId('ses-exec');
const CALLER_SESSION_ID = asSessionId('ses-caller');
const SHA = '1'.repeat(40);
const OTHER_SHA = '2'.repeat(40);
const REQUEST_KEY = 'req-import-1';
const REPO_URL = 'https://github.com/acme/app.git';

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

function sessionOf(input: {
  id: ReturnType<typeof asSessionId>;
  taskId: Task['id'];
  workspaceId: Workspace['id'];
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

function grantOf(project: Project): ProjectSessionGrant {
  return {
    id: 'grant-candidate-import',
    accountId: OWNER_ID,
    sessionId: CALLER_SESSION_ID,
    projectId: project.id,
    scopes: ['candidate:import'],
    createdBy: OWNER_ID,
    createdAt: 1,
    expiresAt: null,
    revokedAt: null,
    revokedBy: null
  };
}

interface StoredReceipt {
  fingerprint: string;
  reservationId: string;
  state: 'pending' | 'completed';
  payload?: OperationReceiptPayload;
}

interface FakeReceipts extends OperationReceiptStore {
  readonly rows: Map<string, StoredReceipt>;
  readonly calls: string[];
  readonly completed: OperationCompleteInput[];
  readonly released: OperationReleaseInput[];
}

function fakeReceipts(): FakeReceipts {
  const rows = new Map<string, StoredReceipt>();
  const calls: string[] = [];
  const completed: OperationCompleteInput[] = [];
  const released: OperationReleaseInput[] = [];
  let tokens = 0;
  const mismatch = (row: StoredReceipt, intent: { fingerprint: string }): boolean =>
    row.fingerprint !== intent.fingerprint;

  return {
    rows,
    calls,
    completed,
    released,
    async reserve(intent: OperationReserveIntent): Promise<OperationReserveOutcome> {
      calls.push('reserve');
      const row = rows.get(intent.key);
      if (!row) {
        tokens += 1;
        const reservationId = `res-${tokens}`;
        rows.set(intent.key, {
          fingerprint: intent.fingerprint,
          reservationId,
          state: 'pending'
        });
        return { status: 'reserved', reservationId };
      }
      if (mismatch(row, intent)) return { status: 'conflict' };
      if (row.state === 'completed') {
        return { status: 'completed', payload: row.payload ?? {} };
      }
      return { status: 'pending' };
    },
    async complete(input: OperationCompleteInput): Promise<OperationCompleteOutcome> {
      calls.push('complete');
      completed.push(input);
      const row = rows.get(input.key);
      if (!row || mismatch(row, input) || row.reservationId !== input.reservationId) {
        return { status: 'conflict' };
      }
      if (row.state === 'completed') {
        return { status: 'replayed', payload: row.payload ?? {} };
      }
      row.state = 'completed';
      row.payload = input.payload;
      return { status: 'completed' };
    },
    async release(input: OperationReleaseInput): Promise<OperationReleaseOutcome> {
      calls.push('release');
      released.push(input);
      const row = rows.get(input.key);
      if (!row || mismatch(row, input) || row.reservationId !== input.reservationId) {
        return { status: 'conflict' };
      }
      if (row.state === 'completed') return { status: 'conflict' };
      rows.delete(input.key);
      return { status: 'released' };
    }
  };
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface Harness {
  readonly project: Project;
  readonly repo: ProjectRepo;
  readonly delegation: Mutable<WorkspaceDelegation>;
  readonly sourceSession: Mutable<Session>;
  readonly callerSession: Mutable<Session>;
  readonly sourceWorkspace: Mutable<Workspace>;
  readonly targetWorkspace: Mutable<Workspace>;
  readonly deps: ProjectCandidateImportDeps;
  readonly sessions: ReturnType<typeof inMemoryDeps>['deps']['sessions'];
  readonly receipts: FakeReceipts;
  readonly grantCalls: Array<{ sessionId: ReturnType<typeof asSessionId>; scope: string }>;
  readonly actorCalls: string[];
  readonly importCalls: Parameters<NonNullable<WorkspaceGit['importCommit']>>[0][];
  readonly commands: string[];
  setGrantResult(value: Result<ProjectSessionGrant, DomainError> | null): void;
  setImportResult(value: Result<{ ref: string; sha: string; alreadyPresent: boolean }, DomainError>): void;
  setGit(workerId: string, git: WorkspaceGit | null): void;
}

async function harness(): Promise<Harness> {
  const world = inMemoryDeps();
  const deps = { ...world.deps, access: undefined };
  const created = await createProjectUseCase(
    { ...deps, access: undefined },
    {
      name: 'candidate-project',
      rootPath: '',
      actor: person(),
      repoUrl: REPO_URL,
      defaultBranch: 'main'
    }
  );
  assert.ok(created.ok, JSON.stringify(created));
  const project = created.value;
  const repo = project.repos[0];
  assert.ok(repo);

  const delegatedTask = createTask({ projectId: project.id, title: '候选来源任务', now: 1 });
  assert.ok(delegatedTask.ok);
  await deps.tasks.save(delegatedTask.value);
  const callerTask = createTask({ projectId: project.id, title: '接收方任务', now: 1 });
  assert.ok(callerTask.ok);
  await deps.tasks.save(callerTask.value);

  const sourceWorkspaceCreated = newWorkspace({
    id: asWorkspaceId('ws-source'),
    projectId: project.id,
    repoUrl: repo.url,
    workerId: 'local',
    path: '/tmp/candidate-source',
    kind: 'temporary',
    source: 'worktree',
    ownerTaskId: delegatedTask.value.id,
    branch: 'delegation/source',
    isGit: true,
    now: 1
  });
  assert.ok(sourceWorkspaceCreated.ok);
  const targetWorkspaceCreated = newWorkspace({
    id: asWorkspaceId('ws-target'),
    projectId: project.id,
    repoUrl: repo.url,
    workerId: 'local',
    path: '/tmp/candidate-target',
    kind: 'temporary',
    source: 'worktree',
    ownerTaskId: callerTask.value.id,
    branch: 'delegation/target',
    isGit: true,
    now: 1
  });
  assert.ok(targetWorkspaceCreated.ok);
  await deps.workspaces.save(sourceWorkspaceCreated.value);
  await deps.workspaces.save(targetWorkspaceCreated.value);

  const sourceSession: Mutable<Session> = sessionOf({
    id: SOURCE_SESSION_ID,
    taskId: delegatedTask.value.id,
    workspaceId: sourceWorkspaceCreated.value.id
  });
  const callerSession: Mutable<Session> = sessionOf({
    id: CALLER_SESSION_ID,
    taskId: callerTask.value.id,
    workspaceId: targetWorkspaceCreated.value.id
  });
  await deps.sessions.save(sourceSession);
  await deps.sessions.save(callerSession);

  const delegation: WorkspaceDelegation = {
    id: 'dlg-1',
    accountId: OWNER_ID,
    coordinatorSessionId: CALLER_SESSION_ID,
    mode: 'direct',
    requestKey: 'delegate-1',
    requestFingerprint: 'fingerprint',
    projectId: project.id,
    taskId: delegatedTask.value.id,
    repoId: repo.id,
    repoUrl: repo.url,
    workerId: 'local',
    baseBranch: 'main',
    baseSha: 'a'.repeat(40),
    instructions: '不要回显这段说明',
    startup: null,
    executionSessionId: SOURCE_SESSION_ID,
    worktreePath: sourceWorkspaceCreated.value.path,
    branch: 'delegation/source',
    state: 'prepared',
    claim: null,
    failure: null,
    createdAt: 1,
    updatedAt: 1
  };

  const grantCalls: Harness['grantCalls'] = [];
  const actorCalls: string[] = [];
  let grantResult: Result<ProjectSessionGrant, DomainError> | null = null;
  const grants: Pick<ProjectSessionGrantService, 'authorize'> = {
    async authorize(input) {
      grantCalls.push({ sessionId: input.sessionId, scope: input.scope });
      return grantResult ?? ok(grantOf(project));
    }
  };

  const receipts = fakeReceipts();
  const importCalls: Harness['importCalls'] = [];
  const commands: string[] = [];
  const gits = new Map<string, WorkspaceGit | null>();
  let importResult: Result<{ ref: string; sha: string; alreadyPresent: boolean }, DomainError> = ok({
    ref: `refs/agent-hub/imports/${CALLER_SESSION_ID}/${SHA}`,
    sha: SHA,
    alreadyPresent: false
  });

  const gitForWorker = async (workerId: string): Promise<WorkspaceGit> => {
    commands.push(workerId);
    const fixed = gits.get(workerId);
    if (fixed === null) throw new Error(`worker ${workerId} unavailable`);
    if (fixed) return fixed;
    return {
      async importCommit(input: Parameters<NonNullable<WorkspaceGit['importCommit']>>[0]) {
        importCalls.push(input);
        return importResult;
      }
    } as unknown as WorkspaceGit;
  };

  const candidateDeps: ProjectCandidateImportDeps = {
    grants,
    access: deps.access,
    projects: deps.projects,
    workspaces: deps.workspaces,
    sessions: deps.sessions,
    delegations: {
      async byExecutionSession(sessionId) {
        return delegation.executionSessionId === sessionId ? delegation : null;
      }
    },
    operationReceipts: receipts,
    loadActor: async (accountId) => {
      actorCalls.push(accountId);
      return accountId === OWNER_ID ? person() : null;
    },
    gitForWorker
  };

  return {
    project,
    repo,
    delegation,
    sourceSession,
    callerSession,
    sourceWorkspace: sourceWorkspaceCreated.value,
    targetWorkspace: targetWorkspaceCreated.value,
    deps: candidateDeps,
    sessions: deps.sessions,
    receipts,
    grantCalls,
    actorCalls,
    importCalls,
    commands,
    setGrantResult: (value) => {
      grantResult = value;
    },
    setImportResult: (value) => {
      importResult = value;
    },
    setGit: (workerId, git) => {
      gits.set(workerId, git);
    }
  };
}

function command(overrides: Partial<ProjectCandidateImportCommand> = {}): ProjectCandidateImportCommand {
  return {
    actorId: OWNER_ID,
    actorVia: 'web',
    sessionId: CALLER_SESSION_ID,
    requestKey: REQUEST_KEY,
    sourceSessionId: SOURCE_SESSION_ID,
    targetSessionId: CALLER_SESSION_ID,
    repoId: 'will-be-replaced',
    sha: SHA,
    ...overrides
  } as ProjectCandidateImportCommand;
}

function repoCommand(h: Harness, overrides: Partial<ProjectCandidateImportCommand> = {}): ProjectCandidateImportCommand {
  return command({ repoId: h.repo.id, ...overrides });
}

test('导入成功：精确调用 importCommit，结果只含最小字段并落回执', async () => {
  const h = await harness();
  const result = await importProjectCandidate(h.deps, repoCommand(h));
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(result.value, {
    projectId: h.project.id,
    repoId: h.repo.id,
    workerId: 'local',
    sourceSessionId: SOURCE_SESSION_ID,
    targetSessionId: CALLER_SESSION_ID,
    targetWorkspaceId: h.targetWorkspace.id,
    ref: `refs/agent-hub/imports/${CALLER_SESSION_ID}/${SHA}`,
    sha: SHA,
    alreadyPresent: false
  });
  assert.deepEqual(h.importCalls, [
    {
      sourcePath: h.sourceWorkspace.path,
      targetPath: h.targetWorkspace.path,
      sourceBranch: 'delegation/source',
      sha: SHA,
      ref: `refs/agent-hub/imports/${CALLER_SESSION_ID}/${SHA}`,
      expectedUrl: REPO_URL
    }
  ]);
  assert.deepEqual(h.commands, ['local']);
  assert.equal(h.grantCalls.length, 2);
  assert.deepEqual(
    h.grantCalls.map((call) => call.scope),
    ['candidate:import', 'candidate:import']
  );
  assert.equal(h.receipts.rows.size, 1);
  assert.equal([...h.receipts.rows.values()][0]?.state, 'completed');
  assert.deepEqual(h.receipts.released, []);
});

test('缺少 candidate:import 授权：不占回执、不调用 Worker', async () => {
  const h = await harness();
  h.setGrantResult(err(forbidden('项目授权已撤销或已过期')));
  const result = await importProjectCandidate(h.deps, repoCommand(h));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error.message, /项目授权/);
  assert.deepEqual(h.receipts.calls, []);
  assert.deepEqual(h.importCalls, []);
  assert.equal(h.grantCalls.length, 1);
});

test('来源不属于当前项目：释放占位，同请求修正后可用同一 requestKey 重试', async () => {
  const h = await harness();
  h.delegation.projectId = asProjectId('other-project');
  const rejected = await importProjectCandidate(h.deps, repoCommand(h));
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.match(rejected.error.message, /候选来源不在当前项目/);
  assert.deepEqual(h.receipts.calls, ['reserve', 'release']);
  assert.equal(h.receipts.rows.size, 0);
  assert.deepEqual(h.importCalls, []);

  h.delegation.projectId = h.project.id;
  const retried = await importProjectCandidate(h.deps, repoCommand(h));
  assert.ok(retried.ok, JSON.stringify(retried));
  assert.equal(h.importCalls.length, 1);
  assert.equal([...h.receipts.rows.values()][0]?.state, 'completed');
});

test('仓库不在项目清单里 / 与来源派工不一致：拒绝且不调用 Worker', async () => {
  const h = await harness();
  const unknown = await importProjectCandidate(h.deps, repoCommand(h, { repoId: 'repo-missing' }));
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.match(unknown.error.message, /候选来源仓库与请求不一致/);

  h.delegation.repoId = 'repo-other';
  const mismatched = await importProjectCandidate(h.deps, repoCommand(h));
  assert.equal(mismatched.ok, false);
  if (!mismatched.ok) assert.match(mismatched.error.message, /候选来源仓库与请求不一致/);
  assert.deepEqual(h.importCalls, []);
  assert.equal(h.receipts.rows.size, 0);
});

test('目标工作空间缺失或属于别的项目：拒绝，不执行', async () => {
  const h = await harness();
  h.callerSession.workspaceId = null;
  await h.sessions.save(h.callerSession);
  const missingBinding = await importProjectCandidate(h.deps, repoCommand(h));
  assert.equal(missingBinding.ok, false);
  if (!missingBinding.ok) assert.match(missingBinding.error.message, /没有绑定工作空间/);

  h.callerSession.workspaceId = asWorkspaceId('ws-missing');
  await h.sessions.save(h.callerSession);
  const missing = await importProjectCandidate(h.deps, repoCommand(h));
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.error.message, /目标工作空间不存在/);

  h.callerSession.workspaceId = h.targetWorkspace.id;
  h.targetWorkspace.projectId = asProjectId('other-project');
  await h.sessions.save(h.callerSession);
  await h.deps.workspaces.save(h.targetWorkspace);
  const wrongProject = await importProjectCandidate(h.deps, repoCommand(h));
  assert.equal(wrongProject.ok, false);
  if (!wrongProject.ok) assert.match(wrongProject.error.message, /目标工作空间不在当前项目/);
  assert.deepEqual(h.importCalls, []);
  assert.equal(h.receipts.rows.size, 0);
});

test('目标会话与冻结绑定不一致：拒绝，不调用 Worker', async () => {
  const h = await harness();
  const result = await importProjectCandidate(
    h.deps,
    repoCommand(h, { targetSessionId: asSessionId('ses-other') })
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error.message, /目标会话与当前绑定会话不一致/);
  assert.deepEqual(h.receipts.calls, []);
  assert.deepEqual(h.importCalls, []);
});

test('接收会话的 Worker 与候选来源不一致：拒绝，不跨 Worker 读取路径', async () => {
  const h = await harness();
  h.callerSession.workerId = 'remote-other';
  await h.sessions.save(h.callerSession);
  const result = await importProjectCandidate(h.deps, repoCommand(h));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error.message, /接收会话与候选来源不在同一台 Worker/);
  assert.deepEqual(h.commands, []);
  assert.deepEqual(h.importCalls, []);
});

test('目标工作空间在不同 Worker：拒绝，不跨 Worker 读取路径', async () => {
  const h = await harness();
  h.targetWorkspace.workerId = 'remote-other';
  await h.deps.workspaces.save(h.targetWorkspace);
  const result = await importProjectCandidate(h.deps, repoCommand(h));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error.message, /同一台 Worker/);
  assert.deepEqual(h.commands, []);
  assert.deepEqual(h.importCalls, []);
});

test('重放时接收会话工作空间漂移：拒绝旧回执，不假装还是原目标', async () => {
  const h = await harness();
  const first = await importProjectCandidate(h.deps, repoCommand(h));
  assert.ok(first.ok);
  const moved = newWorkspace({
    id: asWorkspaceId('ws-target-2'),
    projectId: h.project.id,
    repoUrl: h.repo.url,
    workerId: 'local',
    path: '/tmp/candidate-target-2',
    kind: 'temporary',
    source: 'worktree',
    ownerTaskId: h.callerSession.taskId,
    branch: 'delegation/target-2',
    isGit: true,
    now: 2
  });
  assert.ok(moved.ok);
  await h.deps.workspaces.save(moved.value);
  h.callerSession.workspaceId = moved.value.id;
  await h.sessions.save(h.callerSession);

  const replay = await importProjectCandidate(h.deps, repoCommand(h));
  assert.equal(replay.ok, false);
  if (!replay.ok) assert.match(replay.error.message, /工作空间已变化/);
  assert.equal(h.importCalls.length, 1);
});

test('目标就是来源工作目录：拒绝，即使工作空间 id 不同', async () => {
  const h = await harness();
  h.targetWorkspace.path = h.sourceWorkspace.path;
  await h.deps.workspaces.save(h.targetWorkspace);
  const result = await importProjectCandidate(h.deps, repoCommand(h));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error.message, /来源工作目录本身/);
  assert.deepEqual(h.importCalls, []);
  assert.equal(h.receipts.rows.size, 0);
});

test('同一 requestKey 重放：返回原结果，不重复调用 Worker', async () => {
  const h = await harness();
  const first = await importProjectCandidate(h.deps, repoCommand(h));
  assert.ok(first.ok);
  const second = await importProjectCandidate(h.deps, repoCommand(h));
  assert.ok(second.ok);
  assert.deepEqual(second.value, first.value);
  assert.equal(h.importCalls.length, 1);
  assert.equal(h.grantCalls.length, 3);
  assert.deepEqual(h.receipts.calls, ['reserve', 'complete', 'reserve']);
});

test('同一 requestKey 不同参数：冲突，不覆盖原回执', async () => {
  const h = await harness();
  const first = await importProjectCandidate(h.deps, repoCommand(h));
  assert.ok(first.ok);
  const second = await importProjectCandidate(h.deps, repoCommand(h, { sha: OTHER_SHA }));
  assert.equal(second.ok, false);
  if (!second.ok) assert.match(second.error.message, /不同参数/);
  assert.equal(h.importCalls.length, 1);
});

test('并发窗口内已有 pending：拒绝并提示稍后重试，不接管', async () => {
  const h = await harness();
  const first = await importProjectCandidate(h.deps, repoCommand(h));
  assert.ok(first.ok);
  const row = [...h.receipts.rows.values()][0];
  assert.ok(row);
  row.state = 'pending';
  row.payload = undefined;

  const busy = await importProjectCandidate(h.deps, repoCommand(h));
  assert.equal(busy.ok, false);
  if (!busy.ok) assert.match(busy.error.message, /正在处理中/);
  assert.equal(h.importCalls.length, 1);
});

test('回执形状不认识：拒绝重放结果，不把 unknown 当业务对象', async () => {
  const h = await harness();
  const first = await importProjectCandidate(h.deps, repoCommand(h));
  assert.ok(first.ok);
  const row = [...h.receipts.rows.values()][0];
  assert.ok(row);
  row.payload = { version: 1, projectId: h.project.id };

  const replayed = await importProjectCandidate(h.deps, repoCommand(h));
  assert.equal(replayed.ok, false);
  if (!replayed.ok) assert.match(replayed.error.message, /回执形状不正确/);
});

test('RPC 之后失败：保留 pending 且不回传 Worker 原始错误', async () => {
  const h = await harness();
  h.setImportResult(err(unavailable('fatal: /srv/secret/path is not a git repository')));
  const first = await importProjectCandidate(h.deps, repoCommand(h));
  assert.equal(first.ok, false);
  if (!first.ok) {
    assert.doesNotMatch(first.error.message, /\/srv\/secret/);
    assert.match(first.error.message, /尚未确认/);
  }
  assert.deepEqual(h.receipts.calls, ['reserve']);
  assert.equal([...h.receipts.rows.values()][0]?.state, 'pending');

  const retry = await importProjectCandidate(h.deps, repoCommand(h));
  assert.equal(retry.ok, false);
  if (!retry.ok) assert.match(retry.error.message, /正在处理中/);
  assert.equal(h.importCalls.length, 1);
});

test('Worker 不支持 importCommit 或不可达：RPC 前确定性失败可释放重试', async () => {
  const h = await harness();
  h.setGit('local', {} as WorkspaceGit);
  const unsupported = await importProjectCandidate(h.deps, repoCommand(h));
  assert.equal(unsupported.ok, false);
  if (!unsupported.ok) assert.match(unsupported.error.message, /不支持候选导入/);
  assert.equal(h.receipts.rows.size, 0);

  h.setGit('local', null);
  const unreachable = await importProjectCandidate(h.deps, repoCommand(h));
  assert.equal(unreachable.ok, false);
  if (!unreachable.ok) assert.match(unreachable.error.message, /Worker 当前不可用/);
  assert.equal(h.receipts.rows.size, 0);
  assert.deepEqual(h.importCalls, []);
});

test('专用 ref 只接受安全会话 id 与完整小写 SHA', () => {
  assert.deepEqual(candidateImportRef('ses-1', SHA), ok(`refs/agent-hub/imports/ses-1/${SHA}`));
  assert.equal(candidateImportRef('../escape', SHA).ok, false);
  assert.equal(candidateImportRef('ses-1', 'A'.repeat(40)).ok, false);
  assert.equal(candidateImportRef('ses-1', 'abc1234').ok, false);
});

test('操作名固定，避免与其他写操作共享回执键空间', () => {
  assert.equal(CANDIDATE_IMPORT_OPERATION, 'project.candidate.import');
});
