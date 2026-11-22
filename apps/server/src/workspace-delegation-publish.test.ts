import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { createSqliteDelegationPublishAttempts } from '@agent-hub/storage-sqlite';
import {
  err,
  ok,
  type AccessPolicy,
  type CommitPreview,
  type DelegationPublishStore,
  type DomainError,
  type GhOutcome,
  type GhRequest,
  type GitHostApi,
  type NodeGateway,
  type Project,
  type ProjectId,
  type ProjectRepo,
  type ProjectRepository,
  type PublishAttempt,
  type PublishDelegationCommand,
  type PublishDelegationRun,
  type PublishRefInput,
  type PublishRefOutcome,
  type RemotePullRequest,
  type Result,
  type Session,
  type SessionId,
  type SessionRepository,
  type Subject,
  type Task,
  type TaskId,
  type TaskRepository,
  type Workspace,
  type WorkspaceDelegation,
  type WorkspaceDelegationStore,
  type WorkspaceGit,
  type WorkspaceId,
  type WorkspaceRepository,
  type WorkerStatus
} from '@agent-hub/domain';
import {
  createDelegationHeadResolver,
  createDelegationPublisher,
  delegationPublishView,
  installDelegationPublishRoutes,
  type DelegationPublishDeps,
  type DelegationPublisher
} from './workspace-delegation-publish.ts';

const URL = 'https://github.com/acme/repo.git';
const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const PR_URL = 'https://github.com/acme/repo/pull/7';

const person = { user: { id: 'u1' }, loginId: 'l1' } as unknown as Subject;
const tokenPerson = { user: { id: 'u1' }, loginId: 'l1', via: { kind: 'api-token' } } as unknown as Subject;

