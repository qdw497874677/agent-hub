import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandSecrets, mcpSecretRefs, parseMcpAsset, parseMcpConfig, toolAllowed } from './mcp.ts';

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

test('mcp.json：一份文件里放多个服务器（servers[] 与 Claude 的 mcpServers{}）', () => {
  const listed = parseMcpAsset(
    JSON.stringify({
      servers: [
        { name: 'files', command: 'npx', args: ['-y', 'srv'] },
        { name: 'gh', url: 'https://e/mcp', headers: { Authorization: 'Bearer ${secret:GH_TOKEN}' } }
      ]
    })
  );
  assert.ok(listed.ok);
  assert.deepEqual(listed.value.servers.map((server) => [server.name, server.transport]), [
    ['files', 'stdio'],
    ['gh', 'http']
  ]);
  const mapped = parseMcpAsset(
    JSON.stringify({ mcpServers: { files: { command: 'npx' }, gh: { type: 'http', url: 'https://e/mcp' } } })
  );
  assert.ok(mapped.ok);
  assert.deepEqual(mapped.value.servers.map((server) => server.name), ['files', 'gh']);
  assert.equal(mapped.value.servers[1]?.transport, 'http');
});

test('mcp.json：多服务器要拦重名、超量、空列表；单服务器入口仍要求恰好一个', () => {
  const dup = parseMcpAsset(JSON.stringify({ servers: [{ name: 'a', command: 'npx' }, { name: 'a', command: 'npx' }] }));
  assert.ok(!dup.ok && /同名/.test(dup.error.message));
  const empty = parseMcpAsset(JSON.stringify({ servers: [] }));
  assert.ok(!empty.ok && /空的/.test(empty.error.message));
  const many = parseMcpAsset(JSON.stringify({ servers: Array.from({ length: 21 }, (_, index) => ({ name: `s${index}`, command: 'npx' })) }));
  assert.ok(!many.ok && /最多 20/.test(many.error.message));
  const two = parseMcpAsset(JSON.stringify({ servers: [{ name: 'a', command: 'npx' }, { name: 'b', command: 'npx' }] }));
  assert.ok(two.ok);
  const single = parseMcpConfig(JSON.stringify({ servers: two.ok ? two.value.servers : [] }));
  assert.ok(!single.ok && /单个/.test(single.error.message));
});

test('工具过滤：tools 数组当 allow，{allow,deny} 与 denyTools 都认，deny 优先', () => {
  const allowed = parseMcpAsset(JSON.stringify({ name: 'a', url: 'https://e/mcp', tools: ['read', 'write'] }));
  assert.ok(allowed.ok);
  const server = allowed.value.servers[0];
  assert.ok(server && server.transport === 'http');
  assert.equal(toolAllowed(server, 'read'), true);
  assert.equal(toolAllowed(server, 'delete'), false);
  const denied = parseMcpAsset(JSON.stringify({ name: 'a', url: 'https://e/mcp', tools: { allow: ['read'], deny: ['read'] } }));
  assert.ok(denied.ok);
  const second = denied.value.servers[0];
  assert.ok(second);
  assert.equal(toolAllowed(second, 'read'), false);
  const open = parseMcpAsset(JSON.stringify({ name: 'a', url: 'https://e/mcp' }));
  assert.ok(open.ok);
  const third = open.value.servers[0];
  assert.ok(third);
  assert.equal(toolAllowed(third, 'anything'), true);
});

test('OAuth：clientSecret 走密钥引用，authStyle 只能 basic/post', () => {
  const okd = parseMcpAsset(
    JSON.stringify({
      name: 'gh',
      url: 'https://e/mcp',
      oauth: { tokenUrl: 'https://e/token', clientId: 'id', clientSecret: '${secret:OAUTH_SECRET}', scope: 'read' }
    })
  );
  assert.ok(okd.ok);
  const server = okd.value.servers[0];
  assert.ok(server && server.transport === 'http');
  assert.equal(server.oauth?.authStyle, 'basic');
  assert.deepEqual(mcpSecretRefs(server), ['OAUTH_SECRET']);
  const wrong = parseMcpAsset(JSON.stringify({ name: 'gh', url: 'https://e/mcp', oauth: { tokenUrl: 'https://e/t', clientId: 'i', authStyle: 'jwt' } }));
  assert.ok(!wrong.ok && /basic/.test(wrong.error.message));
  const noClient = parseMcpAsset(JSON.stringify({ name: 'gh', url: 'https://e/mcp', oauth: { tokenUrl: 'https://e/t' } }));
  assert.ok(!noClient.ok && /clientId/.test(noClient.error.message));
});
