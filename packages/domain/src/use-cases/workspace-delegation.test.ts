import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Principal } from '../account.ts';
import { asLoginId, asTeamId, asUserId, type User } from '../account.ts';
import type { AccessPolicy } from './authorization.ts';
import { asSessionId, asWorkspaceId } from '../ids.ts';
import { createProject, normalizeRepos, type Project, type ProjectRepo } from '../project.ts';
import { createTask, type Task } from '../task.ts';
import { inMemoryDeps } from '../testing/in-memory.ts';
import type { DelegationAllocation, DelegationCasInput, DelegationClaim, WorkspaceDelegation } from '../workspace-delegation.ts';
import { delegationCanTransition } from '../workspace-delegation.ts';
import { forbidden } from '../errors.ts';
import { err, ok } from '../result.ts';
import {
  delegateWorkspaceDirectUseCase,
  delegateWorkspaceUseCase,
  proposeWorkspaceDelegationUseCase,
  type DelegateWorkspaceCommand,
  type DelegationCoordinator,
  type DelegationDirectAuthorizeInput,
  type DelegationDirectAuthorizer,
  type DelegationDirectSource,
  type DelegationDirectSourceRejection,
  type DelegationPlan,
  type DelegationStore,
  type DirectDelegateWorkspaceCommand,
  type WorkspaceDelegationBridges,
  type WorkspaceDelegationDirectBridges
} from './workspace-delegation.ts';

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
const coordinatorSessionId = asSessionId('ses_coordinator');

function createFakeStore(): DelegationStore & {
  rows: Map<string, WorkspaceDelegation>;
  writes: { allocate: number; claim: number; compareAndSet: number };
} {
  const rows = new Map<string, WorkspaceDelegation>();
  const writes = { allocate: 0, claim: 0, compareAndSet: 0 };

  return {
    rows,
    writes,
    async allocate(input: DelegationAllocation) {
      writes.allocate += 1;
      const sameKey = [...rows.values()].find(
        (row) =>
          row.mode === (input.mode ?? 'proposal') &&
          row.coordinatorSessionId === input.coordinatorSessionId &&
          row.requestKey === input.requestKey
      );
      if (sameKey) {
        return {
          outcome: sameKey.requestFingerprint === input.requestFingerprint ? ('reused' as const) : ('conflict' as const),
          record: sameKey
        };
      }
      const sameExecution = [...rows.values()].find((row) => row.executionSessionId === input.executionSessionId);
      if (sameExecution) return { outcome: 'conflict' as const, record: sameExecution };

      const record: WorkspaceDelegation = {
        ...input,
        state: 'pending',
        baseSha: null,
        claim: null,
        failure: null,
        createdAt: input.at,
        updatedAt: input.at
      };
      rows.set(record.id, record);
      return { outcome: 'created' as const, record };
    },
    async byId(id: string) {
      return rows.get(id) ?? null;
    },
    async byCoordinatorRequest(sessionId, requestKey, mode = 'proposal') {
      return (
        [...rows.values()].find(
          (row) =>
            row.mode === mode && row.coordinatorSessionId === sessionId && row.requestKey === requestKey
        ) ?? null
      );
    },
    async claim(id: string, claim: DelegationClaim) {
      writes.claim += 1;
      const record = rows.get(id);
      if (!record) return { outcome: 'missing' as const, record: null };
      if (record.state !== 'pending') return { outcome: 'not-claimable' as const, record };
      const next: WorkspaceDelegation = { ...record, state: 'preparing', claim, updatedAt: claim.at };
      rows.set(id, next);
      return { outcome: 'claimed' as const, record: next };
    },
    async compareAndSet(id: string, input: DelegationCasInput) {
      writes.compareAndSet += 1;
      const record = rows.get(id);
      if (!record) return { ok: false, record: null };
      if (record.state !== input.expect.state) return { ok: false, record };
      const expectedToken = input.expect.claimToken;
      if (expectedToken !== undefined) {
        const actual = record.claim?.token ?? null;
        if (expectedToken !== actual) return { ok: false, record };
      }
      if (!delegationCanTransition(record.state, input.state)) return { ok: false, record };
      if (input.state === 'failed' && input.failure?.kind !== 'fatal') return { ok: false, record };
      if (input.state === 'uncertain' && input.failure?.kind !== 'uncertain') return { ok: false, record };
      const next: WorkspaceDelegation = {
        ...record,
        state: input.state,
        baseSha: input.baseSha === undefined ? record.baseSha : input.baseSha,
        claim: null,
        failure: input.state === 'failed' || input.state === 'uncertain' ? (input.failure ?? null) : null,
        updatedAt: input.at
      };
      rows.set(id, next);
      return { ok: true, record: next };
    }
  };
}

interface World {
  readonly world: ReturnType<typeof inMemoryDeps>;
  readonly store: ReturnType<typeof createFakeStore>;
  readonly project: Project;
  readonly task: Task;
  readonly repo: ProjectRepo;
  readonly coordinator: DelegationCoordinator;
  readonly command: DelegateWorkspaceCommand;
  readonly bridges: WorkspaceDelegationBridges;
  readonly calls: { plan: number; prepare: number; start: number; link: number };
}

