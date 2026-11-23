import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import {
  err,
  ok,
  type AccessPolicy,
  type DelegationAcceptance,
  type DelegationAcceptanceInput,
  type DelegationAcceptanceResult,
  type DomainError,
  type Project,
  type Resource,
  type Result,
  type Session,
  type Subject,
  type Task,
  type TaskGate,
  type WorkspaceDelegation
} from '@agent-hub/domain';
import {
  installDelegationAcceptanceRoutes,
  type DelegationAcceptanceRouteOptions
} from './workspace-delegation-acceptance.ts';

const HEAD_SHA = 'b'.repeat(40);
const OLD_SHA = 'a'.repeat(40);
const URL = 'https://github.com/acme/repo.git';

const person = {
  user: { id: 'u1', teamId: 'team1', role: 'member', disabledAt: null, deletedAt: null, clusterAdmin: false },
  loginId: 'l1'
} as unknown as Subject;
const otherPerson = {
  user: { id: 'u2', teamId: 'team1', role: 'member', disabledAt: null, deletedAt: null, clusterAdmin: false },
  loginId: 'l2'
} as unknown as Subject;
const viewer = {
  user: { id: 'u1', teamId: 'team1', role: 'viewer', disabledAt: null, deletedAt: null, clusterAdmin: false },
  loginId: 'l1'
} as unknown as Subject;
const tokenPerson = {
  user: { id: 'u1', teamId: 'team1', role: 'member', disabledAt: null, deletedAt: null, clusterAdmin: false },
  loginId: 'l1',
  via: { kind: 'api-token', permissions: ['project.read', 'session.read', 'task.update'], teamIds: ['team1'] }
} as unknown as Subject;

function delegation(over: Partial<WorkspaceDelegation> = {}): WorkspaceDelegation {
  return {
    id: 'd1',
    accountId: 'u1',
    coordinatorSessionId: 'c1',
    requestKey: 'request-1',
    requestFingerprint: 'f'.repeat(64),
    projectId: 'p1',
    taskId: 't1',
    repoId: 'r1',
    repoUrl: URL,
    workerId: 'w1',
    baseBranch: 'main',
    baseSha: OLD_SHA,
    instructions: 'internal instructions that must never leak',
    executionSessionId: 's1',
    worktreePath: '/work/feat',
    branch: 'feat/x',
    state: 'prepared',
    claim: null,
    failure: null,
    createdAt: 1,
    updatedAt: 2,
    ...over
  } as unknown as WorkspaceDelegation;
}

function project(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Project',
    repo: null,
    repos: [{ id: 'r1', name: 'repo', url: URL, defaultBranch: 'main', tokenSecret: null }],
    primaryRepoId: null,
    description: null,
    createdAt: 1,
    teamId: 'team1',
    createdBy: 'u1',
    members: [],
    worktree: null,
    checks: [],
    deletedAt: null,
    ...over
  } as unknown as Project;
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    projectId: 'p1',
    title: 'Fix it',
    goal: null,
    status: 'in_progress',
    ownerId: 'u1',
    branch: 'feat/x',
    baseBranch: 'main',
    summary: null,
    archivedAt: null,
    logSeq: 0,
    createdAt: 1,
    updatedAt: 2,
    ...over
  } as unknown as Task;
}

function session(over: Partial<Session> = {}): Session {
  return {
    id: 's1',
    taskId: 't1',
    workspaceId: 'ws1',
    workerId: 'w1',
    createdBy: 'u1',
    parentSessionId: null,
    botId: null,
    kind: 'chat',
    ...over
  } as unknown as Session;
}

function acceptance(over: Partial<DelegationAcceptance> = {}): DelegationAcceptance {
  return {
    delegationId: 'd1',
    requestKey: 'k1',
    sha: OLD_SHA,
    actorId: 'u1',
    createdAt: 10,
    note: null,
    ...over
  };
}

const access: AccessPolicy = {
  context: async () => ({ hubTeamId: 'team1', settings: { membersCanAddMachines: false } }),
  worker: async () => ({ kind: 'worker', id: 'w1', teamId: 'team1', createdBy: null } as Resource)
};

