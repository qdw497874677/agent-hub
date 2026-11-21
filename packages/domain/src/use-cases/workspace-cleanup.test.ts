import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { createProjectUseCase, updateProjectReposUseCase } from './projects.ts';
import { createTaskUseCase, setTaskStatusUseCase } from './tasks.ts';
import { prepareLongLivedWorkspaceUseCase } from './workspaces.ts';
import { prepareTemporaryWorkspaceUseCase } from './temporary-workspaces.ts';
import { removeWorkspaceUseCase, sweepTemporaryWorkspacesUseCase, unsavedReason } from './workspace-cleanup.ts';
import { restoreSessionWorktrees } from './session-worktrees.ts';
import { deriveSessionUseCase } from './sessions.ts';
import { systemSubject } from '../access.ts';
import { asAgentId } from '../ids.ts';
import { newWorkspace } from '../workspace.ts';
import { buildWorkspaceGroupUseCase } from './workspace-groups.ts';
import { ok } from '../result.ts';
import type { WorkspaceGroup } from '../workspace-group.ts';
import type { WorkspaceGroupGit } from '../ports/workspace-group-git.ts';
import type { WorkspaceGroupRepository } from '../ports/workspace-groups.ts';
import type { Deps } from './deps.ts';

async function world(repoUrl?: string) {
  const w = inMemoryDeps();
  w.workers.push({ workerId: 'remote-1', label: '远程', origin: 'remote', state: 'online', roots: ['/srv/work'] });
  const project = await createProjectUseCase(w.deps, { name: 'Demo', ...(repoUrl ? { repoUrl } : {}) });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: 'fix' });
  assert.ok(task.ok);
  const temp = await prepareTemporaryWorkspaceUseCase(w.deps, { projectId: project.value.id, taskId: task.value.id, workerId: 'remote-1', home: '/home/me', mode: 'isolated' });
  assert.ok(temp.ok, temp.ok ? '' : temp.error.message);
  const finish = () => setTaskStatusUseCase(w.deps, task.value.id, 'done', 'user');
  return { ...w, project: project.value, task: task.value, temp: temp.value, finish };
}

test('改动说成人话', () => {
  assert.equal(unsavedReason({ dirty: false, untracked: 0, unpushed: 0, branch: 'x', upstream: null }), null);
  assert.equal(unsavedReason({ dirty: null, untracked: 0, unpushed: 0, branch: null, upstream: null }), null); // 老 Worker：交给 Worker 判断
  assert.match(unsavedReason({ dirty: null, untracked: 0, unpushed: 0, branch: null, upstream: null, files: 1 }) ?? '', /还有 1 个文件/);
  assert.equal(unsavedReason({ dirty: true, untracked: 2, unpushed: 1, branch: 'x', upstream: null }), '有未提交的改动，有 2 个未跟踪的文件，有 1 个提交还没推送或合并');
});

test('任务没结束不清理；结束且干净就删', async () => {
  const w = await world('https://example.com/demo.git');
  assert.equal((await sweepTemporaryWorkspacesUseCase(w.deps)).removed.length, 0);
  await w.finish();
  const report = await sweepTemporaryWorkspacesUseCase(w.deps, { taskId: w.task.id });
  assert.deepEqual(report.removed, [w.temp.id]);
  assert.equal((await w.deps.workspaces.byId(w.temp.id))?.state, 'removed');
});

