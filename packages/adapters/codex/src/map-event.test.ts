import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapCodexEvent } from './map-event.ts';

interface Golden {
  readonly name: string;
  readonly given: Record<string, unknown>;
  readonly expect: readonly unknown[];
}

const notification = (method: string, params: Record<string, unknown>) => ({
  jsonrpc: '2.0',
  method,
  params
});

const goldens: readonly Golden[] = [
  {
    name: 'agentMessage 增量 → text',
    given: notification('item/agentMessage/delta', {
      threadId: 'th_1',
      turnId: 'turn_1',
      itemId: 'item_1',
      delta: '我来看看。'
    }),
    expect: [{ kind: 'text', delta: '我来看看。' }]
  },
  {
    name: 'reasoning 正文增量 → thinking',
    given: notification('item/reasoning/textDelta', {
      threadId: 'th_1',
      turnId: 'turn_1',
      itemId: 'item_2',
      contentIndex: 0,
      delta: '先看看目录。'
    }),
    expect: [{ kind: 'thinking', delta: '先看看目录。' }]
  },
  {
    name: 'reasoning 摘要增量 → thinking',
    given: notification('item/reasoning/summaryTextDelta', {
      threadId: 'th_1',
      turnId: 'turn_1',
      itemId: 'item_2',
      summaryIndex: 0,
      delta: '检查工作区'
    }),
    expect: [{ kind: 'thinking', delta: '检查工作区' }]
  },
  {
    name: 'commandExecution 开始 → tool_call',
    given: notification('item/started', {
      threadId: 'th_1',
      turnId: 'turn_1',
      startedAtMs: 1000,
      item: {
        type: 'commandExecution',
        id: 'item_3',
        command: 'ls -la',
        commandActions: [],
        cwd: '/tmp/work',
        status: 'inProgress'
      }
    }),
    expect: [{ kind: 'tool_call', name: 'ls -la', input: 'ls -la' }]
  },
  {
    name: 'commandExecution 完成 → tool_result（带输出与耗时）',
    given: notification('item/completed', {
      threadId: 'th_1',
      turnId: 'turn_1',
      startedAtMs: 1000,
      completedAtMs: 1012,
      item: {
        type: 'commandExecution',
        id: 'item_3',
        command: 'ls -la',
        commandActions: [],
        cwd: '/tmp/work',
        status: 'completed',
        exitCode: 0,
        aggregatedOutput: 'a.txt\nb.ts\n',
        durationMs: 12
      }
    }),
    expect: [{ kind: 'tool_result', name: 'ls -la', ok: true, durationMs: 12, output: 'a.txt\nb.ts\n' }]
  },
  {
    name: 'commandExecution 非零退出 → ok=false',
    given: notification('item/completed', {
      threadId: 'th_1',
      turnId: 'turn_1',
      item: {
        type: 'commandExecution',
        id: 'item_3',
        command: 'false',
        commandActions: [],
        cwd: '/tmp/work',
        status: 'failed',
        exitCode: 1
      }
    }),
    expect: [{ kind: 'tool_result', name: 'false', ok: false, durationMs: 0 }]
  },
  {
    name: 'fileChange 开始 → apply_patch，完成 → 每个文件一条 artifact',
    given: notification('item/completed', {
      threadId: 'th_1',
      turnId: 'turn_1',
      item: {
        type: 'fileChange',
        id: 'item_4',
        status: 'completed',
        changes: [
          { path: 'src/a.ts', kind: { type: 'update' }, diff: '+ a' },
          { path: 'src/b.ts', kind: { type: 'add' }, diff: '+ b' }
        ]
      }
    }),
    expect: [
      { kind: 'artifact', path: 'src/a.ts', bytes: 0 },
      { kind: 'artifact', path: 'src/b.ts', bytes: 0 }
    ]
  },
  {
    name: 'fileChange 被拒绝 → 不发 artifact',
    given: notification('item/completed', {
      threadId: 'th_1',
      turnId: 'turn_1',
      item: {
        type: 'fileChange',
        id: 'item_4',
        status: 'declined',
        changes: [{ path: 'src/a.ts', kind: { type: 'update' }, diff: '+ a' }]
      }
    }),
    expect: []
  },
  {
    name: 'mcpToolCall 完成 → tool_result 取 text 内容',
    given: notification('item/completed', {
      threadId: 'th_1',
      turnId: 'turn_1',
      item: {
        type: 'mcpToolCall',
        id: 'item_5',
        server: 'docs',
        tool: 'search',
        status: 'completed',
        arguments: { q: 'codex' },
        durationMs: 30,
        result: { content: [{ type: 'text', text: '找到 2 条' }] }
      }
    }),
    expect: [{ kind: 'tool_result', name: 'docs/search', ok: true, durationMs: 30, output: '找到 2 条' }]
  },
  {
    name: 'webSearch 开始 → tool_call',
    given: notification('item/started', {
      threadId: 'th_1',
      turnId: 'turn_1',
      item: { type: 'webSearch', id: 'item_6', query: 'codex app-server' }
    }),
    expect: [{ kind: 'tool_call', name: 'web_search', input: 'codex app-server' }]
  },
  {
    name: 'turn/completed completed → ended done',
    given: notification('turn/completed', {
      threadId: 'th_1',
      turn: { id: 'turn_1', items: [], status: 'completed' }
    }),
    expect: [{ kind: 'ended', outcome: 'done' }]
  },
  {
    name: 'turn/completed interrupted → ended stopped',
    given: notification('turn/completed', {
      threadId: 'th_1',
      turn: { id: 'turn_1', items: [], status: 'interrupted' }
    }),
    expect: [{ kind: 'ended', outcome: 'stopped' }]
  },
  {
    name: 'turn/completed failed → ended failed 带原样错误',
    given: notification('turn/completed', {
      threadId: 'th_1',
      turn: {
        id: 'turn_1',
        items: [],
        status: 'failed',
        error: { message: '401 Unauthorized: invalid api key' }
      }
    }),
    expect: [{ kind: 'ended', outcome: 'failed', reason: '401 Unauthorized: invalid api key' }]
  },
  {
    name: 'thread/tokenUsage/updated → context_usage',
    given: notification('thread/tokenUsage/updated', {
      threadId: 'th_1',
      turnId: 'turn_1',
      tokenUsage: {
        last: {
          inputTokens: 100,
          cachedInputTokens: 20,
          outputTokens: 20,
          reasoningOutputTokens: 5,
          totalTokens: 125
        },
        total: {
          inputTokens: 300,
          cachedInputTokens: 40,
          outputTokens: 60,
          reasoningOutputTokens: 15,
          totalTokens: 375
        },
        modelContextWindow: 1000
      }
    }),
    expect: [{ kind: 'context_usage', usedTokens: 125, windowTokens: 1000, percent: 12.5 }]
  },
  {
    name: 'plan 与 thread/started 不产生事件',
    given: notification('thread/started', { thread: { id: 'th_1' } }),
    expect: []
  },
  {
    name: '未知通知不产生事件',
    given: notification('item/plan/delta', { threadId: 'th_1', delta: '- 步骤' }),
    expect: []
  },
  {
    name: 'error 不在 turn 中 → 只有 diagnostic',
    given: notification('error', {
      threadId: 'th_1',
      turnId: null,
      error: { message: '警告：配置过期' },
      willRetry: false
    }),
    expect: [{ kind: 'diagnostic', level: 'error', text: '警告：配置过期' }]
  }
];

for (const golden of goldens) {
  test(`golden：${golden.name}`, () => {
    assert.deepEqual(mapCodexEvent(golden.given), golden.expect);
  });
}
