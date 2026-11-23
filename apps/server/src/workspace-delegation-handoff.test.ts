import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HANDOFF_BUS_ORIGIN,
  asAgentId,
  asLoginId,
  asSessionId,
  asTaskId,
  asTeamId,
  asUserId,
  asWorkspaceId,
  createProjectUseCase,
  createTask,
  type AccessPolicy,
  type AgentMessage,
  type Principal,
  type Project,
  type ProjectRepo,
  type Session,
  type SessionId,
  type WorkspaceDelegation
} from '@agent-hub/domain';
import { inMemoryDeps } from '@agent-hub/domain/testing';
import {
  MAX_HANDOFF_BODY_CHARS,
  createWorkspaceDelegationHandoffProjection,
  type WorkspaceDelegationHandoffProjectionService
} from './workspace-delegation-handoff.ts';
import { PROJECT_CANDIDATE_PART_SCHEMA } from './project-session-handoff.ts';

const OWNER_ID = 'u-owner';
const OTHER_USER_ID = 'u-other';
const TEAM_ID = 't1';
const SHA = 'a'.repeat(40);
const REPO_URL = 'https://github.com/acme/app.git';
const OTHER_REPO_URL = 'https://github.com/acme/other.git';

const SENDER = asSessionId('ses-sender');
const EXEC = asSessionId('ses-exec');
const STRANGER = asSessionId('ses-stranger');

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

/** 成员只读自己的会话：`session.read = own`。 */
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
  id: SessionId;
  taskId: Session['taskId'];
  createdBy?: string;
  originProjectId?: Project['id'];
  updatedAt?: number;
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
    workspaceId: asWorkspaceId(`ws-${input.id}`),
    mcpDisabled: [],
    createdBy: input.createdBy ?? OWNER_ID,
    createdAt: 1,
    updatedAt: input.updatedAt ?? 1,
    ...(input.originProjectId === undefined ? {} : { originProjectId: input.originProjectId })
  };
}

interface HarnessOptions {
  executionCreatedBy?: string;
  executionTaskId?: Session['taskId'];
  executionOriginProjectId?: Project['id'];
  senderCreatedBy?: string;
  senderOriginProjectId?: Project['id'];
  loadActorMissing?: boolean;
  queryThrows?: boolean;
}

interface Harness {
  readonly service: WorkspaceDelegationHandoffProjectionService;
  readonly project: Project;
  readonly otherProject: Project;
  readonly repo: ProjectRepo;
  readonly delegation: WorkspaceDelegation;
  readonly calls: Array<{ projectId: string; sourceSessionId: SessionId; limit: number }>;
  setRows(rows: AgentMessage[]): void;
  message(overrides?: Mutable<Partial<AgentMessage>>): Mutable<AgentMessage>;
  candidateData(overrides?: Mutable<Record<string, unknown>>): Record<string, unknown>;
  candidatePart(overrides?: Mutable<Record<string, unknown>>): {
    type: 'data';
    schema: string;
    data: unknown;
  };
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
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

  const createdTask = createTask({ projectId: project.id, title: '执行任务', now: 1 });
  assert.ok(createdTask.ok);
  await deps.tasks.save(createdTask.value);

  await deps.sessions.save(
    sessionOf({
      id: SENDER,
      taskId: createdTask.value.id,
      createdBy: options.senderCreatedBy ?? OWNER_ID,
      ...(options.senderOriginProjectId === undefined
        ? {}
        : { originProjectId: options.senderOriginProjectId }),
      updatedAt: 10
    })
  );
  await deps.sessions.save(
    sessionOf({
      id: EXEC,
      taskId: options.executionTaskId === undefined ? createdTask.value.id : options.executionTaskId,
      createdBy: options.executionCreatedBy ?? OWNER_ID,
      ...(options.executionOriginProjectId === undefined
        ? {}
        : { originProjectId: options.executionOriginProjectId }),
      updatedAt: 11
    })
  );

