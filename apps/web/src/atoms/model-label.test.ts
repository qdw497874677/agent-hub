import assert from 'node:assert/strict';
import test from 'node:test';
import { MODEL_DEFAULT_LABEL, modelLabel } from './model-label.ts';

test('modelLabel：空串与空白都是运行时默认模型', () => {
  assert.equal(modelLabel(''), MODEL_DEFAULT_LABEL);
  assert.equal(modelLabel('   '), MODEL_DEFAULT_LABEL);
});

test('modelLabel：显式模型原样显示', () => {
  assert.equal(modelLabel('opencode/iceman-free'), 'opencode/iceman-free');
});
