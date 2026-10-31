import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectDrift, hasDrift, parseBundleManifest, type WorkerInventory } from './runtime-bundle.ts';

const SHA = `sha512-${'A'.repeat(86)}==`;
const plugin = {
  id: 'billion-context-pi',
  kind: 'runtime-plugin',
  source: { type: 'npm', package: 'billion-context-pi', version: '1.2.3', integrity: SHA },
  install: { target: 'pi-extension' },
  config: { file: 'acp.json', template: { autoUpdate: false } },
  provides: [{ capability: 'context-strategy:context-pruning', mode: 'runtime-plugin' }],
  conflicts: ['capability:context-strategy:*'],
  requires: { runtime: 'pi@>=1.4.0 <2' }
};
const manifest = { kind: 'bundle', id: 'pi-context-pruning', runtime: { agentId: 'pi', version: '1.4.0' }, components: [plugin, { id: 'github-mcp', kind: 'mcp-server', asset: { ref: 'asset:github-mcp@3' } }] };

test('套件清单：§3 的例子能通过，mcp 组件用资产引用', () => {
  const parsed = parseBundleManifest(manifest);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error.message);
  assert.deepEqual(parsed.value.components[1]!.source, { type: 'asset', ref: 'asset:github-mcp@3' });
});

test('套件清单：不收范围版本、缺哈希、插件走资产、配置文件带路径', () => {
  const bad = (patch: object, comp = 0) => {
    const components = manifest.components.map((c, i) => (i === comp ? { ...c, ...patch } : c));
    const parsed = parseBundleManifest({ ...manifest, components });
    assert.equal(parsed.ok, false);
    return parsed.ok ? '' : parsed.error.message;
  };
  assert.match(bad({ source: { ...plugin.source, version: '^1.2.3' } }), /确切版本/);
  assert.match(bad({ source: { type: 'npm', package: 'x', version: '1.0.0' } }), /sha512/);
  assert.match(bad({ source: { type: 'asset', ref: 'asset:x@1' } }), /npm 来源/);
  assert.match(bad({ config: { file: '../evil.json', template: {} } }), /文件名/);
  assert.match(bad({ source: { type: 'npm', package: 'x', version: '1.0.0', integrity: SHA } }, 1), /只能引用已发布的资产/);
  assert.equal(parseBundleManifest({ ...manifest, runtime: { agentId: 'pi', version: 'latest' } }).ok, false);
});

test('套件清单：同一套件里两个上下文插件互相冲突', () => {
  const other = { ...plugin, id: 'other-ctx', provides: [{ capability: 'context-strategy:other' }] };
  const parsed = parseBundleManifest({ ...manifest, components: [plugin, other] });
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? '' : parsed.error.message, /冲突/);
});

const inventory = (components: WorkerInventory['components']): WorkerInventory => ({
  runtimes: [{ agentId: 'pi', version: '1.4.0', source: 'hub' }],
  components,
  capabilities: components.map((c) => ({ capability: `context-strategy:${c.id}`, via: c.id })),
  collectedAt: 1
});

test('漂移：外部组件只列出、不算能力、不算漂移', () => {
  const report = detectDrift([], inventory([{ id: 'ext', runtime: 'pi', version: '0.3.1', integrity: '', enabled: true, managedBy: 'external' }]));
  assert.deepEqual(report.items.map((i) => i.kind), ['external']);
  assert.equal(report.trusted.length + report.untrusted.length, 0);
  assert.equal(hasDrift(report), false);
});

test('漂移：缺失 / 版本不一致 → 不可信；一致的可信；不在期望里的 hub 组件不可信', () => {
  const pins = [
    { componentId: 'a', runtime: 'pi', version: '1.0.0', integrity: SHA },
    { componentId: 'b', runtime: 'pi', version: '1.0.0', integrity: SHA },
    { componentId: 'gone', runtime: 'pi', version: '1.0.0', integrity: SHA }
  ];
  const report = detectDrift(
    pins,
    inventory([
      { id: 'a', runtime: 'pi', version: '1.0.0', integrity: SHA, enabled: true, managedBy: 'hub' },
      { id: 'b', runtime: 'pi', version: '1.0.1', integrity: SHA, enabled: true, managedBy: 'hub' },
      { id: 'stray', runtime: 'pi', version: '9.0.0', integrity: SHA, enabled: true, managedBy: 'hub' }
    ])
  );
  assert.deepEqual(report.items.map((i) => `${i.kind}:${i.componentId}`).sort(), ['mismatch:b', 'missing:gone', 'unexpected:stray']);
  assert.deepEqual(report.trusted.map((c) => c.via), ['a']);
  assert.deepEqual(report.untrusted.map((c) => c.via).sort(), ['b', 'stray']);
  assert.equal(hasDrift(report), true);
  assert.deepEqual(detectDrift([], null), { items: [], trusted: [], untrusted: [] });
});

test('资产组件：解析成资产名和版本，交给现有资产下发', async () => {
  const { bundleAssetRefs } = await import('./runtime-bundle.ts');
  const parsed = parseBundleManifest(manifest);
  assert.ok(parsed.ok);
  assert.deepEqual(bundleAssetRefs(parsed.value), [{ componentId: 'github-mcp', kind: 'mcp-server', name: 'github-mcp', version: 3 }]);
});
