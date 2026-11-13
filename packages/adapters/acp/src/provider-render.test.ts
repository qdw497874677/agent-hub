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

test('模型 extra 写进配置；保护键被丢弃；name / limit 不被覆盖', () => {
  const extra = {
    temperature: 0.2,
    top_p: 0.9,
    model: 'hijack',
    messages: [{ role: 'user', content: 'x' }],
    input: 'x',
    stream: true,
    stream_options: { include_usage: true },
    tools: [],
    name: 'extra 里的名字',
    limit: { context: 1, output: 1 }
  };
  const withExtra = { ...launch, models: [{ id: 'm-1.5', name: 'M', contextWindow: 128_000, maxTokens: 4096, extra }] };

  const v1 = opencodeProviderConfig(withExtra, 'v1') as {
    provider: Record<string, { models: Record<string, Record<string, unknown>> }>;
  };
  const one = v1.provider['hub-gw']!.models['m-1.5']!;
  assert.equal(one['temperature'], 0.2);
  assert.equal(one['top_p'], 0.9);
  for (const key of ['model', 'messages', 'input', 'stream', 'stream_options', 'tools']) {
    assert.equal(one[key], undefined, `保护键 ${key} 不应写进配置`);
  }
  assert.equal(one['name'], 'M');
  assert.deepEqual(one['limit'], { context: 128_000, output: 4096 });

  const v2 = opencodeProviderConfig(withExtra, 'v2') as {
    providers: Record<string, { models: Record<string, Record<string, unknown>> }>;
  };
  const two = v2.providers['hub-gw']!.models['m-1.5']!;
  assert.equal(two['temperature'], 0.2);
  assert.equal(two['top_p'], 0.9);
  assert.equal(two['model'], undefined);
  assert.equal(two['messages'], undefined);
  assert.equal(two['tools'], undefined);
  assert.equal(two['name'], 'M');
});