function delegation(over: Partial<WorkspaceDelegation> = {}): WorkspaceDelegation {
  return {
    id: 'd1',
    accountId: 'acct-1',
    coordinatorSessionId: 'c1',
    requestKey: 'request-1',
    requestFingerprint: 'f'.repeat(64),
    projectId: 'p1',
    taskId: 't1',
    repoId: 'r1',
    repoUrl: URL,
    workerId: 'w1',
    baseBranch: 'main',
    baseSha: BASE_SHA,
    instructions: 'internal instructions',
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

function task(): Task {
  return { id: 't1', projectId: 'p1', title: 'Fix it' } as unknown as Task;
}

function project(over: { repos?: readonly ProjectRepo[]; teamId?: string | null } = {}): Project {
  return {
    id: 'p1',
    name: 'Project',
    repo: null,
    repos: over.repos ?? [{ id: 'r1', name: 'repo', url: URL, defaultBranch: 'main', tokenSecret: null }],
    primaryRepoId: null,
    description: null,
    createdAt: 1,
    teamId: over.teamId === undefined ? 'team1' : over.teamId,
    createdBy: 'u1',
    members: [],
    worktree: null,
    checks: [],
    deletedAt: null
  } as unknown as Project;
}

function session(over: Partial<Session> = {}): Session {
  return {
    id: 's1',
    taskId: 't1',
    workspaceId: 'ws1',
    workerId: 'w1',
    parentSessionId: null,
    botId: null,
    ...over
  } as unknown as Session;
}

function workspace(over: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws1',
    projectId: 'p1',
    ownerTaskId: 't1',
    workerId: 'w1',
    path: '/work/feat',
    branch: 'feat/x',
    repoUrl: URL,
    kind: 'temporary',
    isGit: true,
    state: 'ready',
    ...over
  } as unknown as Workspace;
}

function preview(over: Partial<CommitPreview> = {}): CommitPreview {
  return {
    isGit: true,
    branch: 'feat/x',
    defaultBranch: 'main',
    remoteUrl: URL,
    upstream: 'origin/feat/x',
    ahead: 1,
    head: HEAD_SHA,
    files: [],
    patch: '',
    truncated: false,
    ...over
  };
}

function remotePr(over: Partial<RemotePullRequest> = {}): RemotePullRequest {
  return {
    number: 7,
    url: PR_URL,
    state: 'open',
    headSha: HEAD_SHA,
    mergedAt: null,
    base: 'main',
    repo: 'acme/repo',
    headRef: 'feat/x',
    draft: true,
    baseRepo: 'acme/repo',
    ...over
  };
}

interface GitFake {
  readonly git: WorkspaceGit;
  readonly publishCalls: PublishRefInput[];
  readonly ghCalls: GhRequest[];
}

function gitFake(options: { preview?: CommitPreview; previewError?: DomainError } = {}): GitFake {
  const publishCalls: PublishRefInput[] = [];
  const ghCalls: GhRequest[] = [];
  const previewValue = options.preview ?? preview();
  const git = {
    preview: async () => (options.previewError ? err(options.previewError) : ok(previewValue)),
    publishRef: async (input: PublishRefInput) => {
      publishCalls.push(input);
      return ok({
        sha: input.sha,
        branch: input.branch,
        published: true,
        pushed: true,
        baseBranch: input.baseBranch,
        baseSha: BASE_SHA,
        defaultBranch: 'main',
        remoteSha: input.sha,
        uncertain: false,
        reason: null
      } as PublishRefOutcome);
    },
    gh: async (_path: string, request: GhRequest) => {
      ghCalls.push(request);
      return ok({ ok: false, reason: 'unused' } as GhOutcome);
    }
  } as unknown as WorkspaceGit;
  return { git, publishCalls, ghCalls };
}

interface HostFake {
  readonly api: GitHostApi;
  readonly lists: { token: string; repo: string; head: string }[];
  readonly creates: { token: string; repo: string; base: string; head: string; title: string; body: string; draft?: boolean }[];
}

function hostFake(): HostFake {
  const lists: HostFake['lists'] = [];
  const creates: HostFake['creates'] = [];
  const api = {
    listPullRequestsByHead: async (input: { token: string; repo: string; head: string }) => {
      lists.push(input);
      return { ok: true, prs: [] } as const;
    },
    createPullRequest: async (input: HostFake['creates'][number]) => {
      creates.push(input);
      return { ok: true, pr: remotePr() } as const;
    },
    getPullRequest: async () => ({ ok: false, reason: 'unused' } as const)
  } as GitHostApi;
  return { api, lists, creates };
}

interface Harness {
  readonly publisher: DelegationPublisher;
  readonly deps: DelegationPublishDeps;
  readonly store: DelegationPublishStore;
  readonly local: GitFake;
  readonly host: HostFake;
  readonly reveals: string[][];
  readonly tokenTeams: string[];
}

function harness(options: {
  records?: readonly WorkspaceDelegation[];
  project?: Project;
  session?: Session | null;
  workspace?: Workspace | null;
  worker?: WorkerStatus | null;
  preview?: CommitPreview;
  previewError?: DomainError;
  secrets?: Readonly<Record<string, string>>;
  teamToken?: string | null;
  remoteGit?: WorkspaceGit;
  store?: DelegationPublishStore;
} = {}): Harness {
  const records = [...(options.records ?? [delegation()])];
  const projectValue = options.project ?? project();
  const sessionValue = options.session === undefined ? session() : options.session;
  const workspaceValue = options.workspace === undefined ? workspace() : options.workspace;
  const worker =
    options.worker === undefined
      ? ({ workerId: 'w1', label: 'local', origin: 'local', state: 'online' } as WorkerStatus)
      : options.worker;
  const local = gitFake({ preview: options.preview, previewError: options.previewError });
  const host = hostFake();
  const store = options.store ?? createSqliteDelegationPublishAttempts(new DatabaseSync(':memory:'));
  const reveals: string[][] = [];
  const tokenTeams: string[] = [];
  const secrets = options.secrets ?? {};
  const teamToken = options.teamToken === undefined ? 'team-token' : options.teamToken;

  const deps: DelegationPublishDeps = {
    projects: {
      byId: async (id: ProjectId) => (id === ('p1' as ProjectId) ? projectValue : null)
    } as unknown as ProjectRepository,
    tasks: {
      byId: async (id: TaskId) => (id === ('t1' as TaskId) ? task() : null)
    } as unknown as TaskRepository,
    sessions: {
      byId: async (id: SessionId) => (id === ('s1' as SessionId) ? sessionValue : null)
    } as unknown as Pick<SessionRepository, 'byId'>,
    workspaces: {
      byId: async (id: WorkspaceId) => (id === ('ws1' as WorkspaceId) ? workspaceValue : null)
    } as unknown as Pick<WorkspaceRepository, 'byId'>,
    gateway: {
      status: async () => (worker === null ? [] : [worker]),
      git: () => {
        if (options.remoteGit) return options.remoteGit;
        throw new Error('remote git was not expected');
      }
    } as unknown as Pick<NodeGateway, 'status' | 'git'>,
    git: local.git,
    secrets: {
      reveal: async (names: readonly string[]) => {
        reveals.push([...names]);
        const out: Record<string, string> = {};
        for (const name of names) {
          const value = secrets[name];
          if (typeof value === 'string') out[name] = value;
        }
        return out;
      }
    },
    now: () => 1000,
    gitHost: host.api,
    gitHostTokens: {
      reveal: async (teamId: string) => {
        tokenTeams.push(teamId);
        return teamId === projectValue.teamId ? teamToken : null;
      }
    }
  };

  const delegations: Pick<WorkspaceDelegationStore, 'byId'> = {
    byId: async (id: string) => records.find((candidate) => candidate.id === id) ?? null
  };

  return {
    publisher: createDelegationPublisher(deps, delegations, store),
    deps,
    store,
    local,
    host,
    reveals,
    tokenTeams
  };
}

async function publish(h: Harness, over: Partial<PublishDelegationCommand> = {}) {
  return h.publisher({
    actor: person,
    delegationId: 'd1',
    approvalKey: 'approval-1',
    mode: 'publish',
    expectedHeadSha: HEAD_SHA,
    ...over
  } as PublishDelegationCommand);
}

test('publish: resolves persisted session/workspace, pushes exact HEAD and opens a draft PR', async () => {
  const h = harness();
  const result = await publish(h);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.attempt.state, 'published');
  assert.equal(result.value.attempt.pullRequest?.number, 7);
  assert.equal(result.value.attempt.pullRequest?.draft, true);

  assert.equal(h.local.publishCalls.length, 1);
  const pushed = h.local.publishCalls[0];
  assert.ok(pushed);
  assert.equal(pushed.path, '/work/feat');
  assert.equal(pushed.branch, 'feat/x');
  assert.equal(pushed.sha, HEAD_SHA);
  assert.equal(pushed.expectedUrl, URL);
  assert.equal(pushed.baseBranch, 'main');
  assert.equal(pushed.verifyOnly, undefined);
  assert.equal(pushed.auth, undefined);

  assert.equal(h.host.lists.length, 1);
  const listed = h.host.lists[0];
  assert.ok(listed);
  assert.equal(listed.head, 'feat/x');
  assert.equal(h.host.creates.length, 1);
  const created = h.host.creates[0];
  assert.ok(created);
  assert.equal(created.token, 'team-token');
  assert.equal(created.repo, 'acme/repo');
  assert.equal(created.draft, true);
  assert.deepEqual(h.tokenTeams, ['team1']);
});

