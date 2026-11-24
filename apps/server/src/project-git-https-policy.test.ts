import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLoopbackResolver,
  isAcceptableBasicAuthorization,
  isMetadataHost,
  originKey,
  parseAllowedOrigins
} from './project-git-https-policy.ts';

test('originKey：大小写 / 结尾点 / IPv6 方括号归一，保留非默认端口', () => {
  assert.equal(originKey(new URL('https://Git.Example.COM./org/repo.git')), 'https://git.example.com');
  assert.equal(originKey(new URL('https://git.example.com:443/r')), 'https://git.example.com');
  assert.equal(originKey(new URL('https://git.example.com:8443/r')), 'https://git.example.com:8443');
  assert.equal(originKey(new URL('https://[::1]:8443/r')), 'https://[::1]:8443');
});

test('parseAllowedOrigins：只收精确 HTTPS origin，错误文案保留调用方前缀', () => {
  const origins = parseAllowedOrigins(['https://git.example.com', 'https://Git.Example.com/'], 'Fixture');
  assert.deepEqual([...origins], ['https://git.example.com']);

  const rejected: ReadonlyArray<readonly [string, RegExp]> = [
    ['', /Fixture: allowedOrigins 必须是精确的 HTTPS origin/],
    ['https://*.example.com', /Fixture: allowedOrigins 必须是精确的 HTTPS origin/],
    ['http://git.example.com', /Fixture: allowedOrigins 只接受纯 HTTPS origin/],
    ['https://git.example.com/org', /Fixture: allowedOrigins 只接受纯 HTTPS origin/],
    ['https://user:pass@git.example.com', /Fixture: allowedOrigins 只接受纯 HTTPS origin/],
    ['https://git.example.com/?a=1', /Fixture: allowedOrigins 只接受纯 HTTPS origin/],
    ['https://git.example.com/#frag', /Fixture: allowedOrigins 只接受纯 HTTPS origin/],
    ['not a url', /Fixture: allowedOrigins 里有不合法的 URL/]
  ];
  for (const [entry, pattern] of rejected) {
    assert.throws(() => parseAllowedOrigins([entry], 'Fixture'), pattern, entry);
  }
});

test('isMetadataHost：常见写法与映射 / 前缀写法都拒绝', () => {
  for (const host of [
    'metadata',
    'metadata.google.internal',
    'foo.metadata.google.internal',
    'instance-data',
    '169.254.169.254',
    '169.254.170.2',
    '100.100.100.200',
    'fd00:ec2::254',
    '::ffff:169.254.169.254',
    'prefix-100.100.100.200-suffix'
  ]) {
    assert.equal(isMetadataHost(host), true, host);
  }
  assert.equal(isMetadataHost('git.example.com'), false);
  assert.equal(isMetadataHost('169.254.169.253'), false);
});

test('createLoopbackResolver：loopback 主机名只能解析到真 loopback，其它主机原样放行', async () => {
  const rejecting = createLoopbackResolver(async () => [{ address: '10.0.0.7', family: 4 }], 'Fixture');
  await assert.rejects(rejecting('localhost'), /Fixture: 测试 loopback 目标解析到了非回环地址/u);
  await assert.rejects(rejecting('LOCALHOST.'), /Fixture:/u);

  const empty = createLoopbackResolver(async () => [], 'Fixture');
  await assert.rejects(empty('127.0.0.1'), /Fixture:/u);

  const accepting = createLoopbackResolver(
    async (hostname) =>
      hostname === 'localhost' ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '10.0.0.7', family: 4 }],
    'Fixture'
  );
  assert.deepEqual(await accepting('localhost'), [{ address: '127.0.0.1', family: 4 }]);
  // 非 loopback 主机名由 base resolver 与出口策略决定，这里不改写结果。
  assert.deepEqual(await accepting('git.example.com'), [{ address: '10.0.0.7', family: 4 }]);
  assert.deepEqual(await createLoopbackResolver(async () => [{ address: '::1', family: 6 }], 'Fixture')('::1'), [
    { address: '::1', family: 6 }
  ]);
});

test('isAcceptableBasicAuthorization：只接受单行 Basic，长度与字符集边界准确', () => {
  assert.equal(isAcceptableBasicAuthorization('Basic dXNlcjpwYXNz'), true);
  assert.equal(isAcceptableBasicAuthorization('Basic YQ=='), true);
  assert.equal(isAcceptableBasicAuthorization(`Basic ${'a'.repeat(8_186)}`), true);

  for (const value of [
    undefined,
    null,
    42,
    {},
    '',
    'Basic ',
    'Bearer token',
    'Basic !!!',
    'Basic abc\r\nX-Injected: yes',
    'Basic abc\ndef',
    'Basic abc\u0000def',
    `Basic ${'a'.repeat(8_187)}`
  ]) {
    assert.equal(isAcceptableBasicAuthorization(value), false, String(value));
  }
});
