import { test } from 'node:test';
import assert from 'node:assert/strict';
import { available, capabilityMatrix } from '../capability.ts';
import { asAgentId, asWorkspaceGroupId, asWorkspaceId } from '../ids.ts';
import { inMemoryDeps } from '../testing/in-memory.ts';
import { createProjectUseCase } from './projects.ts';
import { createTaskUseCase, setTaskStatusUseCase } from './tasks.ts';
import { prepareTemporaryWorkspaceUseCase } from './temporary-workspaces.ts';
import { deriveSessionUseCase } from './sessions.ts';
import { ensureHosted } from './hosting.ts';
import { releaseSessionWorktrees, restoreSessionWorktrees } from './session-worktrees.ts';
import { removeWorkspaceUseCase, sweepTemporaryWorkspacesUseCase } from './workspace-cleanup.ts';
import { err, ok } from '../result.ts';
import { unavailable } from '../errors.ts';
import type { PlannedWorktreeGuard } from './deps.ts';
import { continueElsewhereUseCase } from './continue-elsewhere.ts';
import type { WorkspaceGroup } from '../workspace-group.ts';

async function world() {
  const w = inMemoryDeps();
  w.workers.push({ workerId: 'remote-1', label: 'remote', origin: 'remote', state: 'online', roots: ['/srv/work'] });
  w.agents.push({ id: asAgentId('fake'), label: 'Fake', models: ['m'], defaultModel: 'm', options: [], capabilities: capabilityMatrix({ prompt: available, interrupt: available, fork: available, resume: available, tool_calls: available, artifacts: available, structured_events: available, attachments: available }) });
  const project = await createProjectUseCase(w.deps, { name: 'test', repoUrl: 'https://example.com/a.git' }); assert.ok(project.ok);
  const task = await createTaskUseCase(w.deps, { projectId: project.value.id, title: 'task' }); assert.ok(task.ok);
  const other = await createTaskUseCase(w.deps, { projectId: project.value.id, title: 'other' }); assert.ok(other.ok);
  const temp = await prepareTemporaryWorkspaceUseCase(w.deps, { projectId: project.value.id, taskId: task.value.id, workerId: 'remote-1', home: '/home/me', mode: 'isolated' }); assert.ok(temp.ok, temp.ok ? '' : temp.error.message);
  let state: ReturnType<PlannedWorktreeGuard['forOutput']> = { source: 'local', state: 'ready-unused', groupId: null };
  let protectedOutput = true;
  let starts = 0;
  const guard: PlannedWorktreeGuard = {
    isWorkspaceProtected: (id) => protectedOutput && id === temp.value.id,
    isGroupProtected: () => false,
    forOutput: (id) => id === temp.value.id ? state : null,
    verifyOutput: async () => ok(undefined),
    noteStarted: () => { starts++; protectedOutput = false; state = { ...state!, state: 'closed' }; }
  };
  const deps = { ...w.deps, plannedWorktreeGuard: guard };
  const command = { taskId: task.value.id, workspaceId: temp.value.id, agentId: 'fake', model: 'm' };
  return { ...w, deps, task: task.value, other: other.value, temp: temp.value, command, guard, setState: (next: typeof state) => { state = next; }, get starts() { return starts; } };
}

test('planned launch fences pending, wrong task and direct group member; only real success releases', async () => {
  const w = await world();
  w.setState({ source: 'local', state: 'pending', groupId: null });
  assert.equal((await deriveSessionUseCase(w.deps, w.command)).ok, false);
  w.setState({ source: 'local', state: 'unknown', groupId: null });
  assert.equal((await deriveSessionUseCase(w.deps, w.command)).ok, false);
  w.setState({ source: 'local', state: 'ready-unused', groupId: null });
  assert.equal((await deriveSessionUseCase(w.deps, { ...w.command, taskId: w.other.id })).ok, false);
  w.setState({ source: 'local', state: 'ready-unused', groupId: 'group' });
  assert.equal((await deriveSessionUseCase(w.deps, w.command)).ok, false);
  w.setState({ source: 'local', state: 'ready-unused', groupId: null });
  const failedDeps = { ...w.deps, gateway: { ...w.deps.gateway, dispatch: async () => err(unavailable('offline')) } };
  assert.equal((await deriveSessionUseCase(failedDeps, w.command)).ok, false);
  assert.equal(w.starts, 0);
  const launched = await deriveSessionUseCase(w.deps, w.command); assert.ok(launched.ok);
  assert.equal(w.starts, 1);
});

