import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, type AuditEntry, type HubSettings, type Principal, type User, type UserId } from '../account.ts';
import type { ResourceSample } from '../resources.ts';
import { loadResourcePolicy, setRefuseWhenFull, workerMetricsHistory, type ResourceDeps } from './resources.ts';

const person = (email: string, role: User['role']): Principal =>
  ({
    user: { id: email as UserId, email, displayName: email, role, passwordHash: null, emailVerifiedAt: 1, disabledAt: null, createdAt: 1 },
    loginId: `login-${email}`
  }) as unknown as Principal;

function setup(history: ResourceSample[] = []) {
  let settings: HubSettings = DEFAULT_SETTINGS;
  const applied: (readonly string[])[] = [];
  const audit: AuditEntry[] = [];
  const deps: ResourceDeps = {
    metrics: { history: (id) => (id === 'w1' ? history : []), applyRefuseWhenFull: (ids) => applied.push(ids) },
    settings: { get: async () => settings, save: async (next) => void (settings = next) },
    workers: { list: async () => [] },
    audit: { append: async (entry: AuditEntry) => void audit.push(entry), recent: async () => audit } as unknown as ResourceDeps['audit'],
    now: () => 7
  };
  return { deps, applied, audit, settings: () => settings };
}

test('资源历史：单用户部署直接给；拿不到的机器是空数组', async () => {
  const sample = { at: 1 } as ResourceSample;
  const { deps } = setup([sample]);
  const got = await workerMetricsHistory(deps, null, 'w1');
  assert.ok(got.ok);
  assert.deepEqual(got.value, [sample]);
  const none = await workerMetricsHistory(deps, null, 'w9');
  assert.ok(none.ok && none.value.length === 0);
});

test('「满了拒绝新会话」开关：主人能开关，持久化、同步网关、记审计；成员不行；启动时同步', async () => {
  const world = setup();
  const owner = person('boss@b.co', 'owner');
  const on = await setRefuseWhenFull(world.deps, owner, 'w1', true);
  assert.ok(on.ok);
  assert.deepEqual(world.settings().refuseWhenFull, ['w1']);
  assert.deepEqual(world.applied.at(-1), ['w1']);
  assert.equal(world.audit[0]?.action, 'worker.resource_policy');
  assert.equal(world.audit[0]?.target, 'w1');
  const denied = await setRefuseWhenFull(world.deps, person('m@b.co', 'member'), 'w1', false);
  assert.equal(denied.ok, false);
  assert.deepEqual(world.settings().refuseWhenFull, ['w1']);
  await setRefuseWhenFull(world.deps, owner, 'w1', false);
  assert.deepEqual(world.settings().refuseWhenFull, []);
  world.applied.length = 0;
  await loadResourcePolicy(world.deps);
  assert.deepEqual(world.applied, [[]]);
});
