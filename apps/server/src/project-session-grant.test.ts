import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TOOL_SCOPES,
  PROJECT_TASK_WRITE_TOOL_SCOPE,
  PROJECT_WORKTREE_OPEN_TOOL_SCOPE,
  WORKSPACE_REPORT_SCOPE,
  asProjectId,
  asSessionId,
  asTaskId,
  forbidden,
  type DomainError,
  type GrantActor,
  type ProjectId,
  type ProjectSessionGrant,
  type ProjectSessionGrantRepository,
  type ProjectSessionGrantScope,
  type Result,
  type Session,
  type Task,
  type ToolScope,
  type WorkspaceDelegation
} from '@agent-hub/domain';
import { err, ok } from '@agent-hub/domain';
import {
  createProjectSessionGrantService,
  type ProjectSessionGrantSource
} from './project-session-grant.ts';

const now = () => 10_000;
const human: GrantActor = { userId: 'u1', via: 'web' };

function fakeGrants() {
  const rows = new Map<string, ProjectSessionGrant>();
  const key = (accountId: string, sessionId: string, projectId: string) => `${accountId}|${sessionId}|${projectId}`;
  const repo: ProjectSessionGrantRepository = {
    async save(grant) {
      const existing = rows.get(key(grant.accountId, grant.sessionId, grant.projectId));
      const stored = existing ? { ...grant, id: existing.id, createdAt: existing.createdAt } : { ...grant };
      rows.set(key(grant.accountId, grant.sessionId, grant.projectId), stored);
      return stored;
    },
    async byKey(accountId, sessionId, projectId) {
      return rows.get(key(accountId, sessionId, projectId)) ?? null;
    },
    async byId(id) {
      return [...rows.values()].find((row) => row.id === id) ?? null;
    },
    async listBySession(sessionId) {
      return [...rows.values()].filter((row) => row.sessionId === sessionId);
    },
    async listByAccount(accountId) {
      return [...rows.values()].filter((row) => row.accountId === accountId);
    },
    async revoke(id, at, by) {
      const row = [...rows.values()].find((entry) => entry.id === id);
      if (!row || row.revokedAt !== null) return false;
      Object.assign(row, { revokedAt: at, revokedBy: by });
      return true;
    },
    async revokeSession(accountId, sessionId, at, by) {
      const owned = [...rows.values()].filter(
        (row) => row.accountId === accountId && row.sessionId === sessionId && row.revokedAt === null
      );
      for (const row of owned) Object.assign(row, { revokedAt: at, revokedBy: by });
      return owned.length;
    }
  };
  return { repo, rows };
}

interface WorldOptions {
  readonly taskId?: ReturnType<typeof asTaskId> | null;
  readonly originProjectId?: ProjectId | null;
  readonly createdBy?: string | null;
  readonly projectId?: ProjectId;
  readonly child?: boolean;
  readonly active?: boolean;
  readonly sourceAllowed?: boolean;
  readonly actorVia?: GrantActor['via'];
  readonly invalidateThrows?: boolean;
  readonly canReport?: (actor?: GrantActor) => boolean;
}

function world(options: WorldOptions = {}) {
  const projectId = options.projectId ?? asProjectId('p1');
  const taskId = options.taskId === undefined ? asTaskId('t1') : options.taskId;
  const session = {
    id: asSessionId('s1'),
    taskId,
    originProjectId: options.originProjectId ?? null,
    createdBy: options.createdBy === undefined ? 'u1' : options.createdBy
  } as unknown as Session;
  const task = { id: asTaskId('t1'), projectId } as unknown as Task;
  const { repo, rows } = fakeGrants();
  const delegation = options.child ? ({ id: 'd1', executionSessionId: session.id } as unknown as WorkspaceDelegation) : null;
  const permissionCalls: ProjectSessionGrantScope[] = [];
  const deniedScopes = new Set<ProjectSessionGrantScope>();
  const invalidations: string[] = [];
  const sourceCalls: ProjectSessionGrantSource[] = [];

  const service = createProjectSessionGrantService({
    now,
    projectSessionGrants: repo,
    sessions: { byId: async (id) => (id === session.id ? session : null) },
    tasks: { byId: async (id) => (taskId !== null && id === taskId ? task : null) },
    workspaceDelegations: { byExecutionSession: async (id) => (id === session.id ? delegation : null) },
    canReportDelegation: async (_sessionId, actor) => options.canReport?.(actor) ?? false,
    loadActor: async (accountId) =>
      options.active === false ? null : { userId: accountId, via: options.actorVia ?? 'web' },
    sourceEligible: async (input) => {
      sourceCalls.push(input);
      return options.sourceAllowed ?? true;
    },
    checkCurrentPermission: async (input): Promise<Result<void, DomainError>> => {
      permissionCalls.push(input.scope);
      return deniedScopes.has(input.scope) ? err(forbidden('当前没有这项权限')) : ok(undefined);
    },
    invalidateSessionTools: async (sessionId) => {
      invalidations.push(sessionId);
      if (options.invalidateThrows) throw new Error('gateway down');
    }
  });
  return {
    service,
    session,
    task,
    repo,
    rows,
    permissionCalls,
    deniedScopes,
    invalidations,
    sourceCalls,
    projectId
  };
}