async function world(overrides: Partial<WorkspaceDelegationBridges> = {}): Promise<World> {
  const w = inMemoryDeps();
  const repos = normalizeRepos([{ name: 'app', url: 'git@example.com:acme/app.git', defaultBranch: 'main' }]);
  assert.ok(repos.ok);
  const project = createProject({ name: 'demo', now: 10, teamId: 'team_a', createdBy: 'user_human', repos: repos.value });
  assert.ok(project.ok);
  await w.deps.projects.save(project.value);
  const task = createTask({ projectId: project.value.id, title: '派工目标', now: 11 });
  assert.ok(task.ok);
  await w.deps.tasks.save(task.value);

  const repo = project.value.repos[0]!;
  const coordinator: DelegationCoordinator = {
    sessionId: coordinatorSessionId,
    projectId: project.value.id,
    accountId: user.id
  };
  const command: DelegateWorkspaceCommand = {
    actor,
    requestKey: 'req-1',
    coordinatorSessionId,
    taskId: task.value.id,
    repoId: repo.id,
    baseBranch: 'main',
    instructions: '把设置页拆成两个组件',
    agentId: 'fake',
    model: 'm1'
  };
  const calls = { plan: 0, prepare: 0, start: 0, link: 0 };
  const plan: DelegationPlan = {
    workerId: 'studio',
    baseBranch: 'main',
    worktreePath: '/srv/worktrees/app/settings-1',
    branch: 'settings-1'
  };
  const bridges: WorkspaceDelegationBridges = {
    resolveCoordinator: async (sessionId) => (sessionId === coordinatorSessionId ? coordinator : null),
    plan: async () => {
      calls.plan += 1;
      return plan;
    },
    prepare: async () => {
      calls.prepare += 1;
      return { ok: true, value: { workspaceId: asWorkspaceId('ws_prepared'), baseSha: 'a'.repeat(40) } };
    },
    start: async (input) => {
      calls.start += 1;
      return {
        ok: true,
        value: { sessionId: input.record.executionSessionId, taskId: input.record.taskId, workspaceId: input.prepared.workspaceId }
      };
    },
    link: async (input) => {
      calls.link += 1;
      return { ok: true, value: { sessionId: input.started.sessionId } };
    },
    ...overrides
  };

  return {
    world: w,
    store: createFakeStore(),
    project: project.value,
    task: task.value,
    repo,
    coordinator,
    command,
    bridges,
    calls
  };
}

test('派工：真人主会话 → 同项目任务 → 准备 → 预留执行会话 → 建链，状态落 prepared', async () => {
  const w = await world();
  const result = await delegateWorkspaceUseCase(w.world.deps, w.store, w.bridges, w.command);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.value.allocation, 'created');
  assert.equal(result.value.claimed, true);
  assert.equal(result.value.record.state, 'prepared');
  assert.equal(result.value.record.baseSha, 'a'.repeat(40));
  assert.equal(result.value.record.accountId, user.id);
  assert.equal(result.value.record.projectId, w.project.id);
  assert.equal(result.value.record.taskId, w.task.id);
  assert.equal(result.value.record.repoId, w.repo.id);
  assert.deepEqual(w.calls, { plan: 1, prepare: 1, start: 1, link: 1 });

  // 同键重试：复用记录，不重放任何副作用。
  const again = await delegateWorkspaceUseCase(w.world.deps, w.store, w.bridges, w.command);
  assert.ok(again.ok);
  assert.equal(again.value.allocation, 'reused');
  assert.equal(again.value.claimed, false);
  assert.equal(again.value.record.state, 'prepared');
  assert.deepEqual(w.calls, { plan: 1, prepare: 1, start: 1, link: 1 });
});

test('派工：同键但内容不同 → conflict，不覆盖、不准备', async () => {
  const w = await world();
  assert.ok((await delegateWorkspaceUseCase(w.world.deps, w.store, w.bridges, w.command)).ok);

  const changed = await delegateWorkspaceUseCase(w.world.deps, w.store, w.bridges, {
    ...w.command,
    instructions: '换一个完全不同的需求'
  });
  assert.equal(changed.ok, false);
  assert.equal(!changed.ok && changed.error.code, 'conflict');
  assert.equal(w.store.rows.size, 1);
  assert.equal(w.calls.prepare, 1);
});

test('派工：token 主体 / 非主会话本人 fail-closed，且不产生记录或副作用', async () => {
  const w = await world();
  const viaToken: Principal = {
    ...actor,
    via: { tokenId: 'tok_1', name: 'CI', kind: 'service', permissions: [] }
  };
  const denied = await delegateWorkspaceUseCase(w.world.deps, w.store, w.bridges, { ...w.command, actor: viaToken });
  assert.equal(denied.ok, false);
  assert.equal(!denied.ok && denied.error.code, 'forbidden');
  assert.equal(w.store.rows.size, 0);
  assert.equal(w.calls.plan, 0);

  const anonymous = await delegateWorkspaceUseCase(w.world.deps, w.store, w.bridges, { ...w.command, actor: null });
  assert.equal(anonymous.ok, false);
  assert.equal(!anonymous.ok && anonymous.error.code, 'forbidden');
  assert.equal(w.store.rows.size, 0);
});

