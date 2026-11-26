import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serverToWorkerSchema, workerToServerSchema, workdirTerminalCreate, workdirTerminalInventory } from './index.ts';

test('workdir terminal frames and RPC use separate IDs, epoch and sessions admission', () => {
  const epoch = randomUUID(), terminalId = `wdt_${randomUUID()}`;
  assert.equal(workdirTerminalCreate.capability, 'sessions');
  assert.equal(workdirTerminalInventory.capability, 'sessions');
  assert.equal(workdirTerminalCreate.params.safeParse({ terminalId, epoch, workspaceId: 'w', cwd: '/tmp' }).success, true);
  assert.equal(workdirTerminalCreate.params.safeParse({ terminalId: 'session', epoch, workspaceId: 'w', cwd: '/tmp' }).success, false);
  assert.equal(workdirTerminalCreate.params.safeParse({ terminalId, workspaceId: 'w', cwd: '/tmp' }).success, false);
  assert.equal(workerToServerSchema.safeParse({ type: 'workdir_terminal_data_v1', terminalId, epoch, data: 'eA==' }).success, true);
  assert.equal(workerToServerSchema.safeParse({ type: 'workdir_terminal_data_v1', terminalId, data: 'eA==' }).success, false);
  assert.equal(serverToWorkerSchema.safeParse({ kind: 'workdir_terminal_input_v1', terminalId, epoch, data: 'eA==' }).success, true);
  assert.equal(serverToWorkerSchema.safeParse({ kind: 'workdir_terminal_detach_v1', terminalId, epoch, sessionId: 'fake' }).success, false);
});
