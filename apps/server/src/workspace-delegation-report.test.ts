import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  asLoginId,
  asProjectId,
  asSessionId,
  asTaskId,
  asTeamId,
  asUserId,
  err,
  ok,
  unavailable,
  WORKSPACE_DELEGATE_SCOPE,
  WORKSPACE_REPORT_SCOPE,
  type Accepted,
  type AccessPolicy,
  type DomainError,
  type GrantActor,
  type Principal,
  type Project,
  type Result,
  type Role,
  type Session,
  type SessionId,
  type Task,
  type ToolContext,
  type ToolGrant,
  type WorkspaceDelegation
} from '@agent-hub/domain';
import {
  createWorkspaceReportToolProvider,
  type WorkspaceReportCapability,
  type WorkspaceReportCommand,
  type WorkspaceReportToolDeps
} from './workspace-delegation-report.ts';

const OWNER = 'u-owner';
const PROJECT = 'p1';
const OTHER_PROJECT = 'p2';
const CHILD_TASK = 't1';
const OTHER_TASK = 't2';
const FOREIGN_TASK = 't3';

function person(role: Role, id: string): Principal {
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
      teamId: asTeamId('t1'),
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

function project(id: string): Project {
  return {
    id: asProjectId(id),
    teamId: asTeamId('t1'),
    createdBy: asUserId(OWNER),
    deletedAt: null
  } as unknown as Project;
}

function task(id: string, projectId: string): Task {
  return { id: asTaskId(id), projectId: asProjectId(projectId) } as unknown as Task;
}

function session(
  id: string,
  taskId: string | null,
  createdBy: string | null,
  originProjectId: string | null
): Session {
  return {
    id: asSessionId(id),
    taskId: taskId === null ? null : asTaskId(taskId),
    createdBy,
    originProjectId: originProjectId === null ? null : asProjectId(originProjectId),
    status: 'running'
  } as unknown as Session;
}

function delegation(overrides: Partial<WorkspaceDelegation> = {}): WorkspaceDelegation {
  return {
    id: 'del-1',
    accountId: OWNER,
    coordinatorSessionId: asSessionId('ses-creator'),
    requestKey: 'delegate-1',
    projectId: asProjectId(PROJECT),
    taskId: asTaskId(CHILD_TASK),
    executionSessionId: asSessionId('ses-child'),
    state: 'prepared',
    ...overrides
  } as WorkspaceDelegation;
}

function grant(overrides: Partial<ToolGrant> = {}): ToolGrant {
  return {
    id: 'grant-1',
    tokenHash: 'hash',
    taskId: null,
    sessionId: asSessionId('ses-child'),
    workerId: 'worker-1',
    scopes: [WORKSPACE_REPORT_SCOPE],
    createdAt: 1,
    expiresAt: 1_000,
    revokedAt: null,
    actor: { userId: OWNER, via: 'web' },
    ...overrides
  };
}

function world() {
  const projects = new Map<string, Project>([
    [PROJECT, project(PROJECT)],
    [OTHER_PROJECT, project(OTHER_PROJECT)]
  ]);
  const tasks = new Map<string, Task>([
    [CHILD_TASK, task(CHILD_TASK, PROJECT)],
    [OTHER_TASK, task(OTHER_TASK, PROJECT)],
    [FOREIGN_TASK, task(FOREIGN_TASK, OTHER_PROJECT)]
  ]);
  const sessions = new Map<string, Session>([
    [asSessionId('ses-child'), session('ses-child', CHILD_TASK, OWNER, null)],
    [asSessionId('ses-creator'), session('ses-creator', null, OWNER, PROJECT)]
  ]);
  const delegations = new Map<string, WorkspaceDelegation>([
    ['del-1', delegation()]
  ]);
  const actors = new Map<string, Principal>([[OWNER, person('owner', OWNER)]]);
  const calls: WorkspaceReportCommand[] = [];
  let capability: WorkspaceReportCapability | undefined;
  let clock = 100;
  let busResult: Result<Accepted, DomainError> = ok({
    messageId: 'msg-1',
    traceId: 'trace-1',
    status: 'queued',
    targetSessionId: asSessionId('ses-creator')
  });

  const deps: WorkspaceReportToolDeps = {
    sessions: { byId: async (id) => sessions.get(id) ?? null },
    tasks: { byId: async (id) => tasks.get(id) ?? null },
    projects: { byId: async (id) => projects.get(id) ?? null },
    delegations: {
      byExecutionSession: async (sessionId) => {
        for (const item of delegations.values()) {
          if (item.executionSessionId === sessionId) return item;
        }
        return null;
      }
    },
    access: policy(),
    loadActor: async (userId) => actors.get(userId) ?? null,
    now: () => clock,
    get capability() {
      return capability;
    },
    bus: {
      reportDelegation: async (command) => {
        calls.push(command);
        return busResult;
      }
    }
  };
  const access = createWorkspaceReportToolProvider(deps);

  return {
    deps,
    sessions,
    delegations,
    actors,
    calls,
    setCapability(next: WorkspaceReportCapability | undefined) {
      capability = next;
    },
    setNow(next: number) {
      clock = next;
    },
    setBusResult(next: Result<Accepted, DomainError>) {
      busResult = next;
    },
    canReport(sessionId: SessionId, actor: GrantActor | null | undefined) {
      return access.canReport(sessionId, actor);
    },
    async call(input: unknown = { request_key: 'k1', body: 'done' }, overrides: Partial<ToolGrant> = {}, now = 1) {
      const ctx: ToolContext = { grant: grant(overrides), now };
      return access.provider.call('workspace.report', input, ctx);
    }
  };
}

test('workspace.report sends only to the coordinator derived from a prepared delegation', async () => {
  const w = world();
  const result = await w.call(
    { request_key: 'k1', body: 'tests pass', sha: 'a'.repeat(40) },
    {},
    5
  );

  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(result.value, {
    messageId: 'msg-1',
    status: 'queued',
    delegationId: 'del-1',
    requestKey: 'k1',
    sha: 'a'.repeat(40),
    shaVerification: 'self-reported'
  });
  assert.equal(w.calls.length, 1);
  assert.deepEqual(w.calls[0], {
    fromSessionId: asSessionId('ses-child'),
    targetSessionId: asSessionId('ses-creator'),
    actorId: OWNER,
    delegationId: 'del-1',
    requestKey: 'k1',
    body: 'tests pass',
    sha: 'a'.repeat(40)
  });
});

test('a taskless coordinator in the same project is allowed', async () => {
  const w = world();
  assert.equal(w.sessions.get(asSessionId('ses-creator'))?.taskId, null);
  const result = await w.call();
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(w.calls[0]?.targetSessionId, asSessionId('ses-creator'));
});

test('a coordinator on a sibling task in the same project is allowed', async () => {
  const w = world();
  w.sessions.set(
    asSessionId('ses-creator'),
    session('ses-creator', OTHER_TASK, OWNER, null)
  );
  const result = await w.call();
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(w.calls[0]?.targetSessionId, asSessionId('ses-creator'));
});

test('missing delegation is rejected', async () => {
  const w = world();
  w.delegations.clear();
  const result = await w.call();
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'not_found');
  assert.equal(w.calls.length, 0);
});

