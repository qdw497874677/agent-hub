import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AccessPolicy } from './authorization.ts';
import type { Subject } from '../access.ts';
import type { Principal } from '../account.ts';
import { asLoginId, asTeamId, asUserId, type User } from '../account.ts';
import { conflict, type DomainError } from '../errors.ts';
import { asProjectId, asSessionId, asTaskId } from '../ids.ts';
import type { GitHostApi } from '../ports/pull-requests.ts';
import type { PublishRefInput, PublishRefOutcome, RemotePullRequest, WorkspaceGit } from '../ports/workspace-git.ts';
import { createProject, normalizeRepos, type Project } from '../project.ts';
import { err, ok, type Result } from '../result.ts';
import { createTask, type Task } from '../task.ts';
import { inMemoryDeps } from '../testing/in-memory.ts';
import type { WorkspaceDelegation } from '../workspace-delegation.ts';
import {
  publishWorkspaceDelegationUseCase,
  type DelegationPublishStore,
  type PublishAttempt,
  type PublishAttemptCasInput,
  type PublishAttemptCasResult,
  type PublishAttemptInsert,
  type PublishAttemptInsertResult,
  type PublishDelegationCommand,
  type WorkspaceDelegationPublishBridges
} from './workspace-delegation-publish.ts';

const REPO = 'acme/app';
const REPO_URL = `https://github.com/${REPO}.git`;
const BASE = 'main';
const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const BRANCH = 'feat/settings-split';
const APPROVAL = 'approval-1';
const OTHER_APPROVAL = 'approval-2';

const user: User = {
  id: asUserId('user_human'),
  email: 'human@example.com',
  displayName: 'Human',
  role: 'member',
  passwordHash: null,
  emailVerifiedAt: 1,
  disabledAt: null,
  createdAt: 1,
  teamId: asTeamId('team_a'),
  clusterAdmin: false,
  deletedAt: null
};

const actor: Principal = { user, loginId: asLoginId('login_human') };

/* ───────────────────────── 假端口 ───────────────────────── */

interface FakeStore extends DelegationPublishStore {
  readonly rows: Map<string, PublishAttempt>;
  seed(attempt: PublishAttempt): void;
}

const keyOf = (delegationId: string, approvalKey: string): string => `${delegationId}\u0000${approvalKey}`;

/** storage 语义：同派工只要有**别的**批准键没失败，插入 / 领取就被挡住。 */
function blockerOf(rows: Map<string, PublishAttempt>, delegationId: string, approvalKey: string): PublishAttempt | null {
  for (const row of rows.values()) {
    if (row.delegationId !== delegationId || row.approvalKey === approvalKey) continue;
    if (row.state !== 'failed') return row;
  }
  return null;
}

function createFakeStore(): FakeStore {
  const rows = new Map<string, PublishAttempt>();
  const get = (delegationId: string, approvalKey: string): PublishAttempt | null =>
    rows.get(keyOf(delegationId, approvalKey)) ?? null;
  return {
    rows,
    seed(attempt) {
      rows.set(keyOf(attempt.delegationId, attempt.approvalKey), attempt);
    },
    async byKey(delegationId, approvalKey) {
      return get(delegationId, approvalKey);
    },
    async latest(delegationId) {
      let latest: PublishAttempt | null = null;
      for (const row of rows.values()) {
        if (row.delegationId !== delegationId) continue;
        if (!latest || row.updatedAt >= latest.updatedAt) latest = row;
      }
      return latest;
    },
    async insert(input: PublishAttemptInsert): Promise<PublishAttemptInsertResult> {
      const same = get(input.delegationId, input.approvalKey);
      if (same) return { outcome: 'exists', attempt: same };
      const blocker = blockerOf(rows, input.delegationId, input.approvalKey);
      if (blocker) return { outcome: 'blocked', attempt: blocker };
      const attempt: PublishAttempt = {
        ...input,
        state: 'publishing',
        failure: null,
        remote: null,
        pullRequest: null,
        createdAt: input.at,
        updatedAt: input.at
      };
      rows.set(keyOf(input.delegationId, input.approvalKey), attempt);
      return { outcome: 'created', attempt };
    },
    async compareAndSet(input: PublishAttemptCasInput): Promise<PublishAttemptCasResult> {
      const blocker = blockerOf(rows, input.delegationId, input.approvalKey);
      if (blocker) return { ok: false, attempt: blocker };
      const current = get(input.delegationId, input.approvalKey);
      if (!current) return { ok: false, attempt: null };
      if (current.state !== input.expect.state) return { ok: false, attempt: current };
      if (
        input.expect.claimToken !== undefined &&
        (current.claim?.token ?? null) !== input.expect.claimToken
      ) {
        return { ok: false, attempt: current };
      }
      const next: PublishAttempt = {
        ...current,
        state: input.state,
        claim: input.claim === undefined ? current.claim : input.claim,
        remote: input.remote === undefined ? current.remote : input.remote,
        pullRequest: input.pullRequest === undefined ? current.pullRequest : input.pullRequest,
        failure: input.failure === undefined ? current.failure : input.failure,
        updatedAt: input.at
      };
      rows.set(keyOf(input.delegationId, input.approvalKey), next);
      return { ok: true, attempt: next };
    }
  };
}