test('publish: remote worker uses gateway.git, never the local git implementation', async () => {
  const remote = gitFake();
  const h = harness({
    worker: { workerId: 'w1', label: 'remote', origin: 'remote', state: 'online' } as WorkerStatus,
    remoteGit: remote.git
  });
  const result = await publish(h);

  assert.equal(result.ok, true);
  assert.equal(h.local.publishCalls.length, 0);
  assert.equal(remote.publishCalls.length, 1);
  const remotePush = remote.publishCalls[0];
  assert.ok(remotePush);
  assert.equal(remotePush.sha, HEAD_SHA);
});

test('publish: repo credential is resolved from the exact recorded repoId, not another same-URL entry', async () => {
  const repos: readonly ProjectRepo[] = [
    { id: 'r1', name: 'same-url-without-token', url: URL, defaultBranch: 'main', tokenSecret: null },
    { id: 'r2', name: 'same-url-with-token', url: URL, defaultBranch: 'main', tokenSecret: 'repo-git:p1:r2' }
  ];
  const h = harness({
    records: [delegation({ id: 'd1', repoId: 'r1' }), delegation({ id: 'd2', repoId: 'r2' })],
    project: project({ repos }),
    secrets: { 'repo-git:p1:r2': 'right-token' }
  });

  const first = await publish(h, { delegationId: 'd1' });
  assert.equal(first.ok, true);
  const firstPush = h.local.publishCalls[0];
  assert.ok(firstPush);
  assert.equal(firstPush.auth, undefined);
  assert.deepEqual(h.reveals, []);

  const second = await publish(h, { delegationId: 'd2', approvalKey: 'approval-2' });
  assert.equal(second.ok, true);
  const secondPush = h.local.publishCalls[1];
  assert.ok(secondPush);
  const auth = secondPush.auth;
  assert.ok(auth);
  assert.equal(auth.url, URL);
  const encoded = auth.header.slice('Authorization: Basic '.length);
  assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), 'x-access-token:right-token');
  assert.deepEqual(h.reveals, [['repo-git:p1:r2']]);
});

