import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeSessionCodec, readSubagentMeta } from './opencode.ts';

const toolNames = new Map<string, string>();
const childMeta = (id = 'c1', parentID = 'p1') => ({
  'opencode/child-session': { id, parentID, depth: 1, title: 'child' }
});

test('OpenCode codec：标准 ACP 交给通用 mapper', () => {
  const codec = new OpenCodeSessionCodec();
  assert.equal(
    codec.decode({
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
      meta: undefined,
      toolNames
    }),
    null
  );
});

test('OpenCode codec：child meta 发 start，子事件带 subagentId，重复不重发', () => {
  const codec = new OpenCodeSessionCodec();
  const first = codec.decode({
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
    meta: childMeta(),
    toolNames
  });
  assert.deepEqual(first?.events, [
    { kind: 'subagent', phase: 'start', id: 'c1', parentId: 'p1', depth: 1, title: 'child', status: 'running' },
    { kind: 'text', delta: 'hi', subagentId: 'c1' }
  ]);

  const second = codec.decode({
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'again' } },
    meta: childMeta(),
    toolNames
  });
  assert.deepEqual(second?.events, [{ kind: 'text', delta: 'again', subagentId: 'c1' }]);
});

test('OpenCode codec：父 subagent 工具完成时发 end', () => {
  const codec = new OpenCodeSessionCodec();
  const parentCall = codec.decode({
    update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'subagent', rawInput: { agent: 'explorer' } },
    meta: undefined,
    toolNames
  });
  assert.deepEqual(parentCall?.events, [{ kind: 'tool_call', name: 'subagent', input: '{"agent":"explorer"}' }]);

  const child = codec.decode({
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } },
    meta: childMeta(),
    toolNames
  });
  assert.equal(child?.events[0]?.kind, 'subagent');
  assert.deepEqual(child?.events[0], {
    kind: 'subagent',
    phase: 'start',
    id: 'c1',
    parentId: 'p1',
    depth: 1,
    title: 'child',
    agent: 'explorer',
    status: 'running'
  });

  const done = codec.decode({
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      content: [{ type: 'text', text: '<subagent sessionID="c1" state="completed">ok</subagent>' }]
    },
    meta: undefined,
    toolNames
  });
  assert.equal(done?.events[0]?.kind, 'subagent');
  assert.deepEqual(done?.events[0], {
    kind: 'subagent',
    phase: 'end',
    id: 'c1',
    parentId: 'p1',
    depth: 1,
    title: 'child',
    agent: 'explorer',
    status: 'completed'
  });
  assert.equal(done?.events[1]?.kind, 'tool_result');
});

test('OpenCode codec：finish 收尾未结束的子代理', () => {
  const codec = new OpenCodeSessionCodec();
  codec.decode({
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
    meta: childMeta(),
    toolNames
  });
  assert.deepEqual(codec.finish('failed'), [
    {
      kind: 'subagent',
      phase: 'end',
      id: 'c1',
      parentId: 'p1',
      depth: 1,
      title: 'child',
      status: 'failed'
    }
  ]);
  assert.deepEqual(codec.finish('failed'), []);
});

test('readSubagentMeta：非法/空 meta 返回 null', () => {
  assert.equal(readSubagentMeta(undefined), null);
  assert.equal(readSubagentMeta({}), null);
  assert.deepEqual(readSubagentMeta(childMeta()), { id: 'c1', parentId: 'p1', depth: 1, title: 'child' });
});