function seedGrant(w: ReturnType<typeof world>, scopes: readonly ProjectSessionGrantScope[] = ['task:write']): ProjectSessionGrant {
  const row: ProjectSessionGrant = {
    id: 'seeded',
    accountId: 'u1',
    sessionId: w.session.id,
    projectId: w.projectId,
    scopes,
    createdBy: 'u1',
    createdAt: now(),
    expiresAt: null,
    revokedAt: null,
    revokedBy: null
  };
  w.rows.set(`u1|${w.session.id}|${w.projectId}`, row);
  return row;
}

test('服务层：未登录/已停用账号、非归属人、无记录都拿不到授权（默认拒绝）', async () => {
  const w = world();
  const grant = await w.service.grant({ accountId: 'u1', sessionId: w.session.id, projectId: w.projectId, scopes: ['task:write'] });
  assert.equal(grant.ok, true);
  assert.equal((await w.service.authorize({ actor: human, sessionId: w.session.id, scope: 'task:write' })).ok, true);

  const disabled = world({ active: false });
  assert.equal(
    (await disabled.service.grant({ accountId: 'u1', sessionId: disabled.session.id, projectId: disabled.projectId, scopes: ['task:write'] })).ok,
    false
  );

  const foreign = world({ createdBy: 'u2' });
  assert.equal(
    (await foreign.service.grant({ accountId: 'u1', sessionId: foreign.session.id, projectId: foreign.projectId, scopes: ['task:write'] })).ok,
    false
  );

  const noRecord = world();
  assert.equal((await noRecord.service.authorize({ actor: human, sessionId: noRecord.session.id, scope: 'task:write' })).ok, false);
});

test('服务层：authorize 每次重新读账号；冻结主体的 via 变了也拒绝', async () => {
  const w = world();
  await w.service.grant({ accountId: 'u1', sessionId: w.session.id, projectId: w.projectId, scopes: ['task:write'] });
  assert.equal((await w.service.authorize({ actor: { userId: 'u1', via: 'bot' }, sessionId: w.session.id, scope: 'task:write' })).ok, false);

  const stale = world({ actorVia: 'group' });
  seedGrant(stale);
  assert.equal((await stale.service.authorize({ actor: human, sessionId: stale.session.id, scope: 'task:write' })).ok, false);
  assert.equal((await stale.service.authorize({ sessionId: stale.session.id, scope: 'task:write' })).ok, false, '当前加载结果不是 web 主体也拒绝');

  const current = world();
  seedGrant(current);
  assert.equal((await current.service.authorize({ sessionId: current.session.id, scope: 'task:write' })).ok, true, '不传旧 actor 时以当前加载结果为准');
});

