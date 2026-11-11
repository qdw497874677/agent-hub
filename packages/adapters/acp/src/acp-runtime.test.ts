import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { asSessionId, asTaskId } from '@agent-hub/domain';
import type { RuntimeSession, SessionEvent, StartSpec } from '@agent-hub/domain';
import { hermesAcpOptionValue } from './hermes-acp.ts';
import { createAcpRuntime } from './acp-runtime.ts';
import type { AcpAgentConfig } from './config.ts';
import { opencodeCodec } from './codecs/opencode.ts';

const FAKE = fileURLToPath(new URL('../test-fixtures/fake-agent.mjs', import.meta.url));

const config: AcpAgentConfig = {
  id: 'fake',
  label: 'Fake',
  command: process.execPath,
  args: [FAKE],
  authenticate: (methods) => (methods.includes('key') ? { methodId: 'key' } : null),
  sessionMeta: { yoloMode: true }
};

function spec(overrides: Partial<StartSpec> = {}): StartSpec {
  return {
    sessionId: asSessionId('hub-1'),
    taskId: asTaskId('task-1'),
    workspaceRoot: process.cwd(),
    resume: null,
    options: {},
    ...overrides
  };
}

async function collectUntilEnded(session: RuntimeSession): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const event of session.events()) {
    out.push(event);
    if (event.kind === 'ended') break;
  }
  return out;
}

test('acp runtime: 认证钩子、_meta、开跑前选项都按顺序落到 agent 上', async () => {
  const refs: string[] = [];
  const reported: string[] = [];
  const runtime = createAcpRuntime(config, {
    onAgentSessionRef: (_id, ref) => refs.push(ref),
    onOptions: (_id, options) => reported.push(String(options[0]?.current))
  });
  const started = await runtime.start(spec({ options: { model: 'b' } }));
  assert.ok(started.ok);
  const session = started.value;
  assert.deepEqual(refs, ['s1'], '新会话立刻报出 agent 的真实 ref');
  assert.equal(session.options()[0]?.current, 'b');
  assert.ok(reported.includes('b'));

  const events = collectUntilEnded(session);
  assert.ok((await session.prompt({ text: 'hi', parts: [] })).ok);
  const seen = await events;
  assert.deepEqual(seen.at(-1), { kind: 'ended', outcome: 'done' });
  const text = seen.find((event) => event.kind === 'text');
  assert.ok(text && text.kind === 'text');
  assert.equal(text.delta, 'methods:initialize,authenticate,session/new{"yoloMode":true},session/set_config_option,session/prompt');
  await session.dispose();
});

test('acp runtime: 恢复时丢掉回放、权限请求自动选 allow、dispose 记 stopped', async () => {
  const runtime = createAcpRuntime(config);
  const started = await runtime.start(spec({ resume: { agentSessionRef: 's-old', cursor: 0 } }));
  assert.ok(started.ok);
  const session = started.value;

  const turn = collectUntilEnded(session);
  assert.ok((await session.prompt({ text: 'ask', parts: [] })).ok);
  const texts = (await turn).flatMap((event) => (event.kind === 'text' ? [event.delta] : []));
  assert.ok(!texts.includes('replayed history'), '回放的历史不该再出现');
  assert.ok(texts.includes('perm:yes'));

  const rest = collectUntilEnded(session);
  await session.dispose();
  assert.deepEqual((await rest).at(-1), { kind: 'ended', outcome: 'stopped' });
});

test('acp runtime: 命令不存在时返回 unavailable，不崩', async () => {
  const runtime = createAcpRuntime({ ...config, command: '/nonexistent/agent' });
  const started = await runtime.start(spec());
  assert.equal(started.ok, false);
});

test('acp runtime: launch 给的 sessionMeta 叠加到 session/new 的 _meta 上（Grok 的 rules 走这里）', async () => {
  const assets = { root: '/x', skills: [], instructions: [] };
  const runtime = createAcpRuntime({ ...config, launch: () => ({ sessionMeta: { rules: 'R' } }) });
  const started = await runtime.start(spec({ assets }));
  assert.ok(started.ok);
  const session = started.value;
  const turn = collectUntilEnded(session);
  assert.ok((await session.prompt({ text: 'methods', parts: [] })).ok);
  const text = (await turn).find((event) => event.kind === 'text');
  assert.ok(text && text.kind === 'text');
  assert.match(text.delta, /session\/new\{"yoloMode":true,"rules":"R"\}/);
  await session.dispose();
});

