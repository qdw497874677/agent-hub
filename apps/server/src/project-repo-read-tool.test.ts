import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROJECT_REPO_READ_TOOL_SCOPE, asAgentId, asProjectId, asSessionId, asTaskId, asWorkspaceId,
  err, forbidden, newWorkspace, ok,
  type Deps, type DomainError, type Project, type ProjectRepo, type ProjectSessionGrant,
  type ProjectSessionGrantRepository, type Result, type Session, type ToolGrant, type Workspace
} from '@agent-hub/domain';
import { createProjectSessionGrantService } from './project-session-grant.ts';
import { createProjectRepoReadTool, PROJECT_REPO_READ_TOOL } from './project-repo-read-tool.ts';
import type { HubCredentialBroker } from './hub-credential-broker.ts';
import type { ProjectGitSnapshotOutcome } from './project-git-fetch.ts';

const projectId = asProjectId('project-1');
const sessionId = asSessionId('session-1');
const taskId = asTaskId('task-1');
const sha = 'a'.repeat(40);
const repos: ProjectRepo[] = [
  { id: 'api', name: 'api', url: 'https://git.example/api.git', defaultBranch: 'main', tokenSecret: 'private-handle' },
  { id: 'web', name: 'web', url: 'https://git.example/web.git', defaultBranch: 'main' }
];

function failure(result: Result<unknown, DomainError>): DomainError {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('expected failure');
  return result.error;
}

