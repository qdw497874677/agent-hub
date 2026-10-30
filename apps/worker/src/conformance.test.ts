import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RUNTIME_ADAPTERS } from './runtimes.ts';
import { runRuntimeConformance } from './conformance.ts';

test('注册表：适配器 id 唯一，产出的 agent id 唯一', async () => {
  const ids = RUNTIME_ADAPTERS.map((adapter) => adapter.id);
  assert.equal(new Set(ids).size, ids.length);
});

const agentIds: string[] = [];
for (const adapter of RUNTIME_ADAPTERS) {
  test(`运行时一致性：${adapter.id}`, async () => {
    const report = await runRuntimeConformance(adapter);
    assert.deepEqual(report.failures, []);
    for (const entry of report.prepared) agentIds.push(entry.runtime.descriptor.id);
  });
}

test('注册表：默认产出 pi / opencode / grok，且不重名', () => {
  assert.equal(new Set(agentIds).size, agentIds.length);
  for (const id of ['pi', 'opencode', 'grok']) assert.ok(agentIds.includes(id), id);
});
