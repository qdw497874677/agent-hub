import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acpConfigsFor } from './adapter.ts';
import { hermesAcpConfig, hermesAcpHome, hermesAcpOptionValue } from './hermes-acp.ts';

test('hermes-acp 只在 Hermes 开了才注册', () => {
  assert.equal(hermesAcpConfig({}), null);
  assert.equal(acpConfigsFor({ env: {}, log: () => undefined }).some((c) => c.id === 'hermes-acp'), false);
  const ids = acpConfigsFor({ env: { WORKER_HERMES: '1' }, log: () => undefined }).map((c) => c.id);
  assert.deepEqual(ids.filter((id) => id === 'hermes-acp'), ['hermes-acp']);
  assert.deepEqual(hermesAcpConfig({ HERMES_COMMAND: '/x/hermes' })?.args, ['acp']);
});

test('hermes-acp：每会话独立 HERMES_HOME，config 只引用变量名，令牌只进 env', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hacp-'));
  try {
    const config = hermesAcpConfig({ WORKER_HERMES: '1', HERMES_HUB_ROOT: root })!;
    const launched = await config.providerLaunch!('s/1', { slug: 'p', name: 'P', protocol: 'openai-chat', models: [{ id: 'm1' } as never], baseUrl: 'http://127.0.0.1:9/v1', token: 'tok-secret' }, {});
    const home = hermesAcpHome(root, 's/1');
    assert.equal(launched.env?.['HERMES_HOME'], home);
    assert.equal(launched.env?.['HUB_PROVIDER_TOKEN'], 'tok-secret');
    const written = await readFile(join(home, 'config.yaml'), 'utf8');
    assert.ok(!written.includes('tok-secret'));
    assert.match(written, /\$\{HUB_PROVIDER_TOKEN\}/);
    assert.match(written, /"default": "m1"/);
    assert.match(written, /"unmanaged_idle_exit_seconds": 60/, '自动拉起的 gateway 闲 60 秒就退');
    const local = await config.launch!({} as never);
    assert.equal(local.env?.['HERMES_HOME'], join(root, 'acp', '_unrouted'), '没选 hub 模型也不碰 ~/.hermes');
    assert.notEqual(hermesAcpHome(root, 'a'), hermesAcpHome(root, 'b'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('hermes-acp：hub 模型 id 换成 custom:<id>，其他值原样', () => {
  assert.equal(hermesAcpOptionValue('model', 'hub-p/m-1'), 'custom:m-1');
  assert.equal(hermesAcpOptionValue('model', 'custom:x'), 'custom:x');
  assert.equal(hermesAcpOptionValue('mode', 'hub-p/m-1'), 'hub-p/m-1');
  assert.equal(hermesAcpConfig({ WORKER_HERMES: '1' })?.optionValue, hermesAcpOptionValue);
});