  const delegation: WorkspaceDelegation = {
    id: 'dlg-1',
    accountId: OWNER_ID,
    coordinatorSessionId: SENDER,
    mode: 'direct',
    requestKey: 'dlg-1',
    requestFingerprint: 'fingerprint',
    projectId: project.id,
    taskId: createdTask.value.id as NonNullable<Session['taskId']>,
    repoId: repo.id,
    repoUrl: repo.url,
    workerId: 'local',
    baseBranch: 'main',
    baseSha: null,
    instructions: '',
    startup: null,
    executionSessionId: EXEC,
    worktreePath: '/tmp/delegation-exec',
    branch: 'delegation/dlg-1',
    state: 'prepared',
    claim: null,
    failure: null,
    createdAt: 1,
    updatedAt: 1
  };

  let rows: AgentMessage[] = [];
  const calls: Harness['calls'] = [];
  const messages = {
    async byCandidateSource(
      projectId: string,
      sourceSessionId: SessionId,
      limit: number
    ): Promise<AgentMessage[]> {
      calls.push({ projectId, sourceSessionId, limit });
      if (options.queryThrows === true) throw new Error('message store unavailable');
      return rows;
    }
  };

  const loadActor = async (accountId: string): Promise<Principal | null> => {
    if (options.loadActorMissing === true) return null;
    return accountId === OWNER_ID || accountId === OTHER_USER_ID ? person(accountId) : null;
  };

  const service = createWorkspaceDelegationHandoffProjection({
    delegations: { byId: async (id) => (id === delegation.id ? delegation : null) },
    projects: deps.projects,
    sessions: deps.sessions,
    tasks: deps.tasks,
    messages,
    access: deps.access,
    loadActor
  });

  const candidateData = (
    overrides: Mutable<Record<string, unknown>> = {}
  ): Record<string, unknown> => ({
    notice: '候选提交引用，仅作提示；接收方如需使用，必须自行显式执行候选导入。',
    projectId: project.id,
    sourceSessionId: EXEC,
    repoId: repo.id,
    sha: SHA,
    ...overrides
  });

  const candidatePart = (overrides: Mutable<Record<string, unknown>> = {}) => ({
    type: 'data' as const,
    schema: PROJECT_CANDIDATE_PART_SCHEMA,
    data: candidateData(overrides)
  });

  const message = (
    overrides: Mutable<Partial<AgentMessage>> = {}
  ): Mutable<AgentMessage> => ({
    id: 'msg-handoff',
    traceId: 'trace-handoff',
    depth: 1,
    projectId: project.id,
    kind: 'send',
    fromSessionId: SENDER,
    onBehalfOf: OWNER_ID,
    to: `session:${EXEC}`,
    targetSessionId: STRANGER,
    role: null,
    replyTo: null,
    body: '这是派工交接说明',
    status: 'queued',
    failure: null,
    failureDetail: null,
    replyBody: null,
    replySource: null,
    idempotencyKey: 'replay-1',
    createdAt: 20,
    updatedAt: 20,
    deliveredAt: null,
    deadlineAt: null,
    parts: [candidatePart()],
    wake: false,
    handoffOrigin: HANDOFF_BUS_ORIGIN,
    ...overrides
  });

  return {
    service,
    project,
    otherProject,
    repo,
    delegation,
    calls,
    setRows(next) {
      rows = next;
    },
    message,
    candidateData,
    candidatePart
  };
}

