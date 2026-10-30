import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryAdmin } from '../testing/in-memory.ts';
import { startRuntimeJob, type RuntimeInstallDeps } from './runtime-install.ts';
import type { Principal, User, UserId } from '../account.ts';
import type { WorkerCredential } from '../enrollment.ts';
import type { RuntimeProvision } from '../runtime-install.ts';
import type { WorkerStatus } from '../worker.ts';
import type { Session } from '../session.ts';

const person = (email: string, role: User['role']): Principal =>
  ({
    user: { id: email as UserId, email, displayName: email, role, passwordHash: null, emailVerifiedAt: 1, disabledAt: null, createdAt: 1 },
    loginId: `login-${email}`
  }) as unknown as Principal;

const owner = person('boss@b.co', 'owner');
const member = person('m@b.co', 'member');
const stranger = person('x@b.co', 'member');

function machine(id: string, provision: RuntimeProvision | undefined, extra: Partial<WorkerStatus> = {}): WorkerStatus {
  return {
    workerId: id,
    label: id,
    origin: 'remote',
    state: 'online',
    agentIds: ['opencode'],
    agentModels: [{ agentId: 'opencode', models: [], defaultModel: '', ...(provision ? { provision } : {}) }],
    ...extra
  };
}

function setup(credentials: WorkerCredential[] = []) {
  const admin = inMemoryAdmin();
  const deps: RuntimeInstallDeps = {
    workers: admin.deps.workers,
    enrollment: { credentialFor: async (id) => credentials.find((c) => c.workerId === id) ?? null },
    sessions: admin.deps.sessions,
    audit: admin.deps.audit,
    now: () => 5,
    newJobId: () => 'job-1'
  };
  return { admin, deps };
}

const missing: RuntimeProvision = { source: 'missing', recommended: '2.2.2' };
const cred = (workerId: string, by: string, revokedAt: number | null = null): WorkerCredential => ({
  workerId,
  tokenHash: 'h',
  enrolledBy: by as UserId,
  label: workerId,
  createdAt: 1,
  revokedAt
});

test('主人装推荐版本：下发任务、写审计', async () => {
  const { admin, deps } = setup();
  admin.workerList.push(machine('w1', missing));
  const result = await startRuntimeJob(deps, owner, 'w1', { agentId: 'opencode', action: 'install' });
  assert.ok(result.ok);
  assert.equal(result.value.version, '2.2.2');
  assert.equal(result.value.state, 'running');
  assert.equal(admin.runtimeJobs[0]?.job.jobId, 'job-1');
  assert.equal(admin.entries[0]?.action, 'runtime.install');
  assert.equal(admin.entries[0]?.detail, 'opencode 2.2.2');
});

test('接入这台机器的成员能装；别的成员、已吊销的、本机 Worker 都不行', async () => {
  const { admin, deps } = setup([cred('w1', member.user.id), cred('w2', member.user.id, 9)]);
  admin.workerList.push(machine('w1', missing), machine('w2', missing), machine('local', missing, { origin: 'local' }));
  assert.ok((await startRuntimeJob(deps, member, 'w1', { agentId: 'opencode', action: 'install' })).ok);
  const other = await startRuntimeJob(deps, stranger, 'w1', { agentId: 'opencode', action: 'install' });
  assert.equal(!other.ok && other.error.code, 'forbidden');
  const revoked = await startRuntimeJob(deps, member, 'w2', { agentId: 'opencode', action: 'install' });
  assert.equal(!revoked.ok && revoked.error.code, 'forbidden');
  const local = await startRuntimeJob(deps, member, 'local', { agentId: 'opencode', action: 'install' });
  assert.equal(!local.ok && local.error.code, 'forbidden');
  const anonymous = await startRuntimeJob(deps, null, 'w1', { agentId: 'opencode', action: 'install' });
  assert.equal(!anonymous.ok && anonymous.error.code, 'forbidden');
});