function workspace(overrides: Parameters<typeof newWorkspace>[0]): Workspace {
  const result = newWorkspace(overrides);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function world() {
  let project: Project = { id: projectId, name: 'test', repo: null, repos: [repos[0]!], description: null,
    createdAt: 1, teamId: 'team', createdBy: 'user', members: [], worktree: null, checks: [], assetSetIds: [], deletedAt: null };
  let session: Session = { id: sessionId, taskId: null, originProjectId: projectId, agentId: asAgentId('agent'), model: 'test',
    origin: { kind: 'derive' }, status: 'running', lastSeq: 0, turn: 0, agentSessionRef: null, options: {}, optionSpec: [],
    workerId: 'worker', workspaceId: null, createdBy: 'user', mcpDisabled: [], createdAt: 1, updatedAt: 1 };
  let row: ProjectSessionGrant | null = { id: 'grant', accountId: 'user', sessionId, projectId, scopes: ['repo:read'],
    createdBy: 'user', createdAt: 1, expiresAt: null, revokedAt: null, revokedBy: null };
  let active = true;
  let allowed = true;
  let permission = true;
  let child = false;
  let feature = true;
  let toolGrantActive = true;
  const workspaces = new Map<string, Workspace>();
  const linked = new Set<string>();
  let localPlannedOutput: string | null = null;
  const grantRepo: ProjectSessionGrantRepository = {
    save: async (grant) => (row = grant),
    byKey: async (account, sid, pid) => row && row.accountId === account && row.sessionId === sid && row.projectId === pid ? row : null,
    byId: async (id) => row?.id === id ? row : null,
    listBySession: async () => row ? [row] : [], listByAccount: async () => row ? [row] : [],
    revoke: async () => false, revokeSession: async () => 0
  };
  const grants = createProjectSessionGrantService({
    now: () => 100, projectSessionGrants: grantRepo,
    sessions: { byId: async (id) => id === sessionId ? session : null }, tasks: { byId: async () => null },
    workspaceDelegations: { byExecutionSession: async () => child ? { id: 'child' } as never : null },
    loadActor: async (userId) => active ? { userId, via: 'web' } : null,
    sourceEligible: () => allowed, checkCurrentPermission: async () => permission ? ok(undefined) : err(forbidden('denied')),
    invalidateSessionTools: () => {}
  });
  const deps = {
    projects: { byId: async (id: string) => id === projectId ? project : null },
    sessions: { byId: async (id: string) => id === sessionId ? session : null },
    workspaces: { byId: async (id: string) => workspaces.get(id) ?? null,
      linksOf: async (id: string) => linked.has(id) ? [{ projectId, workspaceId: asWorkspaceId(id), linkedBy: 'user', linkedAt: 1 }] : [] },
    workspaceGroups: { byId: async () => null },
    plannedWorktreeGuard: { forOutput: (id: string) => id === localPlannedOutput ? { source: 'local', state: 'closed', groupId: null } : null }
  } as unknown as Pick<Deps, 'projects' | 'sessions' | 'workspaces' | 'workspaceGroups'>;
  const calls: Parameters<HubCredentialBroker['readRepo']>[0][] = [];
  let outcome: ProjectGitSnapshotOutcome = { ok: true, result: { branch: 'main', tip: sha, path: 'README.md', kind: 'text', content: 'hello' } };
  let beforeCheck: () => void = () => {};
  let betweenChecks: () => void = () => {};
  const checks: boolean[] = [];
  const broker: Pick<HubCredentialBroker, 'readRepo'> = { readRepo: async (input) => {
    calls.push(input);
    beforeCheck();
    checks.push(await input.reauthorize());
    if (!checks.at(-1)) return { ok: false, code: 'blocked', message: 'private upstream details' };
    betweenChecks();
    checks.push(await input.reauthorize());
    return checks.at(-1) ? outcome : { ok: false, code: 'blocked', message: 'private upstream details' };
  } };
  const provider = createProjectRepoReadTool({ deps, grants, broker, now: () => 1234, allowsProject: () => feature,
    toolGrantStillActive: async () => toolGrantActive });
  const toolGrant: ToolGrant = { id: 'tool-grant', tokenHash: 'hash', taskId: null, sessionId, workerId: 'worker',
    scopes: [PROJECT_REPO_READ_TOOL_SCOPE], createdAt: 1, expiresAt: 1000, revokedAt: null, actor: { userId: 'user', via: 'web' } };
  return {
    provider, calls, checks, workspaces, linked,
    call: (args: unknown = {}, grant: ToolGrant = toolGrant) => provider.call(PROJECT_REPO_READ_TOOL, args, { grant, now: 100 }),
    grant: toolGrant,
    setProject: (p: Partial<Project>) => { project = { ...project, ...p }; },
    setSession: (s: Partial<Session>) => { session = { ...session, ...s }; },
    setRow: (r: Partial<ProjectSessionGrant> | null) => { row = r === null ? null : { ...row!, ...r }; },
    setActive: (v: boolean) => { active = v; }, setAllowed: (v: boolean) => { allowed = v; },
    setPermission: (v: boolean) => { permission = v; }, setChild: (v: boolean) => { child = v; },
    setFeature: (v: boolean) => { feature = v; }, setOutcome: (v: ProjectGitSnapshotOutcome) => { outcome = v; },
    setToolGrantActive: (v: boolean) => { toolGrantActive = v; },
    setLocalPlannedOutput: (id: string) => { localPlannedOutput = id; },
    before: (f: () => void) => { beforeCheck = f; }, between: (f: () => void) => { betweenChecks = f; }
  };
}

test('local planned output requires explicit project repo selection even with one registered repo', async () => {
  const w = world();
  w.setSession({ workspaceId: asWorkspaceId('local-output') });
  w.setLocalPlannedOutput('local-output');
  assert.equal(failure(await w.call()).code, 'invalid');
  assert.equal(w.calls.length, 0);
  assert.equal((await w.call({ repo_id: 'api' })).ok, true);
  assert.equal(w.calls[0]?.repoId, 'api');
});

test('authorized snapshot exposes only safe DTO and delegates no local mutation', async () => {
  const w = world();
  const spec = w.provider.tools()[0]!;
  assert.equal(spec.name, PROJECT_REPO_READ_TOOL);
  assert.equal(spec.scope, PROJECT_REPO_READ_TOOL_SCOPE);
  assert.equal(spec.omitAuditPayload, true);
  const result = await w.call({ branch: 'main', path: 'README.md', expected_tip: sha });
  assert.deepEqual(result, ok({ repo: { id: 'api', name: 'api' }, source: 'remote_snapshot', branch: 'main', tip: sha,
    readAt: 1234, path: 'README.md', localFilesUpdated: false, kind: 'text', content: 'hello' }));
  assert.deepEqual(w.checks, [true, true]);
  const { reauthorize, ...request } = w.calls[0]!;
  assert.equal(typeof reauthorize, 'function');
  assert.deepEqual(request, { projectId, repoId: 'api', branch: 'main', path: 'README.md', expectedTip: sha,
    auditContext: { actorId: 'user', sessionId } });
  assert.equal(JSON.stringify(result).includes('private-handle'), false);
  assert.equal(JSON.stringify(result).includes('git.example'), false);
  assert.equal(w.workspaces.size, 0);
});

test('no repo, ambiguous repo and explicit selection remain inside current project', async () => {
  const w = world();
  w.setProject({ repos: [] });
  assert.equal(failure(await w.call()).code, 'not_found');
  w.setProject({ repos });
  const ambiguous = failure(await w.call());
  assert.equal(ambiguous.code, 'invalid');
  assert.match(ambiguous.message, /api.*web/);
  assert.equal(failure(await w.call({ repo_id: 'outside' })).code, 'not_found');
  assert.equal(w.calls.length, 0);
  assert.equal((await w.call({ repo_id: 'web' })).ok, true);
  assert.equal(w.calls[0]?.repoId, 'web');
});

test('duplicate repo IDs fail closed; an independently revoked tool credential cannot deliver a snapshot', async () => {
  const w = world();
  w.setProject({ repos: [repos[0]!, { ...repos[1]!, id: repos[0]!.id }] });
  assert.equal(failure(await w.call({ repo_id: repos[0]!.id })).code, 'conflict');
  assert.equal(w.calls.length, 0);
  w.setProject({ repos: [repos[0]!] });
  w.between(() => w.setToolGrantActive(false));
  assert.equal((await w.call()).ok, false);
  assert.deepEqual(w.checks, [true, false]);
  assert.equal(failure(await w.call()).code, 'forbidden');
  assert.equal(w.calls.length, 1);
});

test('reject foreign authority and unsafe or malformed parameters before broker', async () => {
  const w = world();
  for (const key of ['projectId', 'project_id', 'url', 'credentials', 'token', 'worker', 'workerId']) {
    assert.equal(failure(await w.call({ [key]: 'fake' })).code, 'invalid', key);
  }
  for (const args of [{ path: '../secret' }, { expected_tip: 'abc' }, { branch: 4 }]) {
    assert.equal(failure(await w.call(args)).code, 'invalid');
  }
  assert.equal(w.calls.length, 0);
});

test('registered workspace provenance and worktree base link prove implicit selection', async () => {
  const w = world();
  w.setProject({ repos });
  const baseId = asWorkspaceId('base');
  const childId = asWorkspaceId('worktree');
  const base = workspace({ id: baseId, projectId, workerId: 'worker', path: '/base', kind: 'long_lived', source: 'cloned', repoUrl: repos[1]!.url, now: 1 });
  const child = workspace({ id: childId, projectId, workerId: 'worker', path: '/worktree', kind: 'temporary', source: 'worktree', ownerTaskId: taskId, baseWorkspaceId: baseId, now: 1 });
  w.workspaces.set(baseId, base); w.workspaces.set(childId, child);
  w.setSession({ workspaceId: childId });
  assert.equal(failure(await w.call()).code, 'invalid', 'historical projectId alone is not a link');
  w.linked.add(baseId);
  assert.equal((await w.call()).ok, true);
  assert.equal(w.calls[0]?.repoId, 'web');
  w.workspaces.set(baseId, { ...base, workerId: 'other' });
  assert.equal(failure(await w.call()).code, 'invalid');
  assert.equal(w.calls.length, 1);
});

test('actual grant service enforces the initial authorization boundary', async () => {
  for (const deny of [
    (w: ReturnType<typeof world>) => w.setRow(null),
    (w: ReturnType<typeof world>) => w.setRow({ scopes: ['project:read'] }),
    (w: ReturnType<typeof world>) => w.setRow({ revokedAt: 10 }),
    (w: ReturnType<typeof world>) => w.setActive(false),
    (w: ReturnType<typeof world>) => w.setAllowed(false),
    (w: ReturnType<typeof world>) => w.setPermission(false),
    (w: ReturnType<typeof world>) => w.setChild(true),
    (w: ReturnType<typeof world>) => w.setFeature(false),
    (w: ReturnType<typeof world>) => w.setSession({ originProjectId: asProjectId('other') })
  ]) {
    const w = world(); deny(w);
    assert.equal(failure(await w.call()).code, 'forbidden');
    assert.equal(w.calls.length, 0);
  }
  const w = world();
  for (const grant of [{ ...w.grant, scopes: ['project:read'] as const }, { ...w.grant, actor: { userId: 'user', via: 'bot' as const } }]) {
    assert.equal(failure(await w.call({}, grant)).code, 'forbidden');
  }
  assert.equal(w.calls.length, 0);
});

test('broker callback rechecks current grant and selected repo before delivery', async () => {
  const changes = [
    (w: ReturnType<typeof world>) => w.setRow({ revokedAt: 10 }),
    (w: ReturnType<typeof world>) => w.setRow({ id: 'replacement' }),
    (w: ReturnType<typeof world>) => w.setRow({ createdAt: 2 }),
    (w: ReturnType<typeof world>) => w.setPermission(false),
    (w: ReturnType<typeof world>) => w.setProject({ repos: [{ ...repos[0]!, url: 'https://git.example/changed.git' }] }),
    (w: ReturnType<typeof world>) => w.setProject({ repos: [{ ...repos[0]!, defaultBranch: 'other' }] }),
    (w: ReturnType<typeof world>) => w.setProject({ deletedAt: 10 })
  ];
  for (const phase of ['before', 'between'] as const) {
    for (const change of changes) {
      const w = world(); w[phase](() => change(w));
      const result = await w.call();
      assert.deepEqual(w.checks, phase === 'before' ? [false] : [true, false]);
      assert.equal(failure(result).code, 'unavailable');
      assert.equal(JSON.stringify(result).includes('hello'), false);
    }
  }
});

test('broker errors are normalized without leaking upstream diagnostics', async () => {
  const w = world();
  for (const code of ['bad_authorization', 'upstream', 'timeout', 'blocked', 'generic'] as const) {
    w.setOutcome({ ok: false, code, message: 'sensitive upstream details' });
    const error = failure(await w.call());
    assert.equal(error.code, 'unavailable');
    assert.equal(error.message.includes('sensitive'), false);
  }
  w.setOutcome({ ok: false, code: 'tip_mismatch', message: 'sensitive' });
  assert.equal(failure(await w.call()).code, 'conflict');
});