test('服务层：撤销后当前策略立即拒绝；项目漂移后旧授权失效；归属人以外撤不掉/看不到', async () => {
  const w = world();
  await w.service.grant({ accountId: 'u1', sessionId: w.session.id, projectId: w.projectId, scopes: ['task:write'] });

  assert.equal((await w.service.revoke({ accountId: 'u2', sessionId: w.session.id })).ok, false);
  assert.equal((await w.service.list({ accountId: 'u2', sessionId: w.session.id })).ok, false);
  assert.equal((await w.service.authorize({ actor: human, sessionId: w.session.id, scope: 'task:write' })).ok, true);

  assert.equal((await w.service.revoke({ accountId: 'u1', sessionId: w.session.id })).ok, true);
  assert.equal((await w.service.authorize({ actor: human, sessionId: w.session.id, scope: 'task:write' })).ok, false, '撤销立即生效');

  // 重新授权后把任务挪到别的项目：每次动作都按当前绑定复核 → 旧项目授权不适用。
  await w.service.grant({ accountId: 'u1', sessionId: w.session.id, projectId: w.projectId, scopes: ['task:write'] });
  (w.task as unknown as { projectId: ProjectId }).projectId = asProjectId('p2');
  assert.equal((await w.service.authorize({ actor: human, sessionId: w.session.id, scope: 'task:write' })).ok, false);
  const cap = await w.service.toolScopeCap(w.session);
  assert.ok(cap);
  assert.equal(cap.includes(PROJECT_TASK_WRITE_TOOL_SCOPE), false, 'scopeCap 也按当前绑定，不跨项目取旧授权');
});

test('服务层：无任务会话按不可变来源绑定；没有来源 / 非 web 主体全部拒绝', async () => {
  const w = world({ taskId: null, originProjectId: asProjectId('p9'), projectId: asProjectId('p9') });
  assert.equal(
    (await w.service.grant({ accountId: 'u1', sessionId: w.session.id, projectId: asProjectId('p9'), scopes: ['project:read'] })).ok,
    true
  );
  assert.equal((await w.service.authorize({ actor: human, sessionId: w.session.id, scope: 'project:read' })).ok, true);
  assert.equal(
    (await w.service.authorize({ actor: { userId: 'u1', via: 'bot' }, sessionId: w.session.id, scope: 'project:read' })).ok,
    false
  );

  const orphan = world({ taskId: null, originProjectId: null, projectId: asProjectId('p9') });
  assert.equal((await orphan.service.authorize({ actor: human, sessionId: orphan.session.id, scope: 'project:read' })).ok, false);
});

test('服务层：grant 逐项复核现有权限；任一项不通过都不落库', async () => {
  const w = world();
  w.deniedScopes.add('worktree:open');
  const denied = await w.service.grant({
    accountId: 'u1',
    sessionId: w.session.id,
    projectId: w.projectId,
    scopes: ['task:write', 'worktree:open']
  });
  assert.equal(denied.ok, false);
  assert.deepEqual(w.permissionCalls, ['task:write', 'worktree:open']);
  assert.equal(w.rows.size, 0);

  w.deniedScopes.clear();
  const granted = await w.service.grant({
    accountId: 'u1',
    sessionId: w.session.id,
    projectId: w.projectId,
    scopes: ['task:write', 'worktree:open']
  });
  assert.equal(granted.ok, true);
  assert.deepEqual(w.permissionCalls, ['task:write', 'worktree:open', 'task:write', 'worktree:open']);
});

test('服务层：authorize 每次都过当前权限复核（task.create / project.update 由父层映射）', async () => {
  const w = world();
  await w.service.grant({
    accountId: 'u1',
    sessionId: w.session.id,
    projectId: w.projectId,
    scopes: ['task:write', 'worktree:open']
  });
  w.permissionCalls.length = 0;
  assert.equal((await w.service.authorize({ actor: human, sessionId: w.session.id, scope: 'task:write' })).ok, true);
  assert.equal((await w.service.authorize({ actor: human, sessionId: w.session.id, scope: 'worktree:open' })).ok, true);
  assert.deepEqual(w.permissionCalls, ['task:write', 'worktree:open']);

  w.deniedScopes.add('task:write');
  assert.equal((await w.service.authorize({ actor: human, sessionId: w.session.id, scope: 'task:write' })).ok, false, '当前权限丢了立即拒绝');
});

test('服务层：撤销 / 查看只认归属人；任务权限丢失后仍能撤权', async () => {
  const w = world();
  await w.service.grant({ accountId: 'u1', sessionId: w.session.id, projectId: w.projectId, scopes: ['task:write'] });
  w.deniedScopes.add('task:write');
  w.permissionCalls.length = 0;

  assert.equal((await w.service.list({ accountId: 'u1', sessionId: w.session.id })).ok, true);
  const revoked = await w.service.revoke({ accountId: 'u1', sessionId: w.session.id });
  assert.equal(revoked.ok, true);
  assert.deepEqual(w.permissionCalls, [], '撤权不复核任务权限');
});

