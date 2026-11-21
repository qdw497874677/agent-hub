import assert from 'node:assert/strict';
import { deepStrictEqual } from 'node:assert';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { Hono } from 'hono';
import type { McpReplayStore } from '@agent-hub/domain';
import {
  createIdempotency,
  IDEMPOTENCY_CONFLICT_CODE,
  IDEMPOTENCY_HEADER,
  IDEMPOTENCY_PLACEHOLDER_MS,
  IDEMPOTENCY_TTL_MS
} from './idempotency.ts';

interface Row {
  body: string;
  createdAt: number;
  status: 'pending' | 'done';
}

const memoryStore = (): McpReplayStore & { readonly rows: Map<string, Row> } => {
  const rows = new Map<string, Row>();
  return {
    rows,
    get: async (key, now = Date.now(), ttlMs = IDEMPOTENCY_TTL_MS) => {
      const row = rows.get(key);
      if (row === undefined || row.status !== 'done' || row.createdAt < now - ttlMs) return null;
      return row.body;
    },
    put: async (key, body, at) => {
      rows.set(key, { body, createdAt: at, status: 'done' });
    },
    claim: async (key, at, staleBefore, expiredBefore) => {
      const row = rows.get(key);
      if (row === undefined || row.createdAt < expiredBefore || (row.status === 'pending' && row.createdAt < staleBefore)) {
        rows.set(key, { body: '', createdAt: at, status: 'pending' });
        return true;
      }
      return false;
    },
    commit: async (key, body, at, claimedAt) => {
      const row = rows.get(key);
      if (row === undefined || row.status !== 'pending' || row.createdAt !== claimedAt) return false;
      rows.set(key, { body, createdAt: at, status: 'done' });
      return true;
    },
    release: async (key, claimedAt) => {
      const row = rows.get(key);
      if (row?.status !== 'pending') return;
      if (claimedAt !== undefined && row.createdAt !== claimedAt) return;
      rows.delete(key);
    }
  };
};

const build = (
  store: McpReplayStore | undefined,
  counter: { hits: number },
  options: { now?: () => number; ttlMs?: number } = {}
) => {
  const app = new Hono();
  app.use('/*', async (_c, next) => {
    await next();
  });
  app.use('/v1/*', createIdempotency(store === undefined ? {} : { store, ...options }).handle);
  const handler = (c: { json: (v: unknown, s?: 201) => Response }) => {
    counter.hits += 1;
    return c.json({ n: counter.hits }, 201);
  };
  app.post('/v1/things', handler);
  app.get('/v1/things', handler);
  app.post('/v1/boom', (c) => {
    counter.hits += 1;
    return c.json({ error: 'boom' }, 500);
  });
  return app;
};

const post = (app: Hono, path: string, key?: string, token = 'ahp_a', body?: string) =>
  app.request(path, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(key === undefined ? {} : { [IDEMPOTENCY_HEADER]: key })
    },
    ...(body === undefined ? {} : { body })
  });

const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
/** 现在的键：请求体不进键。 */
const replayKeyOf = (token: string, path: string, key: string): string =>
  [digest(`Bearer ${token}`), 'POST', path, key].join('\u0000');
/** 升级前的键：请求体摘要也在里面。 */
const legacyKeyOf = (token: string, path: string, key: string, body = ''): string =>
  [digest(`Bearer ${token}`), 'POST', path, digest(body), key].join('\u0000');

test('同一个 key + 同一个 body 重试只执行一次，第二次标 idempotent-replay', async () => {
  const store = memoryStore();
  const counter = { hits: 0 };
  const app = build(store, counter);

  const first = await post(app, '/v1/things', 'k1', 'ahp_a', '{"a":1}');
  assert.equal(first.status, 201);
  deepStrictEqual(await first.json(), { n: 1 });

  const second = await post(app, '/v1/things', 'k1', 'ahp_a', '{"a":1}');
  assert.equal(second.status, 201);
  assert.equal(second.headers.get('idempotent-replay'), 'true');
  deepStrictEqual(await second.json(), { n: 1 });
  assert.equal(counter.hits, 1);
});

