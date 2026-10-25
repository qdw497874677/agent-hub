import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogSender, createResendSender, createScryptHasher, createTokenIssuer } from './index.ts';

test('scrypt：同一密码两次哈希不同（加盐），校验对错分明，格式自带参数', async () => {
  const hasher = createScryptHasher({ n: 2 ** 10 });
  const a = await hasher.hash('correct horse battery');
  const b = await hasher.hash('correct horse battery');
  assert.notEqual(a, b);
  assert.match(a, /^scrypt\$1024\$8\$1\$/);
  assert.equal(await hasher.verify('correct horse battery', a), true);
  assert.equal(await hasher.verify('wrong', a), false);
  assert.equal(await hasher.verify('x', 'garbage'), false);
});

test('令牌：高熵、每次不同、哈希稳定且不等于令牌', () => {
  const tokens = createTokenIssuer();
  const one = tokens.issue();
  assert.notEqual(one.token, tokens.issue().token);
  assert.ok(one.token.length >= 43);
  assert.equal(tokens.hashOf(one.token), one.hash);
  assert.notEqual(one.hash, one.token);
});

test('Resend：按 API 形状发信，失败抛错；日志版只记一行', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const ok = createResendSender({
    apiKey: 'k', from: 'hub@x.co',
    fetch: (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response('{}', { status: 200 }); }) as typeof fetch
  });
  await ok.send({ to: 'a@b.co', subject: 's', text: 't' });
  assert.equal(calls[0]?.url, 'https://api.resend.com/emails');
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { from: 'hub@x.co', to: ['a@b.co'], subject: 's', text: 't' });

  const bad = createResendSender({ apiKey: 'k', from: 'f', fetch: (async () => new Response('', { status: 422 })) as unknown as typeof fetch });
  await assert.rejects(bad.send({ to: 'a@b.co', subject: 's', text: 't' }));

  const lines: string[] = [];
  await createLogSender((line) => lines.push(line)).send({ to: 'a@b.co', subject: 's', text: 't' });
  assert.equal(lines.length, 1);
});
