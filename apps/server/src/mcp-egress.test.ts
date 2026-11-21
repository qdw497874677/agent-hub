import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from 'undici';
import {
  DEFAULT_MCP_EGRESS_POLICY,
  assertNoHostHeader,
  checkMcpEgressUrl,
  createEgressLookup,
  createMcpEgress,
  isBlockedEgressAddress,
  mcpEgressPolicyFromEnv,
  normalizeEgressHost,
  type EgressResolver,
  type McpEgressPolicy
} from './mcp-egress.ts';

const publicResolver: EgressResolver = async () => [{ address: '93.184.216.34', family: 4 }];

function resolverReturning(...addresses: { address: string; family: number }[]): EgressResolver {
  return async () => addresses;
}

function lookupOnce(
  lookup: ReturnType<typeof createEgressLookup>,
  hostname: string,
  options: { family?: number | 'IPv4' | 'IPv6'; all?: boolean }
): Promise<{ error: Error | null; address: string | { address: string; family: number }[] | undefined; family: number | undefined }> {
  return new Promise((resolve) => {
    lookup(hostname, options, (error, address, family) => resolve({ error: error as Error | null, address, family }));
  });
}

test('MCP 出口：默认只放行 HTTPS 公网地址，拒绝 userinfo / 字面量内网 / 内网主机名', () => {
  assert.ok(checkMcpEgressUrl('https://mcp.example.test/mcp').ok);

  const userinfo = checkMcpEgressUrl('https://user:secret@mcp.example.test/mcp');
  assert.ok(!userinfo.ok);
  assert.match(userinfo.error.message, /用户名或密码/);

  for (const url of [
    'http://mcp.example.test/mcp',
    'https://127.0.0.1/mcp',
    'https://10.0.0.1/mcp',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/mcp',
    'https://[::ffff:127.0.0.1]/mcp',
    'https://[fc00::1]/mcp',
    'https://localhost/mcp',
    'https://mcp.internal/mcp',
    'https://foo.lan/mcp',
    'https://mcp',
    'ftp://mcp.example.test/mcp'
  ]) {
    const result = checkMcpEgressUrl(url);
    assert.ok(!result.ok, url);
  }
});

test('MCP 出口：运维例外只按精确主机名生效，HTTP 例外不会放开内网 / 字面量地址', () => {
  const policy: McpEgressPolicy = {
    allowPrivateHosts: ['mcp.corp.example'],
    allowHttpHosts: ['mcp.example.test']
  };

  const privateHost = checkMcpEgressUrl('https://mcp.corp.example/mcp', policy);
  assert.ok(privateHost.ok);

  const httpHost = checkMcpEgressUrl('http://mcp.example.test/mcp', policy);
  assert.ok(httpHost.ok);

  // HTTP 例外 + 私网例外必须同时精确命中，才允许明文内网地址。
  assert.ok(!checkMcpEgressUrl('http://127.0.0.1/mcp', policy).ok);
  assert.ok(!checkMcpEgressUrl('http://10.0.0.1/mcp', policy).ok);
  assert.ok(checkMcpEgressUrl('http://127.0.0.1/mcp', { allowPrivateHosts: ['127.0.0.1'], allowHttpHosts: ['127.0.0.1'] }).ok);

  // 通配 / 后缀都不是精确主机名。
  assert.ok(!checkMcpEgressUrl('https://10.0.0.1/mcp', { allowPrivateHosts: ['*.0.0.1'], allowHttpHosts: [] }).ok);
  assert.ok(!checkMcpEgressUrl('https://a.localhost/mcp', { allowPrivateHosts: ['localhost'], allowHttpHosts: [] }).ok);
  assert.ok(checkMcpEgressUrl('https://localhost/mcp', { allowPrivateHosts: ['localhost'], allowHttpHosts: [] }).ok);

  // 任意内网 DNS 名静态阶段看不出来，交给连接时的 lookup 校验（见下面的 lookup 用例）。
  assert.ok(checkMcpEgressUrl('https://mcp.corp.example/mcp', { allowPrivateHosts: [], allowHttpHosts: [] }).ok);

  // 尾点 / 大小写归一化后再做精确比较。
  assert.ok(checkMcpEgressUrl('https://MCP.CORP.EXAMPLE./mcp', policy).ok);
});

test('MCP 出口：OAuth 地址永远要求 HTTPS，HTTP 例外也不放宽', () => {
  const policy: McpEgressPolicy = { allowPrivateHosts: [], allowHttpHosts: ['auth.example.test'] };
  const result = checkMcpEgressUrl('http://auth.example.test/token', policy, { requireHttps: true });
  assert.ok(!result.ok);
  assert.match(result.error.message, /HTTPS/);
});

test('MCP 出口：环境变量解析为精确主机名列表', () => {
  assert.deepEqual(
    mcpEgressPolicyFromEnv({
      MCP_EGRESS_ALLOW_PRIVATE_HOSTS: ' A.Internal. , 10.0.0.5 ,, ',
      MCP_EGRESS_ALLOW_HTTP_HOSTS: 'mcp.example.test'
    }),
    { allowPrivateHosts: ['a.internal', '10.0.0.5'], allowHttpHosts: ['mcp.example.test'] }
  );
  assert.deepEqual(mcpEgressPolicyFromEnv({}), DEFAULT_MCP_EGRESS_POLICY);
  assert.equal(normalizeEgressHost('[::1]'), '::1');
});