interface HarnessOptions {
  readonly record?: WorkspaceDelegation;
  /** byId 依次返回这些快照；用于模拟 HEAD 核对后、追加前上下文发生变化。 */
  readonly records?: readonly WorkspaceDelegation[];
  readonly project?: Project | null;
  readonly task?: Task | null;
  readonly session?: Session | null;
  readonly history?: readonly DelegationAcceptance[];
  readonly subject?: Subject;
  readonly access?: AccessPolicy;
  readonly resolveHead?: (record: WorkspaceDelegation) => Promise<Result<string, DomainError>>;
  readonly append?: (input: DelegationAcceptanceInput) => Promise<DelegationAcceptanceResult>;
  /** 覆盖精确 SHA 查询；默认从 history 里找最后一条，测试可模拟「不在最近 50 条里」。 */
  readonly latestForSha?: (delegationId: string, sha: string) => Promise<DelegationAcceptance | null>;
  readonly taskGate?: TaskGate;
}

interface Harness {
  readonly app: Hono;
  readonly history: DelegationAcceptance[];
  readonly appendCalls: DelegationAcceptanceInput[];
  readonly resolveCalls: WorkspaceDelegation[];
}

function harness(options: HarnessOptions = {}): Harness {
  const record = options.record ?? delegation();
  const snapshots = options.records ?? [record];
  let reads = 0;
  const projectValue = options.project === undefined ? project() : options.project;
  const taskValue = options.task === undefined ? task() : options.task;
  const sessionValue = options.session === undefined ? session() : options.session;
  const history = [...(options.history ?? [])];
  const appendCalls: DelegationAcceptanceInput[] = [];
  const resolveCalls: WorkspaceDelegation[] = [];

  const store = {
    byId: async (id: string) => {
      if (id !== record.id) return null;
      const value = snapshots[Math.min(reads, snapshots.length - 1)] ?? null;
      reads += 1;
      return value;
    }
  };

  const acceptances = {
    byRequest: async (delegationId: string, requestKey: string) =>
      history.find((entry) => entry.delegationId === delegationId && entry.requestKey === requestKey) ?? null,
    latestForSha:
      options.latestForSha ??
      (async (delegationId: string, sha: string) =>
        history.filter((entry) => entry.delegationId === delegationId && entry.sha === sha).at(-1) ?? null),
    history: async (delegationId: string) => history.filter((entry) => entry.delegationId === delegationId),
    append: async (input: DelegationAcceptanceInput): Promise<DelegationAcceptanceResult> => {
      appendCalls.push({ ...input });
      if (options.append) return options.append(input);
      const stored = acceptance({ ...input, note: input.note ?? null });
      history.push(stored);
      return { outcome: 'created', record: stored };
    }
  };

  const optionsValue: DelegationAcceptanceRouteOptions = {
    delegations: store,
    acceptances,
    projects: { byId: async (id: string) => (id === 'p1' ? projectValue : null) },
    tasks: { byId: async (id: string) => (id === 't1' ? taskValue : null) },
    sessions: { byId: async (id: string) => (id === 's1' ? sessionValue : null) },
    access: options.access === undefined ? access : options.access,
    now: () => 1000,
    taskGate: options.taskGate,
    resolveHead: options.resolveHead ?? (async (value) => {
      resolveCalls.push(value);
      return ok(HEAD_SHA);
    })
  };

  const app = new Hono();
  installDelegationAcceptanceRoutes(app, optionsValue, () => options.subject ?? person);
  return { app, history, appendCalls, resolveCalls };
}

async function get(h: Harness, id = 'd1'): Promise<Response> {
  return h.app.request(`/api/workspace-delegations/${id}/acceptance`);
}

