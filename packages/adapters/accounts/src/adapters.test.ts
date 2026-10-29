import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAccountMailer,
  createLogTransport,
  createResendTransport,
  createScryptHasher,
  createSmtpTransport,
  createTokenIssuer,
  mailFromEnv,
  renderAccountMail
} from './index.ts';

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

const RENDERED = { to: 'a@b.co', subject: 's', text: 't', html: '<p>t</p>' };

test('Resend：按 API 形状发信，失败抛错', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const ok = createResendTransport({
    apiKey: 'k', from: 'hub@x.co',
    fetch: (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response('{}', { status: 200 }); }) as typeof fetch
  });
  await ok.deliver(RENDERED);
  assert.equal(calls[0]?.url, 'https://api.resend.com/emails');
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { from: 'hub@x.co', to: ['a@b.co'], subject: 's', text: 't', html: '<p>t</p>' });

  const bad = createResendTransport({ apiKey: 'k', from: 'f', fetch: (async () => new Response('', { status: 422 })) as unknown as typeof fetch });
  await assert.rejects(bad.deliver(RENDERED));
});

test('SMTP：用 nodemailer 的 transport 发，带上发件人；按端口猜 TLS', async () => {
  const sent: unknown[] = [];
  let config: unknown;
  const fake = ((options: unknown) => {
    config = options;
    return { sendMail: async (message: unknown) => void sent.push(message) };
  }) as unknown as Parameters<typeof createSmtpTransport>[1];
  const smtp = createSmtpTransport({ host: 'smtp.qq.com', user: 'me@qq.com', pass: 'p', from: 'hub <me@qq.com>' }, fake);
  await smtp.deliver(RENDERED);
  assert.equal((config as { port: number; secure: boolean }).port, 465);
  assert.equal((config as { secure: boolean }).secure, true);
  assert.deepEqual(sent[0], { from: 'hub <me@qq.com>', to: 'a@b.co', subject: 's', text: 't', html: '<p>t</p>' });
  createSmtpTransport({ host: 'h', port: 587, from: 'f' }, fake);
  assert.equal((config as { secure: boolean }).secure, false);
});

test('模板：验证信带 HUB_PUBLIC_URL 拼的 hash 链接，HTML 做了转义', () => {
  const mail = renderAccountMail(
    { kind: 'verify-email', to: 'a@b.co', displayName: '<b>小明</b>', token: 'abc+/=', expiresAt: 30 * 60_000 },
    { publicUrl: 'https://hub.example.com/', now: 0 }
  );
  assert.match(mail.text, /https:\/\/hub\.example\.com\/#\/verify\?token=abc%2B%2F%3D/);
  assert.match(mail.text, /30 分钟内有效/);
  assert.ok(!mail.html.includes('<b>小明</b>'));
  assert.equal(renderAccountMail({ kind: 'password-changed', to: 'a@b.co', displayName: 'x', at: 0 }, { publicUrl: 'u' }).subject, 'agent-hub 密码已修改');
});

test('选发信方式：SMTP > Resend > 日志；没 HUB_PUBLIC_URL 一律只记日志', () => {
  const pick = (vars: Record<string, string>) =>
    mailFromEnv({ env: (name) => vars[name] ?? null, log: () => undefined, fallbackUrl: 'http://127.0.0.1:1' });
  const url = { HUB_PUBLIC_URL: 'https://h.co' };
  assert.equal(pick({ ...url, SMTP_HOST: 'smtp.qq.com', SMTP_USER: 'a@qq.com', RESEND_API_KEY: 'k' }).transport, 'smtp');
  assert.equal(pick({ ...url, RESEND_API_KEY: 'k' }).transport, 'resend');
  assert.equal(pick(url).transport, 'log');
  assert.equal(pick({ SMTP_HOST: 'smtp.qq.com', SMTP_USER: 'a@qq.com' }).transport, 'log');
  assert.equal(pick({ ...url, SMTP_HOST: 'h', SMTP_USER: 'not-an-email' }).transport, 'log');
  assert.equal(pick({ ...url, HUB_MAIL_PROVIDER: 'resend', SMTP_HOST: 'h', SMTP_USER: 'a@qq.com', RESEND_API_KEY: 'k' }).transport, 'resend');
  assert.equal(pick({ ...url, HUB_MAIL_PROVIDER: 'log', RESEND_API_KEY: 'k' }).transport, 'log');
  assert.equal(pick({ ...url, HUB_MAIL_PROVIDER: 'smtp', RESEND_API_KEY: 'k' }).transport, 'log');
  // 日志里不出现密钥
  assert.ok(!pick({ ...url, RESEND_API_KEY: 'secret-key' }).note.includes('secret-key'));
  assert.ok(!pick({ ...url, SMTP_URL: 'smtps://u:secret-pass@h:465', HUB_MAIL_FROM: 'f@h.co' }).note.includes('secret-pass'));
});

test('日志版：信（含链接）打进日志，并追加到 outbox 文件', async () => {
  const lines: string[] = [];
  const mailer = createAccountMailer({ transport: createLogTransport((line) => lines.push(line)), publicUrl: 'http://h', log: (line) => lines.push(line) });
  await mailer.send({ kind: 'reset-password', to: 'a@b.co', displayName: 'a', token: 'tok', expiresAt: Date.now() + 60_000 });
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /http:\/\/h\/#\/reset\?token=tok/);
});
