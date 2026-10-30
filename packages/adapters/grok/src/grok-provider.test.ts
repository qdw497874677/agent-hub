import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grokProviderToml } from './grok-provider.ts';

const TOKEN = 'relay-token-must-not-leak';
const launch = { slug: 'gw', name: 'GW', protocol: 'openai-chat' as const, models: [{ id: 'm-1.5', name: 'M' }], baseUrl: 'http://127.0.0.1:4100/r/h1', token: TOKEN };

test('Grok 配置不含令牌值；模型表名带点要加引号', () => {
  const text = grokProviderToml(launch);
  assert.ok(!text.includes(TOKEN));
  assert.ok(text.includes('HUB_PROVIDER_TOKEN'));
  assert.ok(text.includes('127.0.0.1:4100'));
  assert.match(text, /\[model\."hub-gw\/m-1\.5"\]/);
  assert.match(grokProviderToml({ ...launch, protocol: 'anthropic' }), /x-api-key/);
});
