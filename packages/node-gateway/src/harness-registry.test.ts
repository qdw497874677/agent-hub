import assert from 'node:assert/strict';
import { test } from 'node:test';

test('withMissingHint：只给「未安装」补提示，其它原因和 ready 原样', async () => {
  const { withMissingHint } = await import('./harness-registry.ts');
  const of = (readiness: import('@agent-hub/domain').AgentReadiness) => ({ agentId: 'pi', probe: async () => ({ readiness, models: [], defaultModel: '' }) });
  assert.deepEqual((await withMissingHint(of({ state: 'unavailable', reason: '未安装' }), 'H').probe()).readiness, { state: 'unavailable', reason: '未安装', hint: 'H' });
  assert.deepEqual((await withMissingHint(of({ state: 'unavailable', reason: '未登录' }), 'H').probe()).readiness, { state: 'unavailable', reason: '未登录' });
  assert.deepEqual((await withMissingHint(of({ state: 'ready' }), 'H').probe()).readiness, { state: 'ready' });
  const same = of({ state: 'unavailable', reason: '未安装' });
  assert.equal(withMissingHint(same, null), same);
});

test('replace：latest 换成新的一套，旧的模型自检结果不残留', async () => {
  const { createHarnessRegistry } = await import('./harness-registry.ts');
  const probe = (agentId: string) => ({ agentId, probe: async () => ({ readiness: { state: 'ready' as const }, models: [], defaultModel: '' }) });
  const registry = createHarnessRegistry([probe('old')], {
    selfChecks: [{ agentId: 'old', run: async () => ({ ok: false, model: '', reason: '没登录', at: 1 }) }]
  });
  await registry.probeAll();
  await registry.selfCheckOnce();
  const before = registry.latest().get('old')?.readiness;
  assert.equal(before?.state, 'ready');
  assert.equal((before as { check?: { ok: boolean } }).check?.ok, false);

  await registry.replace([probe('old'), probe('fresh')]);

  const latest = registry.latest();
  assert.equal(latest.has('fresh'), true);
  assert.equal(latest.get('fresh')?.readiness.state, 'ready');
  // 同一个 id 上的旧自检结论被清掉：不能把「没登录」串到新配置上
  assert.equal((latest.get('old')?.readiness as { check?: unknown }).check, undefined);
});
