import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionEvent } from '@agent-hub/domain';
import { createCodexEventMapper } from './map-event.ts';

const KNOWN_KINDS = new Set<string>([
  'prompt',
  'text',
  'thinking',
  'tool_call',
  'tool_result',
  'artifact',
  'subagent',
  'commands',
  'ended',
  'diagnostic',
  'context_usage',
  'compaction',
  'approval'
]);

const notification = (method: string, params: Record<string, unknown>) => ({
  jsonrpc: '2.0',
  method,
  params
});

function replay(notifications: readonly unknown[]): SessionEvent[] {
  const mapper = createCodexEventMapper();
  const events: SessionEvent[] = [];
  for (const item of notifications) events.push(...mapper.map(item));
  return events;
}

test('conformance：一轮完整对话只发一条 ended，artifact 路径原样', () => {
  const events = replay([
    notification('turn/started', {
      threadId: 'th_1',
      turn: { id: 'turn_1', items: [], status: 'inProgress' }
    }),
    notification('item/reasoning/textDelta', {
      threadId: 'th_1',
      turnId: 'turn_1',
      itemId: 'item_1',
      contentIndex: 0,
      delta: '先看看目录。'
    }),
    notification('item/agentMessage/delta', {
      threadId: 'th_1',
      turnId: 'turn_1',
      itemId: 'item_2',
      delta: '我来看看。'
    }),
    notification('item/started', {
      threadId: 'th_1',
      turnId: 'turn_1',
      startedAtMs: 1000,
      item: {
        type: 'commandExecution',
        id: 'item_3',
        command: 'ls',
        commandActions: [],
        cwd: '/tmp/work',
        status: 'inProgress'
      }
    }),
    notification('item/completed', {
      threadId: 'th_1',
      turnId: 'turn_1',
      startedAtMs: 1000,
      completedAtMs: 1012,
      item: {
        type: 'commandExecution',
        id: 'item_3',
        command: 'ls',
        commandActions: [],
        cwd: '/tmp/work',
        status: 'completed',
        exitCode: 0,
        aggregatedOutput: 'a.txt\n',
        durationMs: 12
      }
    }),
    notification('item/completed', {
      threadId: 'th_1',
      turnId: 'turn_1',
      item: {
        type: 'fileChange',
        id: 'item_4',
        status: 'completed',
        changes: [{ path: 'src/a.ts', kind: { type: 'update' }, diff: '+ a' }]
      }
    }),
    notification('turn/completed', {
      threadId: 'th_1',
      turn: { id: 'turn_1', items: [], status: 'completed' }
    })
  ]);

  assert.deepEqual(
    events.map((event) => event.kind),
    ['thinking', 'text', 'tool_call', 'tool_result', 'artifact', 'ended']
  );
  for (const event of events) assert.ok(KNOWN_KINDS.has(event.kind), `未知事件 ${event.kind}`);
  assert.equal(events.filter((event) => event.kind === 'ended').length, 1);
  const artifact = events.find((event) => event.kind === 'artifact');
  assert.ok(artifact !== undefined && artifact.kind === 'artifact');
  assert.equal(artifact.path, 'src/a.ts');
  const result = events.find((event) => event.kind === 'tool_result');
  assert.ok(result !== undefined && result.kind === 'tool_result');
  assert.equal(result.ok, true);
  assert.equal(result.durationMs, 12);
  assert.equal(result.output, 'a.txt\n');
});

test('conformance：error 与 turn/completed failed 不会各发一条 ended', () => {
  const events = replay([
    notification('turn/started', {
      threadId: 'th_1',
      turn: { id: 'turn_1', items: [], status: 'inProgress' }
    }),
    notification('error', {
      threadId: 'th_1',
      turnId: 'turn_1',
      error: { message: '401 Unauthorized: invalid api key' },
      willRetry: false
    }),
    notification('turn/completed', {
      threadId: 'th_1',
      turn: {
        id: 'turn_1',
        items: [],
        status: 'failed',
        error: { message: '401 Unauthorized: invalid api key' }
      }
    })
  ]);

  const ended = events.filter((event) => event.kind === 'ended');
  assert.equal(ended.length, 1);
  assert.ok(ended[0] !== undefined && ended[0].kind === 'ended');
  assert.equal(ended[0].outcome, 'failed');
  assert.equal(ended[0].reason, '401 Unauthorized: invalid api key');
  assert.equal(events.filter((event) => event.kind === 'diagnostic').length, 1);
});

test('conformance：willRetry 的错误不提前结束这一轮', () => {
  const events = replay([
    notification('turn/started', {
      threadId: 'th_1',
      turn: { id: 'turn_1', items: [], status: 'inProgress' }
    }),
    notification('error', {
      threadId: 'th_1',
      turnId: 'turn_1',
      error: { message: 'stream disconnected' },
      willRetry: true
    }),
    notification('turn/completed', {
      threadId: 'th_1',
      turn: { id: 'turn_1', items: [], status: 'completed' }
    })
  ]);

  assert.deepEqual(events.map((event) => event.kind), ['diagnostic', 'ended']);
  const ended = events[1];
  assert.ok(ended !== undefined && ended.kind === 'ended');
  assert.equal(ended.outcome, 'done');
});

test('conformance：下一轮重新开始，不沿用上一轮的 ended 状态', () => {
  const events = replay([
    notification('turn/started', {
      threadId: 'th_1',
      turn: { id: 'turn_1', items: [], status: 'inProgress' }
    }),
    notification('turn/completed', {
      threadId: 'th_1',
      turn: { id: 'turn_1', items: [], status: 'completed' }
    }),
    notification('turn/started', {
      threadId: 'th_1',
      turn: { id: 'turn_2', items: [], status: 'inProgress' }
    }),
    notification('turn/completed', {
      threadId: 'th_1',
      turn: { id: 'turn_2', items: [], status: 'completed' }
    })
  ]);

  assert.equal(events.filter((event) => event.kind === 'ended').length, 2);
});
