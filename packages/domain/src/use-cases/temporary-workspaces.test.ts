import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { createProjectUseCase, setProjectWorktreeUseCase } from './projects.ts';
import { createTaskUseCase } from './tasks.ts';
import { prepareLongLivedWorkspaceUseCase } from './workspaces.ts';
import { branchSlug, prepareTemporaryWorkspaceUseCase, retryWorkspaceSetupUseCase, taskBranch } from './temporary-workspaces.ts';

async function world(repoUrl?: string) {
  const w = inMemoryDeps();
  w.workers.push({ workerId: 'remote-1', label: '远程', origin: 'remote', state: 'online', roots: ['/srv/work'] });
  const project = await createProjectUseCase(w.deps, { name: 'Demo App', ...(repoUrl ? { repoUrl } : {}) });
  assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: 'Fix login 登录' });
  assert.ok(task.ok);
  const temp = (mode?: 'shared' | 'isolated') =>
    prepareTemporaryWorkspaceUseCase(w.deps, { projectId: project.value.id, taskId: task.value.id, workerId: 'remote-1', home: '/home/me', ...(mode ? { mode } : {}) });
  return { ...w, project: project.value, task: task.value, temp };
}

test('分支名：agent-hub/<ascii slug>-<短 id>；纯中文标题退回 task', () => {
  assert.equal(branchSlug('Fix login 登录'), 'fix-login');
  assert.equal(branchSlug('修登录'), 'task');
  assert.equal(taskBranch('修登录', 'ab12'), 'agent-hub/task-ab12');
});

test('git 项目：从这台机器上的持久工作空间开 worktree，放在仓库旁的 .worktrees/，新分支', async () => {
  const w = await world('https://example.com/demo.git');
  const long = await prepareLongLivedWorkspaceUseCase(w.deps, { projectId: w.project.id, workerId: 'remote-1', plan: { mode: 'create' }, home: '/home/me' });
  assert.ok(long.ok);
  const made = await w.temp('isolated');
  assert.ok(made.ok, made.ok ? '' : made.error.message);
  assert.equal(made.value.kind, 'temporary');
  assert.equal(made.value.source, 'worktree');
  assert.equal(made.value.ownerTaskId, w.task.id);
  assert.equal(made.value.baseWorkspaceId, long.value.id);
  assert.match(made.value.branch ?? '', /^agent-hub\/fix-login-[0-9a-f]{4}$/);
  assert.match(made.value.path, /^\/srv\/work\/agent-hub-workspaces\/\.worktrees\/demo-app\/fix-login-[0-9a-f]{4}$/);
  assert.ok(w.git.calls.some((call) => call.startsWith('remote-1:worktree:/srv/work/agent-hub-workspaces/demo-app->')));
  // 不限数量：再开一个，分支不同
  const again = await w.temp('isolated');
  assert.ok(again.ok);
  assert.notEqual(again.value.branch, made.value.branch);
});

test('有仓库但这台机器上还没下载：先 clone 一个持久的，再开 worktree', async () => {
  const w = await world('https://example.com/demo.git');
  const made = await w.temp('isolated');
  assert.ok(made.ok, made.ok ? '' : made.error.message);
  assert.equal(made.value.source, 'worktree');
  const all = await w.deps.workspaces.byProject(w.project.id);
  assert.equal(all.filter((ws) => ws.kind === 'long_lived' && ws.source === 'cloned').length, 1);
});

test('非 git 项目：新建空目录 <root>/agent-hub-workspaces/.tmp/<slug>-<短 id>', async () => {
  const w = await world();
  const made = await w.temp();
  assert.ok(made.ok, made.ok ? '' : made.error.message);
  assert.equal(made.value.source, 'created');
  assert.equal(made.value.isGit, false);
  assert.equal(made.value.branch, null);
  assert.match(made.value.path, /^\/srv\/work\/agent-hub-workspaces\/\.tmp\/fix-login-[0-9a-f]{4}$/);
});

test('worktree 失败（同名分支已在别处检出等）：不登记，原因带回去', async () => {
  const w = await world('https://example.com/demo.git');
  const long = await prepareLongLivedWorkspaceUseCase(w.deps, { projectId: w.project.id, workerId: 'remote-1', plan: { mode: 'create' }, home: '/home/me' });
  assert.ok(long.ok);
  w.git.failNext = '分支已存在';
  const made = await w.temp('isolated');
  assert.equal(made.ok, false);
  assert.equal((await w.deps.workspaces.byTask(w.task.id)).length, 0);
});

