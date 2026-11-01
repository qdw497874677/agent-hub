import assert from 'node:assert/strict';
import { mkdtemp, readFile, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { StartSpec } from '@agent-hub/domain';
import { submitRun, HermesHttpError } from './client.ts';
import { prepareHermesHome, hermesSessionKey } from './home.ts';
import { hermesBaseEnv, hermesInput, hermesModel } from './hermes-runtime.ts';
import { createHermesEventMapper } from './map-event.ts';
import { createSseParser } from './sse.ts';

test('SSE：按空行分帧、跳过注释、跨 chunk 拼接', () => {
  const frames: { id: string | null; data: string }[] = [];
  const parse = createSseParser((frame) => frames.push(frame));
  parse(': open\n\nid: 1\ndata: {"event":"message.delta",');
  parse('"delta":"hi"}\n\n: keepalive\n\nid: 2\r\ndata: {"event":"run.completed"}\r\n\r\n');
  assert.deepEqual(frames, [
    { id: '1', data: '{"event":"message.delta","delta":"hi"}' },
    { id: '2', data: '{"event":"run.completed"}' }
  ]);
});

/** v0.22.5 上实测到的一轮事件（只留形状），对照映射结果——相当于这个适配器的一致性用例。 */
test('事件映射：一轮完整的 Runs API 事件', () => {
  let clock = 1000;
  const map = createHermesEventMapper(() => clock);
  const fixture = [
    { event: 'run.started', run_id: 'r1' },
    { event: 'message.delta', delta: 'PONG ' },
    { event: 'reasoning.available', text: 'thinking...' },
    { event: 'tool.started', tool: 'terminal', preview: 'ls', tool_call_id: 'c1' },
    { event: 'tool.completed', tool: 'terminal', duration: 0.25, error: false, tool_call_id: 'c1', preview: 'a.ts' },
    { event: 'tool.started', tool: 'read_file', preview: 'x', tool_call_id: 'c2' },
    { event: 'tool.failed', tool_call_id: 'c2' },
    { event: 'message.interim', text: 'already', already_streamed: true },
    { event: 'run.completed', output: 'PONG', usage: { input_tokens: 10, output_tokens: 3 }, runtime: { provider: 'custom', model: 'm-1' } }
  ];
  const out = fixture.flatMap((event) => {
    clock += 100;
    return map(event).events;
  });
  assert.deepEqual(out, [
    { kind: 'text', delta: 'PONG ' },
    { kind: 'thinking', delta: 'thinking...' },
    { kind: 'tool_call', name: 'terminal', input: 'ls' },
    { kind: 'tool_result', name: 'terminal', ok: true, durationMs: 250, output: 'a.ts' },
    { kind: 'tool_call', name: 'read_file', input: 'x' },
    { kind: 'tool_result', name: 'read_file', ok: false, durationMs: 100 },
    { kind: 'diagnostic', level: 'info', text: 'Hermes 用量：输入 10，输出 3（模型 m-1）' },
    { kind: 'ended', outcome: 'done' }
  ]);
});

test('事件映射：终态和控制事件', () => {
  const map = createHermesEventMapper();
  assert.deepEqual(map({ event: 'run.cancelled' }), { events: [{ kind: 'ended', outcome: 'stopped' }], terminal: true });
  assert.equal(map({ event: 'run.failed', partial: true }).events[0]?.kind, 'ended');
  assert.match(JSON.stringify(map({ event: 'run.failed', partial: true })), /没做完/);
  assert.deepEqual(map({ event: 'run.interrupted' }).events[0], { kind: 'ended', outcome: 'interrupted', reason: 'Hermes 中断了这一轮（可能在重启）' });
  const approval = map({ event: 'approval.request', request_id: 'a1', execution_generation: 3, command: 'rm -rf x' });
  assert.deepEqual(approval.control, { kind: 'approval', requestId: 'a1', generation: 3, summary: 'rm -rf x' });
  const clarify = map({ event: 'clarify.request', prompt_id: 'q1', question: 'which?' });
  assert.deepEqual(clarify.control, { kind: 'clarify', requestId: 'q1', generation: null, summary: 'which?' });
  assert.deepEqual(map({ event: 'something.new' }).events, []);
});

test('profile：令牌只用变量引用，记忆默认关，MCP 走垫片', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hermes-home-'));
  const dir = await prepareHermesHome(root, 's/1', { model: 'm-1', workspaceRoot: '/ws', toolShim: { command: 'node', args: ['shim.js'] } });
  assert.equal(dir, join(root, 'sessions', 'ahub-s_1'));
  const text = await readFile(join(dir, 'config.yaml'), 'utf8');
  const config = JSON.parse(text);
  assert.deepEqual(config.model, { provider: 'custom', default: 'm-1', base_url: '${HUB_PROVIDER_BASE_URL}', api_key: '${HUB_PROVIDER_TOKEN}' });
  assert.deepEqual(config.memory, { memory_enabled: false, user_profile_enabled: false });
  assert.equal(config.terminal.cwd, '/ws');
  assert.equal(config.mcp_servers['agent-hub'].env.AGENT_HUB_TOOL_TOKEN, '${AGENT_HUB_TOOL_TOKEN}');
  assert.equal(await readlink(join(dir, 'installs')), join(root, 'shared', 'installs'));
  // 第二次（resume）复用同一个目录
  assert.equal(await prepareHermesHome(root, 's/1', { model: 'm-1', workspaceRoot: '/ws' }), dir);
  assert.equal(hermesSessionKey('abc'), 'ahub-abc');
});