test('同一个 key 换了请求体：409 冲突，不回放旧结果也不重新执行', async () => {
  const store = memoryStore();
  const counter = { hits: 0 };
  const app = build(store, counter);

  const first = await post(app, '/v1/things', 'same-key', 'ahp_a', '{"a":1}');
  assert.equal(first.status, 201);

  const second = await post(app, '/v1/things', 'same-key', 'ahp_a', '{"a":2}');
  assert.equal(second.status, 409);
  assert.equal(second.headers.get('idempotent-replay'), null);
  const error = (await second.json()) as { error?: { code?: string; message?: string } };
  assert.equal(error.error?.code, IDEMPOTENCY_CONFLICT_CODE);
  assert.match(String(error.error?.message), /不同的请求体/);
  assert.equal(counter.hits, 1, '换 body 不能重新执行');

  // 原来的请求体仍然可以回放：冲突不破坏第一次的结果。
  const again = await post(app, '/v1/things', 'same-key', 'ahp_a', '{"a":1}');
  assert.equal(again.status, 201);
  assert.equal(again.headers.get('idempotent-replay'), 'true');
  deepStrictEqual(await again.json(), { n: 1 });
  assert.equal(counter.hits, 1);
});

test('不带 key 的请求行为不变，每次都执行', async () => {
  const counter = { hits: 0 };
  const app = build(memoryStore(), counter);
  await post(app, '/v1/things');
  await post(app, '/v1/things');
  assert.equal(counter.hits, 2);
});

test('令牌不同 / 路径不同 / 方法不同都不共享结果', async () => {
  const counter = { hits: 0 };
  const app = build(memoryStore(), counter);

  await post(app, '/v1/things', 'same', 'ahp_a');
  await post(app, '/v1/things', 'same', 'ahp_b');
  assert.equal(counter.hits, 2);

  // GET 不是写方法，不走幂等
  await app.request('/v1/things', { headers: { authorization: 'Bearer ahp_a', [IDEMPOTENCY_HEADER]: 'same' } });
  assert.equal(counter.hits, 3);
});

test('5xx 不留档，重试会真的再跑', async () => {
  const counter = { hits: 0 };
  const app = build(memoryStore(), counter);
  await post(app, '/v1/boom', 'k2');
  await post(app, '/v1/boom', 'k2');
  assert.equal(counter.hits, 2);
});

test('5xx 没留下结果，之后换请求体也能执行（失败的那次不锁 key）', async () => {
  const store = memoryStore();
  const counter = { hits: 0 };
  const app = new Hono();
  app.use('/v1/*', createIdempotency({ store }).handle);
  app.post('/v1/maybe', (c) => {
    counter.hits += 1;
    return counter.hits === 1 ? c.json({ error: 'boom' }, 500) : c.json({ n: counter.hits }, 201);
  });

  assert.equal((await post(app, '/v1/maybe', 'k5', 'ahp_a', '{"a":1}')).status, 500);
  const retried = await post(app, '/v1/maybe', 'k5', 'ahp_a', '{"a":2}');
  assert.equal(retried.status, 201);
  assert.equal(counter.hits, 2);

  const replayed = await post(app, '/v1/maybe', 'k5', 'ahp_a', '{"a":2}');
  assert.equal(replayed.headers.get('idempotent-replay'), 'true');
  assert.equal(counter.hits, 2);
});

test('没装 store 时退化成直通', async () => {
  const counter = { hits: 0 };
  const app = build(undefined, counter);
  await post(app, '/v1/things', 'k3');
  await post(app, '/v1/things', 'k3');
  assert.equal(counter.hits, 2);
});

test('并发两个同 key 请求：只有一个真正执行，另一个 409', async () => {
  const store = memoryStore();
  const counter = { hits: 0 };
  const app = new Hono();
  app.use('/v1/*', createIdempotency({ store }).handle);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  app.post('/v1/slow', async (c) => {
    counter.hits += 1;
    await gate;
    return c.json({ n: counter.hits }, 201);
  });

  const first = post(app, '/v1/slow', 'k-race', 'ahp_a', '{"a":1}');
  // 等第一条真的进入 handler（说明占位已拿到）再发第二条。
  while (counter.hits === 0) await new Promise((resolve) => setImmediate(resolve));
  const second = await post(app, '/v1/slow', 'k-race', 'ahp_a', '{"a":1}');
  assert.equal(second.status, 409);
  assert.equal(second.headers.get('retry-after'), '1');
  release();
  const firstResponse = await first;
  assert.equal(firstResponse.status, 201);
  assert.equal(counter.hits, 1);
});