function openDraftPr(overrides: Partial<RemotePullRequest> = {}): RemotePullRequest {
  return {
    number: 7,
    url: `https://github.com/${REPO}/pull/7`,
    state: 'open',
    headSha: HEAD_SHA,
    mergedAt: null,
    base: BASE,
    repo: REPO,
    headRef: BRANCH,
    draft: true,
    baseRepo: REPO,
    ...overrides
  };
}

function publishedOutcome(input: PublishRefInput): PublishRefOutcome {
  return {
    sha: input.sha,
    branch: input.branch,
    baseBranch: input.baseBranch,
    baseSha: BASE_SHA,
    defaultBranch: BASE,
    remoteSha: input.sha,
    published: true,
    pushed: input.verifyOnly !== true,
    uncertain: false,
    reason: null
  };
}

type CreateInput = { readonly token: string; readonly repo: string; readonly base: string; readonly head: string; readonly title: string; readonly body: string; readonly draft?: boolean };

interface Calls {
  readonly publish: PublishRefInput[];
  readonly list: { readonly token: string; readonly repo: string; readonly head: string }[];
  readonly create: CreateInput[];
}

interface WorldOptions {
  readonly record?: Partial<WorkspaceDelegation>;
  readonly access?: AccessPolicy;
  readonly publish?: (input: PublishRefInput) => Promise<Result<PublishRefOutcome, DomainError>>;
  readonly list?: () => Promise<{ ok: true; prs: readonly RemotePullRequest[] } | { ok: false; reason: string }>;
  readonly create?: () => Promise<{ ok: true; pr: RemotePullRequest } | { ok: false; reason: string }>;
  readonly resolveTarget?: (record: WorkspaceDelegation) => ReturnType<WorkspaceDelegationPublishBridges['resolveTarget']>;
  /** 注入时钟，用来测租约过期；默认用 inMemoryDeps 的递增时钟。 */
  readonly now?: () => number;
}

interface World {
  readonly deps: ReturnType<typeof inMemoryDeps>['deps'];
  readonly store: FakeStore;
  readonly project: Project;
  readonly task: Task;
  readonly record: WorkspaceDelegation;
  readonly bridges: WorkspaceDelegationPublishBridges;
  readonly calls: Calls;
}

