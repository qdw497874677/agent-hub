import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDescriptor } from '../agent.ts';
import { asAgentId, asProjectId, asSessionId, asTaskId } from '../ids.ts';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { createProjectUseCase } from './projects.ts';
import { createTaskUseCase } from './tasks.ts';
import { deriveSessionUseCase } from './sessions.ts';
import { createToolGateway, withToolAccess } from "./tool-gateway.ts";
import { createTaskToolProvider } from "../tools/task-tools.ts";
import { fakeToolGrants } from "../testing/in-memory.ts";
import { DEFAULT_TOOL_SCOPES, TOOL_SCOPES, WORKSPACE_DELEGATE_SCOPE } from "../tool.ts";
import type { WorkerCommand } from "../ports/node-gateway.ts";


const fake: AgentDescriptor = {
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

let counter = 0;
const tokens = {
  issue: () => {
    counter += 1;
    return { token: `tok-${counter}`, hash: `h-tok-${counter}` };
  },
  hashOf: (token: string) => `h-${token}`
};

async function world() {
  const w = inMemoryDeps();
  w.agents.push(fake);
  const project = await createProjectUseCase(w.deps, { name: 'demo', rootPath: '/tmp/demo', description: '仓库：git@example.com:me/demo.git' });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: '接通能力层', ownerId: 'u1' });
  assert.ok(task.ok);
  const session = await deriveSessionUseCase(w.deps, { taskId: task.value.id, agentId: 'fake', model: 'm1' });
  assert.ok(session.ok);
  const toolGrants = fakeToolGrants();
  let now = 1_000;
  const gateway = createToolGateway({
    now: () => now,
    toolGrants,
    tokens,
    providers: [createTaskToolProvider(w.deps)]
  });
  return { ...w, task: task.value, session: session.value, gateway, toolGrants, tick: (ms: number) => (now += ms) };
}

test('签发授权：令牌换得到授权；重新签发作废旧的；作废/过期后不认', async () => {
  const w = await world();
  const first = await w.gateway.issue(w.session);
  assert.equal((await w.gateway.authenticate(first.token))?.id, first.grant.id);
  assert.equal(w.toolGrants.grants[0]?.tokenHash.includes(first.token), true, 'fake hash');
  const second = await w.gateway.issue(w.session);
  assert.equal(await w.gateway.authenticate(first.token), null);
  assert.ok(await w.gateway.authenticate(second.token));
  w.tick(31 * 24 * 60 * 60 * 1000);
  assert.equal(await w.gateway.authenticate(second.token), null);
  assert.equal(await w.gateway.authenticate(''), null);
});

test('授权滑动续期：闲置 7 天过期；一直在用就续，但签发后最多 30 天', async () => {
  const w = await world();
  const idle = await w.gateway.issue(w.session);
  w.tick(8 * 24 * 60 * 60 * 1000);
  assert.equal(await w.gateway.authenticate(idle.token), null, '闲置超过 7 天即失效');

  const busy = await w.gateway.issue(w.session);
  for (let day = 0; day < 29; day += 1) {
    w.tick(20 * 60 * 60 * 1000);
    assert.ok(await w.gateway.authenticate(busy.token), `第 ${day} 次续期`);
  }
  w.tick(8 * 24 * 60 * 60 * 1000);
  assert.equal(await w.gateway.authenticate(busy.token), null, '超过最长寿命');
});

test('revokeAllExcept：只保留运行中会话的授权（hub 启动时）；传空 = 全部作废', async () => {
  const w = await world();
  const kept = await w.gateway.issue(w.session);
  const other = { ...w.session, id: 'other-session' as typeof w.session.id };
  const stale = await w.gateway.issue(other);
  assert.equal(await w.gateway.revokeAllExcept([w.session.id]), 1);
  assert.ok(await w.gateway.authenticate(kept.token));
  assert.equal(await w.gateway.authenticate(stale.token), null);
  assert.equal(await w.gateway.revokeAllExcept([]), 1);
  assert.equal(await w.gateway.authenticate(kept.token), null);
});

