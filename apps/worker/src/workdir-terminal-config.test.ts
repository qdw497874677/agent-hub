import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workdirTerminalEnabled, workdirTerminalManaged } from './workdir-terminal-config.ts';

test('workdir terminal is disabled by default and enabled only by explicit opt-in', () => {
  for (const value of [undefined, '', '0', 'true', 'yes']) {
    assert.equal(workdirTerminalEnabled({ WORKER_WORKDIR_TERMINAL: value }), false);
  }
  assert.equal(workdirTerminalEnabled({ WORKER_WORKDIR_TERMINAL: '1' }), true);
});

test('managed capability requires an enabled terminal, non-root uid and valid wss URL', () => {
  assert.equal(workdirTerminalManaged(true, 'wss://hub.example/worker', 1000), true);
  assert.equal(workdirTerminalManaged(false, 'wss://hub.example/worker', 1000), false);
  assert.equal(workdirTerminalManaged(true, 'wss://hub.example/worker', 0), false);
  assert.equal(workdirTerminalManaged(true, 'wss://hub.example/worker', undefined), false);
  assert.equal(workdirTerminalManaged(true, 'ws://hub.example/worker', 1000), false);
  assert.equal(workdirTerminalManaged(true, 'wss:not a url', 1000), false);
});