async function post(h: Harness, body: unknown, id = 'd1'): Promise<Response> {
  return h.app.request(`/api/workspace-delegations/${id}/acceptance`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function json(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>;
}

test('GET: returns append history, a freshly observed HEAD/status and no-store', async () => {
  const h = harness({
    history: [acceptance({ requestKey: 'k-old', sha: OLD_SHA }), acceptance({ requestKey: 'k-new', sha: HEAD_SHA, note: 'ok' })]
  });

  const response = await get(h);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await json(response);

  assert.equal(body.delegationId, 'd1');
  assert.equal(body.state, 'prepared');
  assert.equal(body.history.length, 2);
  assert.equal(body.history[0]?.sha, OLD_SHA);
  assert.equal(body.history[1]?.sha, HEAD_SHA);
  assert.equal(body.latest?.requestKey, 'k-new');
  assert.equal(body.current?.requestKey, 'k-new');
  assert.equal(body.current?.sha, HEAD_SHA);
  assert.equal(body.headSha, HEAD_SHA);
  assert.equal(body.headUnavailable, null);
  assert.equal(body.headObservedAt, 1000);
  assert.equal(body.status, 'accepted');
  assert.equal(body.canAccept, true);
  assert.equal(h.resolveCalls.length, 1);
  assert.deepEqual(Object.keys(body).sort(), [
    'canAccept',
    'current',
    'delegationId',
    'headObservedAt',
    'headSha',
    'headUnavailable',
    'history',
    'latest',
    'state',
    'status'
  ]);

  const text = JSON.stringify(body);
  for (const secret of ['internal instructions', '/work/feat', URL, 'requestFingerprint', 'claim', 'accountId']) {
    assert.equal(text.includes(secret), false, `GET leaked ${secret}`);
  }
});

test('GET: empty history is none only when the current HEAD is readable', async () => {
  const readable = harness();
  const readableResponse = await get(readable);
  assert.equal(readableResponse.status, 200);
  const readableBody = await json(readableResponse);
  assert.equal(readableBody.history.length, 0);
  assert.equal(readableBody.latest, null);
  assert.equal(readableBody.current, null);
  assert.equal(readableBody.status, 'none');
  assert.equal(readableBody.canAccept, true);

  const unavailable = harness({
    resolveHead: async () => err({ code: 'unavailable', message: 'private /work/feat' } as DomainError)
  });
  const unavailableResponse = await get(unavailable);
  assert.equal(unavailableResponse.status, 200);
  const unavailableBody = await json(unavailableResponse);
  assert.equal(unavailableBody.history.length, 0);
  assert.equal(unavailableBody.latest, null);
  assert.equal(unavailableBody.current, null);
  assert.equal(unavailableBody.headSha, null);
  assert.equal(unavailableBody.status, 'unavailable');
  assert.equal(unavailableBody.canAccept, false);
  assert.equal(JSON.stringify(unavailableBody).includes('/work/feat'), false);
});

test('GET: a delegation that is not prepared reports unavailable rather than none', async () => {
  const h = harness({ record: delegation({ state: 'failed' }) });
  const response = await get(h);
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.state, 'failed');
  assert.equal(body.history.length, 0);
  assert.equal(body.latest, null);
  assert.equal(body.current, null);
  assert.equal(body.status, 'unavailable');
  assert.equal(body.canAccept, false);
});

test('GET: archived tasks remain readable but canAccept is false', async () => {
  const h = harness({ task: task({ archivedAt: 5 }), history: [acceptance({ requestKey: 'k1', sha: HEAD_SHA })] });
  const response = await get(h);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await json(response);
  assert.equal(body.status, 'accepted');
  assert.equal(body.current?.sha, HEAD_SHA);
  assert.equal(body.canAccept, false);

  const denied = await post(h, { requestKey: 'k-new', expectedHeadSha: HEAD_SHA });
  assert.equal(denied.status, 409);
  assert.equal(h.resolveCalls.length, 1);
  assert.equal(h.appendCalls.length, 0);
});

test('GET: marks a prior acceptance as changed and never rewrites its historical SHA', async () => {
  const stored = acceptance({ requestKey: 'k-old', sha: OLD_SHA, note: 'old note' });
  const h = harness({ history: [stored] });

  const response = await get(h);
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.status, 'changed');
  assert.equal(body.latest?.sha, OLD_SHA);
  assert.equal(body.current, null);
  assert.equal(body.headSha, HEAD_SHA);
  assert.equal(body.latest?.note, 'old note');
  assert.equal(body.canAccept, true);
  assert.equal(stored.sha, OLD_SHA);
  assert.equal(stored.note, 'old note');
});

