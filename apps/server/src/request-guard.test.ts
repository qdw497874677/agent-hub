import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequestGuard } from './request-guard.ts';

test('Host：IP 字面量、localhost、配置过的主机名放行；陌生域名（DNS 重绑定）拒', () => {
  const guard = createRequestGuard(['box.tail1234.ts.net']);
  for (const host of ['127.0.0.1:7878', 'localhost:7878', '[::1]:7878', '100.76.60.33:7878', 'box.tail1234.ts.net', 'app.localhost:7878']) {
    assert.ok(guard.hostAllowed(host), host);
  }
  for (const host of ['evil.example:7878', 'evil.example', '127.0.0.1.evil.example']) {
    assert.ok(!guard.hostAllowed(host), host);
  }
});

test('Origin：同站或不带 Origin 放行；别的站发起的（跨站 WebSocket / 表单）拒', () => {
  const guard = createRequestGuard([]);
  assert.ok(guard.originAllowed(undefined, '127.0.0.1:7878'));
  assert.ok(guard.originAllowed('http://127.0.0.1:7878', '127.0.0.1:7878'));
  assert.ok(!guard.originAllowed('https://evil.example', '127.0.0.1:7878'));
  assert.ok(!guard.originAllowed('http://127.0.0.1:9999', '127.0.0.1:7878'));
  assert.ok(!guard.originAllowed('null', '127.0.0.1:7878'));
});
