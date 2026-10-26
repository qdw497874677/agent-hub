import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inMemoryAccounts } from '../testing/in-memory.ts';
import { LOGIN_TTL_MS } from '../account.ts';
import { authenticate, loginAsFirstOwner, loginWithPassword, logout, registerUser, seedAccount } from './accounts.ts';

const PASSWORD = 'correct horse battery';

test('第一个注册的人是 Owner，之后都是成员；邮箱规范化、密码不存明文', async () => {
  const deps = inMemoryAccounts();
  const first = await registerUser(deps, { email: '  Alice@Example.com ', password: PASSWORD });
  const second = await registerUser(deps, { email: 'bob@example.com', password: PASSWORD });
  assert.ok(first.ok && second.ok);
  assert.equal(first.value.user.email, 'alice@example.com');
  assert.equal(first.value.user.role, 'owner');
  assert.equal(second.value.user.role, 'member');
  assert.equal(first.value.user.displayName, 'alice');
  assert.notEqual(first.value.user.passwordHash, PASSWORD);
  // 库里只有令牌的哈希
  assert.ok([...deps.loginRows.values()].every((row) => row.tokenHash !== first.value.token));
});

test('注册：邮箱重复、格式不对、密码太短或太常见都拒绝', async () => {
  const deps = inMemoryAccounts();
  await registerUser(deps, { email: 'a@b.co', password: PASSWORD });
  for (const [email, password] of [
    ['a@b.co', PASSWORD],
    ['not-an-email', PASSWORD],
    ['c@d.co', 'short'],
    ['c@d.co', 'Password1']
  ] as const) {
    assert.equal((await registerUser(deps, { email, password })).ok, false, `${email} / ${password}`);
  }
});

test('登录：邮箱不存在与密码错误给同一句话；停用的人登不进', async () => {
  const deps = inMemoryAccounts();
  const made = await registerUser(deps, { email: 'a@b.co', password: PASSWORD });
  assert.ok(made.ok);
  const wrong = await loginWithPassword(deps, { email: 'a@b.co', password: 'nope-nope-nope' });
  const missing = await loginWithPassword(deps, { email: 'x@b.co', password: PASSWORD });
  assert.ok(!wrong.ok && !missing.ok);
  assert.equal(wrong.error.message, missing.error.message);

  assert.ok((await loginWithPassword(deps, { email: 'A@B.CO', password: PASSWORD })).ok);
  await deps.users.save({ ...made.value.user, disabledAt: 5 });
  assert.equal((await loginWithPassword(deps, { email: 'a@b.co', password: PASSWORD })).ok, false);
});

test('认证：有效令牌认得出人并续期；过期、停用、登出后都认不出', async () => {
  let clock = 1_000;
  const deps = inMemoryAccounts(() => clock);
  const made = await registerUser(deps, { email: 'a@b.co', password: PASSWORD });
  assert.ok(made.ok);
  const { token } = made.value;

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

test('HUB_TOKEN 换登录落在最早的 Owner；还没人时提示先注册', async () => {
  const deps = inMemoryAccounts();
  assert.equal((await loginAsFirstOwner(deps, null)).ok, false);
  await registerUser(deps, { email: 'owner@b.co', password: PASSWORD });
  await registerUser(deps, { email: 'member@b.co', password: PASSWORD });
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

test('并发注册只产生一个 Owner', async () => {
  const deps = inMemoryAccounts();
  const made = await Promise.all(
    ['a', 'b', 'c', 'd'].map((name) => registerUser(deps, { email: `${name}@b.co`, password: PASSWORD }))
  );
  assert.ok(made.every((result) => result.ok));
  const owners = (await deps.users.list()).filter((user) => user.role === 'owner');
  assert.equal(owners.length, 1);
});