test('projects a trusted candidate handoff sent to an ordinary session, with sanitized attachments', async () => {
  const h = await harness();
  h.setRows([
    h.message({
      status: 'done',
      wake: false,
      parts: [
        h.candidatePart(),
        { type: 'ref', repo: 'acme/app', branch: 'main', sha: 'abc1234' },
        {
          type: 'link',
          url: 'https://user:pass@example.com/pull/7?token=secret#fragment',
          label: 'PR 7'
        },
        { type: 'file', session: 'ses-secret', path: '/home/qdw/secret.ts', member: 'x' },
        // 发送方自述的“验证结果”不当证据，也不回显。
        { type: 'data', schema: 'verify-result/v1', data: { ok: true } }
      ]
    })
  ]);

  const result = await h.service.read({ actorId: OWNER_ID, delegationId: h.delegation.id });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.value.delegationId, h.delegation.id);
  assert.equal(result.value.projectId, h.project.id);
  assert.equal(result.value.executionSessionId, EXEC);
  assert.equal(result.value.state, 'recorded');
  assert.equal(result.value.scanTruncated, false);
  assert.equal(result.value.handoffs.length, 1);

  const handoff = result.value.handoffs[0];
  assert.ok(handoff);

  assert.equal(handoff.messageId, 'msg-handoff');
  assert.equal(handoff.transport, 'inbox');
  assert.equal(handoff.sentAt, 20);
  assert.deepEqual(handoff.candidate, { repoId: h.repo.id, sha: SHA });
  assert.equal(handoff.body, '这是派工交接说明');
  assert.equal(handoff.bodyTruncated, false);
  assert.equal(handoff.hiddenPartCount, 1);
  // DTO 不带发送 / 接收会话 id，UI 不依赖。
  assert.equal('fromSessionId' in handoff, false);
  assert.equal('toSessionId' in handoff, false);

  assert.deepEqual(
    handoff.attachments.map((attachment) => attachment.kind),
    ['ref', 'link', 'file']
  );
  assert.deepEqual(handoff.attachments[0], {
    kind: 'ref',
    repo: 'acme/app',
    branch: 'main',
    sha: 'abc1234'
  });
  // query / fragment / 用户名密码全部丢掉。
  assert.deepEqual(handoff.attachments[1], {
    kind: 'link',
    url: 'https://example.com/pull/7',
    label: 'PR 7'
  });
  // 文件附件只留中性标记，不带会话 / 路径 / 成员，也不代表读到了文件。
  assert.deepEqual(handoff.attachments[2], { kind: 'file' });
  assert.deepEqual(Object.keys(handoff.attachments[2]), ['kind']);
});

test('never confirms misframed candidates and never claims there were no records', async () => {
  const h = await harness();
  const variants: Array<{ name: string; data: Record<string, unknown> }> = [
    { name: '别条派工的来源会话', data: h.candidateData({ sourceSessionId: STRANGER }) },
    { name: '别的仓库', data: h.candidateData({ repoId: 'repo-other' }) },
    { name: '别的项目', data: h.candidateData({ projectId: h.otherProject.id }) },
    { name: '短 SHA', data: h.candidateData({ sha: 'abc1234' }) },
    { name: '大写 SHA', data: h.candidateData({ sha: 'A'.repeat(40) }) },
    { name: '非字符串仓库', data: h.candidateData({ repoId: 42 }) }
  ];

  for (const variant of variants) {
    h.setRows([
      h.message({
        parts: [{ type: 'data', schema: PROJECT_CANDIDATE_PART_SCHEMA, data: variant.data }]
      })
    ]);
    const result = await h.service.read({ actorId: OWNER_ID, delegationId: h.delegation.id });
    assert.ok(result.ok, variant.name);
    assert.equal(result.value.state, 'unknown', variant.name);
    assert.equal(result.value.handoffs.length, 0, variant.name);
  }

  // 根本没有候选 part：不是可展示的候选交接。
  h.setRows([h.message({ parts: [{ type: 'ref', repo: 'acme/app' }] })]);
  const plain = await h.service.read({ actorId: OWNER_ID, delegationId: h.delegation.id });
  assert.ok(plain.ok);
  assert.equal(plain.value.state, 'unknown');
  assert.equal(plain.value.handoffs.length, 0);

  // 两个候选 part 视为歧义，不挑一个「看起来对」的。
  h.setRows([h.message({ parts: [h.candidatePart(), h.candidatePart()] })]);
  const ambiguous = await h.service.read({ actorId: OWNER_ID, delegationId: h.delegation.id });
  assert.ok(ambiguous.ok);
  assert.equal(ambiguous.value.state, 'unknown');
  assert.equal(ambiguous.value.handoffs.length, 0);
});