test('派工：主会话不属于当前人 → forbidden；不在注册表 → not_found', async () => {
  const w = await world({
    resolveCoordinator: async (sessionId) => ({
      sessionId,
      projectId: w.project.id,
      accountId: 'user_someone_else'
    })
  });
  const foreign = await delegateWorkspaceUseCase(w.world.deps, w.store, w.bridges, w.command);
  assert.equal(foreign.ok, false);
  assert.equal(!foreign.ok && foreign.error.code, 'forbidden');
  assert.equal(w.store.rows.size, 0);

  const missing = await world({ resolveCoordinator: async () => null });
  const absent = await delegateWorkspaceUseCase(missing.world.deps, missing.store, missing.bridges, missing.command);
  assert.equal(absent.ok, false);
  assert.equal(!absent.ok && absent.error.code, 'not_found');
  assert.equal(missing.calls.plan, 0);
});

test('派工：跨项目任务 / 项目清单外的仓库都拒绝，且还没规划或准备', async () => {
  const w = await world();
  const others = normalizeRepos([{ name: 'other', url: 'git@example.com:acme/other.git', defaultBranch: 'main' }]);
  assert.ok(others.ok);
  const otherProject = createProject({ name: 'other', now: 12, repos: others.value });
  assert.ok(otherProject.ok);
  await w.world.deps.projects.save(otherProject.value);
  const otherTask = createTask({ projectId: otherProject.value.id, title: '别人的任务', now: 13 });
  assert.ok(otherTask.ok);
  await w.world.deps.tasks.save(otherTask.value);

  const crossProject = await delegateWorkspaceUseCase(w.world.deps, w.store, w.bridges, {
    ...w.command,
    taskId: otherTask.value.id
  });
  assert.equal(crossProject.ok, false);
  assert.equal(!crossProject.ok && crossProject.error.code, 'invalid');

  const unknownRepo = await delegateWorkspaceUseCase(w.world.deps, w.store, w.bridges, {
    ...w.command,
    repoId: 'repo_not_in_project'
  });
  assert.equal(unknownRepo.ok, false);
  assert.equal(!unknownRepo.ok && unknownRepo.error.code, 'invalid');
  assert.equal(w.calls.plan, 0);
  assert.equal(w.calls.prepare, 0);
});

test('派工：项目权限不足时在 Git 副作用之前拒绝', async () => {
  const w = await world();
  const viewer: Principal = { ...actor, user: { ...user, role: 'viewer' } };
  const policy: AccessPolicy = {
    context: async () => ({ hubTeamId: asTeamId('team_a'), settings: { membersCanAddMachines: false } }),
    worker: async (workerId) => ({ kind: 'worker', id: workerId ?? 'local', teamId: asTeamId('team_a'), createdBy: null })
  };
  const deps = { ...w.world.deps, access: policy };
  const denied = await delegateWorkspaceUseCase(deps, w.store, w.bridges, { ...w.command, actor: viewer });
  assert.equal(denied.ok, false);
  assert.equal(!denied.ok && denied.error.code, 'forbidden');
  assert.equal(w.calls.plan, 0);
  assert.equal(w.store.rows.size, 0);
});

test('派工：准备报 fatal → failed；同键重试安全重来', async () => {
  let failFirst = true;
  const base = await world();
  const bridges: WorkspaceDelegationBridges = {
    ...base.bridges,
    prepare: async () => {
      base.calls.prepare += 1;
      if (failFirst) {
        failFirst = false;
        return { ok: false, kind: 'fatal', message: '分支名冲突' };
      }
      return { ok: true, value: { workspaceId: asWorkspaceId('ws_retry'), baseSha: 'b'.repeat(40) } };
    },
    start: async (input) => {
      base.calls.start += 1;
      return {
        ok: true,
        value: { sessionId: input.record.executionSessionId, taskId: input.record.taskId, workspaceId: input.prepared.workspaceId }
      };
    }
  };

  const first = await delegateWorkspaceUseCase(base.world.deps, base.store, bridges, base.command);
  assert.ok(first.ok);
  assert.equal(first.value.record.state, 'failed');
  assert.equal(first.value.record.failure?.kind, 'fatal');
  assert.equal(base.calls.start, 0);

  const second = await delegateWorkspaceUseCase(base.world.deps, base.store, bridges, base.command);
  assert.ok(second.ok);
  assert.equal(second.value.record.state, 'prepared');
  assert.equal(second.value.record.baseSha, 'b'.repeat(40));
  assert.equal(base.calls.prepare, 2);
  assert.equal(base.calls.start, 1);
  assert.equal(base.store.rows.size, 1);
});

test('派工：准备抛错 → uncertain，同键重试不再重放', async () => {
  const base = await world();
  const bridges: WorkspaceDelegationBridges = {
    ...base.bridges,
    prepare: async () => {
      base.calls.prepare += 1;
      throw new Error('worktree add 中断');
    }
  };
  const first = await delegateWorkspaceUseCase(base.world.deps, base.store, bridges, base.command);
  assert.ok(first.ok);
  assert.equal(first.value.record.state, 'uncertain');
  assert.equal(first.value.record.failure?.kind, 'uncertain');
  assert.match(first.value.record.failure?.message ?? '', /worktree add/);

  const second = await delegateWorkspaceUseCase(base.world.deps, base.store, bridges, base.command);
  assert.ok(second.ok);
  assert.equal(second.value.record.state, 'uncertain');
  assert.equal(second.value.claimed, false);
  assert.equal(base.calls.prepare, 1);
  assert.equal(base.calls.start, 0);
});

