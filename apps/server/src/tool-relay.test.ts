import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolGateway, ToolGrant } from '@agent-hub/domain';
import { answerToolRequest } from './tool-relay.ts';

const grant = (workerId: string | null) => ({ id: 'g', workerId }) as unknown as ToolGrant;

function fakeGateway(workerId: string | null, calls: string[]): ToolGateway {
  return {
    authenticate: async (token: string) => (token === 'ok' ? grant(workerId) : null),
    list: () => [{ name: 'task.get', description: '读任务', inputSchema: { type: 'object' } }],
    call: async (_grant: ToolGrant, name: string) => {
      calls.push(name);
      return { ok: true, value: { name } };
    }
  } as unknown as ToolGateway;
}

test('链路上的工具调用：令牌认人、线上名映射回点号、授权绑定的 Worker 才能用', async () => {
  const calls: string[] = [];
  const gateway = fakeGateway('w1', calls);
  const base = { type: 'tool_request' as const, requestId: 'r' };
  assert.deepEqual(await answerToolRequest(gateway, 'w1', { ...base, token: 'bad', op: 'list' }), {
    ok: false,
    error: '工具令牌无效或已过期'
  });
  const listed = await answerToolRequest(gateway, 'w1', { ...base, token: 'ok', op: 'list' });
  assert.deepEqual(listed.tools?.map((tool) => tool.name), ['task_get']);
  assert.deepEqual(await answerToolRequest(gateway, 'w1', { ...base, token: 'ok', op: 'call', name: 'task_get' }), {
    ok: true,
    value: { name: 'task.get' }
  });
  assert.deepEqual(calls, ['task.get']);
  const other = await answerToolRequest(gateway, 'w2', { ...base, token: 'ok', op: 'call', name: 'task_get' });
  assert.equal(other.ok, false);
  assert.deepEqual(calls, ['task.get']);
});