async function world(options: WorldOptions = {}): Promise<World> {
  const w = inMemoryDeps({
    ...(options.access ? { access: options.access } : {}),
    ...(options.now ? { now: options.now } : {})
  });
  const repos = normalizeRepos([{ name: 'app', url: REPO_URL, defaultBranch: BASE }]);
  assert.ok(repos.ok);
  const project = createProject({
    id: asProjectId('proj_1'),
    name: 'demo',
    now: 10,
    teamId: 'team_a',
    createdBy: user.id,
    repos: repos.value
  });
  assert.ok(project.ok);
  await w.deps.projects.save(project.value);
  const task = createTask({
    id: asTaskId('task_1'),
    projectId: project.value.id,
    title: '把设置页拆成两个组件',
    now: 11
  });
  assert.ok(task.ok);
  await w.deps.tasks.save(task.value);
  const repo = project.value.repos[0]!;
  const record: WorkspaceDelegation = {
    id: 'dlg_1',
    accountId: user.id,
    coordinatorSessionId: asSessionId('ses_coord'),
    requestKey: 'req-1',
    requestFingerprint: 'fingerprint-1',
    projectId: project.value.id,
    taskId: task.value.id,
    repoId: repo.id,
    repoUrl: REPO_URL,
    workerId: 'worker_1',
    baseBranch: BASE,
    baseSha: BASE_SHA,
    instructions: '把设置页拆成两个组件',
    startup: null,
    executionSessionId: asSessionId('ses_exec'),
    worktreePath: '/srv/worktrees/app/settings-1',
    branch: BRANCH,
    state: 'prepared',
    claim: null,
    failure: null,
    createdAt: 9,
    updatedAt: 9,
    ...options.record
  };

  const calls: Calls = { publish: [], list: [], create: [] };
  const git = {
    async publishRef(input: PublishRefInput) {
      calls.publish.push(input);
      return options.publish ? options.publish(input) : ok(publishedOutcome(input));
    }
  } as unknown as WorkspaceGit;
  const api: GitHostApi = {
    async createPullRequest(input) {
      calls.create.push(input);
      return options.create ? options.create() : { ok: true, pr: openDraftPr() };
    },
    async getPullRequest() {
      return { ok: false, reason: '用例不读单条 PR' };
    },
    async listPullRequestsByHead(input) {
      calls.list.push(input);
      return options.list ? options.list() : { ok: true, prs: [] };
    }
  };
  const bridges: WorkspaceDelegationPublishBridges = {
    loadRecord: async (id) => (id === record.id ? record : null),
    resolveTarget:
      options.resolveTarget ??
      (async (current) =>
        ok({
          executionSessionId: current.executionSessionId,
          taskId: current.taskId,
          workerId: current.workerId,
          path: current.worktreePath,
          repoUrl: current.repoUrl,
          branch: current.branch,
          headSha: HEAD_SHA
        })),
    git: () => git,
    gitHost: async () => ({ api, token: 'team-token' })
  };

  return { deps: w.deps, store: createFakeStore(), project: project.value, task: task.value, record, bridges, calls };
}

function command(overrides: Partial<PublishDelegationCommand> = {}): PublishDelegationCommand {
  return {
    actor,
    delegationId: 'dlg_1',
    approvalKey: APPROVAL,
    expectedHeadSha: HEAD_SHA,
    ...overrides
  } as PublishDelegationCommand;
}

/* ───────────────────────── 用例 ───────────────────────── */

test('发布：create-only 发布分支 + 草稿 PR；成功重放零外部调用', async () => {
  const w = await world();
  const result = await publishWorkspaceDelegationUseCase(w.deps, w.store, w.bridges, command());
  assert.ok(result.ok, JSON.stringify(result));
  const run = result.value;
  assert.equal(run.attempt.state, 'published');
  assert.equal(run.attempted, true);
  assert.equal(run.replayed, false);
  assert.equal(run.attempt.pullRequest?.number, 7);
  assert.equal(run.attempt.pullRequest?.url, `https://github.com/${REPO}/pull/7`);
  assert.equal(run.attempt.headSha, HEAD_SHA);

  assert.equal(w.calls.publish.length, 1);
  assert.deepEqual(
    {
      path: w.calls.publish[0]!.path,
      branch: w.calls.publish[0]!.branch,
      sha: w.calls.publish[0]!.sha,
      expectedUrl: w.calls.publish[0]!.expectedUrl,
      baseBranch: w.calls.publish[0]!.baseBranch,
      verifyOnly: w.calls.publish[0]!.verifyOnly
    },
    { path: w.record.worktreePath, branch: BRANCH, sha: HEAD_SHA, expectedUrl: REPO_URL, baseBranch: BASE, verifyOnly: undefined }
  );
  assert.deepEqual(w.calls.list, [{ token: 'team-token', repo: REPO, head: BRANCH }]);
  assert.equal(w.calls.create.length, 1);
  assert.deepEqual(
    {
      repo: w.calls.create[0]!.repo,
      base: w.calls.create[0]!.base,
      head: w.calls.create[0]!.head,
      draft: w.calls.create[0]!.draft,
      title: w.calls.create[0]!.title
    },
    { repo: REPO, base: BASE, head: BRANCH, draft: true, title: '应用人工批准的改动' }
  );
  // PR 正文是外部可见文本：不能把 hub 内部的任务标题 / 派工说明抄出去。
  assert.equal(w.calls.create[0]!.body, '本 PR 由 agent-hub 在人工确认后创建，请按项目流程审阅。');
  assert.ok(!w.calls.create[0]!.body.includes(w.record.instructions));

  // 同一次批准重放：只读成功记录，不 push、不列 PR、不建 PR。
  const again = await publishWorkspaceDelegationUseCase(w.deps, w.store, w.bridges, command());
  assert.ok(again.ok);
  assert.equal(again.value.attempt.state, 'published');
  assert.equal(again.value.attempted, false);
  assert.equal(again.value.replayed, true);
  assert.equal(w.calls.publish.length, 1);
  assert.equal(w.calls.list.length, 1);
  assert.equal(w.calls.create.length, 1);
});