test('并发两个同 key 不同 body 的请求：只有一个执行，另一个 409 且不执行', async () => {
  const store = memoryStore();
  const counter = { hits: 0 };
  const app = new Hono();
  app.use('/v1/*', createIdempotency({ store }).handle);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  app.post('/v1/slow', async (c) => {
    counter.hits += 1;
    await gate;
    return c.json({ n: counter.hits }, 201);
  });

  const first = post(app, '/v1/slow', 'k-diff', 'ahp_a', '{"a":1}');
  while (counter.hits === 0) await new Promise((resolve) => setImmediate(resolve));
  const second = await post(app, '/v1/slow', 'k-diff', 'ahp_a', '{"a":2}');
  assert.equal(second.status, 409);
  assert.equal(second.headers.get('retry-after'), '1');
  release();
  assert.equal((await first).status, 201);
  assert.equal(counter.hits, 1);

  // 落档之后：原 body 回放，另一个 body 仍然 409，都不再执行。
  const replayed = await post(app, '/v1/slow', 'k-diff', 'ahp_a', '{"a":1}');
  assert.equal(replayed.headers.get('idempotent-replay'), 'true');
  const other = await post(app, '/v1/slow', 'k-diff', 'ahp_a', '{"a":2}');
  assert.equal(other.status, 409);
  assert.equal(other.headers.get('idempotent-replay'), null);
  assert.equal(counter.hits, 1);
});

test('占位超过 30 秒后可被后来的请求接管', async () => {
  let clock = 1_000;
  const store = memoryStore();
  const counter = { hits: 0 };
  const app = build(store, counter, { now: () => clock });
  // 模拟一个进程挂掉留下的占位。
  assert.equal(await store.claim!(replayKeyOf('ahp_a', '/v1/things', 'k-stale'), clock, clock - IDEMPOTENCY_PLACEHOLDER_MS, clock - IDEMPOTENCY_TTL_MS), true);

  const blocked = await post(app, '/v1/things', 'k-stale', 'ahp_a');
  assert.equal(blocked.status, 409);
  assert.equal(counter.hits, 0);

  clock += IDEMPOTENCY_PLACEHOLDER_MS + 1;
  const taken = await post(app, '/v1/things', 'k-stale', 'ahp_a');
  assert.equal(taken.status, 201);
  assert.equal(counter.hits, 1);
});

test('占位被接管后，老请求不会覆盖新请求的结果', async () => {
  let clock = 1_000;
  const store = memoryStore();
  const hits = { a: 0, b: 0 };
  const app = new Hono();
  app.use('/v1/*', createIdempotency({ store, now: () => clock }).handle);
  let releaseA!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  let enteredA!: () => void;
  const startedA = new Promise<void>((resolve) => {
    enteredA = resolve;
  });
  app.post('/v1/race', async (c) => {
    const body = await c.req.text();
    if (body === '{"v":"a"}') {
      hits.a += 1;
      enteredA();
      await gate;
      return c.json({ from: 'a' }, 201);
    }
    hits.b += 1;
    return c.json({ from: 'b' }, 201);
  });

  const first = post(app, '/v1/race', 'k-takeover', 'ahp_a', '{"v":"a"}');
  await startedA;
  // a 卡住超过占位超时 → b 接管同一个 key。
  clock += IDEMPOTENCY_PLACEHOLDER_MS + 1;
  const second = await post(app, '/v1/race', 'k-takeover', 'ahp_a', '{"v":"b"}');
  assert.equal(second.status, 201);
  deepStrictEqual(await second.json(), { from: 'b' });

  // a 现在才写完：结果作废，不能覆盖 b 写下的记录。
  releaseA();
  assert.equal((await first).status, 201);
  assert.equal(hits.a, 1);
  assert.equal(hits.b, 1);

  const replayed = await post(app, '/v1/race', 'k-takeover', 'ahp_a', '{"v":"b"}');
  assert.equal(replayed.headers.get('idempotent-replay'), 'true');
  deepStrictEqual(await replayed.json(), { from: 'b' });
  const staleBody = await post(app, '/v1/race', 'k-takeover', 'ahp_a', '{"v":"a"}');
  assert.equal(staleBody.status, 409);
  assert.equal(hits.a, 1, '被接管的老请求不能重跑');
  assert.equal(hits.b, 1);
});

test('超过 TTL 的已完成结果不会被回放', async () => {
  let clock = 1_000;
  const store = memoryStore();
  const counter = { hits: 0 };
  const app = build(store, counter, { now: () => clock, ttlMs: 1_000 });

  assert.equal((await post(app, '/v1/things', 'k-ttl')).status, 201);
  assert.equal(counter.hits, 1);

  clock += 999;
  const hit = await post(app, '/v1/things', 'k-ttl');
  assert.equal(hit.headers.get('idempotent-replay'), 'true');
  assert.equal(counter.hits, 1);

  clock += 2;
  const expired = await post(app, '/v1/things', 'k-ttl');
  assert.equal(expired.status, 201);
  assert.equal(expired.headers.get('idempotent-replay'), null);
  assert.equal(counter.hits, 2);
});