test('runtime proof is required before saving or starting and is rechecked on restart', async () => {
  const w = await world();
  let proof = false;
  let calls = 0;
  const guard = { ...w.guard, verifyOutput: async (id: string) => {
    calls++;
    assert.equal(id, w.temp.id);
    return proof ? ok(undefined) : err(unavailable('checkout identity changed'));
  } };
  const deps = { ...w.deps, plannedWorktreeGuard: guard };
  const initialSaves = (await deps.sessions.listAll()).length;
  const initialCommands = w.dispatched.length;
  const missing = await deriveSessionUseCase({ ...deps, plannedWorktreeGuard: { ...guard, verifyOutput: undefined } }, w.command);
  assert.ok(!missing.ok);
  const rejected = await deriveSessionUseCase(deps, w.command);
  assert.ok(!rejected.ok);
  assert.equal((await deps.sessions.listAll()).length, initialSaves);
  assert.equal(w.dispatched.length, initialCommands);
  assert.equal(w.starts, 0);
  proof = true;
  const launched = await deriveSessionUseCase(deps, w.command); assert.ok(launched.ok);
  const afterLaunch = calls;
  assert.ok((await ensureHosted(deps, launched.value)).ok);
  assert.equal(calls, afterLaunch, 'already-hosted turn does not probe again');
  deps.hosting.drop(launched.value.id);
  proof = false;
  const beforeRestart = w.dispatched.length;
  assert.equal((await ensureHosted(deps, launched.value)).ok, false);
  assert.equal(w.dispatched.length, beforeRestart);
  assert.equal(w.starts, 1);
  proof = true;
  assert.ok((await ensureHosted(deps, launched.value)).ok);
  assert.equal(w.starts, 2);
});

test('rehosting validates planned placement and releases only after successful start', async () => {
  const w = await world();
  const launched = await deriveSessionUseCase(w.deps, w.command); assert.ok(launched.ok);
  w.deps.hosting.drop(launched.value.id);
  w.setState({ source: 'local', state: 'pending', groupId: null });
  assert.equal((await ensureHosted(w.deps, launched.value)).ok, false);
  w.setState({ source: 'local', state: 'ready-unused', groupId: null });
  assert.equal((await ensureHosted(w.deps, { ...launched.value, taskId: w.other.id })).ok, false);
  const broken = { ...w.deps, gateway: { ...w.deps.gateway, dispatch: async () => err(unavailable('offline')) } };
  assert.equal((await ensureHosted(broken, launched.value)).ok, false);
  assert.equal(w.starts, 1);
  assert.equal((await ensureHosted(w.deps, launched.value)).ok, true);
  assert.equal(w.starts, 2);
  assert.equal((await ensureHosted(w.deps, { ...launched.value, groupId: asWorkspaceGroupId('bad') })).ok, false);
});

test('protected planned output is not removed by manual, sweep or release, and legacy restore fails closed', async () => {
  const w = await world();
  const launched = await deriveSessionUseCase(w.deps, w.command); assert.ok(launched.ok);
  const guard = { ...w.guard, isWorkspaceProtected: (id: string) => id === w.temp.id };
  const deps = { ...w.deps, plannedWorktreeGuard: guard };
  const release = await releaseSessionWorktrees(deps, launched.value, { force: true });
  assert.equal(release[0]?.action, 'deferred');
  assert.equal((await removeWorkspaceUseCase(deps, { workspaceId: w.temp.id, deleteDirectory: true, force: true })).ok, false);
  await setTaskStatusUseCase(w.deps, w.task.id, 'done', 'user');
  const sweep = await sweepTemporaryWorkspacesUseCase(deps);
  assert.ok(sweep.skipped.includes(w.temp.id));
  await deps.workspaces.save({ ...w.temp, state: 'removed' });
  const restore = await restoreSessionWorktrees(deps, launched.value);
  assert.ok(restore && !restore.ok);
});

test('ready-unused output protected by another plan cannot be unbound or removed', async () => {
  const w = await world();
  assert.equal(w.guard.forOutput(w.temp.id)?.state, 'ready-unused');
  for (const deleteDirectory of [false, true]) {
    const result = await removeWorkspaceUseCase(w.deps, { workspaceId: w.temp.id, deleteDirectory, force: true });
    assert.ok(!result.ok);
    assert.match(result.error.message, /计划保护/);
    assert.equal((await w.deps.workspaces.byId(w.temp.id))?.state, 'ready');
  }
});