test('服务层：受限子会话（executionSessionId 命中）不能获得项目授权，也不继承历史授权', async () => {
  const w = world({ child: true });
  const grant = await w.service.grant({ accountId: 'u1', sessionId: w.session.id, projectId: w.projectId, scopes: ['task:write'] });
  assert.equal(grant.ok, false, '子会话不能自己拿授权');

  // 历史记录（例如派工前留下的）也不能被动作入口使用。
  seedGrant(w);
  assert.deepEqual(await w.service.projectExtraScopes({ session: w.session, actor: human }), [], '不给项目工具 scope');
  const scopes = await w.service.toolScopes({ session: w.session, actor: human });
  assert.ok(scopes);
  for (const scope of ['task:create', 'git', 'session:control', 'agent:message', 'project', PROJECT_TASK_WRITE_TOOL_SCOPE, PROJECT_WORKTREE_OPEN_TOOL_SCOPE] as ToolScope[]) {
    assert.equal(scopes.includes(scope), false, `不得继承 ${scope}`);
  }
  assert.ok(scopes.includes('task:read'));

  assert.equal((await w.service.authorize({ actor: human, sessionId: w.session.id, scope: 'task:write' })).ok, false, '动作入口也拒绝');

  const cap = await w.service.toolScopeCap(w.session);
  assert.ok(cap);
  assert.equal(cap.includes(PROJECT_TASK_WRITE_TOOL_SCOPE), false);
  assert.equal(cap.includes('git'), false);
});

test('服务层：仅受限子会话可获得回报 scope，身份或当前授权失效时收回', async () => {
  let active = true;
  const canReport = (actor?: GrantActor) => active && actor?.userId === human.userId && actor.via === human.via;
  const child = world({ child: true, canReport });
  const ordinary = world({ canReport });
  const scopes = await child.service.toolScopes({ session: child.session, actor: human });
  assert.ok(scopes);
  assert.ok(scopes.includes(WORKSPACE_REPORT_SCOPE));
  assert.ok(!scopes.includes('agent:message'));
  assert.ok(!scopes.includes(PROJECT_WORKTREE_OPEN_TOOL_SCOPE));
  assert.ok((await child.service.toolScopeCap(child.session, human))?.includes(WORKSPACE_REPORT_SCOPE));
  assert.ok(!(await child.service.toolScopeCap(child.session))?.includes(WORKSPACE_REPORT_SCOPE));
  assert.ok(!(await ordinary.service.toolScopeCap(ordinary.session, human))?.includes(WORKSPACE_REPORT_SCOPE));
  active = false;
  assert.ok(!(await child.service.toolScopeCap(child.session, human))?.includes(WORKSPACE_REPORT_SCOPE));
});

test('服务层：普通会话 toolScopes 返回 null（保持既有默认），项目 scope 只来自当前有效授权', async () => {
  const w = world();
  assert.equal(await w.service.toolScopes({ session: w.session, actor: human }), null);

  assert.deepEqual(await w.service.projectExtraScopes({ session: w.session, actor: human }), []);
  assert.deepEqual(await w.service.projectExtraScopes({ session: w.session }), [], '没有冻结主体时不追加项目 scope');
  assert.equal((await w.service.toolScopeCap(w.session))?.includes(PROJECT_TASK_WRITE_TOOL_SCOPE), false);

  await w.service.grant({ accountId: 'u1', sessionId: w.session.id, projectId: w.projectId, scopes: ['task:write'] });
  assert.deepEqual(await w.service.projectExtraScopes({ session: w.session, actor: human }), [PROJECT_TASK_WRITE_TOOL_SCOPE]);
  assert.equal((await w.service.toolScopeCap(w.session))?.includes(PROJECT_TASK_WRITE_TOOL_SCOPE), true);

  await w.service.revoke({ accountId: 'u1', sessionId: w.session.id });
  assert.deepEqual(await w.service.projectExtraScopes({ session: w.session, actor: human }), []);
  assert.equal((await w.service.toolScopeCap(w.session))?.includes(PROJECT_TASK_WRITE_TOOL_SCOPE), false);
});