test('环境：像密钥的变量不传给 Hermes', () => {
  const env = hermesBaseEnv({ PATH: '/bin', HOME: '/h', OPENAI_API_KEY: 'x', HUB_TOKEN: 'y', MY_SECRET: 'z', API_SERVER_KEY: 'k', HERMES_HOME: '/x' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h' });
});

test('模型：认 hub-<slug>/<id>，不在清单里就用第一个', () => {
  const base = { provider: { models: [{ id: 'a' }, { id: 'b' }] } };
  assert.equal(hermesModel({ ...base, options: { model: 'hub-x/b' } } as unknown as StartSpec), 'b');
  assert.equal(hermesModel({ ...base, options: { model: 'zzz' } } as unknown as StartSpec), 'a');
  assert.equal(hermesModel({ ...base, options: {} } as unknown as StartSpec), 'a');
});

test('附件：写成路径清单', () => {
  assert.equal(hermesInput({ text: 'hi', parts: [] }), 'hi');
  assert.match(hermesInput({ text: 'hi', parts: [{ kind: 'mention', name: 'a', path: '/p/a.ts' }] }), /file: \/p\/a\.ts/);
});

test('提交：429 用同一个幂等键退避重试，4xx 不重试', async () => {
  const keys: string[] = [];
  let calls = 0;
  const fetcher = (async (_url: string, init: RequestInit) => {
    keys.push((init.headers as Record<string, string>)['idempotency-key'] ?? '');
    calls++;
    if (calls < 3) return new Response('{"error":{"code":"rate_limited"}}', { status: 429 });
    return new Response('{"run_id":"r1","status":"started"}', { status: 202 });
  }) as unknown as typeof fetch;
  const endpoint = { baseUrl: 'http://x', key: 'k', sessionKey: 'ahub-s' };
  const result = await submitRun(endpoint, {}, 'key-1', { fetcher, sleep: async () => undefined });
  assert.equal(result.run_id, 'r1');
  assert.deepEqual(keys, ['key-1', 'key-1', 'key-1']);

  const bad = (async () => new Response('{"error":{"code":"idempotency_key_conflict"}}', { status: 409 })) as unknown as typeof fetch;
  await assert.rejects(submitRun(endpoint, {}, 'k2', { fetcher: bad, sleep: async () => undefined }), (error: unknown) => error instanceof HermesHttpError && error.code === 'idempotency_key_conflict');
});