test('only the prepared state is accepted', async () => {
  const w = world();
  w.delegations.set('del-1', delegation({ state: 'preparing' }));
  const result = await w.call();
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'conflict');
  assert.equal(w.calls.length, 0);
});

test('a foreign actor cannot report', async () => {
  const w = world();
  w.actors.set('u-other', person('owner', 'u-other'));
  const result = await w.call(undefined, { actor: { userId: 'u-other', via: 'web' } });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'forbidden');
  assert.equal(w.calls.length, 0);
});

test('a stale grant is rejected even with a valid delegation', async () => {
  const w = world();
  const result = await w.call(undefined, { revokedAt: 2 }, 5);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'forbidden');
  assert.equal(w.calls.length, 0);
});

test('a grant without delegation:report is rejected', async () => {
  const w = world();
  const result = await w.call(undefined, { scopes: [WORKSPACE_DELEGATE_SCOPE] });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'forbidden');
  assert.equal(w.calls.length, 0);
});

test('the child session task must match the delegation task', async () => {
  const w = world();
  w.sessions.set(asSessionId('ses-child'), session('ses-child', OTHER_TASK, OWNER, null));
  const result = await w.call();
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'conflict');
  assert.equal(w.calls.length, 0);
});

test('the child cannot be its own coordinator', async () => {
  const w = world();
  w.delegations.set('del-1', delegation({ coordinatorSessionId: asSessionId('ses-child') }));
  const result = await w.call();
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'conflict');
  assert.equal(w.calls.length, 0);
});