test('派工：执行会话身份不符 / start 抛错 → uncertain，不关联、不重放', async () => {
  const wrong = await world();
  const wrongBridges: WorkspaceDelegationBridges = {
    ...wrong.bridges,
    start: async () => ({
      ok: true,
      value: { sessionId: asSessionId('ses_someone_else'), taskId: wrong.task.id, workspaceId: asWorkspaceId('ws_prepared') }
    })
  };
  const mismatched = await delegateWorkspaceUseCase(wrong.world.deps, wrong.store, wrongBridges, wrong.command);
  assert.ok(mismatched.ok);
  assert.equal(mismatched.value.record.state, 'uncertain');
  assert.equal(wrong.calls.link, 0);

  const thrown = await world();
  const thrownBridges: WorkspaceDelegationBridges = {
    ...thrown.bridges,
    start: async () => {
      thrown.calls.start += 1;
      throw new Error('worker 启动超时');
    }
  };
  const failedStart = await delegateWorkspaceUseCase(thrown.world.deps, thrown.store, thrownBridges, thrown.command);
  assert.ok(failedStart.ok);
  assert.equal(failedStart.value.record.state, 'uncertain');
  assert.match(failedStart.value.record.failure?.message ?? '', /worker 启动超时/);

  const retry = await delegateWorkspaceUseCase(thrown.world.deps, thrown.store, thrownBridges, thrown.command);
  assert.ok(retry.ok);
  assert.equal(retry.value.claimed, false);
  assert.equal(thrown.calls.start, 1);
  assert.equal(thrown.calls.prepare, 1);
});

test('派工：关联失败即使自称 fatal 也按 uncertain 停下，执行会话不重建', async () => {
  const w = await world();
  const bridges: WorkspaceDelegationBridges = {
    ...w.bridges,
    link: async () => {
      w.calls.link += 1;
      return { ok: false, kind: 'fatal', message: '任务分支回写失败' };
    }
  };
  const first = await delegateWorkspaceUseCase(w.world.deps, w.store, bridges, w.command);
  assert.ok(first.ok);
  assert.equal(first.value.record.state, 'uncertain');
  assert.equal(first.value.record.failure?.kind, 'uncertain');

  const second = await delegateWorkspaceUseCase(w.world.deps, w.store, bridges, w.command);
  assert.ok(second.ok);
  assert.equal(second.value.claimed, false);
  assert.deepEqual(w.calls, { plan: 1, prepare: 1, start: 1, link: 1 });
});

test('派工：请求键必填，空 / 全空白 / 超长都在规划前拒绝', async () => {
  const w = await world();
  for (const requestKey of ['', '   ', 'x'.repeat(201)]) {
    const result = await delegateWorkspaceUseCase(w.world.deps, w.store, w.bridges, { ...w.command, requestKey });
    assert.equal(result.ok, false, requestKey.slice(0, 10));
    assert.equal(!result.ok && result.error.code, 'invalid');
  }
  assert.equal(w.calls.plan, 0);
  assert.equal(w.store.rows.size, 0);
});

test('派工：基线分支必须显式合法，且与 plan 一致才会产生副作用', async () => {
  const w = await world();
  const blank = await delegateWorkspaceUseCase(w.world.deps, w.store, w.bridges, { ...w.command, baseBranch: '  ' });
  assert.equal(blank.ok, false);
  assert.equal(!blank.ok && blank.error.code, 'invalid');

  const illegal = await delegateWorkspaceUseCase(w.world.deps, w.store, w.bridges, {
    ...w.command,
    baseBranch: 'bad branch'
  });
  assert.equal(illegal.ok, false);
  assert.equal(!illegal.ok && illegal.error.code, 'invalid');
  assert.equal(w.calls.plan, 0);

  const mismatched = await world();
  const replaced = await delegateWorkspaceUseCase(mismatched.world.deps, mismatched.store, {
    ...mismatched.bridges,
    plan: async () => ({
      workerId: 'studio',
      baseBranch: 'release',
      worktreePath: '/srv/worktrees/app/settings-1',
      branch: 'settings-1'
    })
  }, mismatched.command);
  assert.equal(replaced.ok, false);
  assert.equal(!replaced.ok && replaced.error.code, 'invalid');
  assert.equal(mismatched.calls.prepare, 0);
  assert.equal(mismatched.store.rows.size, 0);
});

test('派工：同一请求键换基线分支 → conflict（基线进指纹）', async () => {
  const w = await world();
  assert.ok((await delegateWorkspaceUseCase(w.world.deps, w.store, w.bridges, w.command)).ok);

  const changed = await delegateWorkspaceUseCase(w.world.deps, w.store, w.bridges, {
    ...w.command,
    baseBranch: 'develop'
  });
  assert.equal(changed.ok, false);
  assert.equal(!changed.ok && changed.error.code, 'conflict');
  assert.equal(w.store.rows.size, 1);
  assert.equal(w.calls.prepare, 1);
});

