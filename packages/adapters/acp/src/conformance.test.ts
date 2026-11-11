import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endedFromStopReason, mapAcpUpdate, redactLine } from './map-acp.ts';
import { readSubagentMeta } from './codecs/opencode.ts';
import { ACP_AGENT_DEFAULTS, acpDescriptor } from './config.ts';
import { mapAcpOptions } from './map-options.ts';

const toolNames = new Map<string, string>();

const FIXTURE: { readonly given: unknown; readonly expect: unknown[] }[] = [
  {
    given: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '先读文件' } },
    expect: [{ kind: 'text', delta: '先读文件' }]
  },
  {
    given: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '想一想' } },
    expect: [{ kind: 'thinking', delta: '想一想' }]
  },
  {
    given: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read src/a.ts', kind: 'read', rawInput: { path: 'src/a.ts' } },
    expect: [{ kind: 'tool_call', name: 'Read src/a.ts', input: '{"path":"src/a.ts"}' }]
  },
  {
    given: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' },
    expect: []
  },
  {
    given: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' },
    expect: [{ kind: 'tool_result', name: 'Read src/a.ts', ok: true, durationMs: 0 }]
  },
  {
    given: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't2',
      status: 'failed',
      rawOutput: { path: '/tmp/out.md' }
    },
    expect: [
      { kind: 'tool_result', name: 'tool', ok: false, durationMs: 0, output: '{"path":"/tmp/out.md"}' },
      { kind: 'artifact', path: '/tmp/out.md', bytes: 0 }
    ]
  }
];

for (const [index, step] of FIXTURE.entries()) {
  test(`OpenCode conformance #${index + 1}`, () => {
    assert.deepEqual(mapAcpUpdate(step.given, toolNames), step.expect);
  });
}

test('OpenCode 子代理：读取 child meta，事件带 subagentId', () => {
  assert.deepEqual(
    readSubagentMeta({ 'opencode/child-session': { id: 'c1', parentID: 'p1', depth: 1, title: 'child' } }),
    { id: 'c1', parentId: 'p1', depth: 1, title: 'child' }
  );
  assert.equal(readSubagentMeta({}), null);
  assert.deepEqual(
    mapAcpUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }, toolNames, 'c1'),
    [{ kind: 'text', delta: 'hi', subagentId: 'c1' }]
  );
});

test('OpenCode 停止原因映射', () => {
  assert.deepEqual(endedFromStopReason('cancelled'), { kind: 'ended', outcome: 'stopped' });
  assert.deepEqual(endedFromStopReason('end_turn'), { kind: 'ended', outcome: 'done' });
});

// 可调项：ACP 的 ConfigOption → RuntimeOption，含分组与未认识的 category。
test('acp: 可调项照抄 ACP 的形状，不认识的 category 收进 custom', () => {
  const options = mapAcpOptions([
    {
      configId: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'a',
      options: [
        { value: 'a', name: 'Model A' },
        { groupId: 'g1', name: '来自 provider X', options: [{ value: 'b', name: 'Model B' }] }
      ]
    },
    { configId: 'brave_mode', name: 'Brave', type: 'boolean', currentValue: false },
    { configId: 'weird', name: 'Weird', category: '_custom', type: 'select', currentValue: 'x' }
  ]);

  assert.equal(options.length, 3);
  assert.deepEqual(options.map((option) => option.category), ['model', 'custom', 'custom']);
  assert.equal(options[0]?.choices.length, 2);
  assert.equal(options[0]?.choices[1]?.kind, 'group');
  assert.equal(options[1]?.kind, 'boolean');
  assert.equal(options[1]?.current, false);
});

test('acp: 模型元数据从候选项 _meta 搬到 RuntimeOption', () => {
  const options = mapAcpOptions([
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'a',
      options: [
        {
          value: 'a',
          name: 'Model A',
          _meta: { contextWindow: 200000, maxTokens: 8192, aliases: ['a-fast'], isSelectable: false, tags: ['vision'] }
        }
      ]
    }
  ]);
  const value = options[0]?.choices[0];
  assert.ok(value?.kind === 'value');
  assert.deepEqual(value.value.metadata, {
    contextWindow: 200000,
    maxTokens: 8192,
    aliases: ['a-fast'],
    selectable: false,
    tags: ['vision']
  });
});

test('acp: OpenCode 默认把 Session Mode 当 Agent 展示', () => {
  const opencode = ACP_AGENT_DEFAULTS.find((config) => config.id === 'opencode');
  assert.deepEqual(opencode?.optionOverrides, { mode: { category: 'agent', label: 'Agent' } });
  assert.equal(opencode?.codec?.id, 'opencode');
});

test('acp: agent 配置可把 mode 映射成平台语义 agent，id 不变', () => {
  const options = mapAcpOptions(
    [
      {
        id: 'mode',
        name: 'Session Mode',
        category: 'mode',
        type: 'select',
        currentValue: 'build',
        options: [
          { value: 'orchestrator', name: 'orchestrator' },
          { value: 'build', name: 'build' },
          { value: 'plan', name: 'plan' }
        ]
      }
    ],
    { mode: { category: 'agent', label: 'Agent' } }
  );

  assert.equal(options[0]?.id, 'mode');
  assert.equal(options[0]?.category, 'agent');
  assert.equal(options[0]?.label, 'Agent');
  assert.equal(options[0]?.current, 'build');
});

test('acp: 模型清单从 model 选项投影出来，不是另写一份', () => {
  const descriptor = acpDescriptor(
    { id: 'opencode', label: 'OpenCode', command: 'opencode', args: ['acp'] },
    mapAcpOptions([
      {
        configId: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'b',
        options: [
          { value: 'a', name: 'A' },
          { value: 'b', name: 'B' }
        ]
      }
    ])
  );
  assert.deepEqual(descriptor.models, ['a', 'b']);
  assert.equal(descriptor.defaultModel, 'b');
});

test('endedFromStopReason：空回合、拒答、截断都是 failed 并带原因', () => {
  assert.deepEqual(endedFromStopReason('end_turn', { produced: true }), { kind: 'ended', outcome: 'done' });
  const empty = endedFromStopReason('end_turn', { produced: false, stderrTail: ['boom'] });
  assert.equal(empty.kind === 'ended' && empty.outcome, 'failed');
  assert.match(empty.kind === 'ended' ? (empty.reason ?? '') : '', /没有返回任何内容[\s\S]*stopReason: end_turn[\s\S]*boom/);
  assert.equal(endedFromStopReason('cancelled', { produced: false }).kind === 'ended' && (endedFromStopReason('cancelled', { produced: false }) as { outcome: string }).outcome, 'stopped');
  for (const reason of ['refusal', 'max_tokens', 'max_turn_requests']) {
    const ended = endedFromStopReason(reason, { produced: true });
    assert.equal(ended.kind === 'ended' && ended.outcome, 'failed', reason);
  }
});

test('redactLine：密钥 / 令牌 / 长串都打码', () => {
  const out = redactLine('api_key=sk-abcdef1234567890 Authorization: Bearer eyJhbGciOi.xyz token: "t0ps3cret" hash 0123456789abcdef0123456789abcdef');
  assert.doesNotMatch(out, /abcdef1234567890|eyJhbGciOi|t0ps3cret|0123456789abcdef0123/);
  assert.match(out, /api_key=\*\*\*/);
  assert.equal(redactLine('plain error: connect ECONNREFUSED 127.0.0.1:443'), 'plain error: connect ECONNREFUSED 127.0.0.1:443');
});
