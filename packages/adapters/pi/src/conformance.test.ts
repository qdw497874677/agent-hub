import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPiEventMapper } from './map-event.ts';

/**
 * X1 的门槛，不是人工清单：录制好的 Pi 原始记录进，归一化事件出。
 * 新增 agent 就是把这份 fixture 换成它自己的，断言同一组期望。
 */
const FIXTURE: { readonly given: unknown; readonly expect: unknown[] }[] = [
  {
    given: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '在看 ' } },
    expect: [{ kind: 'text', delta: '在看 ' }]
  },
  {
    given: { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '嗯' } },
    expect: []
  },
  {
    given: { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'ls' } },
    expect: [{ kind: 'tool_call', name: 'bash', input: '{"command":"ls"}' }]
  },
  {
    given: { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash', isError: false, durationMs: 12.6 },
    expect: [{ kind: 'tool_result', name: 'bash', ok: true, durationMs: 13 }]
  },
  {
    // 真实录制里 end 不带 args：路径只能从 start 那条记住。这条 fixture 曾经
    // 把 args 塞进 end，于是它通过了、真机上的产出物却一直是空的。
    given: { type: 'tool_execution_start', toolCallId: 'c2', toolName: 'write', args: { path: './note.md', content: 'x' } },
    expect: [{ kind: 'tool_call', name: 'write', input: '{"path":"./note.md","content":"x"}' }]
  },
  {
    given: { type: 'tool_execution_end', toolCallId: 'c2', toolName: 'write', isError: false, durationMs: 7 },
    expect: [
      { kind: 'tool_result', name: 'write', ok: true, durationMs: 7 },
      { kind: 'artifact', path: './note.md', bytes: 0 }
    ]
  },
  {
    // 写失败不算产出物：文件可能只落了一半
    given: { type: 'tool_execution_start', toolCallId: 'c3', toolName: 'edit', args: { path: '/tmp/b.ts' } },
    expect: [{ kind: 'tool_call', name: 'edit', input: '{"path":"/tmp/b.ts"}' }]
  },
  {
    given: { type: 'tool_execution_end', toolCallId: 'c3', toolName: 'edit', isError: true, durationMs: 2 },
    expect: [{ kind: 'tool_result', name: 'edit', ok: false, durationMs: 2 }]
  },
  {
    // 只读工具的入参不是产出物
    given: { type: 'tool_execution_start', toolCallId: 'c4', toolName: 'read', args: { path: '/tmp/c.ts' } },
    expect: [{ kind: 'tool_call', name: 'read', input: '{"path":"/tmp/c.ts"}' }]
  },
  { given: { type: 'agent_settled', aborted: false }, expect: [{ kind: 'ended', outcome: 'done' }] },
  { given: { type: 'agent_settled', aborted: true }, expect: [{ kind: 'ended', outcome: 'stopped' }] },
  {
    given: { type: 'response', command: 'set_model', success: false, error: 'Model not found' },
    expect: [{ kind: 'diagnostic', level: 'error', text: 'set_model：Model not found' }]
  }
];

// 每条 fixture 都从头重放一遍序列，但只断言自己那一步的输出：
// 事件之间的关联（start 记住路径、end 才发产出物）本身是被验证的行为，
// 逐条新建 mapper 会把这一层漏掉；而分成多条用例又能在失败时一眼看出是哪一步。
for (const [index, step] of FIXTURE.entries()) {
  test(`Pi conformance #${index + 1}`, () => {
    const mapper = createPiEventMapper();
    let output: unknown[] = [];
    for (let cursor = 0; cursor <= index; cursor += 1) {
      output = mapper.map(FIXTURE[cursor]?.given);
    }
    assert.deepEqual(output, step.expect);
  });
}