test('机器自带的不装不卸；离线拒绝；老 Worker 拒绝；同时只一个任务', async () => {
  const { admin, deps } = setup();
  admin.workerList.push(
    machine('own', { source: 'machine', recommended: '2.2.2' }),
    machine('off', missing, { state: 'offline' }),
    machine('old', undefined),
    machine('busy', missing, {
      runtimeJob: { jobId: 'j', agentId: 'pi', action: 'install', version: '1.0.0', state: 'running', message: '', log: '', startedAt: 1, endedAt: null, actorEmail: '' }
    })
  );
  const message = async (id: string, action: 'install' | 'uninstall' = 'install') => {
    const result = await startRuntimeJob(deps, owner, id, { agentId: 'opencode', action });
    return result.ok ? 'ok' : result.error.message;
  };
  assert.match(await message('own'), /以机器上的为准/);
  assert.match(await message('own', 'uninstall'), /以机器上的为准/);
  assert.match(await message('off'), /不在线/);
  assert.match(await message('old'), /版本太旧/);
  assert.match(await message('busy'), /已经有一个安装任务/);
  assert.match(await message('nope'), /没有这台机器/);
  assert.equal(admin.runtimeJobs.length, 0);
});

test('版本号只收 X.Y.Z；装不了的原因原样给出；同版本不重装', async () => {
  const { admin, deps } = setup();
  admin.workerList.push(machine('w1', missing), machine('w2', { ...missing, blocker: '这台机器没有 npm' }), machine('w3', { source: 'hub', version: '2.2.2', recommended: '2.2.2' }));
  const bad = await startRuntimeJob(deps, owner, 'w1', { agentId: 'opencode', action: 'install', version: '2.2.2; rm -rf /' });
  assert.equal(!bad.ok && bad.error.code, 'invalid');
  const blocked = await startRuntimeJob(deps, owner, 'w2', { agentId: 'opencode', action: 'install' });
  assert.equal(!blocked.ok && blocked.error.message, '这台机器没有 npm');
  const same = await startRuntimeJob(deps, owner, 'w3', { agentId: 'opencode', action: 'install' });
  assert.match(!same.ok ? same.error.message : '', /已经装的就是/);
  const upgrade = await startRuntimeJob(deps, owner, 'w3', { agentId: 'opencode', action: 'install', version: '2.3.0' });
  assert.ok(upgrade.ok);
  assert.equal(admin.entries[0]?.detail, 'opencode 2.2.2 → 2.3.0');
});

test('卸载只针对 hub 装的；有会话正用着时不卸载也不升级', async () => {
  const { admin, deps } = setup();
  admin.workerList.push(machine('w1', missing), machine('w2', { source: 'hub', version: '2.2.2', recommended: '2.2.2' }));
  const none = await startRuntimeJob(deps, owner, 'w1', { agentId: 'opencode', action: 'uninstall' });
  assert.match(!none.ok ? none.error.message : '', /只能卸载 hub 装的/);
  admin.sessionList.push({ workerId: 'w2', agentId: 'opencode', status: 'running', lastSeq: 3 } as unknown as Session);
  const busy = await startRuntimeJob(deps, owner, 'w2', { agentId: 'opencode', action: 'uninstall' });
  assert.match(!busy.ok ? busy.error.message : '', /还有会话在用它/);
  const upgrade = await startRuntimeJob(deps, owner, 'w2', { agentId: 'opencode', action: 'install', version: '2.3.0' });
  assert.match(!upgrade.ok ? upgrade.error.message : '', /结束后再升级/);
  admin.sessionList.length = 0;
  const done = await startRuntimeJob(deps, owner, 'w2', { agentId: 'opencode', action: 'uninstall' });
  assert.ok(done.ok);
  assert.equal(done.value.version, null);
  assert.equal(admin.entries[0]?.action, 'runtime.uninstall');
});