test('acp runtime: 只报老式 models/modes 的 agent（Hermes）→ 选项照样能看能改，走 set_model / set_mode', async () => {
  const runtime = createAcpRuntime({ ...config, args: [FAKE, '--legacy'], optionValue: hermesAcpOptionValue });
  const started = await runtime.start(spec({ options: { model: 'hub-p/m-2', mode: 'accept_edits' } }));
  assert.ok(started.ok, started.ok ? '' : started.error.message);
  const session = started.value;
  const byId = Object.fromEntries(session.options().map((o) => [o.id, o]));
  assert.equal(byId['model']?.category, 'model');
  assert.equal(byId['model']?.current, 'hub-p/m-2', 'agent 收到 custom:m-2，hub 看到的仍是 hub 模型 id（不改写 session.model）');
  assert.ok(byId['model']?.choices.some((c) => c.kind === 'value' && c.value.value === 'hub-p/m-2'));
  assert.equal(byId['mode']?.current, 'accept_edits');

  const events = collectUntilEnded(session);
  assert.ok((await session.prompt({ text: 'hi', parts: [] })).ok);
  const text = (await events).find((event) => event.kind === 'text');
  assert.ok(text && text.kind === 'text');
  assert.equal(text.delta, 'methods:initialize,authenticate,session/new{"yoloMode":true},session/set_model,session/set_mode,session/prompt');
  const bad = await session.changeOption('effort', 'high');
  assert.equal(bad.ok, false);
  await session.dispose();
});

test('acp runtime: 一轮什么都没回 → failed，带 stopReason 和脱敏后的 stderr', async (t) => {
  const runtime = createAcpRuntime(config);
  const started = await runtime.start(spec());
  assert.ok(started.ok);
  const session = started.value;
  t.after(() => session.dispose());
  const events = collectUntilEnded(session);
  assert.ok((await session.prompt({ text: 'please-empty', parts: [] })).ok);
  const ended = (await events).at(-1);
  assert.ok(ended && ended.kind === 'ended');
  assert.equal(ended.outcome, 'failed');
  assert.match(ended.reason ?? '', /agent 没有返回任何内容（可能是模型\/鉴权\/网络问题）/);
  assert.match(ended.reason ?? '', /stopReason: end_turn/);
  assert.match(ended.reason ?? '', /401 Unauthorized/);
  assert.doesNotMatch(ended.reason ?? '', /livesecret|abcdefghijklmnop/);
  await session.dispose();
});

test('acp runtime: child session updates → subagent start/子事件/end，父会话不混入子文本', async (t) => {
  const runtime = createAcpRuntime({ ...config, args: [FAKE, '--child'], codec: opencodeCodec });
  const started = await runtime.start(spec());
  assert.ok(started.ok);
  const session = started.value;
  t.after(() => session.dispose());
  const events = collectUntilEnded(session);
  assert.ok((await session.prompt({ text: 'please-child', parts: [] })).ok);
  const seen = await events;

  const start = seen.find((event) => event.kind === 'subagent' && event.phase === 'start');
  assert.ok(start && start.kind === 'subagent');
  assert.equal(start.id, 'c1');
  assert.equal(start.parentId, 's1');
  assert.equal(start.depth, 1);
  assert.equal(start.title, 'child task');
  assert.equal(start.agent, 'explorer');
  assert.equal(start.status, 'running');

  const childText = seen.find((event) => event.kind === 'text' && event.subagentId === 'c1');
  assert.ok(childText && childText.kind === 'text');
  assert.equal(childText.delta, 'child says hi');
  const childTool = seen.find((event) => event.kind === 'tool_call' && event.subagentId === 'c1');
  assert.ok(childTool && childTool.kind === 'tool_call');
  assert.equal(childTool.name, 'child: shell');
  const parentText = seen.find((event) => event.kind === 'text' && !event.subagentId);
  assert.ok(parentText && parentText.kind === 'text');
  assert.equal(parentText.delta, 'parent done');

  const end = seen.find((event) => event.kind === 'subagent' && event.phase === 'end');
  assert.ok(end && end.kind === 'subagent');
  assert.equal(end.id, 'c1');
  assert.equal(end.status, 'completed');
  assert.deepEqual(seen.at(-1), { kind: 'ended', outcome: 'done' });
});

test('acp runtime: refusal / max_tokens 各自报失败原因，不再当成完成', async (t) => {
  const runtime = createAcpRuntime(config);
  const started = await runtime.start(spec());
  assert.ok(started.ok);
  const session = started.value;
  t.after(() => session.dispose());
  let events = collectUntilEnded(session);
  assert.ok((await session.prompt({ text: 'please-refuse', parts: [] })).ok);
  let ended = (await events).at(-1);
  assert.ok(ended && ended.kind === 'ended' && ended.outcome === 'failed');
  assert.match(ended.reason ?? '', /模型拒绝了这次请求/);
  events = collectUntilEnded(session);
  assert.ok((await session.prompt({ text: 'please-long', parts: [] })).ok);
  ended = (await events).at(-1);
  assert.ok(ended && ended.kind === 'ended' && ended.outcome === 'failed');
  assert.match(ended.reason ?? '', /长度上限/);
  await session.dispose();
});
