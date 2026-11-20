import assert from 'node:assert/strict';
import { deepStrictEqual } from 'node:assert';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { Hono } from 'hono';
import type { McpReplayStore } from '@agent-hub/domain';
import { createIdempotency, IDEMPOTENCY_HEADER, IDEMPOTENCY_PLACEHOLDER_MS, IDEMPOTENCY_TTL_MS } from './idempotency.ts';

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
    release: async (key) => {
      if (rows.get(key)?.status === 'pending') rows.delete(key);
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
const replayKeyOf = (token: string, path: string, key: string, body = ''): string =>
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

test('同一个 key 换了请求体：不回放旧结果，重新执行', async () => {
  const store = memoryStore();
  const counter = { hits: 0 };
  const app = build(store, counter);

  const first = await post(app, '/v1/things', 'same-key', 'ahp_a', '{"a":1}');
  assert.equal(first.status, 201);
  const second = await post(app, '/v1/things', 'same-key', 'ahp_a', '{"a":2}');
  assert.equal(second.status, 201);
  assert.equal(second.headers.get('idempotent-replay'), null);
  deepStrictEqual(await second.json(), { n: 2 });
  assert.equal(counter.hits, 2);
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
