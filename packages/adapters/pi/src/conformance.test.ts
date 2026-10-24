import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapPiEvent } from './map-event.ts';

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
    given: { type: 'tool_execution_end', toolCallId: 'c2', toolName: 'write', isError: false, args: { path: '/tmp/a.ts' } },
    expect: [
      { kind: 'tool_result', name: 'write', ok: true, durationMs: 0 },
      { kind: 'artifact', path: '/tmp/a.ts', bytes: 0 }
    ]
  },
  { given: { type: 'agent_settled', aborted: false }, expect: [{ kind: 'ended', outcome: 'done' }] },
  { given: { type: 'agent_settled', aborted: true }, expect: [{ kind: 'ended', outcome: 'stopped' }] },
  {
    given: { type: 'response', command: 'set_model', success: false, error: 'Model not found' },
    expect: [{ kind: 'diagnostic', level: 'error', text: 'set_model：Model not found' }]
  }
];

for (const [index, step] of FIXTURE.entries()) {
  test(`Pi conformance #${index + 1}`, () => {
    assert.deepEqual(mapPiEvent(step.given), step.expect);
  });
}
