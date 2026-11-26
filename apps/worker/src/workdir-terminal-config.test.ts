import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workdirTerminalEnabled } from './workdir-terminal-config.ts';

test('workdir terminal is disabled by default and enabled only by explicit opt-in', () => {
  for (const value of [undefined, '', '0', 'true', 'yes']) {
    assert.equal(workdirTerminalEnabled({ WORKER_WORKDIR_TERMINAL: value }), false);
  }
  assert.equal(workdirTerminalEnabled({ WORKER_WORKDIR_TERMINAL: '1' }), true);
});