test('publish: missing team GitHub token fails closed and never falls back to gh', async () => {
  const h = harness({ teamToken: null });
  const result = await publish(h);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'unavailable');
  assert.match(result.error.message, /GitHub 应用凭据/);
  assert.equal(h.local.publishCalls.length, 0);
  assert.equal(h.local.ghCalls.length, 0);
  assert.equal(h.host.creates.length, 0);
});

test('publish: project without a team cannot use a shared/global Git host token', async () => {
  const h = harness({ project: project({ teamId: null }) });
  const result = await publish(h);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'unavailable');
  assert.equal(h.local.publishCalls.length, 0);
  assert.deepEqual(h.tokenTeams, []);
});

test('publish: target drift fails before any push or PR', async () => {
  const cases: { name: string; options: Parameters<typeof harness>[0]; code: string; message: RegExp }[] = [
    {
      name: 'workspace path',
      options: { workspace: workspace({ path: '/work/other' }) },
      code: 'conflict',
      message: /路径/
    },
    {
      name: 'workspace branch',
      options: { workspace: workspace({ branch: 'feat/other' }) },
      code: 'conflict',
      message: /分支/
    },
    {
      name: 'origin URL',
      options: { preview: preview({ remoteUrl: 'https://github.com/acme/other.git' }) },
      code: 'conflict',
      message: /origin/
    },
    {
      name: 'head SHA',
      options: { preview: preview({ head: 'not-a-sha' }) },
      code: 'unavailable',
      message: /提交/
    },
    {
      name: 'unusable workspace',
      options: { workspace: workspace({ state: 'failed' }) },
      code: 'conflict',
      message: /不可用/
    },
    {
      name: 'missing session',
      options: { session: null },
      code: 'not_found',
      message: /执行会话/
    },
    {
      name: 'unknown worker',
      options: { worker: null },
      code: 'unavailable',
      message: /机器/
    }
  ];

  for (const item of cases) {
    const h = harness(item.options);
    const result = await publish(h);
    assert.equal(result.ok, false, item.name);
    if (result.ok) continue;
    assert.equal(result.error.code, item.code, item.name);
    assert.match(result.error.message, item.message, item.name);
    assert.equal(h.local.publishCalls.length, 0, item.name);
    assert.equal(h.host.creates.length, 0, item.name);
  }
});

test('head resolver: returns the exact worktree HEAD read-only and never touches credentials or publish', async () => {
  const h = harness();
  const resolveHead = createDelegationHeadResolver(h.deps);
  const result = await resolveHead(delegation());

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value, HEAD_SHA);
  assert.equal(h.local.publishCalls.length, 0);
  assert.equal(h.host.creates.length, 0);
  assert.deepEqual(h.reveals, []);
});

test('head resolver: refuses a workspace whose persisted identity drifted', async () => {
  const h = harness({ workspace: workspace({ path: '/work/other' }) });
  const resolveHead = createDelegationHeadResolver(h.deps);
  const result = await resolveHead(delegation());

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'conflict');
  assert.equal(h.local.publishCalls.length, 0);
});

function attempt(over: Partial<PublishAttempt> = {}): PublishAttempt {
  return {
    delegationId: 'd1',
    approvalKey: 'approval-1',
    fingerprint: 'f'.repeat(64),
    headSha: HEAD_SHA,
    state: 'published',
    claim: null,
    failure: null,
    remote: {
      sha: HEAD_SHA,
      branch: 'feat/x',
      baseBranch: 'main',
      baseSha: BASE_SHA,
      defaultBranch: 'main',
      remoteSha: HEAD_SHA,
      published: true
    },
    pullRequest: {
      repo: 'acme/repo',
      number: 7,
      url: PR_URL,
      headRef: 'feat/x',
      headSha: HEAD_SHA,
      base: 'main',
      baseRepo: 'acme/repo',
      state: 'open',
      draft: true
    },
    createdAt: 10,
    updatedAt: 11,
    ...over
  } as PublishAttempt;
}

