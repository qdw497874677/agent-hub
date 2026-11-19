import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OPENCODE_NATIVE_MODEL, opencodeModel, opencodeReady } from './opencode-model.ts';

function withHubModel(value: string | undefined, fn: () => void): void {
  const previous = process.env['E2E_HUB_MODEL'];
  if (value === undefined) delete process.env['E2E_HUB_MODEL'];
  else process.env['E2E_HUB_MODEL'] = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env['E2E_HUB_MODEL'];
    else process.env['E2E_HUB_MODEL'] = previous;
  }
}

test('设置了 E2E_HUB_MODEL：OpenCode 用例用 Hub 模型，只要求 Worker 报了 opencode', () => {
  withHubModel('hub-cn-glm-flash/glm-5.3-flash', () => {
    assert.equal(opencodeModel(), 'hub-cn-glm-flash/glm-5.3-flash');
    assert.equal(opencodeReady({ models: [] }, opencodeModel()), true);
    assert.equal(opencodeReady(undefined, opencodeModel()), false);
  });
});

test('没设置 E2E_HUB_MODEL：保持原来的本机供应商模型和就绪判断', () => {
  withHubModel(undefined, () => {
    assert.equal(opencodeModel(), OPENCODE_NATIVE_MODEL);
    assert.equal(opencodeReady({ models: [] }, OPENCODE_NATIVE_MODEL), false);
    assert.equal(opencodeReady({ models: [OPENCODE_NATIVE_MODEL] }, OPENCODE_NATIVE_MODEL), true);
  });
});