test('终端还开着的会话：目录不清，记成跳过', async () => {
  const w = await world('https://example.com/demo.git');
  w.agents.push({
    id: asAgentId('fake'),
    label: 'Fake',
    capabilities: { prompt: { state: 'available' }, interrupt: { state: 'available' }, fork: { state: 'available' }, resume: { state: 'available' }, tool_calls: { state: 'available' }, artifacts: { state: 'available' }, structured_events: { state: 'available' }, attachments: { state: 'available' } },
    models: ['m1'],
    defaultModel: 'm1',
    options: []
  });
  const session = await deriveSessionUseCase(w.deps, {
    taskId: w.task.id,
    agentId: 'fake',
    model: 'm1',
    actor: systemSubject('test'),
    workspaceId: w.temp.id
  });
  assert.ok(session.ok, session.ok ? '' : session.error.message);
  // 会话已经结束（不然「在跑」就先拦住了），只剩终端还开着。
  await w.deps.sessions.save({ ...session.value, status: 'done' });
  await setTaskStatusUseCase(w.deps, w.task.id, 'done', 'user');
  const cleanup = { ...(w.deps.cleanup as NonNullable<typeof w.deps.cleanup>), liveSessions: () => [session.value.id] };
  const guarded = await sweepTemporaryWorkspacesUseCase({ ...w.deps, cleanup });
  assert.deepEqual(guarded.removed, []);
  assert.deepEqual(guarded.skipped, [w.temp.id]);
  // 关掉终端后就照常清
  const open = await sweepTemporaryWorkspacesUseCase(w.deps);
  assert.deepEqual(open.removed, [w.temp.id]);
});

test('孤儿目录：按登记的 worktree 父目录反推，自定义 WORKER_WORKTREES_DIR 也认', async () => {
  const w = await world('https://example.com/demo.git');
  const parent = w.temp.path.slice(0, w.temp.path.lastIndexOf('/'));
  const gateway = w.deps.gateway as { listDirectories: (workerId: string | null, path: string) => Promise<unknown> };
  const original = gateway.listDirectories;
  gateway.listDirectories = async (_workerId, path) => ({
    ok: true as const,
    value: { path, exists: true, entries: [{ name: 'ghost', path: `${path}/ghost`, kind: 'directory' }] }
  });
  const records = await cleanupRecordsUseCase(w.deps, systemSubject('test'), w.project.id);
  gateway.listDirectories = original;
  assert.ok(records.ok, records.ok ? '' : records.error.message);
  assert.deepEqual(records.value.orphans.map((item) => item.path), [`${parent}/ghost`]);
});

test('有没推送的提交：不删，标已保留并写明原因；强制删除才删', async () => {
  const w = await world('https://example.com/demo.git');
  w.git.statuses.set(w.temp.path, { dirty: false, untracked: 0, unpushed: 3, branch: w.temp.branch, upstream: null });
  await w.finish();
  const report = await sweepTemporaryWorkspacesUseCase(w.deps);
  assert.deepEqual(report.kept, [w.temp.id]);
  const kept = await w.deps.workspaces.byId(w.temp.id);
  assert.equal(kept?.state, 'kept');
  assert.match(kept?.keptReason ?? '', /3 个提交/);
  const plain = await removeWorkspaceUseCase(w.deps, { workspaceId: w.temp.id, deleteDirectory: true });
  assert.ok(!plain.ok);
  const forced = await removeWorkspaceUseCase(w.deps, { workspaceId: w.temp.id, deleteDirectory: true, force: true });
  assert.ok(forced.ok);
  assert.ok(w.git.calls.some((call) => call.endsWith(':force')));
});

test('机器离线：跳过，下次再查', async () => {
  const w = await world('https://example.com/demo.git');
  await w.finish();
  w.git.failNext = 'offline';
  const report = await sweepTemporaryWorkspacesUseCase(w.deps);
  assert.deepEqual(report.skipped, [w.temp.id]);
  assert.equal((await w.deps.workspaces.byId(w.temp.id))?.state, 'ready');
});

test('非 git 项目也能清理临时目录（空目录才删）', async () => {
  const w = await world();
  assert.equal(w.temp.isGit, false);
  w.git.statuses.set(w.temp.path, { dirty: null, untracked: 0, unpushed: 0, branch: null, upstream: null, files: 0 });
  await w.finish();
  const report = await sweepTemporaryWorkspacesUseCase(w.deps);
  assert.deepEqual(report.removed, [w.temp.id]);
});

