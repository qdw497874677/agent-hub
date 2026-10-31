import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ComponentPin, RuntimeProvision } from '@agent-hub/domain';
import { collectInventory, parsePiPackage } from './inventory.ts';
import { createServerGateway } from './server-gateway.ts';
import { connectWorkerLink } from './worker-link.ts';

const SHA = `sha512-${'B'.repeat(86)}==`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'inv-'));
  const pi = join(dir, 'pi');
  mkdirSync(pi);
  writeFileSync(join(pi, 'settings.json'), JSON.stringify({ packages: ['npm:some-pi-ext@0.3.1', { source: 'git:github.com/a/b-ext@v1', enabled: false }, './local/ext', 42] }));
  const comp = join(dir, 'components', 'pi', 'billion-context-pi');
  mkdirSync(join(comp, '1.2.3'), { recursive: true });
  writeFileSync(join(comp, '1.2.3', '.component.json'), JSON.stringify({ integrity: SHA, provides: [{ capability: 'context-strategy:context-pruning', mode: 'runtime-plugin' }] }));
  symlinkSync('1.2.3', join(comp, 'current'));
  const provisions = new Map<string, RuntimeProvision>([
    ['pi', { source: 'hub', version: '1.4.0' }],
    ['grok', { source: 'missing' }]
  ]);
  return { dir, pi, provisions, root: join(dir, 'components') };
}

test('pi 包来源：npm / git / 本地路径', () => {
  assert.deepEqual(parsePiPackage('npm:@scope/x@1.0.0'), { id: '@scope/x', version: '1.0.0', source: 'npm:@scope/x@1.0.0', enabled: true });
  assert.equal(parsePiPackage({ source: 'git:github.com/a/b.git@abc' })?.id, 'b');
  assert.equal(parsePiPackage('/home/u/ext')?.version, 'local');
  assert.equal(parsePiPackage(7), null);
});

test('清单采集：hub 管理的组件带能力，外部组件只列出', () => {
  const f = fixture();
  try {
    const inv = collectInventory({ provisions: f.provisions, componentsRoot: f.root, piAgentDir: f.pi, now: () => 5 });
    assert.deepEqual(inv.runtimes, [{ agentId: 'pi', version: '1.4.0', source: 'hub' }]);
    assert.deepEqual(
      inv.components.map((c) => `${c.managedBy}:${c.id}@${c.version}:${c.enabled}`),
      ['hub:billion-context-pi@1.2.3:true', 'external:some-pi-ext@0.3.1:true', 'external:b-ext@v1:false', 'external:ext@local:true']
    );
    assert.deepEqual(inv.capabilities, [{ capability: 'context-strategy:context-pruning', mode: 'runtime-plugin', via: 'billion-context-pi' }]);
    // 没有 pi 运行时就不看 pi 的目录；目录不存在也不报错
    assert.equal(collectInventory({ provisions: new Map(), componentsRoot: join(f.dir, 'nope'), piAgentDir: f.pi }).components.length, 0);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('清单经长连接上报，hub 算漂移：版本不一致的能力不可信，外部组件不算能力', async () => {
  const f = fixture();
  let pins: ComponentPin[] = [];
  const gateway = createServerGateway({
    token: null,
    onHello: () => {},
    onEvent: () => {},
    onAgentSession: () => {},
    onOptions: () => {},
    onStatus: () => {},
    onWorkerGone: () => {},
    expectedComponents: () => pins
  });
  const server: Server = createServer();
  server.on('upgrade', (request, socket, head) => gateway.handleUpgrade(request, socket, head));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const link = connectWorkerLink({
    url,
    token: '',
    workerId: 'w1',
    label: 'x',
    reconnect: false,
    runtimes: [],
    welcomeFallbackMs: 50,
    inventory: () => collectInventory({ provisions: f.provisions, componentsRoot: f.root, piAgentDir: f.pi })
  });
  try {
    await until(() => gateway.workers()[0]?.inventory !== undefined);
    let w = gateway.workers()[0]!;
    assert.equal(w.inventory?.components.length, 4);
    // 没有期望（P1）：hub 管理的组件来路不明 → 能力不可信；外部组件只列出
    assert.deepEqual(w.drift?.trusted, []);
    assert.equal(w.drift?.untrusted.length, 1);
    assert.equal(w.drift?.items.filter((i) => i.kind === 'external').length, 3);
    assert.ok(w.drift?.items.some((i) => i.kind === 'unexpected' && i.componentId === 'billion-context-pi'));
    pins = [{ componentId: 'billion-context-pi', runtime: 'pi', version: '1.2.3', integrity: SHA }];
    w = gateway.workers()[0]!;
    assert.equal(w.drift?.trusted.length, 1);
    pins = [{ componentId: 'billion-context-pi', runtime: 'pi', version: '1.2.4', integrity: SHA }];
    w = gateway.workers()[0]!;
    assert.deepEqual(w.drift?.items.find((i) => i.kind === 'mismatch'), { kind: 'mismatch', componentId: 'billion-context-pi', runtime: 'pi', expected: '1.2.4', actual: '1.2.3' });
    assert.equal(w.drift?.trusted.length, 0);
  } finally {
    await link.close();
    gateway.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    rmSync(f.dir, { recursive: true, force: true });
  }
});