test('ADR 0026 唯一性：同团队同一目录复用并关联，上下级目录互相嵌套的拒绝', async () => {
  const w = await world();
  const other = await createProjectUseCase(w.deps, { name: 'other' });
  assert.ok(other.ok);
  const link = (projectId: string, path: string) =>
    prepareLongLivedWorkspaceUseCase(w.deps, { projectId, workerId: 'remote-1', plan: { mode: 'link', path }, home: '/home/me' });
  const first = await link(w.project.id, '/srv/work/shared');
  assert.ok(first.ok);
  const again = await link(other.value.id, '/srv/work/shared');
  assert.ok(again.ok && again.value.id === first.value.id, '同一目录 = 同一个工作空间');
  assert.deepEqual((await w.deps.workspaces.linksOf(first.value.id)).map((l) => l.projectId).sort(), [w.project.id, other.value.id].sort());
  for (const path of ['/srv/work/shared/sub', '/srv/work']) {
    const result = await link(other.value.id, path);
    assert.equal(result.ok, false, path);
    if (!result.ok) assert.match(result.error.message, /互相嵌套/);
  }
  assert.ok((await link(other.value.id, '/srv/work/elsewhere')).ok, '兄弟目录没问题');
  // 建项目时直接给同一个目录：复用并关联，不再拒绝
  const third = await createProjectUseCase(w.deps, { name: 'third', rootPath: '/tmp/x' });
  assert.ok(third.ok);
  const fourth = await createProjectUseCase(w.deps, { name: 'fourth', rootPath: '/tmp/x' });
  assert.ok(fourth.ok);
  const thirdWs = (await w.deps.workspaces.byProject(third.value.id))[0];
  const fourthWs = (await w.deps.workspaces.byProject(fourth.value.id))[0];
  assert.equal(thirdWs?.id, fourthWs?.id);
  const nested = await createProjectUseCase(w.deps, { name: 'fifth', rootPath: '/tmp/x/y' });
  assert.equal(nested.ok, false);
});

test('默认 shared：复用长期工作空间，不新开 worktree，也不跑准备命令', async () => {
  const w = await world('https://example.com/demo.git');
  const long = await prepareLongLivedWorkspaceUseCase(w.deps, { projectId: w.project.id, workerId: 'remote-1', plan: { mode: 'create' }, home: '/home/me' });
  assert.ok(long.ok);
  const before = w.git.calls.length;
  const made = await w.temp();
  assert.ok(made.ok, made.ok ? '' : made.error.message);
  assert.equal(made.value.id, long.value.id, '就是那个长期空间');
  assert.equal(made.value.kind, 'long_lived');
  assert.equal(w.git.calls.slice(before).some((call) => call.includes(':worktree:')), false);
});

test('shared + 有仓库但没长期空间：先 clone 一个持久的，直接用它', async () => {
  const w = await world('https://example.com/demo.git');
  const made = await w.temp('shared');
  assert.ok(made.ok, made.ok ? '' : made.error.message);
  assert.equal(made.value.kind, 'long_lived');
  assert.equal(made.value.source, 'cloned');
});

test('准备命令成功：workspace.setup = ready，跑的是项目配置里的命令', async () => {
  const w = await world('https://example.com/demo.git');
  const configured = await setProjectWorktreeUseCase(w.deps, { projectId: w.project.id, worktree: { mode: 'isolated', setup: { command: 'pnpm i', waitForSetup: true, timeoutSeconds: 600 } } });
  assert.ok(configured.ok, configured.ok ? '' : configured.error.message);
  const made = await w.temp('isolated');
  assert.ok(made.ok, made.ok ? '' : made.error.message);
  assert.deepEqual(made.value.setup && { state: made.value.setup.state, exitCode: made.value.setup.exitCode }, { state: 'ready', exitCode: 0 });
  assert.equal(made.value.state, 'ready');
  assert.ok(w.git.calls.some((call) => call.includes(':run_setup:') && call.includes('pnpm i') && call.endsWith(':600000')));
});

test('准备命令失败：state=failed、原因说人话、目录保留；重试成功后转 ready', async () => {
  const w = await world('https://example.com/demo.git');
  const configured = await setProjectWorktreeUseCase(w.deps, { projectId: w.project.id, worktree: { mode: 'isolated', setup: { command: 'pnpm i', waitForSetup: true, timeoutSeconds: 120 } } });
  assert.ok(configured.ok);
  // 路径由 domain 算出来：先用 '*' 让任何路径的第一次准备都失败
  w.git.setups.set('*', { exitCode: 1, output: 'boom', timedOut: false });
  const failed = await w.temp('isolated');
  assert.ok(failed.ok, failed.ok ? '' : failed.error.message);
  assert.equal(failed.value.setup?.state, 'failed');
  assert.equal(failed.value.state, 'failed');
  assert.equal(failed.value.keptReason, '准备失败');
  assert.equal(failed.value.setup?.message, '准备命令退出码 1');
  assert.equal(failed.value.setup?.output, 'boom');

  const retried = await retryWorkspaceSetupUseCase(w.deps, { workspaceId: failed.value.id });
  assert.ok(retried.ok, retried.ok ? '' : retried.error.message);
  assert.equal(retried.value.setup?.state, 'failed');
  assert.equal(retried.value.setup?.message, '准备命令退出码 1');
  assert.equal(retried.value.setup?.output, 'boom');

  w.git.setups.delete('*');
  const ok = await retryWorkspaceSetupUseCase(w.deps, { workspaceId: failed.value.id });
  assert.ok(ok.ok, ok.ok ? '' : ok.error.message);
  assert.equal(ok.value.setup?.state, 'ready');
  assert.equal(ok.value.state, 'ready');
  assert.equal(ok.value.keptReason, null);

  // 已经不是 failed 了：再重试是 conflict
  const again = await retryWorkspaceSetupUseCase(w.deps, { workspaceId: failed.value.id });
  assert.equal(again.ok, false);
});
