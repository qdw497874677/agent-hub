import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverAcpModels, parseModelLines } from './discover-models.ts';
import { acpDescriptor } from './config.ts';

test('parseModelLines 只认 provider/model 行并去重', () => {
  const out = 'cliproxy/kimi-k2.8-code\n\nopencode/big-pickle\nsome log line here\ncliproxy/kimi-k2.8-code\n';
  assert.deepEqual(parseModelLines(out), ['cliproxy/kimi-k2.8-code', 'opencode/big-pickle']);
});

test('没装命令时返回空清单而不是抛错', async () => {
  const models = await discoverAcpModels({
    id: 'x',
    label: 'x',
    command: 'definitely-not-installed-xyz',
    args: [],
    listModelsArgs: ['models']
  });
  assert.deepEqual(models, []);
});

test('acpDescriptor 在会话报选项之前用启动时发现的模型', () => {
  const config = { id: 'x', label: 'x', command: 'x', args: [] };
  assert.deepEqual(acpDescriptor(config, [], ['a/b']).models, ['a/b']);
});