test('服务层：旧令牌的 scopeCap 只收窄项目 scope，普通默认能力不受影响', async () => {
  const w = world();
  await w.service.grant({ accountId: 'u1', sessionId: w.session.id, projectId: w.projectId, scopes: ['task:write', 'worktree:open'] });
  const cap = await w.service.toolScopeCap(w.session);
  assert.ok(cap);
  assert.ok(cap.includes(PROJECT_TASK_WRITE_TOOL_SCOPE));
  assert.ok(cap.includes(PROJECT_WORKTREE_OPEN_TOOL_SCOPE));
  for (const scope of DEFAULT_TOOL_SCOPES) assert.ok(cap.includes(scope), `保留默认 ${scope}`);

  await w.service.revoke({ accountId: 'u1', sessionId: w.session.id });
  const narrowed = await w.service.toolScopeCap(w.session);
  assert.ok(narrowed);
  assert.equal(narrowed.includes(PROJECT_TASK_WRITE_TOOL_SCOPE), false);
  assert.ok(narrowed.includes('git'), '普通默认工具不因项目授权撤销被砍掉');
});

test('服务层：撤销 / 缩小 / 撤销后重授权都会让旧工具令牌失效；首次授权不动旧令牌', async () => {
  const w = world();
  await w.service.grant({ accountId: 'u1', sessionId: w.session.id, projectId: w.projectId, scopes: ['task:write'] });
  assert.deepEqual(w.invalidations, [], '首次授权时旧令牌本来就没有项目 scope');

  await w.service.grant({ accountId: 'u1', sessionId: w.session.id, projectId: w.projectId, scopes: ['task:write'] });
  assert.deepEqual(w.invalidations, [], '同 scope 续期不换令牌');

  await w.service.grant({ accountId: 'u1', sessionId: w.session.id, projectId: w.projectId, scopes: ['worktree:open'] });
  assert.deepEqual(w.invalidations, [w.session.id], 'scope 缩小要作废旧令牌，避免旧集合静默恢复');

  await w.service.revoke({ accountId: 'u1', sessionId: w.session.id });
  assert.deepEqual(w.invalidations, [w.session.id, w.session.id], '撤销要作废旧令牌');

  await w.service.grant({ accountId: 'u1', sessionId: w.session.id, projectId: w.projectId, scopes: ['task:write'] });
  assert.deepEqual(w.invalidations, [w.session.id, w.session.id, w.session.id], '撤销后重授权也要作废旧令牌');
});

test('服务层：来源资格回调缺失即拒绝操作；回调返回 false 时 grant/revoke/list/authorize 全拒绝', async () => {
  const w = world({ sourceAllowed: false });
  seedGrant(w);
  assert.equal((await w.service.grant({ accountId: 'u1', sessionId: w.session.id, projectId: w.projectId, scopes: ['task:write'] })).ok, false);
  assert.equal((await w.service.revoke({ accountId: 'u1', sessionId: w.session.id })).ok, false);
  assert.equal((await w.service.list({ accountId: 'u1', sessionId: w.session.id })).ok, false);
  assert.equal((await w.service.authorize({ actor: human, sessionId: w.session.id, scope: 'task:write' })).ok, false);
  assert.deepEqual(w.sourceCalls.map((call) => call.action), ['grant', 'revoke', 'list', 'authorize']);
});

test('服务层：令牌失效失败按拒绝处理，不留下「旧令牌 + 新授权」', async () => {
  const w = world({ invalidateThrows: true });
  const first = await w.service.grant({ accountId: 'u1', sessionId: w.session.id, projectId: w.projectId, scopes: ['task:write'] });
  assert.equal(first.ok, true);
  const changed = await w.service.grant({ accountId: 'u1', sessionId: w.session.id, projectId: w.projectId, scopes: ['worktree:open'] });
  assert.equal(changed.ok, false);
  assert.deepEqual([...(await w.repo.byKey('u1', w.session.id, w.projectId))?.scopes ?? []], ['task:write'], '保存未发生');
});
