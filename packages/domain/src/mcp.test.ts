import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandSecrets, mcpSecretRefs, parseMcpConfig } from './mcp.ts';

const parse = (value: unknown) => parseMcpConfig(JSON.stringify(value));

test('mcp.json：stdio / http 两种，密钥写成引用', () => {
  const stdio = parse({ name: 'files', command: 'npx', args: ['-y', 'srv', '--key=${secret:FILES_KEY}'], env: { API_TOKEN: '${secret:FILES_TOKEN}' } });
  assert.ok(stdio.ok);
  assert.equal(stdio.value.transport, 'stdio');
  assert.deepEqual(mcpSecretRefs(stdio.value), ['FILES_KEY', 'FILES_TOKEN']);
  const http = parse({ name: 'gh', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${secret:GH_TOKEN}' } });
  assert.ok(http.ok);
  assert.equal(http.value.transport, 'http');
  assert.deepEqual(mcpSecretRefs(http.value), ['GH_TOKEN']);
});

test('mcp.json：拒绝明文密钥、保留名、坏引用名、SSE、坏 JSON，错误是中文', () => {
  const cases: [unknown, RegExp][] = [
    [{ name: 'x', command: 'npx', env: { API_TOKEN: 'abc123' } }, /看起来是密钥/],
    [{ name: 'x', url: 'https://e/mcp', headers: { Authorization: 'Bearer abc' } }, /看起来是密钥/],
    [{ name: 'agent-hub', command: 'npx' }, /hub 自己的/],
    [{ name: 'x', command: 'npx', args: ['${secret:lower}'] }, /密钥名/],
    [{ name: 'x', transport: 'sse', url: 'https://e' }, /SSE/],
    [{ name: 'x' }, /command/],
    [{ name: 'x', url: 'ftp://e' }, /url/],
    [{ name: 'x', command: '${secret:CMD}' }, /command 里不能引用密钥/]
  ];
  for (const [value, message] of cases) {
    const result = parse(value);
    assert.equal(result.ok, false, JSON.stringify(value));
    if (!result.ok) assert.match(result.error.message, message);
  }
  const broken = parseMcpConfig('{');
  assert.ok(!broken.ok && /不是合法的 JSON/.test(broken.error.message));
});

test('展开密钥：缺的只报名字', () => {
  assert.deepEqual(expandSecrets('Bearer ${secret:A}', { A: 'v' }), { ok: true, value: 'Bearer v' });
  const missing = expandSecrets('${secret:A}${secret:B}', { A: 'hidden-value' });
  assert.ok(!missing.ok);
  assert.match(missing.error.message, /B/);
  assert.doesNotMatch(missing.error.message, /hidden-value/);
});