test('excludes forged and legacy rows: no server provenance, wrong kind / project / direction', async () => {
  const h = await harness();
  const legacyWithCandidate = h.message({ id: 'msg-legacy', body: '老数据带候选' });
  delete legacyWithCandidate.handoffOrigin;

  h.setRows([
    legacyWithCandidate,
    h.message({ id: 'msg-ask', kind: 'ask' }),
    h.message({ id: 'msg-other-project', projectId: h.otherProject.id }),
    h.message({ id: 'msg-no-target', targetSessionId: null }),
    // 生产者明确拒绝 source === target；同向伪造不认。
    h.message({ id: 'msg-source-is-target', targetSessionId: EXEC }),
    h.message({ id: 'msg-from-exec', fromSessionId: EXEC })
  ]);

  const result = await h.service.read({ actorId: OWNER_ID, delegationId: h.delegation.id });
  assert.ok(result.ok);
  assert.equal(result.value.state, 'none');
  assert.equal(result.value.scanTruncated, false);
  assert.deepEqual(result.value.handoffs, []);
});

test('skips handoffs whose sending session is no longer readable, without leaking content', async () => {
  const h = await harness({ senderCreatedBy: OTHER_USER_ID });
  h.setRows([
    h.message({
      body: 'secret-body-should-not-leak',
      parts: [
        h.candidatePart(),
        { type: 'file', session: 'ses-secret', path: '/home/qdw/secret.ts' }
      ]
    })
  ]);

  const result = await h.service.read({ actorId: OWNER_ID, delegationId: h.delegation.id });
  assert.ok(result.ok);
  assert.equal(result.value.state, 'unknown');
  assert.equal(result.value.handoffs.length, 0);
  const serialized = JSON.stringify(result.value);
  assert.equal(serialized.includes('secret-body-should-not-leak'), false);
  assert.equal(serialized.includes('/home/qdw/secret.ts'), false);
});

test('fails closed for non-owners, missing accounts, unreadable execution, and drifted tasks', async () => {
  const foreign = await harness();
  const asOther = await foreign.service.read({
    actorId: OTHER_USER_ID,
    delegationId: foreign.delegation.id
  });
  // 非归属人按不存在处理，不泄露派工是否存在。
  assert.ok(!asOther.ok);
  assert.equal(asOther.error.code, 'not_found');
  assert.equal(foreign.calls.length, 0);

  const missingActor = await harness({ loadActorMissing: true });
  const missing = await missingActor.service.read({
    actorId: OWNER_ID,
    delegationId: missingActor.delegation.id
  });
  assert.ok(!missing.ok);
  assert.equal(missing.error.code, 'forbidden');
  assert.equal(missingActor.calls.length, 0);

  const unreadableExec = await harness({ executionCreatedBy: OTHER_USER_ID });
  const denied = await unreadableExec.service.read({
    actorId: OWNER_ID,
    delegationId: unreadableExec.delegation.id
  });
  assert.ok(!denied.ok);
  assert.equal(denied.error.code, 'forbidden');
  assert.equal(unreadableExec.calls.length, 0);

  const driftedTask = await harness({ executionTaskId: asTaskId('task-other') });
  const drifted = await driftedTask.service.read({
    actorId: OWNER_ID,
    delegationId: driftedTask.delegation.id
  });
  assert.ok(!drifted.ok);
  assert.equal(drifted.error.code, 'forbidden');
  assert.match(drifted.error.message, /执行会话与派工记录不一致/);
  assert.equal(driftedTask.calls.length, 0);
});

