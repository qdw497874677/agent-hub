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