test('GET: exact historical acceptance for the current HEAD wins over latest and bypasses the history window', async () => {
  const old = acceptance({ requestKey: 'k-a', sha: OLD_SHA, note: 'older evidence' });
  const latest = acceptance({ requestKey: 'k-b', sha: HEAD_SHA });
  const h = harness({
    // 模拟最近 50 条窗口里只剩 B：A 仍然必须通过 latestForSha 精确查到。
    history: [latest],
    latestForSha: async () => old,
    resolveHead: async () => ok(OLD_SHA)
  });

  const response = await get(h);
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.status, 'accepted');
  assert.equal(body.latest?.requestKey, 'k-b');
  assert.equal(body.current?.requestKey, 'k-a');
  assert.equal(body.current?.sha, OLD_SHA);
  assert.equal(body.current?.note, 'older evidence');
  assert.equal(body.history.length, 1);
  assert.equal(body.history[0]?.sha, HEAD_SHA);
});

test('GET: viewers still read history, but canAccept is false and the request stays 200', async () => {
  const h = harness({
    subject: viewer,
    history: [acceptance({ requestKey: 'k1', sha: HEAD_SHA })]
  });
  const response = await get(h);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await json(response);
  assert.equal(body.status, 'accepted');
  assert.equal(body.canAccept, false);
});

test('GET: canAccept defaults false when the current permission lookup fails', async () => {
  let lookups = 0;
  const flaky: AccessPolicy = {
    context: async () => {
      lookups += 1;
      if (lookups >= 4) throw new Error('permission lookup failed');
      return { hubTeamId: 'team1', settings: { membersCanAddMachines: false } };
    },
    worker: async () => ({ kind: 'worker', id: 'w1', teamId: 'team1', createdBy: null } as Resource)
  };
  const h = harness({
    access: flaky,
    history: [acceptance({ requestKey: 'k1', sha: HEAD_SHA })]
  });

  const response = await get(h);
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.status, 'accepted');
  assert.equal(body.canAccept, false);
  assert.ok(lookups >= 4);
  assert.equal(JSON.stringify(body).includes('permission lookup failed'), false);
});

test('GET: renders unverifiable HEAD neutrally and does not leak resolver errors or paths', async () => {
  const h = harness({
    history: [acceptance({ requestKey: 'k-old', sha: OLD_SHA })],
    resolveHead: async () => err({ code: 'conflict', message: 'secret token at /work/feat' } as DomainError)
  });

  const response = await get(h);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await json(response);
  assert.equal(body.status, 'unavailable');
  assert.equal(body.current, null);
  assert.equal(body.canAccept, false);
  assert.equal(body.headSha, null);
  assert.equal(body.headUnavailable, '暂时无法读取执行工作树的当前提交');
  const text = JSON.stringify(body);
  assert.equal(text.includes('secret token'), false);
  assert.equal(text.includes('/work/feat'), false);
});

test('GET: hides non-owners, token principals, unknown delegations and card/session drift', async () => {
  const cases: readonly Harness[] = [
    harness({ subject: otherPerson }),
    harness({ subject: tokenPerson }),
    harness({ task: task({ projectId: 'p2' as Task['projectId'] }) }),
    harness({ session: session({ taskId: 't2' as Session['taskId'] }) }),
    harness({ session: session({ createdBy: 'u2' }) })
  ];
  for (const h of cases) {
    const response = await get(h);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await json(response);
    assert.equal(body.error.code, 'not_found');
    assert.equal(JSON.stringify(body).includes('internal instructions'), false);
  }

  const unknown = await get(harness(), 'missing');
  assert.equal(unknown.status, 404);
});