test('closed planned output remains attached through release and sweep and rejects legacy removal', async () => {
  const w = await world();
  const launched = await deriveSessionUseCase(w.deps, w.command); assert.ok(launched.ok);
  await w.deps.sessions.save({ ...launched.value, status: 'stopped', settledAt: 1 });
  assert.equal((await releaseSessionWorktrees(w.deps, launched.value, { force: true }))[0]?.action, 'deferred');
  await setTaskStatusUseCase(w.deps, w.task.id, 'done', 'user');
  assert.ok((await sweepTemporaryWorkspacesUseCase(w.deps)).skipped.includes(w.temp.id));
  assert.equal((await w.deps.workspaces.byId(w.temp.id))?.state, 'ready');
  const before = w.dispatched.length;
  let checkpoints = 0;
  const deps = { ...w.deps, cleanup: { ...w.deps.cleanup!, dropCheckpoints: async () => { checkpoints++; } } };
  for (const deleteDirectory of [false, true]) {
    assert.equal((await removeWorkspaceUseCase(deps, { workspaceId: w.temp.id, deleteDirectory, force: true })).ok, false);
  }
  assert.equal(w.dispatched.length, before);
  assert.equal(checkpoints, 0);
});

test('planned group verifies every member and denies legacy member removal', async () => {
  const w = await world();
  const groupId = asWorkspaceGroupId('planned-group');
  const primary = { ...w.temp, groupId, path: '/srv/work/group/primary' };
  const secondary = { ...w.temp, id: asWorkspaceId('secondary'), groupId, path: '/srv/work/group/repos/secondary' };
  await w.deps.workspaces.save(primary); await w.deps.workspaces.save(secondary);
  const group: WorkspaceGroup = { id: groupId, projectId: primary.projectId!, workerId: primary.workerId, root: '/srv/work/group', layout: 'amp', primaryWorkspaceId: primary.id,
    members: [{ workspaceId: secondary.id, repoId: null, name: 'secondary', state: 'ready', error: null }, { workspaceId: primary.id, repoId: null, name: 'primary', state: 'ready', error: null }], state: 'ready', ownerTaskId: w.task.id, createdAt: 1, error: null };
  await w.deps.workspaceGroups.save(group);
  let secondaryState: 'pending' | 'ready-unused' | 'closed' = 'pending';
  let verified = false;
  const seen: string[] = [];
  const guard = { ...w.guard, forOutput: (id: string) => id === primary.id || id === secondary.id ? { source: 'local' as const, state: id === secondary.id ? secondaryState : 'ready-unused' as const, groupId } : null,
    verifyOutput: async (id: string) => { seen.push(id); return id === secondary.id && !verified ? err(unavailable('member checkout changed')) : ok(undefined); } };
  const deps = { ...w.deps, plannedWorktreeGuard: guard };
  assert.equal((await deriveSessionUseCase(deps, { ...w.command, workspaceId: undefined, groupId })).ok, false);
  secondaryState = 'ready-unused';
  const initialCommands = w.dispatched.length;
  const count = (await deps.sessions.listAll()).length;
  assert.equal((await deriveSessionUseCase(deps, { ...w.command, workspaceId: undefined, groupId })).ok, false);
  assert.equal((await deps.sessions.listAll()).length, count);
  assert.equal(w.dispatched.length, initialCommands);
  for (const deleteDirectory of [false, true]) assert.equal((await removeWorkspaceUseCase(deps, { workspaceId: secondary.id, deleteDirectory, force: true })).ok, false);
  verified = true;
  seen.length = 0;
  const result = await deriveSessionUseCase(deps, { ...w.command, workspaceId: undefined, groupId });
  assert.ok(result.ok, result.ok ? '' : result.error.message);
  assert.deepEqual(seen, [secondary.id, primary.id]);
  assert.equal(result.value.workspaceId, primary.id);
  assert.equal(result.value.groupId, groupId);
  secondaryState = 'closed';
  const beforeRemoval = w.dispatched.length;
  for (const deleteDirectory of [false, true]) assert.equal((await removeWorkspaceUseCase(deps, { workspaceId: secondary.id, deleteDirectory, force: true })).ok, false);
  assert.equal(w.dispatched.length, beforeRemoval);
});

test('legacy continue-elsewhere rejects planned output before interrupt or dispatch', async () => {
  const w = await world();
  const launched = await deriveSessionUseCase(w.deps, w.command); assert.ok(launched.ok);
  const source = { ...launched.value, workspaceId: null, lastSeq: 1 as never };
  await w.deps.sessions.save(source);
  const before = w.dispatched.length;
  const result = await continueElsewhereUseCase(w.deps, { sessionId: source.id, target: { kind: 'workspace', workspaceId: w.temp.id }, home: '/home/me' });
  assert.ok(!result.ok && result.error.code === 'conflict');
  assert.equal(w.dispatched.length, before);
});
