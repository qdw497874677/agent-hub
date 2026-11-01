import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RUNTIME_ADAPTERS } from './runtimes.ts';
import { conformanceFixture, runRuntimeConformance } from './conformance.ts';

test('注册表：适配器 id 唯一，产出的 agent id 唯一', async () => {
  const ids = RUNTIME_ADAPTERS.map((adapter) => adapter.id);
  assert.equal(new Set(ids).size, ids.length);
});

const agentIds: string[] = [];
for (const adapter of RUNTIME_ADAPTERS) {
  test(`运行时一致性：${adapter.id}`, async () => {
    // Hermes 默认不注册（要显式开），一致性检查时打开
    const report = await runRuntimeConformance(adapter, adapter.id === 'hermes' ? { WORKER_HERMES: '1' } : {});
    assert.deepEqual(report.failures, []);
    for (const entry of report.prepared) agentIds.push(entry.runtime.descriptor.id);
  });
}

test('注册表：默认产出 pi / opencode / grok，且不重名', () => {
  assert.equal(new Set(agentIds).size, agentIds.length);
  for (const id of ['pi', 'opencode', 'grok']) assert.ok(agentIds.includes(id), id);
});

test('注册表：Hermes 默认不注册', async () => {
  const hermes = RUNTIME_ADAPTERS.find((adapter) => adapter.id === 'hermes');
  assert.ok(hermes);
  const fixture = conformanceFixture();
  try {
    assert.deepEqual(await hermes.prepare(fixture.ctx), []);
  } finally {
    fixture.cleanup();
  }
});
