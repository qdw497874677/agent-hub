import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOT_CREDENTIAL_HINT,
  BOT_CREDENTIAL_SCOPES,
  botCredentialBody,
  botCredentialName,
  botCredentialRevokeConfirm,
  botCredentialView,
  usedText
} from './bot-credential.ts';

/** 本地时间构造，和 stampText 的本地读取对齐，跑在哪个时区都稳。 */
const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

test('没发过凭据：状态是 none，文案说清用途和边界', () => {
  const view = botCredentialView(null, at(2026, 11, 13, 9, 5));
  assert.equal(view.state, 'none');
  assert.equal(view.state === 'none' ? view.hint : '', BOT_CREDENTIAL_HINT);
  assert.match(BOT_CREDENTIAL_HINT, /Bearer/);
  assert.match(BOT_CREDENTIAL_HINT, /\/openapi\/v1/);
  assert.match(BOT_CREDENTIAL_HINT, /只能访问这个项目/);
  assert.equal(botCredentialView(undefined, at(2026, 11, 13)).state, 'none');
});

test('发过但没用过：给前缀、创建时间，最近使用写「还没用过」', () => {
  const view = botCredentialView(
    { id: 'tk1', prefix: 'ahb_1f3c9d', createdAt: at(2026, 11, 13, 9, 5), lastUsedAt: null },
    at(2026, 11, 13, 10, 0)
  );
  assert.equal(view.state, 'issued');
  if (view.state !== 'issued') return;
  assert.equal(view.id, 'tk1');
  assert.equal(view.prefix, 'ahb_1f3c9d');
  assert.equal(view.created, '创建于 2026-11-13 09:05');
  assert.equal(view.lastUsed, '还没用过');
});

test('用过的凭据按调用方给的 now 算相对时间', () => {
  const now = at(2026, 11, 13, 12, 0);
  const used = (lastUsedAt: number) =>
    botCredentialView({ id: 'tk1', prefix: 'ahb_1f3c9d', createdAt: now, lastUsedAt }, now);
  const text = (lastUsedAt: number) => {
    const view = used(lastUsedAt);
    return view.state === 'issued' ? view.lastUsed : '';
  };
  assert.equal(text(now - 30_000), '刚刚用过');
  assert.equal(text(now - 3 * 60_000), '3 分钟前用过');
  assert.equal(text(now - 2 * 3_600_000), '2 小时前用过');
  assert.equal(text(now - 3 * 86_400_000), '3 天前用过');
  // 超过一周给绝对时间，别出现「41 天前」这种没法核对的数
  assert.equal(text(at(2026, 10, 1, 8, 30)), '2026-10-01 08:30 用过');
});

test('时钟偏差不出现「-1 分钟前」', () => {
  const now = at(2026, 11, 13, 12, 0);
  assert.equal(usedText(now + 5_000, now), '刚刚用过');
});

test('吊销确认文案说清后果，带上 bot 的 @id', () => {
  const text = botCredentialRevokeConfirm('reviewer');
  assert.match(text, /@reviewer/);
  assert.match(text, /吊销/);
  assert.match(text, /立刻失效/);
});

test('发放请求体：kind 是 bot、带项目、带 @id、权限固定五条', () => {
  assert.deepEqual(botCredentialBody('p1', ' reviewer '), {
    name: 'reviewer 的凭据',
    kind: 'bot',
    projectId: 'p1',
    botName: 'reviewer',
    scopes: BOT_CREDENTIAL_SCOPES
  });
  const body = botCredentialBody('p1', 'reviewer');
  assert.deepEqual([...body.scopes], [
    'projects:read',
    'sessions:write',
    'groups:write',
    'files:read',
    'memory:read'
  ]);
});

test('令牌名不超过 60 字；bot 没名字时也给个能读的名字', () => {
  assert.equal(botCredentialName(''), 'bot 的凭据');
  assert.equal(botCredentialName('   '), 'bot 的凭据');
  const long = botCredentialName('x'.repeat(80));
  assert.equal([...long].length, 60);
  assert.ok(long.endsWith(' 的凭据'));
});
