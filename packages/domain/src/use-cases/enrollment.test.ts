import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryAdmin, inMemoryEnrollment } from '../testing/in-memory.ts';
import { authenticateWorker, enrollWorker, issuePairingCode, revokeWorker } from './enrollment.ts';
import { PAIRING_TTL_MS } from '../enrollment.ts';
import type { Principal, User, UserId } from '../account.ts';

async function setup() {
  let clock = 1_000;
  const now = () => clock;
  const admin = inMemoryAdmin(now);
  const { deps, credentials, pairings } = inMemoryEnrollment(admin, now);
  const principal = async (email: string, role: User['role']): Promise<Principal> => {
    const user: User = {
      id: email as UserId,
      email,
      displayName: email,
      role,
      passwordHash: null,
      emailVerifiedAt: null,
      disabledAt: null,
      createdAt: 1,
      teamId: null,
      clusterAdmin: false,
      deletedAt: null
    };
    await admin.accounts.users.save(user);
    return { user, loginId: `login-${email}` } as unknown as Principal;
  };
  const owner = await principal('boss@b.co', 'owner');
  const member = await principal('m@b.co', 'member');
  return { admin, deps, credentials, pairings, owner, member, tick: (ms: number) => (clock += ms) };
}

test('接入码：只存哈希、15 分钟、只能用一次；换出的凭据绑定 workerId', async () => {
  const { deps, pairings, credentials, member, admin } = await setup();
  const issued = await issuePairingCode(deps, member);
  assert.ok(issued.ok);
  assert.match(issued.value.code, /^ahw_pair_/);
  assert.equal(issued.value.expiresAt, 1_000 + PAIRING_TTL_MS);
  assert.ok(![...pairings.keys()].includes(issued.value.code), '明文不落库');

  const enrolled = await enrollWorker(deps, { code: issued.value.code, label: '书房' });
  assert.ok(enrolled.ok);
  assert.match(enrolled.value.credential, /^ahw_/);
  const stored = credentials.get(enrolled.value.workerId)!;
  assert.notEqual(stored.tokenHash, enrolled.value.credential);
  assert.equal(stored.enrolledBy, member.user.id);

  const again = await enrollWorker(deps, { code: issued.value.code });
  assert.ok(!again.ok);
  assert.match(again.error.message, /无效或已过期/);
  assert.deepEqual(admin.entries.map((e) => e.action), ['worker.enroll', 'worker.pair']);
});

test('过期的码、乱写的码、签发人被停用的码：同一句拒绝', async () => {
  const { deps, member, tick, admin } = await setup();
  const late = await issuePairingCode(deps, member);
  assert.ok(late.ok);
  tick(PAIRING_TTL_MS);
  const expired = await enrollWorker(deps, { code: late.value.code });
  const bogus = await enrollWorker(deps, { code: 'ahw_pair_nope' });
  assert.ok(!expired.ok && !bogus.ok);
  assert.equal(expired.error.message, bogus.error.message);

  const fresh = await issuePairingCode(deps, member);
  assert.ok(fresh.ok);
  await admin.accounts.users.save({ ...member.user, disabledAt: 5 });
  const disabled = await enrollWorker(deps, { code: fresh.value.code });
  assert.ok(!disabled.ok);
  assert.equal(disabled.error.message, bogus.error.message);
});

test('主人关了「成员可以加机器」：成员签不出码，主人可以', async () => {
  const { deps, member, owner, admin } = await setup();
  await admin.accounts.settings.save({ ...(await admin.accounts.settings.get()), membersCanAddMachines: false });
  const denied = await issuePairingCode(deps, member);
  assert.ok(!denied.ok);
  assert.equal(denied.error.code, 'forbidden');
  assert.ok((await issuePairingCode(deps, owner)).ok);
  assert.ok(!(await issuePairingCode(deps, null)).ok);
});

test('hello 认证：凭据要对得上 workerId；有凭据记录的机器不再认共享令牌；吊销后进不来', async () => {
  const { deps, member } = await setup();
  const issued = await issuePairingCode(deps, member);
  assert.ok(issued.ok);
  const enrolled = await enrollWorker(deps, { code: issued.value.code });
  assert.ok(enrolled.ok);
  const { workerId, credential } = enrolled.value;

  assert.deepEqual(await authenticateWorker(deps, { workerId, credential, sharedTokenOk: false }), { ok: true, via: 'credential' });
  assert.equal((await authenticateWorker(deps, { workerId: 'other', credential, sharedTokenOk: true })).ok, false);
  assert.equal((await authenticateWorker(deps, { workerId, sharedTokenOk: true })).ok, false);
  // 老机器：没有凭据记录，凭共享令牌照旧
  assert.deepEqual(await authenticateWorker(deps, { workerId: 'legacy', sharedTokenOk: true }), { ok: true, via: 'shared' });
  assert.equal((await authenticateWorker(deps, { workerId: 'legacy', sharedTokenOk: false })).ok, false);

  assert.ok((await revokeWorker(deps, member, workerId)).ok);
  const after = await authenticateWorker(deps, { workerId, credential, sharedTokenOk: true });
  assert.deepEqual(after, { ok: false, reason: '这台机器已被吊销' });
});

test('吊销：成员只能吊销自己接入的；本机不能吊销；共享令牌的老机器记一条占位；会断开并写审计', async () => {
  const { deps, member, owner, admin } = await setup();
  const issued = await issuePairingCode(deps, owner);
  assert.ok(issued.ok);
  const enrolled = await enrollWorker(deps, { code: issued.value.code });
  assert.ok(enrolled.ok);
  const forbidden = await revokeWorker(deps, member, enrolled.value.workerId);
  assert.ok(!forbidden.ok);
  assert.equal(forbidden.error.code, 'forbidden');

  admin.workerList.push(
    { workerId: 'local', label: '本机', origin: 'local', state: 'online' } as never,
    { workerId: 'legacy', label: '老机器', origin: 'remote', state: 'online' } as never
  );
  const local = await revokeWorker(deps, owner, 'local');
  assert.ok(!local.ok);
  assert.equal(local.error.code, 'conflict');

  const legacy = await revokeWorker(deps, owner, 'legacy');
  assert.ok(legacy.ok);
  assert.deepEqual(admin.disconnected, ['legacy']);
  assert.equal((await authenticateWorker(deps, { workerId: 'legacy', sharedTokenOk: true })).ok, false);
  assert.equal(admin.entries[0]?.action, 'worker.revoke');
  assert.equal((await revokeWorker(deps, owner, 'legacy')).ok, false, '不重复吊销');
  assert.equal((await revokeWorker(deps, owner, 'ghost')).ok, false);
});