test('task.get / task.log.append / task.log.list：隐式绑定当前任务，agent 署名，写日志刷新 summary', async () => {
  const w = await world();
  const { grant } = await w.gateway.issue(w.session);
  assert.deepEqual(
    w.gateway.list(grant).map((tool) => tool.name),
    ['task.get', 'task.log.list', 'task.log.append', 'task.update_status']
  );
  const appended = await w.gateway.call(grant, 'task.log.append', { body: '## 已完成\n- 接好 MCP\n\n## 下一步\n- 写测试' });
  assert.ok(appended.ok);
  const got = await w.gateway.call(grant, 'task.get', {});
  assert.ok(got.ok);
  const task = got.value as { title: string; summary: string; latestEntry: { author: { kind: string; agentId: string } }; sessions: { current: boolean }[] };
  assert.equal(task.title, '接通能力层');
  assert.match(task.summary, /接好 MCP/);
  assert.equal(task.latestEntry.author.kind, 'agent');
  assert.equal(task.latestEntry.author.agentId, 'fake');
  assert.equal(task.sessions[0]?.current, true);
  assert.equal((got.value as { project: { description: string } }).project.description, '仓库：git@example.com:me/demo.git');
  const listed = await w.gateway.call(grant, 'task.log.list', { limit: 5 });
  assert.ok(listed.ok);
  assert.ok((listed.value as { entries: { author: { kind: string } }[] }).entries.some((e) => e.author.kind === 'agent'));
  // 审计：每次调用一条，正文只记长度
  assert.equal(w.toolGrants.calls.length, 3);
  assert.match(w.toolGrants.calls[0]?.detail ?? '', /body=<\d+ 字>/);
});

test('权限、校验与限流：body 必须是字符串；旧版的 kind 参数被忽略；agent 不能收尾；超频返回错误不断开', async () => {
  const w = await world();
  const { grant } = await w.gateway.issue(w.session, ['task:read']);
  const denied = await w.gateway.call(grant, 'task.log.append', { body: 'x' });
  assert.equal(denied.ok ? null : denied.error.code, 'forbidden');
  assert.equal(w.gateway.list(grant).length, 2);

  const full = (await w.gateway.issue(w.session)).grant;
  const system = await w.gateway.call(full, 'task.log.append', { body: 42 });
  assert.equal(system.ok ? null : system.error.code, 'invalid');
  const done = await w.gateway.call(full, 'task.update_status', { status: 'done' });
  assert.equal(done.ok, false);
  const review = await w.gateway.call(full, 'task.update_status', { status: 'in_review', note: '可以验收' });
  assert.ok(review.ok);
  assert.equal((await w.deps.tasks.byId(w.task.id))?.status, 'in_review');
  assert.equal((review.value as { changed: boolean }).changed, true);
  // 系统日志点名是哪个 agent 改的，并挂在它的会话上
  const logged = (await w.deps.workLog.list(w.task.id, { limit: 5 })).find((e) => /待验收/.test(e.body));
  assert.match(logged?.body ?? '', /^agent fake/);
  assert.equal(logged?.sessionId, w.session.id);
  // 重复设同一个状态：明确告诉模型「没变」，免得它反复重试
  const again = await w.gateway.call(full, 'task.update_status', { status: 'in_review' });
  assert.ok(again.ok);
  assert.equal((again.value as { changed: boolean }).changed, false);

  // 上面那次被拒的 append 也算一次 append：再来 9 次刚好用满 10 次/分钟
  assert.ok((await w.gateway.call(full, 'task.log.append', { kind: 'handoff', body: '旧客户端带 kind' })).ok);
  for (let i = 0; i < 8; i += 1) assert.ok((await w.gateway.call(full, 'task.log.append', { body: `n${i}` })).ok);
  const limited = await w.gateway.call(full, 'task.log.append', { body: 'too many' });
  assert.match(limited.ok ? '' : limited.error.message, /太频繁/);
  w.tick(61_000);
  assert.ok((await w.gateway.call(full, 'task.log.append', { body: 'ok again' })).ok);
});

test('隐藏工具：不在 list 里、能按名调用、不占授权总配额', async () => {
  const w = await world();
  let calls = 0;
  const gateway = createToolGateway({
    now: () => 1_000,
    toolGrants: fakeToolGrants(),
    tokens,
    perMinute: 2,
    providers: [
      createTaskToolProvider(w.deps),
      { id: 'ctx', tools: () => [{ name: 'context.transform', version: 1, scope: 'context', perMinute: 100, hidden: true, description: 'x', inputSchema: { type: 'object' } }], call: async () => ({ ok: true, value: { n: ++calls } }) as never }
    ]
  });
  const { grant } = await gateway.issue(w.session);
  assert.ok(!gateway.list(grant).some((t) => t.name === 'context.transform'));
  for (let i = 0; i < 5; i++) assert.ok((await gateway.call(grant, 'context.transform', {})).ok);
  assert.ok((await gateway.call(grant, 'task.get', {})).ok !== undefined);
  assert.equal(calls, 5);
});