test('POST: creates a record only after the real current HEAD matches, with exact input', async () => {
  const h = harness();
  const response = await post(h, { requestKey: 'k-new', expectedHeadSha: HEAD_SHA, note: 'looks good' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await json(response);
  assert.equal(body.delegationId, 'd1');
  assert.equal(body.outcome, 'created');
  assert.equal(body.acceptance.requestKey, 'k-new');
  assert.equal(body.acceptance.sha, HEAD_SHA);
  assert.equal(body.acceptance.note, 'looks good');

  assert.equal(h.resolveCalls.length, 1);
  assert.equal(h.appendCalls.length, 1);
  assert.deepEqual(h.appendCalls[0], {
    delegationId: 'd1',
    requestKey: 'k-new',
    sha: HEAD_SHA,
    actorId: 'u1',
    createdAt: 1000,
    note: 'looks good'
  });
  const text = JSON.stringify(body);
  for (const secret of ['internal instructions', '/work/feat', URL, 'requestFingerprint', 'claim']) {
    assert.equal(text.includes(secret), false, `POST leaked ${secret}`);
  }
});

test('POST: stale expected SHA conflicts before any append', async () => {
  const h = harness();
  const response = await post(h, { requestKey: 'k-new', expectedHeadSha: OLD_SHA });
  assert.equal(response.status, 409);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await json(response);
  assert.equal(body.error.code, 'conflict');
  assert.equal(h.resolveCalls.length, 1);
  assert.equal(h.appendCalls.length, 0);
});

test('POST: exact durable replay returns the original record without worker I/O', async () => {
  const stored = acceptance({ requestKey: 'k1', sha: HEAD_SHA, note: 'ok' });
  const h = harness({ history: [stored] });
  const response = await post(h, { requestKey: 'k1', expectedHeadSha: HEAD_SHA, note: 'ok' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await json(response);
  assert.equal(body.outcome, 'replayed');
  assert.equal(body.acceptance.requestKey, 'k1');
  assert.equal(body.acceptance.sha, HEAD_SHA);
  assert.equal(body.acceptance.note, 'ok');
  assert.equal(h.resolveCalls.length, 0);
  assert.equal(h.appendCalls.length, 0);
});

test('POST: same request key with different content conflicts without leaking the old record', async () => {
  const stored = acceptance({ requestKey: 'k1', sha: OLD_SHA, note: 'old secret note' });
  const h = harness({ history: [stored] });
  const response = await post(h, { requestKey: 'k1', expectedHeadSha: HEAD_SHA, note: 'new note' });
  assert.equal(response.status, 409);
  const body = await json(response);
  assert.equal(body.error.code, 'conflict');
  const text = JSON.stringify(body);
  assert.equal(text.includes('old secret note'), false);
  assert.equal(text.includes(OLD_SHA), false);
  assert.equal(h.resolveCalls.length, 0);
  assert.equal(h.appendCalls.length, 0);
});

test('POST: requires task.update and hides non-owners', async () => {
  const denied = harness({ subject: viewer });
  const deniedResponse = await post(denied, { requestKey: 'k-new', expectedHeadSha: HEAD_SHA });
  assert.equal(deniedResponse.status, 403);
  assert.equal(denied.resolveCalls.length, 0);
  assert.equal(denied.appendCalls.length, 0);

  const hidden = harness({ subject: otherPerson });
  const hiddenResponse = await post(hidden, { requestKey: 'k-new', expectedHeadSha: HEAD_SHA });
  assert.equal(hiddenResponse.status, 404);
  assert.equal(hidden.resolveCalls.length, 0);
  assert.equal(hidden.appendCalls.length, 0);
});

test('POST: archived task or an in-progress archive is not writable', async () => {
  const archived = harness({ task: task({ archivedAt: 5 }) });
  const archivedResponse = await post(archived, { requestKey: 'k-new', expectedHeadSha: HEAD_SHA });
  assert.equal(archivedResponse.status, 409);
  assert.equal(archived.resolveCalls.length, 0);
  assert.equal(archived.appendCalls.length, 0);

  let entered = 0;
  const gate: TaskGate = {
    enter: () => {
      entered += 1;
      return null;
    },
    exclusive: () => null
  };
  const blocked = harness({ taskGate: gate });
  const blockedResponse = await post(blocked, { requestKey: 'k-new', expectedHeadSha: HEAD_SHA });
  assert.equal(blockedResponse.status, 409);
  assert.equal(entered, 1);
  assert.equal(blocked.resolveCalls.length, 1);
  assert.equal(blocked.appendCalls.length, 0);
});

test('POST: only prepared delegations get a real HEAD read', async () => {
  const h = harness({ record: delegation({ state: 'failed' }) });
  const response = await post(h, { requestKey: 'k-new', expectedHeadSha: HEAD_SHA });
  assert.equal(response.status, 409);
  assert.equal(h.resolveCalls.length, 0);
  assert.equal(h.appendCalls.length, 0);
});

test('POST: unverifiable HEAD is unavailable and never writes', async () => {
  const h = harness({ resolveHead: async () => err({ code: 'unavailable', message: 'private /work/feat' } as DomainError) });
  const response = await post(h, { requestKey: 'k-new', expectedHeadSha: HEAD_SHA });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await json(response);
  assert.equal(body.error.code, 'unavailable');
  assert.equal(JSON.stringify(body).includes('/work/feat'), false);
  assert.equal(h.appendCalls.length, 0);
});

test('POST: append race conflict is reported without the competing record', async () => {
  const stored = acceptance({ requestKey: 'k-new', sha: OLD_SHA, note: 'racing note' });
  const h = harness({
    append: async () => ({ outcome: 'conflict', record: stored })
  });
  const response = await post(h, { requestKey: 'k-new', expectedHeadSha: HEAD_SHA });
  assert.equal(response.status, 409);
  const body = await json(response);
  const text = JSON.stringify(body);
  assert.equal(text.includes('racing note'), false);
  assert.equal(text.includes(OLD_SHA), false);
  assert.equal(h.resolveCalls.length, 1);
  assert.equal(h.appendCalls.length, 1);
});

test('POST: append race replay is propagated as replayed instead of a false created', async () => {
  const stored = acceptance({ requestKey: 'k-new', sha: HEAD_SHA, note: null });
  const h = harness({
    append: async () => ({ outcome: 'replayed', record: stored })
  });

  const response = await post(h, { requestKey: 'k-new', expectedHeadSha: HEAD_SHA });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await json(response);
  assert.equal(body.outcome, 'replayed');
  assert.equal(body.acceptance.requestKey, 'k-new');
  assert.equal(body.acceptance.sha, HEAD_SHA);
  assert.equal(h.resolveCalls.length, 1);
  assert.equal(h.appendCalls.length, 1);
});

test('POST: rechecks live context before append and refuses when it drifted', async () => {
  const h = harness({
    records: [delegation(), delegation({ state: 'failed' })]
  });
  const response = await post(h, { requestKey: 'k-new', expectedHeadSha: HEAD_SHA });
  assert.equal(response.status, 409);
  const body = await json(response);
  assert.equal(body.error.code, 'conflict');
  assert.equal(h.resolveCalls.length, 1);
  assert.equal(h.appendCalls.length, 0);
});

test('POST: rejects malformed bodies before any lookup or worker I/O', async () => {
  const bodies: readonly unknown[] = [
    {},
    { requestKey: 'k-new', expectedHeadSha: 'short' },
    { requestKey: '   ', expectedHeadSha: HEAD_SHA },
    { requestKey: 'k'.repeat(201), expectedHeadSha: HEAD_SHA },
    { requestKey: 'k-new', expectedHeadSha: HEAD_SHA, note: 'bad\u0001note' },
    { requestKey: 'k-new', expectedHeadSha: HEAD_SHA, extra: true }
  ];
  for (const body of bodies) {
    const h = harness();
    const response = await post(h, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(h.resolveCalls.length, 0);
    assert.equal(h.appendCalls.length, 0);
  }
});