test('a coordinator in another project is rejected', async () => {
  const w = world();
  w.sessions.set(
    asSessionId('ses-creator'),
    session('ses-creator', FOREIGN_TASK, OWNER, null)
  );
  const result = await w.call();
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'forbidden');
  assert.equal(w.calls.length, 0);
});

test('a taskless coordinator without an immutable origin is rejected', async () => {
  const w = world();
  w.sessions.set(
    asSessionId('ses-creator'),
    session('ses-creator', null, OWNER, null)
  );
  const result = await w.call();
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'not_found');
  assert.equal(w.calls.length, 0);
});

test('a task session whose origin project conflicts with its task is rejected', async () => {
  const w = world();
  w.sessions.set(
    asSessionId('ses-child'),
    session('ses-child', CHILD_TASK, OWNER, OTHER_PROJECT)
  );
  const result = await w.call();
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'not_found');
  assert.equal(w.calls.length, 0);
});

test('activated, verified owner is required', async () => {
  const disabled = world();
  const disabledOwner = person('owner', OWNER);
  disabled.actors.set(OWNER, {
    ...disabledOwner,
    user: { ...disabledOwner.user, disabledAt: 2 }
  });
  const disabledResult = await disabled.call();
  assert.equal(disabledResult.ok, false);
  if (!disabledResult.ok) assert.equal(disabledResult.error.code, 'forbidden');

  const unverified = world();
  const unverifiedOwner = person('owner', OWNER);
  unverified.actors.set(OWNER, {
    ...unverifiedOwner,
    user: { ...unverifiedOwner.user, emailVerifiedAt: null }
  });
  const unverifiedResult = await unverified.call();
  assert.equal(unverifiedResult.ok, false);
  if (!unverifiedResult.ok) assert.equal(unverifiedResult.error.code, 'forbidden');
});

test('capability checker can tighten a valid delegation', async () => {
  const w = world();
  w.setCapability(() => false);
  const result = await w.call();
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'forbidden');
  assert.equal(w.calls.length, 0);
});

test('unknown attributes including recipient, project, and wake are rejected', async () => {
  for (const key of ['recipient', 'recipient_session_id', 'target', 'project', 'project_id', 'wake']) {
    const w = world();
    const result = await w.call({ request_key: 'k1', body: 'done', [key]: 'x' });
    assert.equal(result.ok, false, key);
    if (!result.ok) assert.equal(result.error.code, 'invalid', key);
    assert.equal(w.calls.length, 0, key);
  }
});

test('sha must be an exact full lowercase 40-character hex string', async () => {
  for (const sha of ['a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), 'g'.repeat(40), 123]) {
    const w = world();
    const result = await w.call({ request_key: 'k1', body: 'done', sha });
    assert.equal(result.ok, false, String(sha));
    if (!result.ok) assert.equal(result.error.code, 'invalid', String(sha));
    assert.equal(w.calls.length, 0);
  }
});

test('a bus record failure is surfaced unchanged', async () => {
  const w = world();
  w.setBusResult(err(unavailable('消息写入失败')));
  const result = await w.call();
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.error, { code: 'unavailable', message: '消息写入失败' });
  assert.equal(w.calls.length, 1);
});

test('canReport requires a real web actor and never synthesizes one from the delegation', async () => {
  const w = world();
  assert.equal(await w.canReport(asSessionId('ses-child'), undefined), false);
  assert.equal(await w.canReport(asSessionId('ses-child'), null), false);
  assert.equal(await w.canReport(asSessionId('ses-child'), { userId: OWNER, via: 'web' }), true);
  assert.equal(await w.canReport(asSessionId('ses-missing'), { userId: OWNER, via: 'web' }), false);
});