test('派工：准备结果 workspaceId 为空 / baseSha 不是小写 40 位 → uncertain，不启动', async () => {
  const emptyWorkspace = await world();
  const missing = await delegateWorkspaceUseCase(emptyWorkspace.world.deps, emptyWorkspace.store, {
    ...emptyWorkspace.bridges,
    prepare: async () => {
      emptyWorkspace.calls.prepare += 1;
      return { ok: true, value: { workspaceId: asWorkspaceId('  '), baseSha: 'a'.repeat(40) } };
    }
  }, emptyWorkspace.command);
  assert.ok(missing.ok);
  assert.equal(missing.value.record.state, 'uncertain');
  assert.equal(emptyWorkspace.calls.start, 0);

  const malformedSha = await world();
  const badSha = await delegateWorkspaceUseCase(malformedSha.world.deps, malformedSha.store, {
    ...malformedSha.bridges,
    prepare: async () => {
      malformedSha.calls.prepare += 1;
      return { ok: true, value: { workspaceId: asWorkspaceId('ws_ok'), baseSha: 'A'.repeat(40) } };
    }
  }, malformedSha.command);
  assert.ok(badSha.ok);
  assert.equal(badSha.value.record.state, 'uncertain');
  assert.match(badSha.value.record.failure?.message ?? '', /baseSha/);
  assert.equal(malformedSha.calls.start, 0);
});

test('派工：同一请求键下项目仓库地址变了 → conflict，不重放准备', async () => {
  const w = await world();
  assert.ok((await delegateWorkspaceUseCase(w.world.deps, w.store, w.bridges, w.command)).ok);

  const renamed = normalizeRepos([
    { id: w.repo.id, name: 'app', url: 'git@example.com:acme/app-renamed.git', defaultBranch: 'main' }
  ]);
  assert.ok(renamed.ok);
  const updated = createProject({
    id: w.project.id,
    name: 'demo',
    now: 20,
    teamId: 'team_a',
    createdBy: 'user_human',
    repos: renamed.value
  });
  assert.ok(updated.ok);
  await w.world.deps.projects.save(updated.value);

  const retry = await delegateWorkspaceUseCase(w.world.deps, w.store, w.bridges, w.command);
  assert.equal(retry.ok, false);
  assert.equal(!retry.ok && retry.error.code, 'conflict');
  assert.match(!retry.ok ? retry.error.message : '', /仓库地址/);
  assert.equal(w.calls.prepare, 1);
});

test('派工：回收站里的项目明确拒绝，不规划', async () => {
  const w = await world();
  await w.world.deps.projects.save({ ...w.project, deletedAt: 99 });
  const result = await delegateWorkspaceUseCase(w.world.deps, w.store, w.bridges, w.command);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error.code, 'not_found');
  assert.equal(w.calls.plan, 0);
  assert.equal(w.store.rows.size, 0);
});

test('提案：只分配 pending 与冻结启动配置，不领取、不准备、不启动、不关联', async () => {
  const w = await world();
  const result = await proposeWorkspaceDelegationUseCase(w.world.deps, w.store, w.bridges, {
    ...w.command,
    options: { approve: true, model_tier: 'fast' }
  });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.value.allocation, 'created');
  assert.equal(result.value.record.state, 'pending');
  assert.equal(result.value.record.claim, null);
  assert.equal(result.value.record.baseSha, null);
  assert.deepEqual(result.value.record.startup, {
    agentId: 'fake',
    model: 'm1',
    profileId: null,
    options: { approve: true, model_tier: 'fast' }
  });
  assert.deepEqual(w.calls, { plan: 1, prepare: 0, start: 0, link: 0 });
  assert.deepEqual(w.store.writes, { allocate: 1, claim: 0, compareAndSet: 0 });
});

test('提案：同键重放只读既有记录，不重新规划、不修改状态', async () => {
  const w = await world();
  const first = await proposeWorkspaceDelegationUseCase(w.world.deps, w.store, w.bridges, w.command);
  assert.ok(first.ok);
  const snapshot = JSON.stringify([...w.store.rows.values()]);

  const second = await proposeWorkspaceDelegationUseCase(w.world.deps, w.store, w.bridges, w.command);
  assert.ok(second.ok);
  assert.equal(second.value.allocation, 'reused');
  assert.equal(second.value.record.state, 'pending');
  assert.equal(second.value.record.id, first.value.record.id);
  assert.deepEqual(w.calls, { plan: 1, prepare: 0, start: 0, link: 0 });
  assert.deepEqual(w.store.writes, { allocate: 1, claim: 0, compareAndSet: 0 });
  assert.equal(JSON.stringify([...w.store.rows.values()]), snapshot);
});

test('提案后真人确认：同键同指纹才领取并建链，副作用只发生一次', async () => {
  const w = await world();
  const proposed = await proposeWorkspaceDelegationUseCase(w.world.deps, w.store, w.bridges, w.command);
  assert.ok(proposed.ok);
  assert.deepEqual(w.calls, { plan: 1, prepare: 0, start: 0, link: 0 });

  const confirmed = await delegateWorkspaceUseCase(w.world.deps, w.store, w.bridges, w.command);
  assert.ok(confirmed.ok, JSON.stringify(confirmed));
  assert.equal(confirmed.value.allocation, 'reused');
  assert.equal(confirmed.value.claimed, true);
  assert.equal(confirmed.value.record.id, proposed.value.record.id);
  assert.equal(confirmed.value.record.state, 'prepared');
  assert.deepEqual(w.calls, { plan: 1, prepare: 1, start: 1, link: 1 });
  assert.deepEqual(w.store.writes, { allocate: 1, claim: 1, compareAndSet: 1 });
  assert.equal(w.store.rows.size, 1);
});

