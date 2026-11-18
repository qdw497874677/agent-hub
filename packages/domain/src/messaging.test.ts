import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asSessionId } from './ids.ts';
import { addressName, botAddress, parseAddress, promptOpening, wrapUntrusted } from './messaging.ts';

test('地址：bot:<name> 是唯一写入写法，role:<name> 只读兼容', () => {
  assert.deepEqual(parseAddress('bot:reviewer'), { kind: 'bot', name: 'reviewer' });
  assert.deepEqual(parseAddress('role:reviewer'), { kind: 'role', role: 'reviewer' });
  assert.deepEqual(parseAddress('session:s1'), { kind: 'session', sessionId: asSessionId('s1') });
  assert.equal(parseAddress('bot:'), null);
  assert.equal(parseAddress('nothing'), null);
  assert.equal(botAddress('reviewer'), 'bot:reviewer');
  assert.equal(addressName({ kind: 'bot', name: 'fixer' }), 'fixer');
  assert.equal(addressName({ kind: 'role', role: 'old' }), 'old');
  assert.equal(addressName({ kind: 'session', sessionId: asSessionId('s1') }), '');
});

test('promptOpening：agent 消息只留正文并标类型；普通输入原样压空白', () => {
  const wrapped = wrapUntrusted({
    message: { id: 'm', kind: 'ask', traceId: 't', depth: 1, body: '帮我 <看看>\n测试', replyTo: null, failure: null, failureDetail: null, parts: [], replyStatus: null },
    fromLabel: 'pi', fromSessionId: 's', onBehalfOfName: 'alice'
  });
  assert.equal(promptOpening(wrapped), 'agent 提问：帮我 <看看> 测试');
  assert.equal(promptOpening('  你好\n  世界 '), '你好 世界');
});