test('发布：API 令牌 / bot 不是真人，直接拒绝且零副作用', async () => {
  const w = await world();
  const tokenActor: Subject = { ...actor, via: { tokenId: 'tok_1', name: 'CI', kind: 'service', permissions: [] } };
  const result = await publishWorkspaceDelegationUseCase(
    w.deps,
    w.store,
    w.bridges,
    command({ actor: tokenActor })
  );
  assert.ok(!result.ok);
  assert.equal(result.error.code, 'forbidden');
  assert.equal(w.calls.publish.length, 0);
  assert.equal(w.calls.create.length, 0);
  assert.equal(w.store.rows.size, 0);
});

test('发布：派工人自己的 git.push 被收回后也不能发布', async () => {
  const viewer: User = { ...user, role: 'viewer' };
  const viewerActor: Principal = { ...actor, user: viewer };
  const w = await world({
    access: {
      context: async () => ({ hubTeamId: 'team_a', settings: { membersCanAddMachines: true } }),
      worker: async (workerId) => ({
        kind: 'worker',
        id: workerId ?? 'local',
        teamId: 'team_a',
        createdBy: user.id,
        local: false
      })
    }
  });
  const result = await publishWorkspaceDelegationUseCase(
    w.deps,
    w.store,
    w.bridges,
    command({ actor: viewerActor })
  );
  assert.ok(!result.ok);
  assert.equal(result.error.code, 'forbidden');
  assert.equal(w.calls.publish.length, 0);
  assert.equal(w.calls.create.length, 0);
});

test('发布：派工人在别的团队、用不了这台机器 → 拒绝', async () => {
  const w = await world({
    access: {
      context: async () => ({ hubTeamId: 'team_a', settings: { membersCanAddMachines: true } }),
      worker: async (workerId) => ({
        kind: 'worker',
        id: workerId ?? 'local',
        teamId: 'team_b',
        createdBy: 'user_other',
        local: false
      })
    }
  });
  const result = await publishWorkspaceDelegationUseCase(w.deps, w.store, w.bridges, command());
  assert.ok(!result.ok);
  assert.equal(result.error.code, 'forbidden');
  assert.equal(w.calls.publish.length, 0);
  assert.equal(w.calls.create.length, 0);
});

test('发布：项目在回收站 → 当作不存在，零副作用', async () => {
  const w = await world();
  await w.deps.projects.save({ ...w.project, deletedAt: 99 });
  const result = await publishWorkspaceDelegationUseCase(w.deps, w.store, w.bridges, command());
  assert.ok(!result.ok);
  assert.equal(result.error.code, 'not_found');
  assert.equal(w.calls.publish.length, 0);
  assert.equal(w.calls.create.length, 0);
});

