import { test } from 'node:test';
import assert from 'node:assert/strict';
import { opencodeDialect, opencodeProviderConfig } from './opencode-provider.ts';

const TOKEN = 'relay-token-must-not-leak';
const launch = { slug: 'gw', name: 'GW', protocol: 'openai-chat' as const, models: [{ id: 'm-1.5', name: 'M' }], baseUrl: 'http://127.0.0.1:4100/r/h1', token: TOKEN };

test('OpenCode 配置不含令牌值', () => {
  for (const text of [JSON.stringify(opencodeProviderConfig(launch, 'v1')), JSON.stringify(opencodeProviderConfig(launch, 'v2'))]) {
    assert.ok(!text.includes(TOKEN));
    assert.ok(text.includes('HUB_PROVIDER_TOKEN'));
    assert.ok(text.includes('127.0.0.1:4100'));
  }
});

test('OpenCode v2 用 providers / package / settings；v1 用 provider', () => {
  const v2 = opencodeProviderConfig(launch, 'v2') as { providers: Record<string, { package: string; settings: { baseURL: string }; models: Record<string, unknown> }> };
  assert.equal(v2.providers['hub-gw']!.package, '@opencode/ai/providers/openai-compatible');
  assert.ok(v2.providers['hub-gw']!.models['m-1.5']);
  assert.ok('provider' in opencodeProviderConfig(launch, 'v1'));
  assert.equal(opencodeDialect('2.2.2'), 'v2');
  assert.equal(opencodeDialect('1.19.4'), 'v1');
});