test('提案后真人确认：同键但内容不同 → conflict，记录仍停在 pending，无副作用', async () => {
  const w = await world();
  assert.ok((await proposeWorkspaceDelegationUseCase(w.world.deps, w.store, w.bridges, w.command)).ok);
  const before = JSON.stringify([...w.store.rows.values()]);

  const denied = await delegateWorkspaceUseCase(w.world.deps, w.store, w.bridges, {
    ...w.command,
    instructions: '批准时偷偷换一个需求'
  });
  assert.equal(denied.ok, false);
  assert.equal(!denied.ok && denied.error.code, 'conflict');
  assert.equal(JSON.stringify([...w.store.rows.values()]), before);
  assert.equal(w.store.rows.values().next().value?.state, 'pending');
  assert.deepEqual(w.calls, { plan: 1, prepare: 0, start: 0, link: 0 });
  assert.deepEqual(w.store.writes, { allocate: 1, claim: 0, compareAndSet: 0 });
});

test('提案：权限不足时拒绝，未分配记录也未规划', async () => {
  const w = await world();
  const viewer: Principal = { ...actor, user: { ...user, role: 'viewer' } };
  const policy: AccessPolicy = {
    context: async () => ({ hubTeamId: asTeamId('team_a'), settings: { membersCanAddMachines: false } }),
    worker: async (workerId) => ({ kind: 'worker', id: workerId ?? 'local', teamId: asTeamId('team_a'), createdBy: null })
  };
  const result = await proposeWorkspaceDelegationUseCase(
    { ...w.world.deps, access: policy },
    w.store,
    w.bridges,
    { ...w.command, actor: viewer }
  );
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error.code, 'forbidden');
  assert.equal(w.calls.plan, 0);
  assert.equal(w.store.rows.size, 0);
  assert.deepEqual(w.store.writes, { allocate: 0, claim: 0, compareAndSet: 0 });
});

test('提案：旧记录缺少冻结启动配置 → conflict，不能猜默认 agent/model', async () => {
  const w = await world();
  const proposed = await proposeWorkspaceDelegationUseCase(w.world.deps, w.store, w.bridges, w.command);
  assert.ok(proposed.ok);
  w.store.rows.set(proposed.value.record.id, { ...proposed.value.record, startup: null });

  const replay = await proposeWorkspaceDelegationUseCase(w.world.deps, w.store, w.bridges, w.command);
  assert.equal(replay.ok, false);
  assert.equal(!replay.ok && replay.error.code, 'conflict');
  assert.equal(w.calls.prepare, 0);
  assert.deepEqual(w.store.writes, { allocate: 1, claim: 0, compareAndSet: 0 });
});

function directSource(projectId: string, taskId: string | null = null): DelegationDirectSource {
  return {
    sessionId: coordinatorSessionId,
    projectId: projectId as DelegationDirectSource['projectId'],
    taskId: taskId as DelegationDirectSource['taskId'],
    accountId: user.id
  };
}

function directBridges(w: World, source: DelegationDirectSource): WorkspaceDelegationDirectBridges {
  return {
    ...w.bridges,
    resolveDirectSource: async (sessionId) => (sessionId === source.sessionId ? source : null)
  };
}

function directCommand(
  w: World,
  extra: Partial<DirectDelegateWorkspaceCommand> = {}
): DirectDelegateWorkspaceCommand {
  const { coordinatorSessionId: _coordinatorSessionId, ...rest } = w.command;
  return { ...rest, sourceSessionId: coordinatorSessionId, ...extra };
}

function authorizer(
  deny: DelegationDirectAuthorizeInput['step'] | null = null,
  seen: DelegationDirectAuthorizeInput[] = []
): DelegationDirectAuthorizer {
  return async (input) => {
    seen.push(input);
    return input.step === deny ? err(forbidden('当前授权已失效')) : ok(undefined);
  };
}

function rejectingBridges(
  w: World,
  rejection: DelegationDirectSourceRejection | null
): WorkspaceDelegationDirectBridges {
  return {
    ...w.bridges,
    resolveDirectSource: async () => null,
    explainDirectSourceRejection: async (_sessionId, accountId) =>
      accountId === user.id ? rejection : null
  };
}

test('直接执行：来源不可用时只对主人给出安全、可行动的原因', async () => {
  const w = await world();
  const cases: Array<[DelegationDirectSourceRejection, string]> = [
    ['chat_only', '没有可复用的长期工作空间'],
    ['workspace_missing', '工作空间已不存在'],
    ['workspace_not_ready', '尚未就绪'],
    ['workspace_unlinked', '未关联到当前项目'],
    ['worker_mismatch', '不同的 Worker']
  ];
  for (const [reason, expected] of cases) {
    const seen: DelegationDirectAuthorizeInput[] = [];
    const result = await delegateWorkspaceDirectUseCase(
      w.world.deps,
      w.store,
      rejectingBridges(w, reason),
      authorizer(null, seen),
      directCommand(w)
    );
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.error.code, 'not_found');
    assert.match(!result.ok ? result.error.message : '', new RegExp(expected));
    assert.deepEqual(seen, []);
    assert.deepEqual(w.store.writes, { allocate: 0, claim: 0, compareAndSet: 0 });
  }
});

