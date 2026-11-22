import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import {
  asAgentId,
  asLoginId,
  asSessionId,
  asTeamId,
  asUserId,
  createProjectUseCase,
  createTask,
  createToolGateway,
  ok,
  proposeWorkspaceDelegationUseCase,
  WORKSPACE_DELEGATE_SCOPE,
  type AccessPolicy,
  type AgentDescriptor,
  type GitHostApi,
  type Principal,
  type RemotePullRequest,
  type Role,
  type Subject,
  type WorkspaceGit
} from '@agent-hub/domain';
import { fakeSessionLinks, inMemoryDeliveries, inMemoryDeps } from '@agent-hub/domain/testing';
import { createTokenIssuer } from '@agent-hub/adapter-accounts';
import { createGitWorkspace } from '@agent-hub/node-gateway';
import {
  createSqliteDelegationPublishAttempts,
  createSqliteWorkspaceCoordinators,
  createSqliteWorkspaceDelegations,
  openSqliteStore
} from '@agent-hub/storage-sqlite';
import { installCoordinatorRoutes } from './workspace-coordinator.ts';
import {
  createWorkspaceDelegationBridges,
  installDelegationRoutes,
  type DelegationDeps
} from './workspace-delegation.ts';
import {
  createWorkspaceDelegateScopeResolverFromDelegation,
  createWorkspaceDelegationToolProvider
} from './workspace-delegation-tool.ts';
import {
  createDelegationHeadResolver,
  createDelegationPublisher,
  installDelegationPublishRoutes,
  type DelegationPublishDeps
} from './workspace-delegation-publish.ts';

/**
 * 端到端（本地、真 Git）集成：工具提案 / HTTP 派工 → 真人确认 → node-gateway 真 worktree
 * → 人工批准 → publishRef 推到本地 bare origin → 模拟 GitHub host 建草稿 PR。
 *
 * 生产桥要求 HTTPS 项目地址且 domain 只认 github.com 仓库，而真 Git 需要一个本地
 * origin，所以这里用「注入的传输边界」：只把 expectedUrl 换成 bare 路径、把 preview
 * 读到的本地 origin 换回 HTTPS；prepare/publish 仍是 node-gateway 的真实实现。
 * 生产代码、策略开关、URL 校验一概不动，也不写仓库外的地方。
 */
