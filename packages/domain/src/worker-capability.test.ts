import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canInvoke, commandCapability, narrowCapabilities, normalizeCapabilities, presetOf, WORKER_CAPABILITIES, WORKER_CAPABILITY_PRESETS } from './worker-capability.ts';

test('老凭据（null）按 full', () => {
  assert.deepEqual(normalizeCapabilities(null), WORKER_CAPABILITIES);
  assert.equal(presetOf(null), 'full');
  assert.ok(canInvoke(null, 'git.remote'));
});

test('control 永远允许；readonly 不含 sessions', () => {
  const ro = WORKER_CAPABILITY_PRESETS.readonly;
  assert.ok(canInvoke(ro, 'control'));
  assert.ok(canInvoke(ro, 'files.read'));
  assert.equal(canInvoke(ro, 'sessions'), false);
  assert.equal(canInvoke(ro, 'files.write'), false);
});

test('预设识别与未知能力丢弃', () => {
  assert.equal(presetOf(WORKER_CAPABILITY_PRESETS['no-remote']), 'no-remote');
  assert.equal(presetOf(['files.read', 'bogus']), 'readonly');
  assert.equal(presetOf(['files.read', 'git']), null);
});

test('只能收窄', () => {
  assert.deepEqual(narrowCapabilities(WORKER_CAPABILITY_PRESETS.readonly, WORKER_CAPABILITIES), ['files.read']);
  assert.deepEqual(narrowCapabilities(null, ['git', 'sessions']), ['sessions', 'git']);
});

test('指令帧映射', () => {
  assert.equal(commandCapability('prompt'), 'sessions');
  assert.equal(commandCapability('runtime_job'), 'runtimes');
  assert.equal(commandCapability('update'), 'update');
  assert.equal(commandCapability('welcome'), 'control');
});
