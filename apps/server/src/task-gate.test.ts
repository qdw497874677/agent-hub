import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asTaskId } from '@agent-hub/domain';
import { createTaskGate } from './task-gate.ts';

test('task archive excludes active writers and new writers, but not other tasks', () => {
  const gate = createTaskGate();
  const task = asTaskId('task-a');
  const other = asTaskId('task-b');
  const one = gate.enter(task);
  const two = gate.enter(task);
  assert.ok(one && two);
  assert.equal(gate.exclusive(task), null);
  one();
  one();
  assert.equal(gate.exclusive(task), null);
  two();
  const leave = gate.exclusive(task);
  assert.ok(leave);
  assert.equal(gate.enter(task), null);
  assert.equal(gate.exclusive(task), null);
  const leaveOther = gate.exclusive(other);
  assert.ok(leaveOther);
  leaveOther();
  leave();
  const next = gate.enter(task);
  assert.ok(next);
  next();
});