test('授权冻结来源身份：签发时带 actor 就存下来，不带就是 undefined（#221 步骤 3）', async () => {
  const w = await world();
  const withActor = await w.gateway.issue(w.session, ['task:read'], { userId: 'u-1', via: 'group' });
  assert.deepEqual(withActor.grant.actor, { userId: 'u-1', via: 'group' });
  const plain = await w.gateway.issue(w.session, ['task:read']);
  assert.equal(plain.grant.actor, undefined);
});


function startCommand(session: { id: string; taskId: string | null; workerId: string | null; agentId: string }): WorkerCommand {
  return {
    kind: 'start_session',
    sessionId: session.id as never,
    workerId: session.workerId ?? 'local',
    taskId: session.taskId as never,
    agentId: session.agentId,
    workspaceRoot: '/tmp/demo',
    origin: { kind: 'derive' },
    resume: null,
    options: {}
  };
}

test('workspace:delegate 不在默认授权；只有 extraScopes 明确返回时才追加', async () => {
  const w = await world();
  assert.ok(TOOL_SCOPES.includes(WORKSPACE_DELEGATE_SCOPE));
  assert.equal(DEFAULT_TOOL_SCOPES.includes(WORKSPACE_DELEGATE_SCOPE), false);

  const seen: { session: { id: string; taskId: string | null; workerId: string }; actor?: { userId: string | null; via: string } }[] = [];
  const command = await withToolAccess(
    w.gateway,
    { url: 'http://hub/mcp', transport: 'relay' },
    startCommand(w.session),
    { userId: 'u1', via: 'web' },
    {
      extraScopes: async (input) => {
        seen.push(input as never);
        return [WORKSPACE_DELEGATE_SCOPE];
      }
    }
  );
  const token = (command as { tools?: { token: string } }).tools?.token;
  assert.ok(token);
  const grant = await w.gateway.authenticate(token);
  assert.ok(grant?.scopes.includes(WORKSPACE_DELEGATE_SCOPE));
  assert.ok(grant?.scopes.includes('session:control'));
  assert.deepEqual(seen[0]?.session, { id: w.session.id, taskId: w.session.taskId, workerId: w.session.workerId ?? 'local' });
  assert.deepEqual(seen[0]?.actor, { userId: 'u1', via: 'web' });
});

test('extraScopes 抛错只丢额外 scope，默认工具授权照发', async () => {
  const w = await world();
  const command = await withToolAccess(
    w.gateway,
    { url: 'http://hub/mcp', transport: 'relay' },
    startCommand(w.session),
    { userId: 'u1', via: 'web' },
    { extraScopes: () => { throw new Error('registry down'); } }
  );
  const token = (command as { tools?: { token: string } }).tools?.token;
  assert.ok(token);
  const grant = await w.gateway.authenticate(token);
  assert.ok(grant);
  assert.equal(grant?.scopes.includes(WORKSPACE_DELEGATE_SCOPE), false);
  assert.ok(grant?.scopes.includes('session:control'));
});

test('审计摘要把 instructions 只记成长度，短内容也不落库', async () => {
  const w = await world();
  const toolGrants = fakeToolGrants();
  const gateway = createToolGateway({
    now: () => 1_000,
    toolGrants,
    tokens,
    providers: [
      {
        id: 'audit',
        tools: () => [{ name: 'audit.echo', version: 1, scope: 'context', description: 'x', inputSchema: { type: 'object' } }],
        call: async () => ({ ok: true, value: {} })
      }
    ]
  });
  const { grant } = await gateway.issue(w.session);
  const result = await gateway.call(grant, 'audit.echo', { instructions: 'hi' });
  assert.ok(result.ok);
  assert.equal(toolGrants.calls[0]?.detail, 'instructions=<2 字>');
});

test('敏感工具的审计只记录结果，不记录参数或错误正文', async () => {
  const w = await world();
  const toolGrants = fakeToolGrants();
  const gateway = createToolGateway({
    now: () => 1_000, toolGrants, tokens,
    providers: [{
      id: 'audit',
      tools: () => [{ name: 'audit.sensitive', version: 1, scope: 'context', description: 'x', inputSchema: {}, omitAuditPayload: true }],
      call: async (_name, input) => {
        if (input === 'throw') throw new Error('private content');
        return { ok: true, value: {} };
      }
    }]
  });
  const { grant } = await gateway.issue(w.session);
  assert.ok((await gateway.call(grant, 'audit.sensitive', { files: [{ content: 'private content' }] })).ok);
  assert.equal((await gateway.call(grant, 'audit.sensitive', 'throw')).ok, false);
  assert.deepEqual(toolGrants.calls.map(({ detail }) => detail), ['ok', 'invalid']);
});