test('发布：同一个批准键换提交 → conflict，不产生任何外部调用', async () => {
  const w = await world();
  const first = await publishWorkspaceDelegationUseCase(w.deps, w.store, w.bridges, command());
  assert.ok(first.ok);
  const otherSha = 'c'.repeat(40);
  const second = await publishWorkspaceDelegationUseCase(
    w.deps,
    w.store,
    w.bridges,
    command({ expectedHeadSha: otherSha })
  );
  assert.ok(!second.ok);
  assert.equal(second.error.code, 'conflict');
  assert.equal(w.calls.publish.length, 1);
  assert.equal(w.calls.create.length, 1);
});

test('发布：换一个批准键想对同一条派工再发一次 → 被已发布尝试挡住；原键对账仍然只读', async () => {
  const w = await world();
  assert.ok((await publishWorkspaceDelegationUseCase(w.deps, w.store, w.bridges, command())).ok);

  const second = await publishWorkspaceDelegationUseCase(
    w.deps,
    w.store,
    w.bridges,
    command({ approvalKey: OTHER_APPROVAL })
  );
  assert.ok(!second.ok);
  assert.equal(second.error.code, 'conflict');
  assert.match(second.error.message, /已经发布过 PR/);
  assert.equal(w.calls.publish.length, 1);
  assert.equal(w.calls.list.length, 1);
  assert.equal(w.calls.create.length, 1);

  // 同一个（旧的）批准键做对账：读已发布记录，不碰远端。
  const reconciled = await publishWorkspaceDelegationUseCase(
    w.deps,
    w.store,
    w.bridges,
    command({ mode: 'reconcile' })
  );
  assert.ok(reconciled.ok);
  assert.equal(reconciled.value.reconciled, true);
  assert.equal(reconciled.value.attempted, false);
  assert.equal(w.calls.publish.length, 1);
  assert.equal(w.calls.create.length, 1);
});

test('发布：上一条结果不明时，换批准键也不能再发', async () => {
  const w = await world({ create: async () => ({ ok: false, reason: 'socket hang up' }) });
  assert.ok(!(await publishWorkspaceDelegationUseCase(w.deps, w.store, w.bridges, command())).ok);
  const blocker = w.store.rows.get(keyOf('dlg_1', APPROVAL))!;
  assert.equal(blocker.state, 'uncertain');

  const other = await publishWorkspaceDelegationUseCase(
    w.deps,
    w.store,
    w.bridges,
    command({ approvalKey: OTHER_APPROVAL })
  );
  assert.ok(!other.ok);
  assert.equal(other.error.code, 'conflict');
  assert.match(other.error.message, /结果不明/);
  assert.equal(w.calls.publish.length, 1);
  assert.equal(w.calls.create.length, 1);
});

test('发布：崩在「已建 PR」之后 → 远端已发布且列出符合草稿 PR 时认领，不重复创建', async () => {
  const w = await world({ list: async () => ({ ok: true, prs: [openDraftPr()] }) });
  const result = await publishWorkspaceDelegationUseCase(w.deps, w.store, w.bridges, command());
  assert.ok(result.ok);
  assert.equal(result.value.attempt.state, 'published');
  assert.equal(result.value.attempted, false);
  assert.equal(result.value.attempt.pullRequest?.number, 7);
  assert.equal(w.calls.create.length, 0);
});

test('发布：列 PR 失败 → uncertain 且绝不创建；对账只读认领已有草稿 PR', async () => {
  let failList = true;
  const w = await world({
    list: async () =>
      failList ? { ok: false, reason: '网络断了' } : { ok: true, prs: [openDraftPr()] }
  });
  const first = await publishWorkspaceDelegationUseCase(w.deps, w.store, w.bridges, command());
  assert.ok(!first.ok);
  assert.equal(first.error.code, 'unavailable');
  const uncertain = w.store.rows.get(keyOf('dlg_1', APPROVAL))!;
  assert.equal(uncertain.state, 'uncertain');
  assert.equal(w.calls.create.length, 0);
  assert.ok(!(uncertain.failure?.message ?? '').includes('网络断了'));

  failList = false;
  const reconciled = await publishWorkspaceDelegationUseCase(
    w.deps,
    w.store,
    w.bridges,
    command({ mode: 'reconcile' })
  );
  assert.ok(reconciled.ok);
  assert.equal(reconciled.value.reconciled, true);
  assert.equal(reconciled.value.attempt.state, 'published');
  assert.equal(w.calls.create.length, 0);
  assert.equal(w.calls.publish.length, 2);
  assert.equal(w.calls.publish[1]!.verifyOnly, true);
});

