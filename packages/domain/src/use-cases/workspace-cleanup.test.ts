import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { createProjectUseCase } from './projects.ts';
import { createTaskUseCase, setTaskStatusUseCase } from './tasks.ts';
import { prepareLongLivedWorkspaceUseCase } from './workspaces.ts';
import { prepareTemporaryWorkspaceUseCase } from './temporary-workspaces.ts';
import { removeWorkspaceUseCase, sweepTemporaryWorkspacesUseCase, unsavedReason } from './workspace-cleanup.ts';

async function world(repoUrl?: string) {
  const w = inMemoryDeps();
  w.workers.push({ workerId: 'remote-1', label: '远程', origin: 'remote', state: 'online', roots: ['/srv/work'] });
  const project = await createProjectUseCase(w.deps, { name: 'Demo', ...(repoUrl ? { repoUrl } : {}) });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: 'fix' });
  assert.ok(task.ok);
  const temp = await prepareTemporaryWorkspaceUseCase(w.deps, { projectId: project.value.id, taskId: task.value.id, workerId: 'remote-1', home: '/home/me' });
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
  const again = await prepareTemporaryWorkspaceUseCase(w.deps, { projectId: w.project.id, taskId: w.task.id, workerId: 'remote-1', home: '/home/me' });
  assert.ok(again.ok, again.ok ? '' : again.error.message);
  assert.equal(again.value.path, w.temp.path);
  assert.equal(again.value.branch, w.temp.branch);
  assert.equal(again.value.state, 'ready');
});