test('MCP 出口：内网 / 保留地址识别覆盖 IPv4、IPv6 与内嵌 IPv4', () => {
  for (const address of [
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.0.0.1',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fe80::1',
    'fc00::1',
    'ff02::1',
    '2001:db8::1',
    '2001::1',
    '::ffff:10.0.0.1',
    '64:ff9b::7f00:1',
    '2002:7f00:1::'
  ]) {
    assert.equal(isBlockedEgressAddress(address), true, address);
  }

  for (const address of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isBlockedEgressAddress(address), false, address);
  }
  assert.equal(isBlockedEgressAddress('not-an-address'), true);
});

test('MCP 出口 lookup：all=true 返回全部地址，single 返回第一个地址', async () => {
  const lookup = createEgressLookup(DEFAULT_MCP_EGRESS_POLICY, resolverReturning(
    { address: '93.184.216.34', family: 4 },
    { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }
  ));

  const all = await lookupOnce(lookup, 'mcp.example.test', { all: true });
  assert.equal(all.error, null);
  assert.deepEqual(all.address, [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }
  ]);

  const single = await lookupOnce(lookup, 'mcp.example.test', {});
  assert.equal(single.error, null);
  assert.equal(single.address, '93.184.216.34');
  assert.equal(single.family, 4);
});

test('MCP 出口 lookup：解析结果里只要有一个内网地址就拒绝，精确例外才放行', async () => {
  const mixed = createEgressLookup(DEFAULT_MCP_EGRESS_POLICY, resolverReturning(
    { address: '93.184.216.34', family: 4 },
    { address: '10.0.0.7', family: 4 }
  ));
  const blocked = await lookupOnce(mixed, 'mcp.example.test', { all: true });
  assert.ok(blocked.error);
  assert.match(blocked.error.message, /内网/);

  const privateOnly = createEgressLookup(DEFAULT_MCP_EGRESS_POLICY, resolverReturning({ address: '10.0.0.7', family: 4 }));
  const rejected = await lookupOnce(privateOnly, 'mcp.example.test', {});
  assert.ok(rejected.error);

  const allowed = createEgressLookup(
    { allowPrivateHosts: ['mcp.corp.example'], allowHttpHosts: [] },
    resolverReturning({ address: '10.0.0.7', family: 4 })
  );
  const passed = await lookupOnce(allowed, 'mcp.corp.example', {});
  assert.equal(passed.error, null);
  assert.equal(passed.address, '10.0.0.7');

  // 例外只认精确主机名：父域 / 通配不覆盖子域。
  const suffix = createEgressLookup(
    { allowPrivateHosts: ['corp.example'], allowHttpHosts: [] },
    resolverReturning({ address: '10.0.0.7', family: 4 })
  );
  assert.ok((await lookupOnce(suffix, 'mcp.corp.example', {})).error);
});

test('MCP 出口 lookup：family 过滤后没有地址时失败', async () => {
  const lookup = createEgressLookup(DEFAULT_MCP_EGRESS_POLICY, resolverReturning({ address: '2606:4700:4700::1111', family: 6 }));
  const result = await lookupOnce(lookup, 'mcp.example.test', { family: 'IPv4' });
  assert.ok(result.error);
  assert.match(result.error.message, /解析不到/);
});

test('MCP 出口 Host 头：Headers / 数组 / 对象三种形态都拒绝覆盖 Host', () => {
  assert.throws(() => assertNoHostHeader(new Headers({ Host: 'evil.example' })), /Host/);
  assert.throws(() => assertNoHostHeader([['hOsT', 'evil.example']]), /Host/);
  assert.throws(() => assertNoHostHeader({ ' Host ': 'evil.example' }), /Host/);
  assert.doesNotThrow(() => assertNoHostHeader({ authorization: 'Bearer x', accept: 'application/json' }));
});

test('MCP 出口安全 fetch：强制 redirect=error、绑定 app 私有 Agent，并在发请求前校验 URL / Host', async () => {
  const seen: { input: string; init: RequestInit & { dispatcher?: unknown } }[] = [];
  const egress = createMcpEgress({
    resolve: publicResolver,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ input: String(input), init: (init ?? {}) as RequestInit & { dispatcher?: unknown } });
      return new Response('ok');
    }) as typeof fetch
  });

  const response = await egress.fetch('https://mcp.example.test/mcp', { headers: { accept: 'application/json' } });
  assert.equal(await response.text(), 'ok');
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.input, 'https://mcp.example.test/mcp');
  assert.equal(seen[0]?.init.redirect, 'error');
  assert.ok(seen[0]?.init.dispatcher instanceof Agent);

  await assert.rejects(() => egress.fetch('https://127.0.0.1/mcp'), /内网/);
  await assert.rejects(() => egress.fetch('https://mcp.example.test/mcp', { headers: { Host: 'evil.example' } }), /Host/);
  assert.equal(seen.length, 1, '被策略拒绝的请求不应到达底层 fetch');

  const request = new Request('https://mcp.example.test/mcp');
  request.headers.set('host', 'evil.example');
  await assert.rejects(() => egress.fetch(request), /Host/);
  assert.equal(seen.length, 1, 'Request 自带的 Host 也要在底层 fetch 前拒绝');

  await egress.close();
});