test('fails closed when the execution session canonical project conflicts with the delegation', async () => {
  const h = await harness();
  const conflicting = await harness({ executionOriginProjectId: h.otherProject.id });
  const result = await conflicting.service.read({
    actorId: OWNER_ID,
    delegationId: conflicting.delegation.id
  });
  assert.ok(!result.ok);
  assert.equal(result.error.code, 'forbidden');
  assert.match(result.error.message, /执行会话与派工记录不一致/);
  assert.equal(conflicting.calls.length, 0);
});

test('skips a sender whose canonical project differs from the delegation project', async () => {
  const h = await harness();
  const foreignSender = await harness({ senderOriginProjectId: h.otherProject.id });
  foreignSender.setRows([foreignSender.message()]);
  const result = await foreignSender.service.read({
    actorId: OWNER_ID,
    delegationId: foreignSender.delegation.id
  });
  assert.ok(result.ok);
  assert.equal(result.value.state, 'unknown');
  assert.equal(result.value.handoffs.length, 0);
});

test('distinguishes an unproven bounded window (unknown) from a complete scan with no handoffs (none)', async () => {
  const h = await harness();
  h.setRows([
    h.message({ id: 'msg-1', kind: 'reply' }),
    h.message({ id: 'msg-2', kind: 'ask' })
  ]);

  const unknown = await h.service.read({
    actorId: OWNER_ID,
    delegationId: h.delegation.id,
    scanLimit: 2
  });
  assert.ok(unknown.ok);
  assert.equal(unknown.value.state, 'unknown');
  assert.equal(unknown.value.scanTruncated, true);
  assert.equal(unknown.value.handoffs.length, 0);

  const none = await h.service.read({
    actorId: OWNER_ID,
    delegationId: h.delegation.id,
    scanLimit: 5
  });
  assert.ok(none.ok);
  assert.equal(none.value.state, 'none');
  assert.equal(none.value.scanTruncated, false);

  assert.deepEqual(h.calls, [
    { projectId: h.project.id, sourceSessionId: EXEC, limit: 2 },
    { projectId: h.project.id, sourceSessionId: EXEC, limit: 5 }
  ]);
});

test('maps transport states without claiming task success, and truncates bodies', async () => {
  const h = await harness();
  const longBody = 'x'.repeat(MAX_HANDOFF_BODY_CHARS + 10);
  h.setRows([
    h.message({ id: 'msg-inbox', status: 'done', wake: false, readAt: 55, createdAt: 60 }),
    h.message({ id: 'msg-done', status: 'done', wake: true, deliveredAt: 40, createdAt: 50 }),
    h.message({ id: 'msg-held', status: 'held', holdReason: 'pingpong', createdAt: 40 }),
    h.message({
      id: 'msg-failed',
      status: 'failed',
      failure: 'auth',
      body: longBody,
      createdAt: 30
    }),
    h.message({ id: 'msg-queued', status: 'queued', createdAt: 20 }),
    h.message({ id: 'msg-delivered', status: 'delivered', deliveredAt: 15, createdAt: 10 }),
    // 伪造的失败码不回显，只给枚举内的值或 null。
    h.message({ id: 'msg-bad-failure', status: 'failed', failure: 'kaboom' as never, createdAt: 5 })
  ]);

  const result = await h.service.read({ actorId: OWNER_ID, delegationId: h.delegation.id });
  assert.ok(result.ok);
  assert.deepEqual(
    result.value.handoffs.map((handoff) => [handoff.messageId, handoff.transport]),
    [
      ['msg-inbox', 'inbox'],
      ['msg-done', 'delivered'],
      ['msg-held', 'held'],
      ['msg-failed', 'failed'],
      ['msg-queued', 'queued'],
      ['msg-delivered', 'delivered'],
      ['msg-bad-failure', 'failed']
    ]
  );

  const inbox = result.value.handoffs[0];
  assert.ok(inbox);
  assert.equal(inbox.readAt, 55);
  assert.equal(inbox.deliveredAt, null);

  const done = result.value.handoffs[1];
  assert.ok(done);
  assert.equal(done.deliveredAt, 40);

  const held = result.value.handoffs[2];
  assert.ok(held);
  assert.equal(held.holdReason, 'pingpong');

  const failed = result.value.handoffs[3];
  assert.ok(failed);
  assert.equal(failed.failure, 'auth');
  assert.equal(failed.body.length, MAX_HANDOFF_BODY_CHARS);
  assert.equal(failed.bodyTruncated, true);

  assert.equal(result.value.handoffs[6]?.failure, null);
});