// ── 项目会话显式授权（docs/design/project-session-mcp.md §25-§31） ─────────────

type ProjectGrant = import('../project-session-grant.ts').ProjectSessionGrant;

function fakeProjectGrants() {
  const rows = new Map<string, ProjectGrant>();
  const key = (accountId: string, sessionId: string, projectId: string) => `${accountId}|${sessionId}|${projectId}`;
  const repo: import('../project-session-grant.ts').ProjectSessionGrantRepository = {
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

const domainNow = () => 5_000;
const taskSession = {
  id: asSessionId('s-task'),
  taskId: asTaskId('t1'),
  originProjectId: null,
  createdBy: 'u1'
};
const taskProject = { projectId: asProjectId('p1') };
const human = { userId: 'u1', via: 'web' as const };

test('项目绑定：任务会话核任务项目；无任务会话核不可变来源；冲突/缺失/非归属人全部拒绝', async () => {
  const { resolveProjectSessionBinding } = await import('../project-session-grant.ts');
  const taskBound = resolveProjectSessionBinding({ actor: human, session: taskSession, task: taskProject, projectId: asProjectId('p1') });
  assert.equal(taskBound.ok, true);
  const drifted = resolveProjectSessionBinding({ actor: human, session: taskSession, task: taskProject, projectId: asProjectId('p2') });
  assert.equal(drifted.ok, false);
  const conflict = resolveProjectSessionBinding({
    actor: human,
    session: { ...taskSession, originProjectId: asProjectId('p2') },
    task: taskProject,
    projectId: asProjectId('p1')
  });
  assert.equal(conflict.ok, false);

  const taskless = { id: asSessionId('s-container'), taskId: null, originProjectId: asProjectId('p1'), createdBy: 'u1' };
  assert.equal(resolveProjectSessionBinding({ actor: human, session: taskless, task: null, projectId: asProjectId('p1') }).ok, true);
  assert.equal(resolveProjectSessionBinding({ actor: human, session: taskless, task: null, projectId: asProjectId('p2') }).ok, false);
  assert.equal(resolveProjectSessionBinding({ actor: human, session: { ...taskless, originProjectId: null }, task: null, projectId: asProjectId('p1') }).ok, false);
  assert.equal(resolveProjectSessionBinding({ actor: { userId: 'u2', via: 'web' }, session: taskSession, task: taskProject, projectId: asProjectId('p1') }).ok, false);
  assert.equal(resolveProjectSessionBinding({ actor: { userId: 'u1', via: 'bot' }, session: taskSession, task: taskProject, projectId: asProjectId('p1') }).ok, false);
});

test('项目授权：默认无记录即拒绝；逐项 scope；撤销后当前策略立即拒绝；归属人以外不能撤销', async () => {
  const {
    grantProjectSession, checkProjectSessionGrant, requireProjectSessionScope, revokeProjectSessionGrants
  } = await import('../project-session-grant.ts');
  const { repo } = fakeProjectGrants();
  const deps = { now: domainNow, projectSessionGrants: repo };
  const input = { actor: human, session: taskSession, task: taskProject, projectId: asProjectId('p1') };

  assert.equal((await checkProjectSessionGrant(deps, input)).ok, false, '没有授权记录 = 默认拒绝');

  const granted = await grantProjectSession(deps, { ...input, scopes: ['task:write'] });
  assert.equal(granted.ok, true);
  assert.equal((await requireProjectSessionScope(deps, { ...input, scope: 'task:write' })).ok, true);
  assert.equal((await requireProjectSessionScope(deps, { ...input, scope: 'worktree:open' })).ok, false);

  const foreign = await revokeProjectSessionGrants(deps, { actor: { userId: 'u2', via: 'web' }, sessionId: taskSession.id });
  assert.equal(foreign.ok, false);
  assert.equal((await requireProjectSessionScope(deps, { ...input, scope: 'task:write' })).ok, true, '别人撤不掉');

  const revoked = await revokeProjectSessionGrants(deps, { actor: human, sessionId: taskSession.id });
  assert.equal(revoked.ok && revoked.value.revoked, 1);
  assert.equal((await requireProjectSessionScope(deps, { ...input, scope: 'task:write' })).ok, false, '撤销只影响下一次校验');
});

test('scopeCap：项目授权撤销后旧令牌认证/调用立即被收窄（不依赖重新签发）', async () => {
  const { PROJECT_TASK_WRITE_TOOL_SCOPE, PROJECT_WORKTREE_OPEN_TOOL_SCOPE } = await import('../tool.ts');
  const w = await world();
  let allowed: readonly import('../tool.ts').ToolScope[] = [PROJECT_TASK_WRITE_TOOL_SCOPE, PROJECT_WORKTREE_OPEN_TOOL_SCOPE];
  const gateway = createToolGateway({
    now: () => 1_000,
    toolGrants: w.toolGrants,
    tokens,
    scopeCap: () => [...DEFAULT_TOOL_SCOPES, ...allowed],
    providers: [
      {
        id: 'project-session',
        tools: () => [
          { name: 'project.task.create', version: 1, scope: PROJECT_TASK_WRITE_TOOL_SCOPE, description: '建任务', inputSchema: { type: 'object' } }
        ],
        call: async () => ({ ok: true, value: { created: true } })
      }
    ]
  });
  const { grant, token } = await gateway.issue(w.session, [...DEFAULT_TOOL_SCOPES, ...allowed]);
  assert.equal((await gateway.call(grant, 'project.task.create', {})).ok, true);

  allowed = [PROJECT_WORKTREE_OPEN_TOOL_SCOPE];
  const narrowed = await gateway.authenticate(token);
  assert.ok(narrowed);
  assert.equal(narrowed.scopes.includes(PROJECT_TASK_WRITE_TOOL_SCOPE), false);
  assert.equal(gateway.list(narrowed).some((tool) => tool.name === 'project.task.create'), false);
  const denied = await gateway.call(narrowed, 'project.task.create', {});
  assert.equal(denied.ok, false);
});

test('scopeCap 求值失败按空权限处理，不回落完整授权', async () => {
  const w = await world();
  const gateway = createToolGateway({
    now: () => 1_000,
    toolGrants: w.toolGrants,
    tokens,
    providers: [],
    scopeCap: () => { throw new Error('policy store down'); }
  });
  const { grant, token } = await gateway.issue(w.session);
  assert.deepEqual(grant.scopes, []);
  const authed = await gateway.authenticate(token);
  assert.ok(authed);
  assert.deepEqual(authed.scopes, []);
});

test('withToolAccess scopes 替换：受限子会话拿不到 task:create/git/session:control/agent:message/project/workspace:delegate', async () => {
  const { restrictedChildScopes } = await import('../tool.ts');
  const w = await world();
  const command = await withToolAccess(
    w.gateway,
    { url: 'http://hub/mcp', transport: 'relay' },
    startCommand(w.session),
    human,
    { scopes: () => restrictedChildScopes() }
  );
  const token = (command as { tools?: { token: string } }).tools?.token;
  assert.ok(token);
  const grant = await w.gateway.authenticate(token);
  assert.ok(grant);
  for (const scope of ['task:create', 'git', 'session:control', 'agent:message', 'project', WORKSPACE_DELEGATE_SCOPE]) {
    assert.equal(grant.scopes.includes(scope as import('../tool.ts').ToolScope), false, `不得继承 ${scope}`);
  }
  assert.ok(grant.scopes.includes('task:read'));
  assert.ok(grant.scopes.includes('task:log:write'));
});

test('withToolAccess scopes 返回 null 保持普通默认；求值抛错按受限子会话 fail closed', async () => {
  const w = await world();
  const ordinary = await withToolAccess(
    w.gateway,
    { url: 'http://hub/mcp', transport: 'relay' },
    startCommand(w.session),
    human,
    { scopes: () => null, extraScopes: () => [WORKSPACE_DELEGATE_SCOPE] }
  );
  const ordinaryGrant = await w.gateway.authenticate((ordinary as { tools: { token: string } }).tools.token);
  assert.ok(ordinaryGrant?.scopes.includes('git'));
  assert.ok(ordinaryGrant?.scopes.includes(WORKSPACE_DELEGATE_SCOPE));

  const failed = await withToolAccess(
    w.gateway,
    { url: 'http://hub/mcp', transport: 'relay' },
    startCommand(w.session),
    human,
    { scopes: () => { throw new Error('policy down'); }, extraScopes: () => [WORKSPACE_DELEGATE_SCOPE] }
  );
  const failedGrant = await w.gateway.authenticate((failed as { tools: { token: string } }).tools.token);
  assert.ok(failedGrant);
  assert.equal(failedGrant.scopes.includes('git'), false);
  assert.equal(failedGrant.scopes.includes(WORKSPACE_DELEGATE_SCOPE), false);
});
