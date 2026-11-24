import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  asObject,
  checkRelativePath,
  exactString,
  PATH_MAX,
  rejectUnknownKeys,
  requiredExact
} from './project-session-input.ts';

function problem(result: { ok: boolean; error?: { message: string } }): string {
  assert.equal(result.ok, false);
  return result.error!.message;
}

test('exactString：缺省为 null，空白 / 超长 / 控制字符分别拒绝', () => {
  assert.deepEqual(exactString({}, 'request_key', 200), { ok: true, value: null });
  assert.deepEqual(exactString({ request_key: null }, 'request_key', 200), { ok: true, value: null });
  assert.equal(problem(exactString({ request_key: 1 }, 'request_key', 200)), 'request_key 必须是字符串');
  assert.equal(problem(exactString({ request_key: '' }, 'request_key', 200)), 'request_key 必须是非空字符串，且不能有首尾空白');
  assert.equal(problem(exactString({ request_key: ' x' }, 'request_key', 200)), 'request_key 必须是非空字符串，且不能有首尾空白');
  assert.equal(problem(exactString({ request_key: 'x'.repeat(201) }, 'request_key', 200)), 'request_key 不能超过 200 字符');
  assert.equal(problem(exactString({ request_key: 'a\u0000b' }, 'request_key', 200)), 'request_key 不能包含控制字符');
  assert.deepEqual(exactString({ request_key: 'ok' }, 'request_key', 200), { ok: true, value: 'ok' });
});

test('requiredExact：缺省报「必填」，其余沿用 exactString', () => {
  assert.equal(problem(requiredExact({}, 'agent_id', 200)), 'agent_id 必填');
  assert.equal(problem(requiredExact({ agent_id: '' }, 'agent_id', 200)), 'agent_id 必须是非空字符串，且不能有首尾空白');
  assert.deepEqual(requiredExact({ agent_id: 'a' }, 'agent_id', 200), { ok: true, value: 'a' });
});

test('asObject：只接受普通对象', () => {
  assert.equal(problem(asObject(null)), '参数必须是对象');
  assert.equal(problem(asObject([])), '参数必须是对象');
  assert.equal(problem(asObject('x')), '参数必须是对象');
  assert.deepEqual(asObject({ a: 1 }), { ok: true, value: { a: 1 } });
});

test('rejectUnknownKeys：只列键名，超过 5 个加「等」，键名截到 40 字', () => {
  const allowed = new Set(['request_key']);
  assert.equal(rejectUnknownKeys({ request_key: 'k' }, allowed), null);
  assert.equal(
    rejectUnknownKeys({ request_key: 'k', token: 'secret-value', actor_id: 'u1' }, allowed)?.message,
    '不支持的参数：token, actor_id'
  );
  const many = Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`k${index}`, 'v']));
  assert.equal(rejectUnknownKeys(many, allowed)?.message, '不支持的参数：k0, k1, k2, k3, k4 等');
  const longKey = 'k'.repeat(60);
  assert.equal(rejectUnknownKeys({ [longKey]: 'v' }, allowed)?.message, `不支持的参数：${'k'.repeat(40)}`);
});

test('checkRelativePath：只接受资产内相对 POSIX 路径', () => {
  assert.equal(checkRelativePath('docs/readme.md'), null);
  assert.equal(checkRelativePath('a'), null);
  assert.equal(checkRelativePath('/etc/passwd')?.message, '文件路径不合法：必须是资产内的相对 POSIX 路径');
  assert.equal(checkRelativePath('a\\b')?.message, '文件路径不合法：必须是资产内的相对 POSIX 路径');
  // 盘符 / 冒号按路径语义拒绝；不要拿标识 / 请求键的校验混进来
  assert.equal(checkRelativePath('C:/x')?.message, '文件路径不合法：必须是资产内的相对 POSIX 路径');
  assert.equal(checkRelativePath('dir/')?.message, '文件路径不合法：不能以 / 结尾');
  assert.equal(checkRelativePath('a//b')?.message, '文件路径不合法：不能包含空段、. 或 ..');
  assert.equal(checkRelativePath('a/./b')?.message, '文件路径不合法：不能包含空段、. 或 ..');
  assert.equal(checkRelativePath('a/../b')?.message, '文件路径不合法：不能包含空段、. 或 ..');
  assert.equal(checkRelativePath('a\u0001b')?.message, '文件路径不能包含控制字符');
  assert.equal(checkRelativePath('x'.repeat(PATH_MAX + 1))?.message, `文件路径不能超过 ${PATH_MAX} 字符`);
});