test('TTL 内的 body 冲突在过期后解除：新一个 key 生命周期重新计时', async () => {
  let clock = 1_000;
  const store = memoryStore();
  const counter = { hits: 0 };
  const app = build(store, counter, { now: () => clock, ttlMs: 1_000 });

  assert.equal((await post(app, '/v1/things', 'k-ttl-diff', 'ahp_a', '{"a":1}')).status, 201);
  clock += 500;
  const conflict = await post(app, '/v1/things', 'k-ttl-diff', 'ahp_a', '{"a":2}');
  assert.equal(conflict.status, 409);
  assert.equal(counter.hits, 1);

  // 过了 TTL，旧结果不再可回放，同一个 key 重新从这次请求开始算。
  clock += 501;
  const fresh = await post(app, '/v1/things', 'k-ttl-diff', 'ahp_a', '{"a":2}');
  assert.equal(fresh.status, 201);
  assert.equal(fresh.headers.get('idempotent-replay'), null);
  assert.equal(counter.hits, 2);

  assert.equal((await post(app, '/v1/things', 'k-ttl-diff', 'ahp_a', '{"a":2}')).headers.get('idempotent-replay'), 'true');
  assert.equal((await post(app, '/v1/things', 'k-ttl-diff', 'ahp_a', '{"a":1}')).status, 409);
  assert.equal(counter.hits, 2);
});

test('升级前的旧行：同一个请求体继续回放，并迁移到新键', async () => {
  let clock = 5_000;
  const store = memoryStore();
  const counter = { hits: 0 };
  const app = build(store, counter, { now: () => clock });
  const oldBody = '{"a":1}';
  store.rows.set(legacyKeyOf('ahp_a', '/v1/things', 'k-old', oldBody), {
    body: JSON.stringify({ status: 201, body: '{"n":9}', contentType: 'application/json', at: 4_000 }),
    createdAt: 4_000,
    status: 'done'
  });

  const replayed = await post(app, '/v1/things', 'k-old', 'ahp_a', oldBody);
  assert.equal(replayed.status, 201);
  assert.equal(replayed.headers.get('idempotent-replay'), 'true');
  deepStrictEqual(await replayed.json(), { n: 9 });
  assert.equal(counter.hits, 0);

  // 迁到新键时保留旧完成时间（TTL 不续命）。
  const migrated = store.rows.get(replayKeyOf('ahp_a', '/v1/things', 'k-old'));
  assert.equal(migrated?.status, 'done');
  assert.equal(migrated?.createdAt, 4_000);

  // 迁移之后这个 key 进入新语义：换 body 就是 409。
  const other = await post(app, '/v1/things', 'k-old', 'ahp_a', '{"a":2}');
  assert.equal(other.status, 409);
  assert.equal(counter.hits, 0);

  // 迁移后的结果照常过期。
  clock = 4_000 + IDEMPOTENCY_TTL_MS + 1;
  const expired = await post(app, '/v1/things', 'k-old', 'ahp_a', oldBody);
  assert.equal(expired.status, 201);
  assert.equal(counter.hits, 1);
});

test('升级前的旧行：换个请求体查不到旧行，仍会执行（已知的过渡限制）', async () => {
  const store = memoryStore();
  const counter = { hits: 0 };
  const app = build(store, counter);
  store.rows.set(legacyKeyOf('ahp_a', '/v1/things', 'k-old2', '{"a":1}'), {
    body: JSON.stringify({ status: 201, body: '{"n":9}', contentType: 'application/json', at: 4_000 }),
    createdAt: 4_000,
    status: 'done'
  });

  // 旧键里的请求体事后不可知：新 body 查不到这一行，只能执行一次。
  const other = await post(app, '/v1/things', 'k-old2', 'ahp_a', '{"a":2}');
  assert.equal(other.status, 201);
  assert.equal(counter.hits, 1);

  // 从这次写入起，这个 key 已被新 body 占用，旧 body 再来就是 409。
  const staleBody = await post(app, '/v1/things', 'k-old2', 'ahp_a', '{"a":1}');
  assert.equal(staleBody.status, 409);
  assert.equal(counter.hits, 1);
});
