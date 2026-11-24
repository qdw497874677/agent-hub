import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import type { Principal, Subject } from '@agent-hub/domain';
import { humanOf, NO_STORE, readJson } from './http-helpers.ts';

const cookieHuman = { user: { id: 'u1' }, loginId: 'l1' } as unknown as Principal;

test('humanOf: 只认 cookie 登录的人，令牌 / 系统 / 空主体都不是人', () => {
  assert.equal(humanOf(null), null);
  assert.equal(humanOf({ system: true } as unknown as Subject), null);
  assert.equal(humanOf({ ...cookieHuman, via: { kind: 'api-token' } } as unknown as Subject), null);
  assert.equal(humanOf(cookieHuman as Subject), cookieHuman);
});

test('readJson: 坏 JSON / 空 body 返回 null，合法 JSON 原样解析', async () => {
  const app = new Hono();
  app.post('/echo', async (c) => c.json({ value: await readJson(c) }));

  const malformed = await app.request('/echo', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json'
  });
  assert.equal(malformed.status, 200);
  assert.deepEqual(await malformed.json(), { value: null });

  const empty = await app.request('/echo', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: ''
  });
  assert.deepEqual(await empty.json(), { value: null });

  const valid = await app.request('/echo', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ a: 1 })
  });
  assert.deepEqual(await valid.json(), { value: { a: 1 } });
});

test('NO_STORE: 固定 cache-control: no-store', () => {
  assert.deepEqual(NO_STORE, { 'cache-control': 'no-store' });
});
