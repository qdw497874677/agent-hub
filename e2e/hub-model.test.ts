import { test } from 'node:test';
import assert from 'node:assert/strict';
import { e2eHubModel, hubProviderBody, parseE2eHubModel, piModel } from './hub-model.ts';
import { serverEnv } from './server-env.ts';

const KEY = 'sk-test-placeholder-not-real';

test('未设置 E2E_HUB_MODEL 时真 Pi 仍是空模型', () => {
  const previous = process.env['E2E_HUB_MODEL'];
  delete process.env['E2E_HUB_MODEL'];
  try {
    assert.equal(e2eHubModel(), '');
    assert.equal(piModel(), '');
  } finally {
    if (previous === undefined) delete process.env['E2E_HUB_MODEL'];
    else process.env['E2E_HUB_MODEL'] = previous;
  }
});

test('解析 hub-<标识>/<模型>，拒绝空模型名和非法标识', () => {
  assert.deepEqual(parseE2eHubModel('hub-cn-glm-flash/glm-5.3-flash'), { slug: 'cn-glm-flash', modelId: 'glm-5.3-flash' });
  assert.equal(parseE2eHubModel(''), null);
  assert.equal(parseE2eHubModel('glm-5.3-flash'), null);
  assert.equal(parseE2eHubModel('hub-cn-glm-flash/'), null);
  assert.equal(parseE2eHubModel('hub-Bad/glm'), null);
});

test('种供应商的请求体：密钥只在 apiKey，作用域是全站', () => {
  const body = hubProviderBody({ slug: 'cn-glm-flash', modelId: 'glm-5.3-flash' }, 'https://open.bigmodel.cn/api/coding/paas/v4', KEY);
  assert.equal(body.apiKey, KEY);
  assert.equal(body.scope, 'hub');
  assert.equal(body.protocol, 'openai-chat');
  assert.deepEqual(body.models, ['glm-5.3-flash']);
  const { apiKey: _hidden, ...rest } = body;
  assert.equal(JSON.stringify(rest).includes(KEY), false);
  assert.equal(rest.slug.includes(KEY), false);
  assert.equal(rest.baseUrl.includes(KEY), false);
});

test('交给 hub 的环境把密钥名留成 undefined，Playwright 再展开 process.env 时才能盖住', () => {
  const base = {
    ZAI_CODING_CN_API_KEY: KEY,
    ZAI_API_KEY: KEY,
    PI_DEFAULT_MODEL: 'opencode-go/deepseek-v4-flash',
    OPENCODE_API_KEY: KEY,
    OPENCODE_GO_API_KEY: KEY,
    PATH: '/usr/bin',
    HUB_PROVIDER_TOKEN: 'relay-placeholder'
  };
  const plain = serverEnv(base);
  assert.equal(Object.prototype.hasOwnProperty.call(plain, 'ZAI_CODING_CN_API_KEY'), true);
  assert.equal(plain['ZAI_CODING_CN_API_KEY'], undefined);
  assert.equal(plain['PI_DEFAULT_MODEL'], 'opencode-go/deepseek-v4-flash');
  assert.equal(plain['OPENCODE_API_KEY'], KEY);
  assert.equal(plain['OPENCODE_GO_API_KEY'], KEY);
  assert.equal(plain['HUB_PROVIDER_TOKEN'], 'relay-placeholder');
  const hub = serverEnv({ ...base, E2E_HUB_MODEL: 'hub-cn-glm-flash/glm-5.3-flash' });
  for (const name of ['ZAI_CODING_CN_API_KEY', 'OPENCODE_API_KEY', 'OPENCODE_GO_API_KEY', 'PI_DEFAULT_MODEL']) {
    assert.equal(Object.prototype.hasOwnProperty.call(hub, name), true, name);
    assert.equal(hub[name], undefined, name);
  }
  assert.equal(hub['HUB_PROVIDER_TOKEN'], 'relay-placeholder');
  assert.equal(hub['E2E_HUB_MODEL'], 'hub-cn-glm-flash/glm-5.3-flash');
  const launched = { ...base, ...hub };
  assert.equal(launched['ZAI_CODING_CN_API_KEY'], undefined);
  assert.equal(launched['OPENCODE_GO_API_KEY'], undefined);
  assert.equal(launched['HUB_PROVIDER_TOKEN'], 'relay-placeholder');
  assert.equal(JSON.stringify(launched).includes(KEY), false);
});
