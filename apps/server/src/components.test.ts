import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNpmResolver } from './components.ts';
import { startMockRegistry } from '@agent-hub/node-gateway/testing';

test('npm 解析器：查确切版本，拿 tarball、sha512、安装脚本；查不到报错', { timeout: 60_000 }, async () => {
  const registry = await startMockRegistry([
    { name: 'demo-pi-ext', version: '1.0.0', scripts: { postinstall: 'node x.js', test: 'echo' } },
    { name: '@scope/ext', version: '2.0.0' }
  ]);
  try {
    const resolve = createNpmResolver(`${registry.url}/`);
    const info = await resolve('demo-pi-ext', '1.0.0');
    assert.equal(info.version, '1.0.0');
    assert.equal(info.integrity, registry.integrity('demo-pi-ext', '1.0.0'));
    assert.match(info.resolved, /demo-pi-ext-1\.0\.0\.tgz$/);
    assert.deepEqual(info.scripts, { postinstall: 'node x.js' });
    assert.equal((await resolve('@scope/ext', '2.0.0')).name, '@scope/ext');
    await assert.rejects(resolve('demo-pi-ext', '3.0.0'), /404/);
  } finally {
    await registry.close();
  }
});
