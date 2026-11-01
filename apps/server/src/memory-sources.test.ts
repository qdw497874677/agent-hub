import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JournalEntry } from '@agent-hub/domain';
import { renderTranscript } from './memory-sources.ts';

test('TranscriptSource 只取人说的话和回复文字，不含思考和工具输出', () => {
  const events = [
    { kind: 'prompt', text: '修一下登录' },
    { kind: 'thinking', delta: '想想' },
    { kind: 'tool_call', id: '1', name: 'bash', input: 'ls' },
    { kind: 'tool_result', id: '1', output: 'SECRET_OUTPUT' },
    { kind: 'text', delta: '好，' },
    { kind: 'text', delta: '改完了' },
    { kind: 'ended', outcome: 'done' }
  ].map((event, i) => ({ seq: i, at: i, event }) as unknown as JournalEntry);
  assert.equal(renderTranscript(events), '人：修一下登录\nagent：好，改完了');
});
