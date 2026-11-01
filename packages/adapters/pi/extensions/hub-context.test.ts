import { test } from 'node:test';
import assert from 'node:assert/strict';
import hubContext, { applyAnswer, toMeta } from './hub-context.ts';

const msgs = [
  { role: 'user', content: [{ type: 'text', text: '旧问题' }] },
  { role: 'assistant', content: [{ type: 'toolCall', id: 'c1' }] },
  { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [{ type: 'text', text: 'x'.repeat(400) }] },
  { role: 'user', content: [{ type: 'text', text: '新问题' }] }
];

test('pi 扩展：只发元数据（不含正文），按回答删轮次、清旧结果、加引导', () => {
  const meta = toMeta(msgs);
  assert.deepEqual(meta.map((m) => m.role), ['user', 'assistant', 'tool', 'user']);
  assert.deepEqual(meta[1]!.calls, ['c1']);
  assert.equal(meta[2]!.callId, 'c1');
  assert.ok(!JSON.stringify(meta).includes('旧问题'));
  const out = applyAnswer(msgs, { apply: true, mode: 'hub-managed', keep: ['m1', 'm2', 'm3'], clear: ['m2'], guidance: ['已截断'] })!;
  assert.equal(out.length, 4);
  assert.match(JSON.stringify(out[0]!.content), /\[agent-hub\] 已截断/);
  assert.match(JSON.stringify(out[2]!.content), /旧工具结果已清理/);
  assert.equal(applyAnswer(msgs, { apply: false }), null);
  assert.equal(applyAnswer(msgs, { apply: true, keep: [] }), null, '回答不完整就不改');
});

test('pi 扩展：没有 hub 地址 / 令牌就不挂；hub 连不上放行', async () => {
  let handler: ((e: { messages: typeof msgs }) => Promise<unknown>) | null = null;
  const pi = { on: (_: 'context', h: typeof handler) => void (handler = h) } as never;
  delete process.env['AGENT_HUB_TOOL_URL'];
  hubContext(pi);
  assert.equal(handler, null);
  process.env['AGENT_HUB_TOOL_URL'] = 'http://127.0.0.1:1/mcp';
  process.env['AGENT_HUB_TOOL_TOKEN'] = 'test';
  hubContext(pi);
  assert.equal(await handler!({ messages: msgs }), undefined);
  delete process.env['AGENT_HUB_TOOL_URL'];
  delete process.env['AGENT_HUB_TOOL_TOKEN'];
});