test('发布：创建 PR 结果不明 → uncertain；对账看不到 PR 仍保持不确定，绝不重试创建', async () => {
  const w = await world({
    create: async () => ({ ok: false, reason: 'socket hang up' })
  });
  const first = await publishWorkspaceDelegationUseCase(w.deps, w.store, w.bridges, command());
  assert.ok(!first.ok);
  assert.equal(first.error.code, 'unavailable');
  const row = w.store.rows.get(keyOf('dlg_1', APPROVAL))!;
  assert.equal(row.state, 'uncertain');
  assert.ok(!(row.failure?.message ?? '').includes('socket hang up'));
  assert.equal(w.calls.create.length, 1);

  // 没对账之前，同键重放绝不再次创建。
  const retryBeforeReconcile = await publishWorkspaceDelegationUseCase(w.deps, w.store, w.bridges, command());
  assert.ok(!retryBeforeReconcile.ok);
  assert.match(retryBeforeReconcile.error.message, /先对账/);
  assert.equal(w.calls.create.length, 1);

  // 远端有这个提交、但没有列出 PR：列表为空证明不了「没创建过」（创建可能还在飞行 /
  // 列表会滞后 / PR 可能已关闭），所以对账后仍然是 uncertain。
  const reconciled = await publishWorkspaceDelegationUseCase(
    w.deps,
    w.store,
    w.bridges,
    command({ mode: 'reconcile' })
  );
  assert.ok(reconciled.ok);
  assert.equal(reconciled.value.attempt.state, 'uncertain');
  assert.equal(w.calls.create.length, 1);
  assert.equal(w.calls.publish.length, 2);
  assert.equal(w.calls.publish[1]!.verifyOnly, true);

  // 不确定状态不能靠「再点一次发布」绕过去。
  const retryAfterReconcile = await publishWorkspaceDelegationUseCase(w.deps, w.store, w.bridges, command());
  assert.ok(!retryAfterReconcile.ok);
  assert.equal(retryAfterReconcile.error.code, 'conflict');
  assert.equal(w.calls.create.length, 1);
});

test('对账：认领崩在「已建 PR」之后留下的草稿 PR，只读且不重复创建', async () => {
  let created = false;
  const w = await world({
    create: async () => {
      created = true;
      return { ok: false, reason: 'socket hang up' };
    },
    list: async () => (created ? { ok: true, prs: [openDraftPr()] } : { ok: true, prs: [] })
  });
  const first = await publishWorkspaceDelegationUseCase(w.deps, w.store, w.bridges, command());
  assert.ok(!first.ok);
  assert.equal(w.store.rows.get(keyOf('dlg_1', APPROVAL))!.state, 'uncertain');

  // 对账前不让列表看到 PR：保持不确定。
  const early = await publishWorkspaceDelegationUseCase(
    { ...w.deps, now: w.deps.now },
    w.store,
    { ...w.bridges },
    command({ mode: 'reconcile' })
  );
  assert.ok(early.ok);
  assert.equal(early.value.attempt.state, 'published');
  assert.equal(w.calls.create.length, 1);
  assert.equal(w.calls.publish.length, 2);
  assert.equal(w.calls.publish[1]!.verifyOnly, true);

  // 已发布后重放：不再 push / 列 / 建。
  const replay = await publishWorkspaceDelegationUseCase(w.deps, w.store, w.bridges, command());
  assert.ok(replay.ok);
  assert.equal(replay.value.replayed, true);
  assert.equal(w.calls.create.length, 1);
});

