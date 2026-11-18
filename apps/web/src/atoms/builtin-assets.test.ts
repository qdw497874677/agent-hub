import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserSummary, builtinAction, missingSecrets } from './builtin-assets.ts';

const secret = (set: boolean) => ({ name: 'GITHUB_TOKEN', label: 'GitHub 访问令牌', hint: 'h', set });

test('内置资产的操作：缺密钥先填；同名不能启用；启用后看开关和新版本', () => {
  assert.equal(builtinAction({ enabled: null, secrets: [], clash: null }), 'enable');
  assert.equal(builtinAction({ enabled: null, secrets: [secret(false)], clash: null }), 'secrets');
  assert.equal(builtinAction({ enabled: null, secrets: [secret(true)], clash: null }), 'enable');
  assert.equal(builtinAction({ enabled: null, secrets: [], clash: '项目里已经有叫「x」的资产' }), 'clash');
  assert.equal(builtinAction({ enabled: { assetId: 'a', version: '1', on: true, update: null }, secrets: [], clash: null }), 'enabled');
  assert.equal(builtinAction({ enabled: { assetId: 'a', version: '1', on: true, update: '2' }, secrets: [], clash: null }), 'update');
  assert.equal(builtinAction({ enabled: { assetId: 'a', version: '1', on: false, update: '2' }, secrets: [], clash: null }), 'off');
  assert.deepEqual(missingSecrets({ secrets: [secret(true), { ...secret(false), name: 'X' }] }).map((s) => s.name), ['X']);
});

test('浏览器一句话', () => {
  assert.equal(browserSummary([]), '还没有机器');
  assert.equal(browserSummary([{ ready: true, online: true }]), '1 台机器都装好了 Chromium');
  assert.equal(browserSummary([{ ready: true, online: true }, { ready: false, online: true }]), '1/2 台机器装了 Chromium');
});
