import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Principal, User } from '../account.ts';
import { asLoginId, asTeamId, asUserId } from '../account.ts';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { createAccessPolicy as createAccessPolicyForTests } from './authorization.ts';
import { createProjectUseCase, setProjectWorktreeUseCase } from './projects.ts';
import { createTaskUseCase } from './tasks.ts';
import { prepareLongLivedWorkspaceUseCase } from './workspaces.ts';
import { branchSlug, originBranchRef, prepareTemporaryWorkspaceUseCase, retryWorkspaceSetupUseCase, sessionBranchSuffix, taskBranch } from './temporary-workspaces.ts';

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

test('分支名：agent-hub/<ascii slug>-<会话 id 后缀>；纯中文标题退回 task', () => {
  assert.equal(branchSlug('Fix login 登录'), 'fix-login');
  assert.equal(branchSlug('修登录'), 'task');
  assert.equal(taskBranch('修登录', 'ab12'), 'agent-hub/task-ab12');
  assert.equal(sessionBranchSuffix('a1b2c3d4-e5f6-7890-abcd-ef1234567890'), 'a1b2c3d4e5f6');
  assert.equal(taskBranch('修登录', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'), 'agent-hub/task-a1b2c3d4e5f6');
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
  assert.match(made.value.branch ?? '', /^agent-hub\/fix-login-[0-9a-f]{8,12}$/);
  assert.match(made.value.path, /^\/srv\/work\/agent-hub-workspaces\/\.worktrees\/demo-app\/fix-login-[0-9a-f]{8,12}$/);
  assert.ok(w.git.calls.some((call) => call.startsWith('remote-1:worktree:/srv/work/agent-hub-workspaces/demo-app->')));
  // 不限数量：再开一个，分支不同
  const again = await w.temp('isolated');
  assert.ok(again.ok);
  assert.notEqual(again.value.branch, made.value.branch);
});

test('分支起点：task.baseBranch 规范成 origin/<name>，建好后回写任务的实际分支', async () => {
  const w = await world('https://example.com/demo.git');
  const long = await prepareLongLivedWorkspaceUseCase(w.deps, { projectId: w.project.id, workerId: 'remote-1', plan: { mode: 'create' }, home: '/home/me' });
  assert.ok(long.ok);
  await w.deps.tasks.save({ ...w.task, baseBranch: 'release' });
  const made = await w.temp('isolated');
  assert.ok(made.ok, made.ok ? '' : made.error.message);
  assert.ok(
    w.git.calls.some((call) => call.includes(':worktree:') && call.endsWith('<origin/release')),
    `git 收到的 base 应该是 origin/release：${w.git.calls.join('\n')}`
  );
  const stored = await w.deps.tasks.byId(w.task.id);
  assert.equal(stored?.branch, made.value.branch);
  assert.equal(stored?.baseBranch, 'release');
});

test('回写分支只改 branch：并发把任务标成 done 之后，状态不会被旧快照回滚', async () => {
  const w = await world('https://example.com/demo.git');
  const long = await prepareLongLivedWorkspaceUseCase(w.deps, { projectId: w.project.id, workerId: 'remote-1', plan: { mode: 'create' }, home: '/home/me' });
  assert.ok(long.ok);

  // worktree 建好、还没回写分支的窗口里，另一条路（人点完成 / 定时巡检）把任务标成 done
  const realGit = w.deps.gateway.git;
  w.deps.gateway.git = (workerId) => {
    const port = realGit(workerId);
    return {
      ...port,
      async addWorktree(input) {
        const made = await port.addWorktree(input);
        const live = w.deps.tasks.rows.get(w.task.id);
        if (live) w.deps.tasks.rows.set(w.task.id, { ...live, status: 'done' });
        return made;
      }
    };
  };
  let saves = 0;
  const realSave = w.deps.tasks.save;
  w.deps.tasks.save = async (task) => {
    saves += 1;
    return realSave(task);
  };

  const made = await w.temp('isolated');
  assert.ok(made.ok, made.ok ? '' : made.error.message);

  const stored = await w.deps.tasks.byId(w.task.id);
  assert.equal(stored?.branch, made.value.branch, 'branch 照常回写');
  assert.equal(stored?.status, 'done', '回写分支不能把并发改掉的状态覆盖回旧值');
  assert.equal(saves, 0, '只该走 setBranch，不整行 save');
});

test('显式 command.base 优先于 task.baseBranch；已带 origin/ 的原样传', async () => {
  const w = await world('https://example.com/demo.git');
  const long = await prepareLongLivedWorkspaceUseCase(w.deps, { projectId: w.project.id, workerId: 'remote-1', plan: { mode: 'create' }, home: '/home/me' });
  assert.ok(long.ok);
  await w.deps.tasks.save({ ...w.task, baseBranch: 'release' });
  const made = await prepareTemporaryWorkspaceUseCase(w.deps, {
    projectId: w.project.id,
    taskId: w.task.id,
    workerId: 'remote-1',
    home: '/home/me',
    mode: 'isolated',
    base: 'origin/hotfix'
  });
  assert.ok(made.ok, made.ok ? '' : made.error.message);
  assert.ok(w.git.calls.some((call) => call.includes(':worktree:') && call.endsWith('<origin/hotfix')));
  assert.equal(originBranchRef('origin/main'), 'origin/main');
  assert.equal(originBranchRef(' maintain '), 'origin/maintain');
  assert.equal(originBranchRef(null), null);
});

test('shared 档不受 task.baseBranch 影响：复用长期空间、不建 worktree、不回写分支', async () => {
  const w = await world('https://example.com/demo.git');
  const long = await prepareLongLivedWorkspaceUseCase(w.deps, { projectId: w.project.id, workerId: 'remote-1', plan: { mode: 'create' }, home: '/home/me' });
  assert.ok(long.ok);
  await w.deps.tasks.save({ ...w.task, baseBranch: 'release' });
  const before = w.git.calls.length;
  const made = await w.temp('shared');
  assert.ok(made.ok, made.ok ? '' : made.error.message);
  assert.equal(made.value.id, long.value.id);
  assert.equal(w.git.calls.slice(before).some((call) => call.includes(':worktree:')), false);
  const stored = await w.deps.tasks.byId(w.task.id);
  assert.equal(stored?.branch, null);
});

test('有仓库但这台机器上还没下载：先 clone 一个持久的，再开 worktree', async () => {  const w = await world('https://example.com/demo.git');
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
  assert.match(made.value.path, /^\/srv\/work\/agent-hub-workspaces\/\.tmp\/fix-login-[0-9a-f]{8,12}$/);
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
  assert.equal(again.ok, false, '同一目录已被别的项目认领，不能再关联（#233）');
  if (!again.ok) assert.match(again.error.message, /已经分配给其他项目/);
  assert.deepEqual((await w.deps.workspaces.linksOf(first.value.id)).map((l) => l.projectId), [w.project.id]);
  for (const path of ['/srv/work/shared/sub', '/srv/work']) {
    const result = await link(other.value.id, path);
    assert.equal(result.ok, false, path);
    if (!result.ok) {
      assert.match(result.error.message, /互相嵌套/);
      // 不泄露嵌套空间的所属项目名（调用方未必有权看见它）
      assert.doesNotMatch(result.error.message, /Demo App/);
    }
  }
  assert.ok((await link(other.value.id, '/srv/work/elsewhere')).ok, '兄弟目录没问题');
  // 建项目时直接给同一个目录：已被别的项目认领 → 明确冲突，不静默抢走
  const third = await createProjectUseCase(w.deps, { name: 'third', rootPath: '/tmp/x' });
  assert.ok(third.ok);
  const fourth = await createProjectUseCase(w.deps, { name: 'fourth', rootPath: '/tmp/x' });
  assert.equal(fourth.ok, false);
  if (!fourth.ok) assert.match(fourth.error.message, /已经分配给其他项目/);
  assert.deepEqual((await w.deps.workspaces.linksOf((await w.deps.workspaces.byProject(third.value.id))[0]!.id)).map((l) => l.projectId), [third.value.id]);
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

function principalOf(id: string, teamId: string, role: User['role']): Principal {
  const user: User = {
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
  };
  return { user, loginId: asLoginId(`login-${id}`) };
}

/** 一个准备命令失败、目录保留的临时空间（项目配了 isolated + setup）。 */
async function failedTemporary() {
  const configured = await world('https://example.com/demo.git');
  const worktree = await setProjectWorktreeUseCase(configured.deps, {
    projectId: configured.project.id,
    worktree: { mode: 'isolated', setup: { command: 'pnpm i', waitForSetup: true, timeoutSeconds: 120 } }
  });
  assert.ok(worktree.ok, worktree.ok ? '' : worktree.error.message);
  configured.git.setups.set('*', { exitCode: 1, output: 'boom', timedOut: false });
  const failed = await configured.temp('isolated');
  assert.ok(failed.ok, failed.ok ? '' : failed.error.message);
  assert.equal(failed.value.setup?.state, 'failed');
  configured.git.setups.delete('*');
  return { ...configured, workspace: failed.value };
}

test('重试准备 #243：没有项目 update 的人被拒，且不会执行准备命令', async () => {
  const w = await failedTemporary();
  const owner = principalOf('owner', 'team-1', 'owner');
  const viewer = principalOf('viewer', 'team-1', 'viewer');
  const outsider = principalOf('outsider', 'team-2', 'member');
  const policy = createAccessPolicyForTests({
    users: {
      firstClusterAdmin: async () => owner.user,
      byId: async (id) => (id === owner.user.id ? owner.user : null)
    },
    settings: { get: async () => ({ openRegistration: false, membersCanAddMachines: true, refuseWhenFull: [] }) },
    enrollment: { credentialFor: async () => null },
    gateway: { status: async () => w.workers }
  });
  const deps = { ...w.deps, access: policy };
  const setups = () => w.git.calls.filter((call) => call.includes(':run_setup:')).length;
  const before = setups();

  // 只读成员看得见项目，但没有 project.update
  const denied = await retryWorkspaceSetupUseCase(deps, { workspaceId: w.workspace.id, actor: viewer });
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.error.code, 'forbidden');
  // 别的团队看不见项目，也不泄露工作空间存在
  const hidden = await retryWorkspaceSetupUseCase(deps, { workspaceId: w.workspace.id, actor: outsider });
  assert.equal(hidden.ok, false);
  if (!hidden.ok) assert.equal(hidden.error.code, 'not_found');
  assert.equal(setups(), before, '被拒时不能跑准备命令');

  // 项目 owner 可以，正常派发一次
  const passed = await retryWorkspaceSetupUseCase(deps, { workspaceId: w.workspace.id, actor: owner });
  assert.ok(passed.ok, passed.ok ? '' : passed.error.message);
  assert.equal(passed.value.setup?.state, 'ready');
  assert.equal(setups(), before + 1);
});

test('重试准备 #243：长期空间、linked、所有者任务与项目对不上，一律拒绝且不派发', async () => {
  const w = await failedTemporary();
  const setups = () => w.git.calls.filter((call) => call.includes(':run_setup:')).length;

  // 长期空间即使被人为弄成 failed 也不跑准备命令（那是人自己的目录）
  const long = await prepareLongLivedWorkspaceUseCase(w.deps, { projectId: w.project.id, workerId: 'remote-1', plan: { mode: 'create' }, home: '/home/me' });
  assert.ok(long.ok);
  assert.equal(long.value.kind, 'long_lived');
  await w.deps.workspaces.save({ ...long.value, state: 'failed', setup: w.workspace.setup });
  const before = setups();
  const longRetry = await retryWorkspaceSetupUseCase(w.deps, { workspaceId: long.value.id });
  assert.equal(longRetry.ok, false);
  if (!longRetry.ok) {
    assert.equal(longRetry.error.code, 'conflict');
    assert.match(longRetry.error.message, /平台创建的临时工作空间/);
  }

  // 合成一条「临时但 linked」的登记：不是平台建的目录，不允许
  await w.deps.workspaces.save({ ...w.workspace, source: 'linked' });
  const linkedRetry = await retryWorkspaceSetupUseCase(w.deps, { workspaceId: w.workspace.id });
  assert.equal(linkedRetry.ok, false);
  if (!linkedRetry.ok) assert.match(linkedRetry.error.message, /平台创建的临时工作空间/);
  await w.deps.workspaces.save(w.workspace);

  // 所有者任务被挪到别的项目：空间和任务对不上
  const other = await createProjectUseCase(w.deps, { name: 'Other' });
  assert.ok(other.ok);
  await w.deps.tasks.save({ ...w.task, projectId: other.value.id });
  const mismatch = await retryWorkspaceSetupUseCase(w.deps, { workspaceId: w.workspace.id });
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) {
    assert.equal(mismatch.error.code, 'conflict');
    assert.match(mismatch.error.message, /对不上/);
  }
  assert.equal(setups(), before, '三种拒绝都不能跑到准备命令');
});