const ORIGIN = 'https://github.com/acme/app.git';
const REPO = 'acme/app';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function commit(cwd: string, message: string): string {
  git(cwd, ['add', '-A']);
  git(cwd, ['-c', 'user.name=Integration', '-c', 'user.email=integration@example.com', 'commit', '-q', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

function headRefs(bare: string): string[] {
  return execFileSync('git', ['-C', bare, 'for-each-ref', '--format=%(refname)', 'refs/heads'], {
    encoding: 'utf8'
  })
    .split('\n')
    .filter(Boolean);
}

function snapshot(path: string) {
  return {
    branch: git(path, ['rev-parse', '--abbrev-ref', 'HEAD']),
    head: git(path, ['rev-parse', 'HEAD']),
    status: git(path, ['status', '--porcelain']),
    index: git(path, ['ls-files', '-s'])
  };
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-hub-delegation-')));
  const bare = join(root, 'origin.git');
  const source = join(root, 'source');

  execFileSync('git', ['init', '-q', '-b', 'main', source]);
  writeFileSync(join(source, 'README.md'), '# app\n');
  writeFileSync(join(source, 'app.txt'), 'v1\n');
  const initial = commit(source, 'initial');

  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  git(source, ['remote', 'add', 'origin', bare]);
  git(source, ['push', '-q', '-u', 'origin', 'main']);

  // 主工作区保持「已跟踪文件有改动 + 未跟踪文件」，用来证明派工不会碰源工作区。
  writeFileSync(join(source, 'README.md'), '# app\n\nlocal edit\n');
  writeFileSync(join(source, 'scratch.txt'), 'scratch\n');

  return { root, bare, source, initial };
}

function bridgedGit(bare: string): WorkspaceGit {
  const real = createGitWorkspace(undefined, { allowLocalPublishOrigin: true });
  const prepare = real.prepareDelegationWorktree;
  const publish = real.publishRef;
  if (!prepare || !publish) throw new Error('node-gateway 缺少真 Git 的派工实现');

  return {
    ...real,
    async preview(path, maxPatchBytes, options) {
      const result = await real.preview(path, maxPatchBytes, options);
      if (!result.ok) return result;
      if (result.value.remoteUrl === null || result.value.remoteUrl.trim() !== bare) return result;
      return ok({ ...result.value, remoteUrl: ORIGIN });
    },
    async prepareDelegationWorktree(input) {
      return prepare({ ...input, expectedUrl: bare });
    },
    async publishRef(input) {
      return publish({ ...input, expectedUrl: bare });
    }
  };
}

function fakeHost(bare: string) {
  const prs: RemotePullRequest[] = [];
  let next = 1;
  const api: GitHostApi = {
    async listPullRequestsByHead(input) {
      return {
        ok: true,
        prs: prs.filter((pr) => pr.state === 'open' && pr.repo === input.repo && pr.headRef === input.head)
      } as const;
    },
    async createPullRequest(input) {
      const number = next++;
      const pr: RemotePullRequest = {
        number,
        url: `https://github.com/${input.repo}/pull/${number}`,
        state: 'open',
        headSha: git(bare, ['rev-parse', `refs/heads/${input.head}`]),
        mergedAt: null,
        base: input.base,
        repo: input.repo,
        headRef: input.head,
        draft: input.draft === true,
        baseRepo: input.repo
      };
      prs.push(pr);
      return { ok: true, pr } as const;
    },
    async getPullRequest(input) {
      const pr = prs.find((candidate) => candidate.number === input.number);
      return pr ? ({ ok: true, pr } as const) : ({ ok: false, reason: 'not found' } as const);
    }
  };
  return { api, prs };
}

const fakeAgent: AgentDescriptor = {
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

interface DelegationView {
  id: string;
  worktreePath: string;
  branch: string;
  baseSha: string | null;
  state: string;
  executionSessionId: string;
}

interface PublishView {
  headSha?: string | null;
  headUnavailable?: string | null;
  attempted?: boolean;
  replayed?: boolean;
  reconciled?: boolean;
  attempt?: {
    state: string;
    headSha?: string | null;
    pullRequest?: RemotePullRequest | null;
  } | null;
  error?: { code: string; message: string };
}

async function world(fx: ReturnType<typeof fixture>) {
  const w = inMemoryDeps();
  w.agents.push(fakeAgent);

  const owner = person('owner', 't1', 'u-owner');
  const access = policy();
  const base = { ...w.deps, access };

  const created = await createProjectUseCase(base, {
    name: 'hub',
    rootPath: fx.source,
    actor: owner,
    repoUrl: ORIGIN,
    defaultBranch: 'main'
  });
  assert.ok(created.ok, created.ok ? '' : created.error.message);
  const project = created.value;

  const [workspace] = await w.deps.workspaces.byProject(project.id);
  assert.ok(workspace);
  // createProjectUseCase 关联目录时不写 repoUrl / isGit；派工的主仓库校验需要这两个字段。
  const saved = await w.deps.workspaces.save({ ...workspace, repoUrl: ORIGIN, isGit: true });
  assert.equal(saved.status, 'saved');
  const coordinatorWorkspace = saved.status === 'saved' ? saved.workspace : workspace;

  const task = createTask({ projectId: project.id, title: '委派发布集成', now: 20 });
  assert.ok(task.ok);
  await w.deps.tasks.save(task.value);

  const gitImpl = bridgedGit(fx.bare);
  const links = fakeSessionLinks();
  const deliveries = inMemoryDeliveries();
  const deps: DelegationDeps = { ...base, git: gitImpl, links, deliveries };

  const coordinators = createSqliteWorkspaceCoordinators(new DatabaseSync(':memory:'));
  const delegations = createSqliteWorkspaceDelegations(new DatabaseSync(':memory:'));
  const attempts = createSqliteDelegationPublishAttempts(new DatabaseSync(':memory:'));
  const host = fakeHost(fx.bare);

  const publishDeps: DelegationPublishDeps = {
    sessions: deps.sessions,
    workspaces: deps.workspaces,
    gateway: deps.gateway,
    git: gitImpl,
    projects: deps.projects,
    tasks: deps.tasks,
    secrets: deps.secrets,
    access,
    now: deps.now,
    gitHost: host.api,
    gitHostTokens: { reveal: async (teamId) => (teamId === 't1' ? 'ghs_integration_token' : null) }
  };
  const publisher = createDelegationPublisher(publishDeps, delegations, attempts);
  const resolveHead = createDelegationHeadResolver(publishDeps);

  // 工具车道用真实的 provider + 网关 + SQLite 授权表；测试只在签发授权时冻结真人 actor，
  // 与运行时 `withToolAccess` 的做法一致，并没有给生产代码开旁路。
  const toolStore = openSqliteStore(join(fx.root, 'hub.sqlite'));
  const loadActor = async (userId: string): Promise<Principal | null> =>
    userId === owner.user.id ? owner : null;
  const toolProvider = createWorkspaceDelegationToolProvider({
    sessions: deps.sessions,
    bridgesFor: (input) => createWorkspaceDelegationBridges(deps, coordinators, input),
    propose: (command, bridges) => proposeWorkspaceDelegationUseCase(base, delegations, bridges, command),
    loadActor
  });
  const toolGateway = createToolGateway({
    now: deps.now,
    toolGrants: toolStore.toolGrants,
    tokens: createTokenIssuer(),
    providers: [toolProvider]
  });
  const scopeResolver = createWorkspaceDelegateScopeResolverFromDelegation({
    delegationDeps: deps,
    coordinators,
    loadActor
  });

  let subject: Subject | null = owner;
  const app = new Hono();
  installCoordinatorRoutes(app, { deps: base, coordinators }, () => subject);
  installDelegationRoutes(app, { deps, delegations, coordinators }, () => subject);
  installDelegationPublishRoutes(
    app,
    { publisher, delegations, attempts, projects: deps.projects, access, resolveHead },
    () => subject
  );

  const opened = await app.request('/api/coordinators', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: project.id, workspaceId: coordinatorWorkspace.id, agentId: 'fake' })
  });
  assert.equal(opened.status, 201);
  const openedBody = (await opened.json()) as { session: { id: string } };
  const coordinatorSession = await deps.sessions.byId(asSessionId(openedBody.session.id));
  assert.ok(coordinatorSession);

  return {
    app,
    deps,
    owner,
    project,
    task: task.value,
    coordinatorSession,
    coordinatorSessionId: openedBody.session.id,
    host,
    toolGateway,
    scopeResolver,
    setSubject: (next: Subject | null) => {
      subject = next;
    }
  };
}

test('server delegation + publish bridge: tool proposal, real worktrees, draft PR, SHA drift and replay', async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  const w = await world(fx);

  const before = snapshot(fx.source);
  assert.equal(before.branch, 'main');
  assert.equal(before.head, fx.initial);
  assert.match(before.status, /^M README\.md$/m);
  assert.match(before.status, /^\?\? scratch\.txt$/m);

  const delegate = async (requestKey: string): Promise<DelegationView> => {
    const response = await w.app.request(`/api/coordinators/${w.coordinatorSessionId}/delegations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestKey,
        taskId: w.task.id,
        repoId: w.project.repos[0]!.id,
        baseBranch: 'main',
        instructions: '实现一个可独立审阅的改动。',
        agentId: 'fake',
        model: 'm1'
      })
    });
    assert.equal(response.status, 201);
    const payload = (await response.json()) as { delegation: DelegationView };
    assert.equal(payload.delegation.state, 'prepared');
    return payload.delegation;
  };

  const publish = async (delegationId: string, approvalKey: string, expectedHeadSha: string) => {
    const response = await w.app.request(`/api/workspace-delegations/${delegationId}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approvalKey, expectedHeadSha })
    });
    return { response, body: (await response.json()) as PublishView };
  };

  // 车道一：走真实的 workspace.delegate 工具 provider。
  // scope 由与运行时相同的 resolver 从主会话归属推导；授权由真实 createToolGateway 写进
  // 真实 SQLite ToolGrantRepository，调用身份取自授权快照里的真人 actor。
  const scopes = await w.scopeResolver({
    session: w.coordinatorSession,
    actor: { userId: w.owner.user.id, via: 'web' }
  });
  assert.deepEqual(scopes, [WORKSPACE_DELEGATE_SCOPE]);
  const issued = await w.toolGateway.issue(w.coordinatorSession, scopes, {
    userId: w.owner.user.id,
    via: 'web'
  });
  assert.deepEqual(
    w.toolGateway.list(issued.grant).map((tool) => tool.name),
    ['workspace.delegate']
  );

  const proposed = await w.toolGateway.call(issued.grant, 'workspace.delegate', {
    request_key: 'req-a',
    task_id: w.task.id,
    repo_id: w.project.repos[0]!.id,
    base_branch: 'main',
    instructions: '实现一个可独立审阅的改动。',
    agent_id: 'fake'
  });
  assert.ok(proposed.ok, proposed.ok ? '' : proposed.error.message);
  const proposal = proposed.value as {
    created: boolean;
    allocation: string;
    delegation: DelegationView;
  };
  assert.equal(proposal.created, true);
  assert.equal(proposal.allocation, 'created');
  assert.equal(proposal.delegation.state, 'pending');

  // 真人确认之前：只登记了 pending，没有执行会话、第二个 workspace、worktree 或分支。
  assert.equal(await w.deps.sessions.byId(asSessionId(proposal.delegation.executionSessionId)), null);
  assert.equal((await w.deps.workspaces.byProject(w.project.id)).length, 1);
  assert.equal(existsSync(proposal.delegation.worktreePath), false);
  assert.equal(git(fx.source, ['branch', '--list', 'delegation/*']), '');
  assert.deepEqual(
    headRefs(fx.bare).filter((ref) => ref.startsWith('refs/heads/delegation/')),
    []
  );
  assert.equal(
    git(fx.source, ['worktree', 'list', '--porcelain'])
      .split('\n')
      .filter((line) => line.startsWith('worktree ')).length,
    1
  );

  // 真人的 HTTP 确认使用工具返回的那条提案 id；副作用只在这一步发生。
  const confirmed = await w.app.request(
    `/api/coordinators/${w.coordinatorSessionId}/delegations/${proposal.delegation.id}/confirm`,
    { method: 'POST' }
  );
  assert.equal(confirmed.status, 200);
  const confirmedBody = (await confirmed.json()) as { delegation: DelegationView };
  const a = confirmedBody.delegation;
  assert.equal(a.state, 'prepared');
  assert.equal(a.baseSha, fx.initial);
  assert.equal(existsSync(a.worktreePath), true);
  assert.equal((await w.deps.workspaces.byProject(w.project.id)).length, 2);
  assert.ok(await w.deps.sessions.byId(asSessionId(a.executionSessionId)));

  // 车道二：保留一次直接由 HTTP 真人派工作为对照（同一套真实 Git 桥）。
  const b = await delegate('req-b');

  // 两个独立 worktree：不同路径、分支，同一个 base，但都不是主工作区。
  assert.notEqual(a.worktreePath, b.worktreePath);
  assert.notEqual(a.branch, b.branch);
  assert.match(a.branch, /^delegation\/[0-9a-f]{24}$/);
  assert.match(b.branch, /^delegation\/[0-9a-f]{24}$/);
  assert.equal(a.baseSha, fx.initial);
  assert.equal(b.baseSha, fx.initial);
  for (const item of [a, b]) {
    assert.equal(git(item.worktreePath, ['rev-parse', 'HEAD']), fx.initial);
    assert.equal(git(item.worktreePath, ['branch', '--show-current']), item.branch);
    assert.equal(git(item.worktreePath, ['status', '--porcelain']), '');
  }

  // 只在 A 里提交；B 的 HEAD 和状态不受影响。
  writeFileSync(join(a.worktreePath, 'feature-a.txt'), 'feature a\n');
  const shaA = commit(a.worktreePath, 'feature a');
  assert.notEqual(shaA, fx.initial);
  assert.equal(git(b.worktreePath, ['rev-parse', 'HEAD']), fx.initial);
  assert.equal(git(b.worktreePath, ['status', '--porcelain']), '');

  // B 连续两次提交，让「批准的 SHA」落后于当前 HEAD。
  writeFileSync(join(b.worktreePath, 'feature-b.txt'), 'b1\n');
  const shaB1 = commit(b.worktreePath, 'feature b1');
  writeFileSync(join(b.worktreePath, 'feature-b2.txt'), 'b2\n');
  const shaB2 = commit(b.worktreePath, 'feature b2');
  assert.notEqual(shaB1, shaB2);

  // GET 通过真实的 preview / HEAD 解析给出可批准的确切提交（本地 origin 被映射回 HTTPS）。
  const headResponse = await w.app.request(`/api/workspace-delegations/${a.id}/publish`);
  assert.equal(headResponse.status, 200);
  const head = (await headResponse.json()) as PublishView;
  assert.equal(head.headSha, shaA);
  assert.equal(head.headUnavailable, null);

  // 人工批准 shaA：真实 publishRef 推到本地 bare origin，模拟 host 建草稿 PR。
  const first = await publish(a.id, 'approval-a', shaA);
  assert.equal(first.response.status, 200);
  assert.equal(first.body.attempted, true);
  assert.equal(first.body.replayed, false);
  assert.equal(first.body.reconciled, false);
  assert.equal(first.body.attempt?.state, 'published');
  const pr = first.body.attempt?.pullRequest;
  assert.ok(pr);
  assert.equal(pr.number, 1);
  assert.equal(pr.state, 'open');
  assert.equal(pr.draft, true);
  assert.equal(pr.headSha, shaA);
  assert.equal(pr.headRef, a.branch);
  assert.equal(pr.base, 'main');
  assert.equal(pr.repo, REPO);
  assert.equal(pr.baseRepo, REPO);
  assert.equal(pr.url, `https://github.com/${REPO}/pull/1`);
  assert.equal(w.host.prs.length, 1);
  assert.equal(git(fx.bare, ['rev-parse', `refs/heads/${a.branch}`]), shaA);

  // 同一个批准键重放：不 push、不建第二个 PR。
  const replay = await publish(a.id, 'approval-a', shaA);
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.attempted, false);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.attempt?.pullRequest?.number, 1);
  assert.equal(w.host.prs.length, 1);

  // 换一个批准键但仍是同一个 SHA：派工已发布，拒绝第二条记录，也不会再建一个 PR。
  const secondKey = await publish(a.id, 'approval-a-2', shaA);
  assert.equal(secondKey.response.status, 409);
  assert.match(secondKey.body.error?.message ?? '', /已经发布过 PR/);
  assert.equal(w.host.prs.length, 1);

  // 批准的 SHA 已经不是 worktree HEAD：任何远端写之前就拒绝。
  const drift = await publish(b.id, 'approval-b', shaB1);
  assert.equal(drift.response.status, 409);
  assert.match(drift.body.error?.message ?? '', /HEAD 已经不是批准的提交/);
  assert.equal(w.host.prs.length, 1);
  assert.deepEqual(
    headRefs(fx.bare).filter((ref) => ref === `refs/heads/${b.branch}`),
    [],
    'B 的分支不能被推送'
  );

  // 主工作区的分支 / HEAD / 已跟踪改动 / 未跟踪文件 / index 都保持原样。
  assert.deepEqual(snapshot(fx.source), before);
  assert.equal(readFileSync(join(fx.source, 'README.md'), 'utf8'), '# app\n\nlocal edit\n');
  assert.equal(git(fx.source, ['rev-parse', 'refs/heads/main']), fx.initial);
});
