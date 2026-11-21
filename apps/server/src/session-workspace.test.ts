import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryDeps, fakeSessionLinks } from '@agent-hub/domain/testing';
import { asAgentId, createProjectUseCase, createTaskUseCase, deriveSession, newWorkspace } from '@agent-hub/domain';
import { workspaceForApiStart } from './session-workspace.ts';

async function world(repoUrl?: string) {
  const w = inMemoryDeps();
  w.workers.push({ workerId: 'remote-1', label: '远程', origin: 'remote', state: 'online', roots: ['/srv/work'] });
  const project = await createProjectUseCase(w.deps, { name: 'Demo App', ...(repoUrl ? { repoUrl } : {}) });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: 'Fix login' });
  assert.ok(task.ok);
  return { ...w, project: project.value, task: task.value };
}

test('开放 API 建会话：项目没有长期工作空间时现建一个临时空间，别再回「没有工作空间」', async () => {
  const w = await world();
  const placed = await workspaceForApiStart(w.deps, { taskId: w.task.id, workerId: 'remote-1' }, null);
  assert.ok(placed.ok, placed.ok ? '' : placed.error.message);
  assert.ok(placed.value, '应该建出一个工作空间');
  const made = await w.deps.workspaces.byId(placed.value as never);
  assert.equal(made?.kind, 'temporary');
  assert.equal(made?.ownerTaskId, w.task.id);
  assert.equal(made?.workerId, 'remote-1');
});

test('已经有长期工作空间时沿用默认，不额外建目录', async () => {
  const w = await world();
  const { prepareLongLivedWorkspaceUseCase } = await import('@agent-hub/domain');
  const long = await prepareLongLivedWorkspaceUseCase(w.deps, { projectId: w.project.id, workerId: 'remote-1', plan: { mode: 'create' }, home: '/home/me' });
  assert.ok(long.ok);
  const placed = await workspaceForApiStart(w.deps, { taskId: w.task.id, workerId: 'remote-1' }, null);
  assert.ok(placed.ok);
  assert.equal(placed.value, null);
});

test('调用方指定了 workspaceId 或组合工作空间：原样放行', async () => {
  const w = await world();
  const a = await workspaceForApiStart(w.deps, { taskId: w.task.id, workspaceId: 'ws-1' }, null);
  assert.ok(a.ok);
  assert.equal(a.value, null);
  const b = await workspaceForApiStart(w.deps, { taskId: w.task.id, groupId: 'grp-1' }, null);
  assert.ok(b.ok);
  assert.equal(b.value, null);
});

test('容器会话（没有 taskId）不建工作空间，交给 derive 自己判断', async () => {
  const w = await world();
  const placed = await workspaceForApiStart(w.deps, {}, null);
  assert.ok(placed.ok);
  assert.equal(placed.value, null);
});

test('会话通信 P1b：repoId = 一仓一会话（只为那个仓开 worktree）；和 workspaceId / groupId 互斥', async () => {
  const w = await world('https://example.com/web.git');
  const placed = await workspaceForApiStart(w.deps, { taskId: w.task.id, workerId: 'remote-1', repoId: w.project.repos[0]!.id }, null);
  assert.ok(placed.ok, placed.ok ? '' : placed.error.message);
  const made = await w.deps.workspaces.byId(placed.value as never);
  assert.equal(made?.kind, 'temporary');
  assert.equal(made?.source, 'worktree');
  assert.equal(made?.repoUrl, 'https://example.com/web.git');
  const clash = await workspaceForApiStart(w.deps, { taskId: w.task.id, repoId: 'web', groupId: 'grp-1' }, null);
  assert.equal(clash.ok ? null : clash.error.code, 'invalid');
});

test('会话通信 P1b：开会话前检查 handle 与 linkWith（格式 / 占用 / 同项目）', async () => {
  const { checkStartExtras } = await import('./session-start-extras.ts');
  const { deriveSessionUseCase } = await import('@agent-hub/domain');
  const base = await world();
  // check 只看有没有连线仓库，不会真去连
  const w = { ...base, deps: { ...base.deps, links: {} as never } };
  const taken = { sessionByHandle: async (_task: string, handle: string) => (handle === 'verify' ? ('s-x' as never) : null) };
  assert.equal((await checkStartExtras(w.deps, taken, w.task.id, { handle: 'Bad Name' }, null)).ok, false);
  const dup = await checkStartExtras(w.deps, taken, w.task.id, { handle: 'verify' }, null);
  assert.equal(dup.ok ? null : dup.error.code, 'conflict');
  const missing = await checkStartExtras(w.deps, taken, w.task.id, { linkWith: ['nope'] }, null);
  assert.equal(missing.ok ? null : missing.error.code, 'not_found');
  const placed = await workspaceForApiStart(w.deps, { taskId: w.task.id, workerId: 'remote-1' }, null);
  assert.ok(placed.ok);
  const other = await deriveSessionUseCase(w.deps, { taskId: w.task.id, agentId: w.deps.agents.list()[0]?.id ?? 'fake', model: '', workspaceId: placed.value });
  if (!other.ok) return; // 内存 deps 没有 agent 时跳过连线这半
  const fine = await checkStartExtras(w.deps, taken, w.task.id, { handle: 'dev', linkWith: [other.value.id] }, null);
  assert.ok(fine.ok, fine.ok ? '' : fine.error.message);
  assert.deepEqual(fine.value, [other.value.id]);
});

test('#243：开会话连线按不可变来源项目判；旧容器会话不能借长期空间混进来', async () => {
  const { checkStartExtras } = await import('./session-start-extras.ts');
  const base = await world();
  const deps = { ...base.deps, links: fakeSessionLinks() };
  // 长期空间不记录项目也无所谓：来源已经落在会话自己身上。
  const ws = newWorkspace({ projectId: null, workerId: 'remote-1', path: '/srv/originless', kind: 'long_lived', source: 'linked', now: 1 });
  assert.ok(ws.ok);
  await deps.workspaces.save(ws.value);
  const input = { agentId: asAgentId('fake'), model: 'm1', now: 1, workspaceId: ws.value.id };
  const origin = deriveSession({ ...input, originProjectId: base.project.id });
  const legacy = deriveSession(input);
  assert.ok(origin.ok);
  assert.ok(legacy.ok);
  await deps.sessions.save(origin.value);
  await deps.sessions.save(legacy.value);

  const allowed = await checkStartExtras(deps, undefined, base.task.id, { linkWith: [origin.value.id] }, null);
  assert.ok(allowed.ok, allowed.ok ? '' : allowed.error.message);
  assert.deepEqual(allowed.value, [origin.value.id]);

  const denied = await checkStartExtras(deps, undefined, base.task.id, { linkWith: [legacy.value.id] }, null);
  assert.equal(denied.ok ? null : denied.error.code, 'not_found');
});
