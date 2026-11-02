import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asAgentId } from '@agent-hub/domain';
import type { AgentRuntime, HarnessReadiness, RuntimeSession, SessionEvent } from '@agent-hub/domain';
import { runtimeSelfCheck, SELF_CHECK_PREFIX } from './model-check.ts';
import { createHarnessRegistry } from './harness-registry.ts';

/** 假 runtime：每轮按 script 吐事件。 */
function fakeRuntime(script: (n: number) => SessionEvent[], hang = false): AgentRuntime & { started: string[]; disposed: number } {
  const state = { started: [] as string[], disposed: 0 };
  const runtime = {
    ...state,
    descriptor: { id: asAgentId('fake'), label: 'Fake' },
    async start(spec: { sessionId: string }) {
      runtime.started.push(spec.sessionId);
      const queue: SessionEvent[] = [];
      let wake: (() => void) | null = null;
      let n = 0;
      const session = {
        sessionId: spec.sessionId,
        async prompt() {
          if (!hang) queue.push(...script(n++));
          wake?.();
          return { ok: true, value: undefined };
        },
        async interrupt() {},
        async *events() {
          for (;;) {
            while (queue.length > 0) yield queue.shift()!;
            await new Promise<void>((resolve) => (wake = resolve));
          }
        },
        async adopt() {},
        options: () => [{ id: 'model', label: 'Model', category: 'model', kind: 'select', current: 'm-1', choices: [] }],
        async changeOption() {
          return { ok: true, value: [] };
        },
        async dispose() {
          runtime.disposed++;
        }
      };
      return { ok: true, value: session as unknown as RuntimeSession };
    }
  };
  return runtime as unknown as AgentRuntime & { started: string[]; disposed: number };
}

test('runtimeSelfCheck：回了话 = ok，带当前模型；会话 id 有自检前缀，结束就 dispose', async () => {
  const runtime = fakeRuntime(() => [{ kind: 'text', delta: 'OK' }, { kind: 'ended', outcome: 'done' }]);
  const result = await runtimeSelfCheck(runtime).run();
  assert.equal(result.ok, true);
  assert.equal(result.model, 'm-1');
  assert.ok(runtime.started[0]?.startsWith(SELF_CHECK_PREFIX));
  assert.equal(runtime.disposed, 1);
});

test('runtimeSelfCheck：空回合 / 失败带原因；超时算失败', async () => {
  const failed = await runtimeSelfCheck(fakeRuntime(() => [{ kind: 'ended', outcome: 'failed', reason: 'agent 没有返回任何内容' }])).run();
  assert.equal(failed.ok, false);
  assert.match(failed.reason ?? '', /没有返回任何内容/);
  const silent = await runtimeSelfCheck(fakeRuntime(() => [{ kind: 'ended', outcome: 'done' }])).run();
  assert.equal(silent.ok, false);
  const hung = fakeRuntime(() => [], true);
  const slow = await runtimeSelfCheck(hung, { timeoutMs: 50 }).run();
  assert.equal(slow.ok, false);
  assert.match(slow.reason ?? '', /超时/);
  assert.equal(hung.disposed, 1);
});

test('registry.selfCheckOnce：只跑一次、只跑 ready 的；结果并进 ready.check', async () => {
  const ready: HarnessReadiness = { agentId: 'a', probe: async () => ({ readiness: { state: 'ready' }, models: [], defaultModel: '' }) };
  const down: HarnessReadiness = { agentId: 'b', probe: async () => ({ readiness: { state: 'unavailable', reason: '未安装' }, models: [], defaultModel: '' }) };
  let runs = 0;
  const registry = createHarnessRegistry([ready, down], {
    selfChecks: [
      { agentId: 'a', run: async () => (runs++, { ok: false, model: 'x', reason: '401', at: 1 }) },
      { agentId: 'b', run: async () => (runs++, { ok: true, model: '', at: 1 }) }
    ]
  });
  await registry.probeAll();
  const fresh = await registry.selfCheckOnce();
  await registry.selfCheckOnce();
  assert.equal(runs, 1);
  assert.deepEqual([...fresh.keys()], ['a']);
  assert.deepEqual(registry.latest().get('a')?.readiness, { state: 'ready', check: { ok: false, model: 'x', reason: '401', at: 1 } });
  assert.equal(registry.latest().get('b')?.readiness.state, 'unavailable');
  const again = await registry.probeAll();
  assert.deepEqual(again.get('a')?.readiness, { state: 'ready', check: { ok: false, model: 'x', reason: '401', at: 1 } });
});
