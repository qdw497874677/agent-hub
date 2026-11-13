import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asSessionId } from './ids.ts';
import { addressName, botAddress, parseAddress } from './messaging.ts';

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