test('直接执行：非主人或不提供归类时保持中性 notFound', async () => {
  const w = await world();
  const other: Principal = { ...actor, user: { ...user, id: asUserId('user_other') } };

  const stranger = await delegateWorkspaceDirectUseCase(
    w.world.deps,
    w.store,
    rejectingBridges(w, 'chat_only'),
    authorizer(),
    directCommand(w, { actor: other })
  );
  assert.equal(stranger.ok, false);
  assert.equal(!stranger.ok && stranger.error.code, 'not_found');
  assert.equal(!stranger.ok ? stranger.error.message : '', '直接执行的来源会话不存在或不可用');

  const silent: WorkspaceDelegationDirectBridges = {
    ...w.bridges,
    resolveDirectSource: async () => null
  };
  const noBridge = await delegateWorkspaceDirectUseCase(
    w.world.deps,
    w.store,
    silent,
    authorizer(),
    directCommand(w)
  );
  assert.equal(noBridge.ok, false);
  assert.equal(!noBridge.ok && noBridge.error.code, 'not_found');
  assert.equal(!noBridge.ok ? noBridge.error.message : '', '直接执行的来源会话不存在或不可用');
  assert.deepEqual(w.store.writes, { allocate: 0, claim: 0, compareAndSet: 0 });
});

test('直接执行：来源诊断异常时保持中性 notFound，不透出内部错误', async () => {
  const w = await world();
  const broken: WorkspaceDelegationDirectBridges = {
    ...w.bridges,
    resolveDirectSource: async () => null,
    explainDirectSourceRejection: async () => {
      throw new Error('boom');
    }
  };
  const result = await delegateWorkspaceDirectUseCase(
    w.world.deps,
    w.store,
    broken,
    authorizer(),
    directCommand(w)
  );
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error.code, 'not_found');
  assert.equal(!result.ok ? result.error.message : '', '直接执行的来源会话不存在或不可用');
  assert.deepEqual(w.store.writes, { allocate: 0, claim: 0, compareAndSet: 0 });
});

test('直接执行：无任务会话按不可变项目直接建链，且与同键提案记录隔离', async () => {
  const w = await world();
  const source = directSource(w.project.id);
  const seen: DelegationDirectAuthorizeInput[] = [];
  const direct = await delegateWorkspaceDirectUseCase(
    w.world.deps,
    w.store,
    directBridges(w, source),
    authorizer(null, seen),
    directCommand(w)
  );
  assert.ok(direct.ok, JSON.stringify(direct));
  assert.equal(direct.value.record.mode, 'direct');
  assert.equal(direct.value.record.state, 'prepared');
  assert.equal(direct.value.claimed, true);
  assert.deepEqual(
    seen.map((input) => input.step),
    ['create', 'prepare', 'start', 'instruction']
  );
  assert.equal(seen[0]?.source.taskId, null);

  // 同来源、同请求键的提案是另一条记录；它不能领走直接执行那条。
  const proposed = await proposeWorkspaceDelegationUseCase(w.world.deps, w.store, w.bridges, w.command);
  assert.ok(proposed.ok, JSON.stringify(proposed));
  assert.notEqual(proposed.value.record.id, direct.value.record.id);
  assert.equal(proposed.value.record.mode, 'proposal');
  assert.equal(proposed.value.record.state, 'pending');
  assert.equal(w.store.rows.size, 2);

  const confirmed = await delegateWorkspaceUseCase(w.world.deps, w.store, w.bridges, w.command);
  assert.ok(confirmed.ok, JSON.stringify(confirmed));
  assert.equal(confirmed.value.record.id, proposed.value.record.id);
  assert.equal(confirmed.value.record.state, 'prepared');
  const directRow = await w.store.byId(direct.value.record.id);
  assert.equal(directRow?.mode, 'direct');
  assert.equal(directRow?.state, 'prepared');
  assert.equal(directRow?.executionSessionId, direct.value.record.executionSessionId);

  // 直接车道的同键重放只读既有记录，不重放任何副作用。
  const replay = await delegateWorkspaceDirectUseCase(
    w.world.deps,
    w.store,
    directBridges(w, source),
    authorizer(),
    directCommand(w)
  );
  assert.ok(replay.ok, JSON.stringify(replay));
  assert.equal(replay.value.claimed, false);
  assert.equal(replay.value.record.id, direct.value.record.id);
  assert.deepEqual(w.calls, { plan: 2, prepare: 2, start: 2, link: 2 });
});

test('直接执行：任务来源与目标任务同项目时可以直接建链', async () => {
  const w = await world();
  const source = directSource(w.project.id, w.task.id);
  const result = await delegateWorkspaceDirectUseCase(
    w.world.deps,
    w.store,
    directBridges(w, source),
    authorizer(),
    directCommand(w, { taskId: w.task.id })
  );
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.value.record.state, 'prepared');
  assert.equal(result.value.record.mode, 'direct');
});

test('直接执行：创建前授权被拒 → 不分配记录，也不规划', async () => {
  const w = await world();
  const result = await delegateWorkspaceDirectUseCase(
    w.world.deps,
    w.store,
    directBridges(w, directSource(w.project.id)),
    authorizer('create'),
    directCommand(w)
  );
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error.code, 'forbidden');
  assert.equal(w.store.rows.size, 0);
  assert.deepEqual(w.calls, { plan: 1, prepare: 0, start: 0, link: 0 });
});

