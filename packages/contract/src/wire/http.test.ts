import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveSessionRequest } from './http.ts';
import { journalEntrySchema } from './entities.ts';

test('prompt journal wire 保留可选受限 actor，旧事件兼容', () => {
  for (const promptActor of ['account', 'token', 'system', 'unknown']) {
    const parsed = journalEntrySchema.parse({ seq: 1, at: 1, event: { kind: 'prompt', text: 'x', promptActor } });
    assert.equal(parsed.event.kind === 'prompt' && parsed.event.promptActor, promptActor);
  }
  const old = journalEntrySchema.parse({ seq: 1, at: 1, event: { kind: 'prompt', text: 'x' } });
  assert.equal(old.event.kind === 'prompt' && old.event.promptActor, undefined);
  assert.equal(journalEntrySchema.safeParse({ seq: 1, at: 1, event: { kind: 'prompt', text: 'x', promptActor: 'secret' } }).success, false);
});

test('deriveSessionRequest：model 可省略（外部 MCP 按默认 Agent 层级解析），空串也合法', () => {
  // 完全体：显式 model 照常通过
  const full = deriveSessionRequest.parse({ taskId: '550e8400-e29b-41d4-a716-446655440000', agentId: 'opencode/x', model: 'g' });
  assert.equal(full.model, 'g');

  // 省略 model 不再 400：session_start 会按 任务默认 > 项目默认 > 团队运行时默认 解析
  const omitted = deriveSessionRequest.parse({ taskId: '550e8400-e29b-41d4-a716-446655440000', agentId: 'opencode/x' });
  assert.equal(omitted.model, undefined);

  // 空串合法（内部派生对话框的历史约定：交给 agent 自己的默认）
  const empty = deriveSessionRequest.parse({ taskId: '550e8400-e29b-41d4-a716-446655440000', agentId: 'opencode/x', model: '' });
  assert.equal(empty.model, '');
});