test('对账：同名 head 上只有已关闭 / 非草稿 PR 时不认领，保持不确定', async () => {
  let created = false;
  const w = await world({
    create: async () => {
      created = true;
      return { ok: false, reason: 'socket hang up' };
    },
    list: async () =>
      created
        ? {
            ok: true,
            prs: [
              openDraftPr({ state: 'closed' }),
              openDraftPr({ number: 8, draft: false, url: `https://github.com/${REPO}/pull/8` })
            ]
          }
        : { ok: true, prs: [] }
  });
  const first = await publishWorkspaceDelegationUseCase(w.deps, w.store, w.bridges, command());
  assert.ok(!first.ok);

  const reconciled = await publishWorkspaceDelegationUseCase(
    w.deps,
    w.store,
    w.bridges,
    command({ mode: 'reconcile' })
  );
  assert.ok(reconciled.ok);
  assert.equal(reconciled.value.attempt.state, 'uncertain');
  assert.equal(reconciled.value.attempt.pullRequest, null);
  assert.equal(w.calls.create.length, 1);
});

test('对账：结算期间被并发改成 published → conflict，且不把结果改回 uncertain', async () => {
  let failList = true;
  let target: World | null = null;
  const w = await world({
    list: async () => {
      if (failList) return { ok: false, reason: '网络断了' };
      const honest = target!.store.rows.get(keyOf('dlg_1', APPROVAL))!;
      target!.store.seed({ ...honest, state: 'published', claim: null, updatedAt: honest.updatedAt + 5 });
      return { ok: true, prs: [] };
    }
  });
  target = w;
  const first = await publishWorkspaceDelegationUseCase(w.deps, w.store, w.bridges, command());
  assert.ok(!first.ok);

  failList = false;
  const reconciled = await publishWorkspaceDelegationUseCase(
    w.deps,
    w.store,
    w.bridges,
    command({ mode: 'reconcile' })
  );
  assert.ok(!reconciled.ok);
  assert.equal(reconciled.error.code, 'conflict');
  assert.equal(w.store.rows.get(keyOf('dlg_1', APPROVAL))!.state, 'published');
  assert.equal(w.calls.create.length, 0);
});

test('发布：远端写之前租约过期 → 不 push、不打远端，尝试落 failed 并可重试', async () => {
  let jump = false;
  let clock = 1_000;
  const w = await world({
    now: () => {
      if (jump) {
        jump = false;
        clock += 10 * 60_000;
      } else {
        clock += 1;
      }
      return clock;
    }
  });
  const realInsert = w.store.insert.bind(w.store);
  w.store.insert = async (input) => {
    const inserted = await realInsert(input);
    jump = true;
    return inserted;
  };

  const result = await publishWorkspaceDelegationUseCase(w.deps, w.store, w.bridges, command());
  assert.ok(!result.ok);
  assert.equal(result.error.code, 'unavailable');
  assert.match(result.error.message, /租期已过/);
  assert.equal(w.calls.publish.length, 0);
  assert.equal(w.calls.create.length, 0);
  const row = w.store.rows.get(keyOf('dlg_1', APPROVAL))!;
  assert.equal(row.state, 'failed');
  assert.equal(row.failure?.kind, 'fatal');
  assert.equal(row.claim, null);
});

test('发布：建 PR 之前租约过期 → 不建 PR，尝试保持 uncertain（PR 是否创建不明）', async () => {
  let jump = false;
  let clock = 1_000;
  const w = await world({
    now: () => {
      if (jump) {
        jump = false;
        clock += 10 * 60_000;
      } else {
        clock += 1;
      }
      return clock;
    },
    list: async () => ({ ok: true, prs: [] })
  });
  const hostOf = w.bridges.gitHost?.bind(w.bridges);
  // 在列 PR 之后（也就是建 PR 之前）让时钟越过租约。
  const bridges: WorkspaceDelegationPublishBridges = {
    ...w.bridges,
    gitHost: async (project) => {
      const host = await hostOf?.(project);
      if (!host) return null;
      return {
        token: host.token,
        api: {
          ...host.api,
          listPullRequestsByHead: async (input) => {
            jump = true;
            return host.api.listPullRequestsByHead(input);
          }
        }
      };
    }
  };

  const result = await publishWorkspaceDelegationUseCase(w.deps, w.store, bridges, command());
  assert.ok(!result.ok);
  assert.equal(result.error.code, 'unavailable');
  assert.match(result.error.message, /租期已过/);
  assert.equal(w.calls.publish.length, 1);
  assert.equal(w.calls.create.length, 0);
  const row = w.store.rows.get(keyOf('dlg_1', APPROVAL))!;
  assert.equal(row.state, 'uncertain');
  assert.equal(row.pullRequest, null);
});