test('非 git 临时目录里还有文件：任务结束 / 清理时保留，清理记录写明原因；手动删也拒绝，强制才删', async () => {
  const w = await world();
  w.git.statuses.set(w.temp.path, { dirty: null, untracked: 0, unpushed: 0, branch: null, upstream: null, files: 3, sizeBytes: 4096 });
  const sweeps = sweepStore();
  (w.deps as { cleanup?: unknown }).cleanup = { sweeps: sweeps.store, pullRequests: { byWorkspace: async () => [], byTask: async () => [] }, dropCheckpoints: async () => undefined };
  await w.finish();
  const report = await sweepTemporaryWorkspacesUseCase(w.deps, { taskId: w.task.id });
  assert.deepEqual(report.kept, [w.temp.id]);
  assert.equal(report.removed.length, 0);
  assert.ok(!w.git.calls.some((call) => call.includes(':remove:')));
  const kept = await w.deps.workspaces.byId(w.temp.id);
  assert.equal(kept?.state, 'kept');
  assert.match(kept?.keptReason ?? '', /不是 git 仓库，目录里还有 3 个文件/);
  assert.equal(sweeps.items[0]?.action, 'kept');
  assert.match(sweeps.items[0]?.reason ?? '', /还有 3 个文件/);
  assert.equal(sweeps.items[0]?.sizeBytes, 4096);
  const plain = await removeWorkspaceUseCase(w.deps, { workspaceId: w.temp.id, deleteDirectory: true });
  assert.ok(!plain.ok && /3 个文件/.test(plain.error.message));
  const forced = await removeWorkspaceUseCase(w.deps, { workspaceId: w.temp.id, deleteDirectory: true, force: true });
  assert.ok(forced.ok);
});

test('人自己的目录只能移除登记，不能删；还有临时工作空间时不能删持久目录', async () => {
  const w = await world('https://example.com/demo.git');
  const all = await w.deps.workspaces.byProject(w.project.id);
  const cloned = all.find((ws) => ws.kind === 'long_lived');
  assert.ok(cloned);
  const blocked = await removeWorkspaceUseCase(w.deps, { workspaceId: cloned.id, deleteDirectory: true, force: true });
  assert.ok(!blocked.ok);
  assert.match(blocked.error.message, /临时工作空间/);
  w.git.repos.add('/home/me/mine');
  const linked = await prepareLongLivedWorkspaceUseCase(w.deps, { projectId: w.project.id, workerId: 'remote-1', plan: { mode: 'link', path: '/srv/work/mine' }, home: '/home/me' });
  if (linked.ok) {
    const refused = await removeWorkspaceUseCase(w.deps, { workspaceId: linked.value.id, deleteDirectory: true });
    assert.ok(!refused.ok);
    const unregistered = await removeWorkspaceUseCase(w.deps, { workspaceId: linked.value.id, deleteDirectory: false });
    assert.ok(unregistered.ok);
  }
});

/* ── ADR 0027 阶段 3：规则、squash 合并、闲置、清理记录、检查点、重建 ── */
import type { CleanupPolicy, SweepItem, SweepRun, WorkspaceSweepStore } from '../ports/workspace-sweeps.ts';
import type { PullRequestLink } from '../ports/pull-requests.ts';
import { cleanupRecordsUseCase, saveCleanupPolicyUseCase } from './workspace-cleanup-admin.ts';

function sweepStore() {
  const policies = new Map<string, CleanupPolicy>();
  const runs: SweepRun[] = [];
  const items: SweepItem[] = [];
  const store: WorkspaceSweepStore = {
    policy: async (scope, id) => policies.get(`${scope}:${id}`) ?? null,
    savePolicy: async (scope, id, p) => void policies.set(`${scope}:${id}`, p),
    saveRun: async (run, list) => void (runs.push(run), items.push(...list)),
    itemsOfProject: async (projectId, limit) => items.filter((i) => i.projectId === projectId).reverse().slice(0, limit)
  };
  return { store, runs, items };
}

async function withCleanup(prs: PullRequestLink[] = []) {
  const w = await world('https://example.com/demo.git');
  const sweeps = sweepStore();
  const dropped: string[] = [];
  (w.deps as { cleanup?: unknown }).cleanup = {
    sweeps: sweeps.store,
    pullRequests: { byWorkspace: async (id: string) => prs.filter((p) => p.workspaceId === id), byTask: async (id: string) => prs.filter((p) => p.taskId === id) },
    dropCheckpoints: async (id: string) => void dropped.push(id)
  };
  return { ...w, sweeps, dropped };
}

