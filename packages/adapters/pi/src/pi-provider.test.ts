import { test } from 'node:test';
import assert from 'node:assert/strict';
import { piProviderSource } from './pi-provider.ts';

const TOKEN = 'relay-token-must-not-leak';
const launch = { slug: 'gw', name: 'GW', protocol: 'openai-chat' as const, models: [{ id: 'm-1.5', name: 'M' }], baseUrl: 'http://127.0.0.1:4100/r/h1', token: TOKEN };

test('Pi 扩展不含令牌值', () => {
  const text = piProviderSource(launch);
  assert.ok(!text.includes(TOKEN));
  assert.ok(text.includes('HUB_PROVIDER_TOKEN'));
  assert.ok(text.includes('127.0.0.1:4100'));
  assert.match(text, /registerProvider\("hub-gw"/);
});