function run(record = delegation(), attemptValue = attempt()): PublishDelegationRun {
  return { record, attempt: attemptValue, attempted: true, replayed: false, reconciled: false };
}

interface RouteHarness {
  readonly app: Hono;
  readonly calls: PublishDelegationCommand[];
  readonly headCalls: WorkspaceDelegation[];
}

function routes(options: {
  subject?: Subject | null;
  records?: readonly WorkspaceDelegation[];
  latest?: PublishAttempt | null;
  project?: Project | null;
  publisher?: DelegationPublisher;
  access?: AccessPolicy;
  resolveHead?: ((record: WorkspaceDelegation) => Promise<Result<string, DomainError>>) | null;
} = {}): RouteHarness {
  const calls: PublishDelegationCommand[] = [];
  const headCalls: WorkspaceDelegation[] = [];
  const records = [...(options.records ?? [delegation()])];
  const projectValue = options.project === undefined ? project() : options.project;
  const publisher: DelegationPublisher =
    options.publisher ??
    (async (command) => {
      calls.push(command);
      return ok(run());
    });
  const resolveHead =
    options.resolveHead === null
      ? undefined
      : options.resolveHead ??
        (async (record: WorkspaceDelegation) => {
          headCalls.push(record);
          return ok(HEAD_SHA);
        });
  const app = new Hono();
  installDelegationPublishRoutes(
    app,
    {
      publisher,
      delegations: { byId: async (id) => records.find((candidate) => candidate.id === id) ?? null },
      attempts: { latest: async () => options.latest ?? null },
      projects: {
        byId: async (id: ProjectId) => (id === ('p1' as ProjectId) ? projectValue : null)
      } as unknown as Pick<ProjectRepository, 'byId'>,
      access: options.access,
      resolveHead
    },
    () => (options.subject === undefined ? person : options.subject)
  );
  return { app, calls, headCalls };
}