const pr = (over: Partial<PullRequestLink>): PullRequestLink => ({
  id: 'pr1', taskId: 't', workspaceId: null, sessionId: null, provider: 'github', via: 'gh', repo: 'o/r', number: 7, url: 'u', branch: 'b', base: 'main',
  state: 'merged', headSha: 'abc', mergedAt: 1, createdBy: 'me', createdAt: 1, lastSyncedAt: 1, ...over
});

test('squash 合并：任务没结束也删（HEAD == PR head），分支上的提交不算未推送；记一条带大小的记录', async () => {
  const w = await withCleanup();
  const link = pr({ taskId: w.task.id, workspaceId: w.temp.id, branch: w.temp.branch ?? 'b' });
  (w.deps as { cleanup: { pullRequests: unknown } }).cleanup.pullRequests = { byWorkspace: async () => [link], byTask: async () => [link] };
  w.git.statuses.set(w.temp.path, { dirty: false, untracked: 0, unpushed: 2, branch: w.temp.branch, upstream: null, head: 'abc', sizeBytes: 4096 });
  const report = await sweepTemporaryWorkspacesUseCase(w.deps);
  assert.deepEqual(report.removed, [w.temp.id]);
  assert.equal(w.sweeps.items[0]?.action, 'removed');
  assert.equal(w.sweeps.items[0]?.sizeBytes, 4096);
  assert.match(w.sweeps.items[0]?.reason ?? '', /PR #7 已合并/);
});

test('squash 合并但 HEAD 之后又有新提交 / 未跟踪文件：保留', async () => {
  const w = await withCleanup();
  const link = pr({ taskId: w.task.id, workspaceId: w.temp.id });
  (w.deps as { cleanup: { pullRequests: unknown } }).cleanup.pullRequests = { byWorkspace: async () => [link], byTask: async () => [] };
  w.git.statuses.set(w.temp.path, { dirty: false, untracked: 0, unpushed: 3, branch: w.temp.branch, upstream: null, head: 'def' });
  assert.deepEqual((await sweepTemporaryWorkspacesUseCase(w.deps)).kept, [w.temp.id]);
  w.git.statuses.set(w.temp.path, { dirty: false, untracked: 1, unpushed: 2, branch: w.temp.branch, upstream: null, head: 'abc' });
  const again = await sweepTemporaryWorkspacesUseCase(w.deps);
  assert.deepEqual(again.kept, [w.temp.id]);
  assert.match((await w.deps.workspaces.byId(w.temp.id))?.keptReason ?? '', /未跟踪/);
  assert.equal(w.sweeps.items.filter((i) => i.action === 'kept').length, 2, '原因变了才再记');
  await sweepTemporaryWorkspacesUseCase(w.deps);
  assert.equal(w.sweeps.items.filter((i) => i.action === 'kept').length, 2, '同样的原因不重复记');
});

test('规则：关掉「任务结束」就不删；闲置 N 天默认关，打开后按最后活动判断', async () => {
  const w = await withCleanup();
  const saved = await saveCleanupPolicyUseCase(w.deps, null, w.project.id, { taskEndedClean: false });
  assert.ok(saved.ok, saved.ok ? '' : saved.error.message);
  await w.finish();
  assert.equal((await sweepTemporaryWorkspacesUseCase(w.deps)).removed.length, 0);
  assert.equal((await saveCleanupPolicyUseCase(w.deps, null, w.project.id, { idleDays: 0 })).ok, false);
  assert.ok((await saveCleanupPolicyUseCase(w.deps, null, w.project.id, { idleDays: 3 })).ok);
  assert.equal((await sweepTemporaryWorkspacesUseCase(w.deps)).removed.length, 0, '刚刚还在用');
  const base = w.deps.now;
  (w.deps as { now: () => number }).now = () => base() + 4 * 24 * 3600 * 1000;
  const report = await sweepTemporaryWorkspacesUseCase(w.deps);
  assert.deepEqual(report.removed, [w.temp.id]);
  assert.match(w.sweeps.items[0]?.reason ?? '', /闲置超过 3 天/);
});

test('删工作空间时删检查点；记录可查；任务再开始时从分支重建同一路径', async () => {
  const w = await withCleanup();
  await w.finish();
  await sweepTemporaryWorkspacesUseCase(w.deps, { trigger: 'manual' });
  assert.equal(w.sweeps.runs[0]?.trigger, 'manual');
  const records = await cleanupRecordsUseCase(w.deps, null, w.project.id);
  assert.ok(records.ok && records.value.items.length === 1);
  await setTaskStatusUseCase(w.deps, w.task.id, 'in_progress', 'user');
  const again = await prepareTemporaryWorkspaceUseCase(w.deps, { projectId: w.project.id, taskId: w.task.id, workerId: 'remote-1', home: '/home/me', mode: 'isolated' });
  assert.ok(again.ok, again.ok ? '' : again.error.message);
  assert.equal(again.value.path, w.temp.path);
  assert.equal(again.value.branch, w.temp.branch);
  assert.equal(again.value.state, 'ready');
});

test('PR 合并后先收起会话，下一轮才拆干净的 worktree；有脏改动则留下', async () => {
  const w = await withCleanup();
  w.agents.push({
    id: asAgentId('fake'),
    label: 'Fake',
    capabilities: { prompt: { state: 'available' }, interrupt: { state: 'available' }, fork: { state: 'available' }, resume: { state: 'available' }, tool_calls: { state: 'available' }, artifacts: { state: 'available' }, structured_events: { state: 'available' }, attachments: { state: 'available' } },
    models: ['m1'],
    defaultModel: 'm1',
    options: []
  });
  const session = await deriveSessionUseCase(w.deps, {
    taskId: w.task.id,
    agentId: 'fake',
    model: 'm1',
    actor: systemSubject('test'),
    workspaceId: w.temp.id
  });
  assert.ok(session.ok, session.ok ? '' : session.error.message);
  await w.deps.sessions.save({ ...session.value, status: 'stopped' });
  const link = { taskId: w.task.id, workspaceId: w.temp.id, sessionId: session.value.id, state: 'merged' as const, headSha: 'abc', branch: w.temp.branch };
  (w.deps as { cleanup: { pullRequests: unknown } }).cleanup.pullRequests = {
    byWorkspace: async () => [link],
    byTask: async () => [link]
  };
  w.git.statuses.set(w.temp.path, { dirty: false, untracked: 0, unpushed: 0, branch: w.temp.branch, upstream: null, head: 'abc' });

  const first = await sweepTemporaryWorkspacesUseCase(w.deps, { projectId: w.project.id });
  assert.deepEqual(first.removed, []);
  const archived = await w.deps.sessions.byId(session.value.id);
  assert.ok(archived?.settledAt != null);
  assert.equal((await w.deps.workspaces.byId(w.temp.id))?.state !== 'removed', true);

  const second = await sweepTemporaryWorkspacesUseCase(w.deps, { projectId: w.project.id });
  assert.deepEqual(second.removed, [w.temp.id]);

  const dirty = await withCleanup();
  dirty.agents.push({
    id: asAgentId('fake'),
    label: 'Fake',
    capabilities: { prompt: { state: 'available' }, interrupt: { state: 'available' }, fork: { state: 'available' }, resume: { state: 'available' }, tool_calls: { state: 'available' }, artifacts: { state: 'available' }, structured_events: { state: 'available' }, attachments: { state: 'available' } },
    models: ['m1'],
    defaultModel: 'm1',
    options: []
  });
  const dirtySession = await deriveSessionUseCase(dirty.deps, {
    taskId: dirty.task.id,
    agentId: 'fake',
    model: 'm1',
    actor: systemSubject('test'),
    workspaceId: dirty.temp.id
  });
  assert.ok(dirtySession.ok);
  await dirty.deps.sessions.save({ ...dirtySession.value, status: 'stopped', settledAt: 10 });
  dirty.git.statuses.set(dirty.temp.path, { dirty: true, untracked: 0, unpushed: 0, branch: dirty.temp.branch, upstream: null, head: 'abc' });
  const kept = await sweepTemporaryWorkspacesUseCase(dirty.deps, { projectId: dirty.project.id });
  assert.deepEqual(kept.removed, []);
  assert.ok(kept.kept.includes(dirty.temp.id) || (await dirty.deps.workspaces.byId(dirty.temp.id))?.state === 'kept' || (await dirty.deps.workspaces.byId(dirty.temp.id))?.keptReason);
});


const cap = { state: 'available' as const };
const fakeAgent = {
  id: asAgentId('fake'),
  label: 'Fake',
  capabilities: { prompt: cap, interrupt: cap, fork: cap, resume: cap, tool_calls: cap, artifacts: cap, structured_events: cap, attachments: cap },
  models: ['m1'],
  defaultModel: 'm1',
  options: []
};

async function comboWorld() {
  const groups = (() => {
    const rows = new Map<string, WorkspaceGroup>();
    const store: WorkspaceGroupRepository & { rows: Map<string, WorkspaceGroup> } = {
      rows,
      async byId(id) { return rows.get(id) ?? null; },
      async listByProject(projectId) { return [...rows.values()].filter((group) => group.projectId === projectId); },
      async save(group) { rows.set(group.id, group); },
      async remove(id) { rows.delete(id); }
    };
    return store;
  })();
  const removedGroups: { root: string; id: string }[] = [];
  const groupGit: WorkspaceGroupGit = {
    async init(input) { return ok({ root: `/srv/work/groups/${input.id}` }); },
    async remove(input) { removedGroups.push(input); return ok({ removed: true }); },
    async newWorktree(input) { return ok({ path: input.path, branch: input.branch }); }
  };
  const memory = inMemoryDeps();
  memory.workers.push({ workerId: 'remote-1', label: '远程', origin: 'remote', state: 'online', roots: ['/srv/work'] });
  memory.agents.push(fakeAgent);
  const deps: Deps = { ...memory.deps, workspaceGroups: groups, gateway: { ...memory.deps.gateway, groups: () => groupGit } };
  const project = await createProjectUseCase(deps, { name: 'Combo Demo' });
  assert.ok(project.ok);
  const withRepos = await updateProjectReposUseCase(deps, {
    projectId: project.value.id,
    repos: [
      { name: 'web', url: 'https://example.com/web.git' },
      { name: 'api', url: 'https://example.com/api.git' }
    ]
  });
  assert.ok(withRepos.ok);
  const primary = withRepos.value.repos.find((repo) => repo.name === 'web');
  assert.ok(primary);
  const designated = await updateProjectReposUseCase(deps, { projectId: project.value.id, repos: withRepos.value.repos, primaryRepoId: primary.id });
  assert.ok(designated.ok);
  const task = await createTaskUseCase(deps, { projectId: designated.value.id, title: 'Ship' });
  assert.ok(task.ok);
  for (const repo of designated.value.repos) {
    const base = newWorkspace({ projectId: designated.value.id, repoUrl: repo.url, workerId: 'remote-1', path: `/srv/work/${repo.name}`, kind: 'long_lived', source: 'cloned', isGit: true, now: 1 });
    assert.ok(base.ok);
    await deps.workspaces.save(base.value);
    await deps.workspaces.claim({ projectId: designated.value.id, workspaceId: base.value.id, linkedBy: null, linkedAt: 1 });
  }
  const built = await buildWorkspaceGroupUseCase(deps, { projectId: designated.value.id, taskId: task.value.id, workerId: 'remote-1', home: '/home/me' });
  assert.ok(built.ok, built.ok ? '' : built.error.message);
  const session = await deriveSessionUseCase(deps, { taskId: task.value.id, agentId: 'fake', model: 'm1', actor: systemSubject('test'), groupId: built.value.id });
  assert.ok(session.ok, session.ok ? '' : session.error.message);
  await deps.sessions.save({ ...session.value, status: 'stopped' });
  const sweeps = sweepStore();
  const withClean = {
    ...deps,
    cleanup: {
      sweeps: sweeps.store,
      pullRequests: { byWorkspace: async () => [], byTask: async () => [] },
      dropCheckpoints: async () => undefined
    }
  };
  return { memory, deps: withClean, groups, removedGroups, project: designated.value, task: task.value, group: built.value, session: session.value, sweeps };
}

test('组合组：每个成员的 PR 都合并才整组收起并拆掉；只合并一部分则整组留下', async () => {
  const all = await comboWorld();
  const links = all.group.members.map((member, i) => ({
    taskId: all.task.id,
    workspaceId: member.workspaceId,
    sessionId: all.session.id,
    state: 'merged' as const,
    headSha: `h${i}`,
    branch: `agent-hub/${member.name}-xxxxxxxxxxxx`
  }));
  (all.deps as { cleanup: { pullRequests: unknown } }).cleanup.pullRequests = {
    byWorkspace: async (id: string) => links.filter((link) => link.workspaceId === id),
    byTask: async () => links
  };
  const first = await sweepTemporaryWorkspacesUseCase(all.deps, { projectId: all.project.id });
  assert.deepEqual(first.removed, []);
  assert.ok((await all.deps.sessions.byId(all.session.id))?.settledAt != null);
  assert.equal((await all.groups.byId(all.group.id)) != null, true);

  const second = await sweepTemporaryWorkspacesUseCase(all.deps, { projectId: all.project.id });
  assert.equal(second.removed.length, all.group.members.length);
  // 组行留下，重新打开时按原分支把 worktree 加回来。
  const keptGroup = await all.groups.byId(all.group.id);
  assert.ok(keptGroup);
  assert.equal(all.removedGroups.length, 0);
  for (const member of keptGroup.members) {
    assert.equal((await all.deps.workspaces.byId(member.workspaceId))?.state, 'removed');
  }
  const archivedSession = await all.deps.sessions.byId(all.session.id);
  assert.ok(archivedSession?.settledAt != null);
  const reopened = { ...archivedSession, settledAt: null };
  await all.deps.sessions.save(reopened);
  await restoreSessionWorktrees(all.deps, reopened);
  for (const member of keptGroup.members) {
    assert.equal((await all.deps.workspaces.byId(member.workspaceId))?.state, 'ready');
  }

  const partial = await comboWorld();
  const one = partial.group.members[0]!;
  const other = partial.group.members[1]!;
  const onlyOne = [{ taskId: partial.task.id, workspaceId: one.workspaceId, sessionId: partial.session.id, state: 'merged' as const, headSha: 'h0', branch: 'b' }];
  (partial.deps as { cleanup: { pullRequests: unknown } }).cleanup.pullRequests = {
    byWorkspace: async (id: string) => onlyOne.filter((link) => link.workspaceId === id),
    byTask: async () => onlyOne
  };
  // 另一个成员还有未推送提交、没有合并的 PR：整组不能收起
  partial.memory.git.statuses.set((await partial.deps.workspaces.byId(other.workspaceId))!.path, {
    dirty: false, untracked: 0, unpushed: 2, branch: 'b', upstream: null, head: 'h1'
  });
  const skipped = await sweepTemporaryWorkspacesUseCase(partial.deps, { projectId: partial.project.id });
  assert.deepEqual(skipped.removed, []);
  assert.equal((await partial.deps.sessions.byId(partial.session.id))?.settledAt, undefined);
  assert.ok(await partial.groups.byId(partial.group.id));
  const again = await sweepTemporaryWorkspacesUseCase(partial.deps, { projectId: partial.project.id });
  assert.deepEqual(again.removed, []);
  assert.ok(await partial.groups.byId(partial.group.id));
});

test('收起时已拆除：再 sweep 会说明没有待清理项，并列出 alreadyRemoved', async () => {
  const w = await world('https://example.com/demo.git');
  await w.deps.workspaces.save({ ...w.temp, state: 'removed', updatedAt: 2 });
  const report = await sweepTemporaryWorkspacesUseCase(w.deps, { projectId: w.project.id, trigger: 'manual' });
  assert.deepEqual(report.removed, []);
  assert.deepEqual(report.kept, []);
  assert.ok(report.alreadyRemoved?.includes(w.temp.id));
  assert.match(report.message ?? '', /收起时拆除/);
});
