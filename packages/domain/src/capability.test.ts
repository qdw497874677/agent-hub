import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPABILITY_NAMES,
  available,
  capabilityMatrix,
  denied,
  limited,
  unavailableReason,
  type Capability,
  type CapabilityName
} from './capability.ts';

/** 故意造出类型上合法、运行时违规的输入（缺 reason），验证构造器的运行时校验。 */
const missingReason: Capability = { state: 'limited' };

function full(state: 'available' | 'limited' | 'denied') {
  const raw = Object.fromEntries(
    CAPABILITY_NAMES.map((name) => [
      name,
      state === 'available' ? available : state === 'limited' ? limited('部分可用') : denied('不支持')
    ])
  );
  return capabilityMatrix(raw as Record<CapabilityName, Capability>);
}

test('三态都能构造，且 available 无原因', () => {
  assert.equal(full('available').fork.state, 'available');
  assert.equal(unavailableReason(full('available'), 'fork'), null);
});

test('limited 与 denied 必须带原因——用户看到置灰要知道为什么', () => {
  assert.throws(() =>
    capabilityMatrix({ ...full('available'), fork: missingReason })
  );
  assert.throws(() =>
    capabilityMatrix({ ...full('available'), fork: denied(' ') })
  );
  assert.equal(unavailableReason(full('denied'), 'fork'), '不支持');
});