test('canReport accepts an unexpired preparing claim but not terminal or expired ones', async () => {
  const w = world();
  const owner: GrantActor = { userId: OWNER, via: 'web' };
  const claim = { owner: 'worker-1', token: 'claim-1', at: 1, expiresAt: 200 };

  w.delegations.set('del-1', delegation({ state: 'preparing', claim }));
  assert.equal(await w.canReport(asSessionId('ses-child'), owner), true);

  w.setNow(200);
  assert.equal(await w.canReport(asSessionId('ses-child'), owner), false);

  w.setNow(199);
  w.delegations.set('del-1', delegation({ state: 'preparing', claim: null }));
  assert.equal(await w.canReport(asSessionId('ses-child'), owner), false);

  for (const state of ['failed', 'uncertain', 'cancelled', 'pending'] as const) {
    w.delegations.set('del-1', delegation({ state, claim }));
    assert.equal(await w.canReport(asSessionId('ses-child'), owner), false, state);
  }

  w.delegations.set('del-1', delegation({ state: 'prepared' }));
  assert.equal(await w.canReport(asSessionId('ses-child'), owner), true);
  assert.equal(w.calls.length, 0, 'cap/mint must be read-only');
});

test('the provider still requires prepared even while canReport allows a preparing claim', async () => {
  const w = world();
  w.delegations.set('del-1', {
    ...delegation({ state: 'preparing' }),
    claim: { owner: 'worker-1', token: 'claim-1', at: 1, expiresAt: 200 }
  });
  assert.equal(await w.canReport(asSessionId('ses-child'), { userId: OWNER, via: 'web' }), true);
  const result = await w.call();
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'conflict');
  assert.equal(w.calls.length, 0);
});

test('canReport accepts the actual grant actor and rejects non-web or foreign actors', async () => {
  const w = world();
  assert.equal(await w.canReport(asSessionId('ses-child'), { userId: OWNER, via: 'web' }), true);
  assert.equal(await w.canReport(asSessionId('ses-child'), { userId: OWNER, via: 'bot' }), false);
  assert.equal(await w.canReport(asSessionId('ses-child'), { userId: null, via: 'web' }), false);
  assert.equal(await w.canReport(asSessionId('ses-child'), { userId: 'u-other', via: 'web' }), false);
});

test('canReport honors the shared capability checker', async () => {
  const w = world();
  w.setCapability(() => false);
  assert.equal(await w.canReport(asSessionId('ses-child'), { userId: OWNER, via: 'web' }), false);
  assert.equal(w.calls.length, 0);
});

test('the result surfaces the bus status and an optional hold reason without claiming delivery', async () => {
  const w = world();
  w.setBusResult(
    ok({
      messageId: 'msg-held',
      traceId: 'trace-2',
      status: 'held',
      targetSessionId: asSessionId('ses-creator'),
      holdReason: 'privilege'
    })
  );

  const result = await w.call();
  assert.ok(result.ok);
  assert.deepEqual(result.value, {
    messageId: 'msg-held',
    status: 'held',
    holdReason: 'privilege',
    delegationId: 'del-1',
    requestKey: 'k1'
  });
  assert.equal('accepted' in (result.value as object), false);
});

test('the shared capability requires current agent.message.send on the project', async () => {
  const w = world();
  // viewer 能读项目/会话（project.read / session.read = team），但没有 agent.message.send。
  w.actors.set(OWNER, person('viewer', OWNER));

  assert.equal(await w.canReport(asSessionId('ses-child'), { userId: OWNER, via: 'web' }), false);
  const result = await w.call();
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'forbidden');
  assert.equal(w.calls.length, 0);
});

test('the result snapshot never includes the body or a chosen recipient', async () => {
  const w = world();
  const result = await w.call({ request_key: 'k1', body: 'secret body', sha: 'b'.repeat(40) });
  assert.ok(result.ok);
  assert.deepEqual(Object.keys(result.value as object).sort(), [
    'delegationId',
    'messageId',
    'requestKey',
    'sha',
    'shaVerification',
    'status'
  ]);
  assert.equal(JSON.stringify(result.value).includes('secret body'), false);
  assert.equal(JSON.stringify(result.value).includes('ses-creator'), false);
});
