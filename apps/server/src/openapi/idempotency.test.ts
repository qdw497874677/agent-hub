import assert from 'node:assert/strict';
import { deepStrictEqual } from 'node:assert';
import test from 'node:test';
import { Hono } from 'hono';
import type { McpReplayStore } from '@agent-hub/domain';
import { createIdempotency, IDEMPOTENCY_HEADER } from './idempotency.ts';

const memoryStore = (): McpReplayStore & { readonly rows: Map<string, string> } => {
  const rows = new Map<string, string>();
  return {
    rows,
    get: async (key) => rows.get(key) ?? null,
    put: async (key, body) => {
      rows.set(key, body);
    }
  };
};

const build = (store: McpReplayStore | undefined, counter: { hits: number }) => {
  const app = new Hono();
  app.use('/*', async (_c, next) => {
    await next();
  });
  app.use('/v1/*', createIdempotency(store === undefined ? {} : { store }).handle);
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

const post = (app: Hono, path: string, key?: string, token = 'ahp_a') =>
  app.request(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, ...(key === undefined ? {} : { [IDEMPOTENCY_HEADER]: key }) }
  });

test('同一个 key 重试只执行一次，第二次标 idempotent-replay', async () => {
  const store = memoryStore();
  const counter = { hits: 0 };
  const app = build(store, counter);

  const first = await post(app, '/v1/things', 'k1');
  assert.equal(first.status, 201);
  deepStrictEqual(await first.json(), { n: 1 });

  const second = await post(app, '/v1/things', 'k1');
  assert.equal(second.status, 201);
  assert.equal(second.headers.get('idempotent-replay'), 'true');
  deepStrictEqual(await second.json(), { n: 1 });
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

test('没装 store 时退化成直通', async () => {
  const counter = { hits: 0 };
  const app = build(undefined, counter);
  await post(app, '/v1/things', 'k3');
  await post(app, '/v1/things', 'k3');
  assert.equal(counter.hits, 2);
});