test('发布：建 PR 之前尝试被别的操作接管 → conflict，不建 PR', async () => {
  let target: World | null = null;
  const w = await world({
    list: async () => {
      const row = target!.store.rows.get(keyOf('dlg_1', APPROVAL))!;
      if (row.state === 'publishing') {
        target!.store.seed({ ...row, state: 'published', claim: null, updatedAt: row.updatedAt + 5 });
      }
      return { ok: true, prs: [] };
    }
  });
  target = w;

  const result = await publishWorkspaceDelegationUseCase(w.deps, w.store, w.bridges, command());
  assert.ok(!result.ok);
  assert.equal(result.error.code, 'conflict');
  assert.match(result.error.message, /接管/);
  assert.equal(w.calls.create.length, 0);
  assert.equal(w.store.rows.get(keyOf('dlg_1', APPROVAL))!.state, 'published');
});

test('发布：崩溃遗留的 publishing（租期已过）→ 拒绝发布；对账仍只读', async () => {
  const w = await world({
    publish: async (input) =>
      input.verifyOnly === true ? ok(publishedOutcome(input)) : err(conflict('远端有别的提交'))
  });
  const first = await publishWorkspaceDelegationUseCase(w.deps, w.store, w.bridges, command());
  assert.ok(!first.ok);
  const row = w.store.rows.get(keyOf('dlg_1', APPROVAL))!;
  assert.equal(row.state, 'failed');
  // 模拟进程崩在 publishing 里：claim 过期。
  w.store.seed({ ...row, state: 'publishing', claim: { owner: user.id, token: 'tok_dead', at: 1, expiresAt: 1 } });

  const publishAgain = await publishWorkspaceDelegationUseCase(w.deps, w.store, w.bridges, command());
  assert.ok(!publishAgain.ok);
  assert.equal(publishAgain.error.code, 'conflict');
  assert.match(publishAgain.error.message, /先对账/);
  assert.equal(w.calls.publish.length, 1);

  const reconciled = await publishWorkspaceDelegationUseCase(
    w.deps,
    w.store,
    w.bridges,
    command({ mode: 'reconcile' })
  );
  assert.ok(reconciled.ok, JSON.stringify(reconciled));
  assert.equal(reconciled.value.reconciled, true);
  assert.equal(reconciled.value.attempt.state, 'uncertain');
  assert.match(reconciled.value.attempt.failure?.message ?? '', /结果仍然不明/);
  assert.equal(w.calls.publish.length, 2);
  assert.equal(w.calls.publish[1]!.verifyOnly, true);
  assert.equal(w.calls.create.length, 0);
});

test('发布：记录没有有效基线 / 项目仓库地址变了 → conflict，零外部调用', async () => {
  const noBaseline = await world({ record: { baseSha: null } });
  const first = await publishWorkspaceDelegationUseCase(noBaseline.deps, noBaseline.store, noBaseline.bridges, command());
  assert.ok(!first.ok);
  assert.equal(first.error.code, 'conflict');
  assert.equal(noBaseline.calls.publish.length, 0);

  const changed = await world();
  const repo = changed.project.repos[0]!;
  await changed.deps.projects.save({
    ...changed.project,
    repos: [{ ...repo, url: 'https://github.com/acme/other.git' }]
  });
  const second = await publishWorkspaceDelegationUseCase(changed.deps, changed.store, changed.bridges, command());
  assert.ok(!second.ok);
  assert.equal(second.error.code, 'conflict');
  assert.match(second.error.message, /仓库地址已变化/);
  assert.equal(changed.calls.publish.length, 0);
  assert.equal(changed.calls.create.length, 0);
});