async function post(app: Hono, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

test('POST /publish: rejects token principals and non-human sessions', async () => {
  const token = routes({ subject: tokenPerson });
  const tokenResponse = await post(token.app, '/api/workspace-delegations/d1/publish', {
    approvalKey: 'a1',
    expectedHeadSha: HEAD_SHA
  });
  assert.equal(tokenResponse.status, 403);
  assert.match(((await tokenResponse.json()) as { error: { message: string } }).error.message, /真人/);
  assert.equal(token.calls.length, 0);

  const anonymous = routes({ subject: null });
  const anonymousResponse = await post(anonymous.app, '/api/workspace-delegations/d1/publish', {
    approvalKey: 'a1',
    expectedHeadSha: HEAD_SHA
  });
  assert.equal(anonymousResponse.status, 403);
  assert.equal(anonymous.calls.length, 0);
});

test('POST /publish: strict body, exact SHA and no nested actor/token', async () => {
  const h = routes();
  const withActor = await post(h.app, '/api/workspace-delegations/d1/publish', {
    approvalKey: 'a1',
    expectedHeadSha: HEAD_SHA,
    actor: { user: { id: 'attacker' } }
  });
  assert.equal(withActor.status, 400);
  assert.equal(h.calls.length, 0);

  const upperSha = await post(h.app, '/api/workspace-delegations/d1/publish', {
    approvalKey: 'a1',
    expectedHeadSha: HEAD_SHA.toUpperCase()
  });
  assert.equal(upperSha.status, 400);

  const missingSha = await post(h.app, '/api/workspace-delegations/d1/publish', {
    approvalKey: 'a1'
  });
  assert.equal(missingSha.status, 400);

  const blankKey = await post(h.app, '/api/workspace-delegations/d1/publish', {
    approvalKey: '   ',
    expectedHeadSha: HEAD_SHA
  });
  assert.equal(blankKey.status, 400);
  assert.equal(h.calls.length, 0);
});

test('POST /publish: forwards the human subject and approval key unchanged', async () => {
  const h = routes();
  const response = await post(h.app, '/api/workspace-delegations/d1/publish', {
    approvalKey: '  approval-1  ',
    expectedHeadSha: HEAD_SHA
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(h.calls.length, 1);
  const command = h.calls[0];
  assert.ok(command);
  assert.equal(command.actor, person);
  assert.equal(command.delegationId, 'd1');
  assert.equal(command.approvalKey, '  approval-1  ');
  assert.equal(command.mode, 'publish');
  assert.equal('expectedHeadSha' in command ? command.expectedHeadSha : undefined, HEAD_SHA);

  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.delegationId, 'd1');
  assert.equal(body.attempted, true);
  assert.equal(body.replayed, false);
  assert.equal(body.reconciled, false);
});

test('POST /publish: domain errors are returned without URL credentials or stack frames', async () => {
  const h = routes({
    publisher: async () =>
      err({
        code: 'conflict',
        message: 'push failed for https://user:secret-token@github.com/acme/repo.git\n    at push (x:1:1)'
      })
  });
  const response = await post(h.app, '/api/workspace-delegations/d1/publish', {
    approvalKey: 'a1',
    expectedHeadSha: HEAD_SHA
  });
  assert.equal(response.status, 409);
  const body = (await response.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, 'conflict');
  assert.equal(body.error.message.includes('secret-token'), false);
  assert.equal(body.error.message.includes('at push'), false);
  assert.match(body.error.message, /\*\*\*/);
});

test('POST /reconcile: only accepts the approval key and asks for read-only reconciliation', async () => {
  const h = routes();
  const response = await post(h.app, '/api/workspace-delegations/d1/reconcile', { approvalKey: 'approval-1' });
  assert.equal(response.status, 200);
  assert.equal(h.calls.length, 1);
  const command = h.calls[0];
  assert.ok(command);
  assert.equal(command.mode, 'reconcile');
  assert.equal(command.approvalKey, 'approval-1');
  assert.equal('expectedHeadSha' in command, false);

  const withSha = await post(h.app, '/api/workspace-delegations/d1/reconcile', {
    approvalKey: 'approval-1',
    expectedHeadSha: HEAD_SHA
  });
  assert.equal(withSha.status, 400);
  assert.equal(h.calls.length, 1);
});

test('GET /publish: returns review state without fingerprint, claim, repo URL or credentials', async () => {
  const record = delegation({
    failure: { kind: 'fatal', message: 'Authorization: Basic c2VjcmV0\n    at inner (file:1:1)', at: 3 }
  });
  const h = routes({
    records: [record],
    latest: attempt({
      failure: {
        kind: 'uncertain',
        message: 'fetch https://user:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/acme/repo.git\n    at fetch (x:1:1)',
        at: 12
      }
    })
  });
  const response = await h.app.request('/api/workspace-delegations/d1/publish');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');

  const body = (await response.json()) as {
    repo: string;
    headSha: string | null;
    headUnavailable: string | null;
    attempt: { state: string; pullRequest: { url: string }; failure: { message: string } };
    failure: { message: string };
  };
  assert.equal(body.repo, 'acme/repo');
  assert.equal(body.attempt.state, 'published');
  assert.equal(body.attempt.pullRequest.url, PR_URL);
  assert.equal(body.headSha, null);
  assert.equal(body.headUnavailable, null);
  assert.equal(h.headCalls.length, 0);

  const text = JSON.stringify(body);
  for (const secret of ['requestFingerprint', 'approvalKey', 'repoUrl', 'worktreePath', 'accountId', 'claim', 'c2VjcmV0', 'ghp_', 'at inner', 'at fetch']) {
    assert.equal(text.includes(secret), false, secret);
  }
  assert.match(body.failure.message, /\*\*\*/);
  assert.match(body.attempt.failure.message, /\*\*\*/);
});

test('GET /publish: prepared with no attempt returns the authoritative approval SHA', async () => {
  const seen: string[] = [];
  const h = routes({
    resolveHead: async (record) => {
      seen.push(record.id);
      return ok(HEAD_SHA);
    }
  });
  const response = await h.app.request('/api/workspace-delegations/d1/publish');
  assert.equal(response.status, 200);
  const body = (await response.json()) as { headSha: string | null; headUnavailable: string | null };
  assert.equal(body.headSha, HEAD_SHA);
  assert.equal(body.headUnavailable, null);
  assert.deepEqual(seen, ['d1']);
});

test('GET /publish: after a definitively failed attempt shows the current HEAD for retry', async () => {
  const failed = attempt({
    state: 'failed',
    failure: { kind: 'fatal', message: 'push failed', at: 12 }
  });
  const h = routes({ latest: failed });
  const response = await h.app.request('/api/workspace-delegations/d1/publish');
  assert.equal(response.status, 200);
  const body = (await response.json()) as { headSha: string | null; headUnavailable: string | null };
  assert.equal(body.headSha, HEAD_SHA);
  assert.equal(body.headUnavailable, null);
  assert.equal(h.headCalls.length, 1);
});

test('GET /publish: does not read HEAD while publishing, published or uncertain', async () => {
  for (const state of ['publishing', 'published', 'uncertain'] as const) {
    const h = routes({
      latest: attempt({
        state,
        claim:
          state === 'publishing'
            ? ({ owner: 'u1', token: 'claim-1', at: 10, expiresAt: 10_000 } as unknown as PublishAttempt['claim'])
            : null,
        failure: state === 'uncertain' ? { kind: 'uncertain', message: 'unknown', at: 12 } : null
      }),
      resolveHead: async () => {
        throw new Error('must not read HEAD');
      }
    });
    const response = await h.app.request('/api/workspace-delegations/d1/publish');
    assert.equal(response.status, 200, state);
    const body = (await response.json()) as { headSha: string | null; headUnavailable: string | null };
    assert.equal(body.headSha, null, state);
    assert.equal(body.headUnavailable, null, state);
  }
});

test('GET /publish: unreadable worker gives a neutral reason, not internal identity', async () => {
  const h = routes({
    resolveHead: async () => err({ code: 'unavailable', message: 'worker w1 offline at /work/feat' })
  });
  const response = await h.app.request('/api/workspace-delegations/d1/publish');
  assert.equal(response.status, 200);
  const body = (await response.json()) as { headSha: string | null; headUnavailable: string | null };
  assert.equal(body.headSha, null);
  assert.equal(body.headUnavailable, '暂时无法读取执行工作树的当前提交');
  assert.equal(body.headUnavailable.includes('w1'), false);
  assert.equal(body.headUnavailable.includes('/work/feat'), false);
});

test('GET /publish: non-prepared record does not attempt to read HEAD', async () => {
  const h = routes({
    records: [delegation({ state: 'failed' })],
    resolveHead: async () => {
      throw new Error('must not read HEAD');
    }
  });
  const response = await h.app.request('/api/workspace-delegations/d1/publish');
  assert.equal(response.status, 200);
  const body = (await response.json()) as { headSha: string | null; headUnavailable: string | null };
  assert.equal(body.headSha, null);
  assert.equal(body.headUnavailable, null);
});

test('GET /publish: missing head resolver returns null + neutral reason', async () => {
  const h = routes({ resolveHead: null });
  const response = await h.app.request('/api/workspace-delegations/d1/publish');
  assert.equal(response.status, 200);
  const body = (await response.json()) as { headSha: string | null; headUnavailable: string | null };
  assert.equal(body.headSha, null);
  assert.equal(body.headUnavailable, '暂时无法读取执行工作树的当前提交');
});

test('GET /publish: requires login and a visible project', async () => {
  const anonymous = routes({ subject: null });
  const anonymousResponse = await anonymous.app.request('/api/workspace-delegations/d1/publish');
  assert.equal(anonymousResponse.status, 403);

  const missing = routes({ project: null });
  const missingResponse = await missing.app.request('/api/workspace-delegations/d1/publish');
  assert.equal(missingResponse.status, 404);
});

test('view: missing attempt is null and never exposes internal record fields', () => {
  const view = delegationPublishView(delegation(), null);
  assert.equal(view.attempt, null);
  const text = JSON.stringify(view);
  for (const secret of ['requestFingerprint', 'requestKey', 'instructions', 'claim', 'accountId', 'coordinatorSessionId', 'repoUrl', 'worktreePath']) {
    assert.equal(text.includes(secret), false, secret);
  }
});
