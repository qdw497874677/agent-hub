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

test('交给 hub 的环境不含密钥；只有指定 Hub 模型时才去掉原生模型变量', () => {
  const base = {
    ZAI_CODING_CN_API_KEY: KEY,
    ZAI_API_KEY: KEY,
    PI_DEFAULT_MODEL: 'opencode-go/deepseek-v4-flash',
    OPENCODE_API_KEY: KEY,
    PATH: '/usr/bin'
  };
  const plain = serverEnv(base);
  assert.equal(plain['ZAI_CODING_CN_API_KEY'], undefined);
  assert.equal(plain['ZAI_API_KEY'], undefined);
  assert.equal(plain['PI_DEFAULT_MODEL'], 'opencode-go/deepseek-v4-flash');
  assert.equal(plain['OPENCODE_API_KEY'], KEY);
  assert.equal(plain['PATH'], '/usr/bin');
  const hub = serverEnv({ ...base, E2E_HUB_MODEL: 'hub-cn-glm-flash/glm-5.3-flash' });
  assert.equal(hub['ZAI_CODING_CN_API_KEY'], undefined);
  assert.equal(hub['PI_DEFAULT_MODEL'], undefined);
  assert.equal(hub['OPENCODE_API_KEY'], undefined);
  assert.equal(hub['E2E_HUB_MODEL'], 'hub-cn-glm-flash/glm-5.3-flash');
  assert.equal(JSON.stringify(hub).includes(KEY), false);
});
