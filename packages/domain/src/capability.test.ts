import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPABILITY_NAMES,
  available,
  capabilityMatrix,
  denied,
  limited,
  unavailableReason
} from './capability.ts';

function full(state: 'available' | 'limited' | 'denied') {
  const raw = Object.fromEntries(
    CAPABILITY_NAMES.map((name) => [
      name,
      state === 'available' ? available : state === 'limited' ? limited('部分可用') : denied('不支持')
    ])
  );
  return capabilityMatrix(raw as never);
}

test('三态都能构造，且 available 无原因', () => {
  assert.equal(full('available').fork.state, 'available');
  assert.equal(unavailableReason(full('available'), 'fork'), null);
});

test('limited 与 denied 必须带原因——用户看到置灰要知道为什么', () => {
  assert.throws(() =>
    capabilityMatrix({ ...full('available'), fork: { state: 'limited' } } as never)
  );
  assert.throws(() =>
    capabilityMatrix({ ...full('available'), fork: { state: 'denied', reason: ' ' } } as never)
  );
  assert.equal(unavailableReason(full('denied'), 'fork'), '不支持');
});