test('reports unavailable when the store fails instead of pretending there were no deliveries', async () => {
  const h = await harness({ queryThrows: true });
  const result = await h.service.read({ actorId: OWNER_ID, delegationId: h.delegation.id });
  assert.ok(!result.ok);
  assert.equal(result.error.code, 'unavailable');
  assert.match(result.error.message, /无法确认是否已交付/);
});

test('rejects malformed queries before touching any store', async () => {
  const h = await harness();
  for (const query of [
    { actorId: '', delegationId: h.delegation.id },
    { actorId: OWNER_ID, delegationId: ' dlg-1 ' },
    { actorId: OWNER_ID, delegationId: h.delegation.id, scanLimit: 0 },
    { actorId: OWNER_ID, delegationId: h.delegation.id, scanLimit: 201 },
    { actorId: OWNER_ID, delegationId: h.delegation.id, scanLimit: 1.5 },
    { actorId: OWNER_ID, delegationId: h.delegation.id, extra: true }
  ]) {
    const result = await h.service.read(query as never);
    assert.ok(!result.ok, JSON.stringify(query));
    assert.equal(result.error.code, 'invalid', JSON.stringify(query));
  }
  assert.equal(h.calls.length, 0);
});

test('skips null / primitive siblings in parts without poisoning the handoff', async () => {
  const h = await harness();
  h.setRows([
    h.message({
      status: 'done',
      parts: [
        null,
        'not-a-part',
        7,
        h.candidatePart(),
        { type: 'data', schema: 'verify-result/v1', data: { ok: true } }
      ] as never
    }),
    // 没有候选 part 的坏行只计入 unknown，不抛出。
    h.message({ id: 'msg-no-candidate', parts: [null, 'x'] as never })
  ]);

  const result = await h.service.read({ actorId: OWNER_ID, delegationId: h.delegation.id });
  assert.ok(result.ok);
  assert.equal(result.value.state, 'recorded');
  assert.equal(result.value.handoffs.length, 1);
  const handoff = result.value.handoffs[0];
  assert.ok(handoff);
  assert.equal(handoff.messageId, 'msg-handoff');
  // 3 个非对象元素 + 1 个 verify-result data。
  assert.equal(handoff.hiddenPartCount, 4);
  assert.deepEqual(handoff.attachments, []);
  assert.deepEqual(JSON.stringify(result.value).includes('not-a-part'), false);
});

test('hides arbitrary data parts and unsafe links instead of echoing them as evidence', async () => {
  const h = await harness();
  h.setRows([
    h.message({
      parts: [
        h.candidatePart(),
        { type: 'data', schema: 'verify-result/v1', data: { ok: true } },
        { type: 'data', schema: 'verify-result/v1', data: { ok: false } },
        { type: 'link', url: 'javascript:alert(1)' },
        { type: 'link', url: 'https://example.com/ok?token=abc' }
      ]
    })
  ]);

  const result = await h.service.read({ actorId: OWNER_ID, delegationId: h.delegation.id });
  assert.ok(result.ok);
  const handoff = result.value.handoffs[0];
  assert.ok(handoff);
  assert.equal(handoff.hiddenPartCount, 3);
  assert.deepEqual(handoff.attachments, [
    { kind: 'link', url: 'https://example.com/ok', label: null }
  ]);
});
