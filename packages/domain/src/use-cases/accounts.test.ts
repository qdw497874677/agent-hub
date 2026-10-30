import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryAccounts } from '../testing/in-memory.ts';
import { LOGIN_TTL_MS } from '../account.ts';
import type { IssuedLogin } from './accounts.ts';
import { authenticate, loginAsFirstOwner, loginWithPassword, logout, registerUser, seedAccount } from './accounts.ts';

const PASSWORD = 'correct horse battery';

/** 第一个注册的人直接登录；拿出登录结果。 */
function loggedIn(result: Awaited<ReturnType<typeof registerUser>>): IssuedLogin {
  assert.ok(result.ok && result.value.kind === 'login', '应直接登录');
  return result.value.issued;
}

test('第一个注册的人是 hub 管理员兼自己团队的 Owner；邮箱规范化、密码不存明文', async () => {
  const deps = inMemoryAccounts();
  const first = loggedIn(await registerUser(deps, { email: '  Alice@Example.com ', password: PASSWORD }));
  assert.equal(first.user.email, 'alice@example.com');
  assert.equal(first.user.role, 'owner');
  assert.equal(first.user.hubAdmin, true);
  assert.ok(first.user.teamId);
  assert.equal(first.user.displayName, 'alice');
  assert.notEqual(first.user.passwordHash, PASSWORD);
  // 库里只有令牌的哈希
  assert.ok([...deps.loginRows.values()].every((row) => row.tokenHash !== first.token));
});

test('开放注册默认关闭：之后的人注册被拒，文案引导要邀请', async () => {
  const deps = inMemoryAccounts();
  loggedIn(await registerUser(deps, { email: 'a@b.co', password: PASSWORD }));
  const closed = await registerUser(deps, { email: 'bob@example.com', password: PASSWORD });
  assert.ok(!closed.ok && closed.error.code === 'conflict');
  assert.match(closed.error.message, /邀请/);
});

test('开放注册：自助注册的人得到自己的空团队并当 Owner；新旧邮箱回应一样（防枚举）', async () => {
  const deps = inMemoryAccounts();
  const admin = loggedIn(await registerUser(deps, { email: 'a@b.co', password: PASSWORD }));
  await deps.settings.save({ ...(await deps.settings.get()), openRegistration: true });
  const fresh = await registerUser(deps, { email: 'bob@example.com', password: PASSWORD });
  const again = await registerUser(deps, { email: 'a@b.co', password: PASSWORD });
  assert.ok(fresh.ok && again.ok);
  assert.deepEqual(fresh.value, { kind: 'check-email' });
  assert.deepEqual(again.value, fresh.value);
  const bob = await deps.users.byEmail('bob@example.com');
  assert.equal(bob?.role, 'owner');
  assert.equal(bob?.hubAdmin, false);
  assert.notEqual(bob?.teamId, admin.user.teamId);
});

test('注册：格式不对、密码太短或太常见都拒绝；邮箱重复不泄露', async () => {
  const deps = inMemoryAccounts();
  await registerUser(deps, { email: 'a@b.co', password: PASSWORD });
  await deps.settings.save({ ...(await deps.settings.get()), openRegistration: true });
  // 重复邮箱不报错（防枚举），只回「去查收邮件」
  const duplicate = await registerUser(deps, { email: 'a@b.co', password: PASSWORD });
  assert.ok(duplicate.ok && duplicate.value.kind === 'check-email');
  for (const [email, password] of [
    ['not-an-email', PASSWORD],
    ['c@d.co', 'short'],
    ['c@d.co', 'Password1']
  ] as const) {
    assert.equal((await registerUser(deps, { email, password })).ok, false, `${email} / ${password}`);
  }
});

test('登录：邮箱不存在与密码错误给同一句话；停用的人登不进', async () => {
  const deps = inMemoryAccounts();
  const made = loggedIn(await registerUser(deps, { email: 'a@b.co', password: PASSWORD }));
  const wrong = await loginWithPassword(deps, { email: 'a@b.co', password: 'nope-nope-nope' });
  const missing = await loginWithPassword(deps, { email: 'x@b.co', password: PASSWORD });
  assert.ok(!wrong.ok && !missing.ok);
  assert.equal(wrong.error.message, missing.error.message);

  assert.ok((await loginWithPassword(deps, { email: 'A@B.CO', password: PASSWORD })).ok);
  await deps.users.save({ ...made.user, disabledAt: 5 });
  assert.equal((await loginWithPassword(deps, { email: 'a@b.co', password: PASSWORD })).ok, false);
});

test('认证：有效令牌认得出人并续期；过期、停用、登出后都认不出', async () => {
  let clock = 1_000;
  const deps = inMemoryAccounts(() => clock);
  const { token } = loggedIn(await registerUser(deps, { email: 'a@b.co', password: PASSWORD }));

  clock += 2 * 60 * 60 * 1000;
  const principal = await authenticate(deps, token);
  assert.equal(principal?.user.email, 'a@b.co');
  assert.equal([...deps.loginRows.values()][0]?.expiresAt, clock + LOGIN_TTL_MS);

  assert.equal(await authenticate(deps, 'forged'), null);
  clock += LOGIN_TTL_MS + 1;
  assert.equal(await authenticate(deps, token), null);

  clock = 1_000;
  const again = await loginWithPassword(deps, { email: 'a@b.co', password: PASSWORD });
  assert.ok(again.ok);
  const who = await authenticate(deps, again.value.token);
  assert.ok(who);
  await logout(deps, who);
  assert.equal(await authenticate(deps, again.value.token), null);
});

test('HUB_TOKEN 换登录落在 hub 管理员；还没人时提示先注册', async () => {
  const deps = inMemoryAccounts();
  assert.equal((await loginAsFirstOwner(deps, null)).ok, false);
  await registerUser(deps, { email: 'owner@b.co', password: PASSWORD });
  await seedAccount(deps, { email: 'member@b.co', password: PASSWORD, role: 'member', displayName: 'm' });
  const issued = await loginAsFirstOwner(deps, 'curl');
  assert.ok(issued.ok);
  assert.equal(issued.value.user.email, 'owner@b.co');
  assert.equal([...deps.loginRows.values()].at(-1)?.method, 'hub-token');
});

test('内置账号幂等：重复调用不重建，换了密码就对齐', async () => {
  const deps = inMemoryAccounts();
  const seed = { email: 'test@agent-hub.local', password: PASSWORD, role: 'owner' as const, displayName: '测试账号' };
  const once = await seedAccount(deps, seed);
  const twice = await seedAccount(deps, seed);
  assert.ok(once.ok && twice.ok);
  assert.equal(once.value.id, twice.value.id);
  await seedAccount(deps, { ...seed, password: 'another long password' });
  assert.ok((await loginWithPassword(deps, { email: seed.email, password: 'another long password' })).ok);
  assert.equal((await loginWithPassword(deps, { email: seed.email, password: PASSWORD })).ok, false);
});

test('并发注册只产生一个 hub 管理员', async () => {
  const deps = inMemoryAccounts();
  const made = await Promise.all(
    ['a', 'b', 'c', 'd'].map((name) => registerUser(deps, { email: `${name}@b.co`, password: PASSWORD }))
  );
  // 只有一个抢到 hub 管理员；其余的因注册未开放被拒
  assert.equal(made.filter((result) => result.ok).length, 1);
  const admins = (await deps.users.list()).filter((user) => user.hubAdmin);
  assert.equal(admins.length, 1);
});