test('直接执行：准备前撤销授权 → 记录 failed/fatal，无 worktree；同键可安全重试', async () => {
  const w = await world();
  const source = directSource(w.project.id);
  const bridges = directBridges(w, source);
  const denied = await delegateWorkspaceDirectUseCase(
    w.world.deps,
    w.store,
    bridges,
    authorizer('prepare'),
    directCommand(w)
  );
  assert.equal(denied.ok, false);
  assert.equal(!denied.ok && denied.error.code, 'forbidden');
  assert.equal(w.calls.prepare, 0);
  const [record] = [...w.store.rows.values()];
  assert.equal(record?.state, 'failed');
  assert.equal(record?.failure?.kind, 'fatal');

  const retry = await delegateWorkspaceDirectUseCase(
    w.world.deps,
    w.store,
    bridges,
    authorizer(),
    directCommand(w)
  );
  assert.ok(retry.ok, JSON.stringify(retry));
  assert.equal(retry.value.record.state, 'prepared');
  assert.equal(w.calls.prepare, 1);
});

test('直接执行：启动前撤销授权 → uncertain，不创建执行会话，也不盲目重试', async () => {
  const w = await world();
  const source = directSource(w.project.id);
  const bridges = directBridges(w, source);
  const denied = await delegateWorkspaceDirectUseCase(
    w.world.deps,
    w.store,
    bridges,
    authorizer('start'),
    directCommand(w)
  );
  assert.equal(denied.ok, false);
  assert.equal(!denied.ok && denied.error.code, 'forbidden');
  assert.equal(w.calls.prepare, 1);
  assert.equal(w.calls.start, 0);
  const [record] = [...w.store.rows.values()];
  assert.equal(record?.state, 'uncertain');
  assert.equal(record?.failure?.kind, 'uncertain');

  const retry = await delegateWorkspaceDirectUseCase(
    w.world.deps,
    w.store,
    bridges,
    authorizer(),
    directCommand(w)
  );
  assert.ok(retry.ok, JSON.stringify(retry));
  assert.equal(retry.value.claimed, false);
  assert.equal(retry.value.record.state, 'uncertain');
  assert.deepEqual(w.calls, { plan: 1, prepare: 1, start: 0, link: 0 });
});

test('直接执行：说明送达前撤销授权 → uncertain，执行会话保留但不重放', async () => {
  const w = await world();
  const source = directSource(w.project.id);
  const bridges = directBridges(w, source);
  const denied = await delegateWorkspaceDirectUseCase(
    w.world.deps,
    w.store,
    bridges,
    authorizer('instruction'),
    directCommand(w)
  );
  assert.equal(denied.ok, false);
  assert.equal(!denied.ok && denied.error.code, 'forbidden');
  assert.equal(w.calls.prepare, 1);
  assert.equal(w.calls.start, 1);
  assert.equal(w.calls.link, 0);
  const [record] = [...w.store.rows.values()];
  assert.equal(record?.state, 'uncertain');

  const retry = await delegateWorkspaceDirectUseCase(
    w.world.deps,
    w.store,
    bridges,
    authorizer(),
    directCommand(w)
  );
  assert.ok(retry.ok, JSON.stringify(retry));
  assert.equal(retry.value.claimed, false);
  assert.equal(retry.value.record.state, 'uncertain');
  assert.deepEqual(w.calls, { plan: 1, prepare: 1, start: 1, link: 0 });
});

test('归档准入：目标任务已归档 → 提案不分配、不规划', async () => {
  const w = await world();
  assert.equal(await w.world.deps.tasks.setArchived(w.task.id, 99, null), true);
  const proposed = await proposeWorkspaceDelegationUseCase(w.world.deps, w.store, w.bridges, w.command);
  assert.equal(proposed.ok, false);
  assert.equal(!proposed.ok && proposed.error.code, 'conflict');
  assert.match(!proposed.ok ? proposed.error.message : '', /已归档/);
  assert.deepEqual(w.calls, { plan: 0, prepare: 0, start: 0, link: 0 });
  assert.equal(w.store.rows.size, 0);
  assert.deepEqual(w.store.writes, { allocate: 0, claim: 0, compareAndSet: 0 });
});

test('归档准入：确认时任务已归档 → 不领取、不准备，原记录保持不动', async () => {
  const w = await world();
  assert.ok((await delegateWorkspaceUseCase(w.world.deps, w.store, w.bridges, w.command)).ok);
  assert.equal(await w.world.deps.tasks.setArchived(w.task.id, 99, null), true);

  const confirm = await delegateWorkspaceUseCase(w.world.deps, w.store, w.bridges, w.command);
  assert.equal(confirm.ok, false);
  assert.equal(!confirm.ok && confirm.error.code, 'conflict');
  assert.deepEqual(w.calls, { plan: 1, prepare: 1, start: 1, link: 1 });
  assert.deepEqual(w.store.writes, { allocate: 1, claim: 1, compareAndSet: 1 });
  assert.equal([...w.store.rows.values()][0]?.state, 'prepared');
});

test('归档准入：直接执行车道在分配前拒绝归档任务', async () => {
  const w = await world();
  const source = directSource(w.project.id, w.task.id);
  assert.equal(await w.world.deps.tasks.setArchived(w.task.id, 99, null), true);
  const seen: DelegationDirectAuthorizeInput[] = [];
  const direct = await delegateWorkspaceDirectUseCase(
    w.world.deps,
    w.store,
    directBridges(w, source),
    authorizer(null, seen),
    directCommand(w)
  );
  assert.equal(direct.ok, false);
  assert.equal(!direct.ok && direct.error.code, 'conflict');
  assert.deepEqual(w.calls, { plan: 0, prepare: 0, start: 0, link: 0 });
  assert.equal(w.store.rows.size, 0);
  assert.equal(seen.length, 0);
});
