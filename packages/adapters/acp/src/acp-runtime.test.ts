import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { asSessionId, asTaskId } from '@agent-hub/domain';
import type { RuntimeSession, SessionEvent, StartSpec } from '@agent-hub/domain';
import { createAcpRuntime } from './acp-runtime.ts';
import type { AcpAgentConfig } from './config.ts';

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
