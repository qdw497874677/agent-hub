import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  asSessionId,
  asTaskId,
  type AgentRuntime,
  type RuntimeSession,
  type SessionEvent,
  type StartSpec
} from '@agent-hub/domain';
import { createCodexRuntime } from './codex-runtime.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fakeServer = join(here, '..', 'test-fixtures', 'fake-app-server.mjs');

const MODELS = ['gpt-5.1-codex', 'gpt-5.1-codex-mini'];

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'codex-adapter-'));
}

function spec(root: string, agentSessionRef: string | null = null): StartSpec {
  return {
    sessionId: asSessionId('sess-codex'),
    taskId: asTaskId('task-codex'),
    workspaceRoot: root,
    resume: agentSessionRef === null ? null : { agentSessionRef, cursor: 0 },
    options: {}
  };
}

function makeRuntime(hooks: { refs?: string[] } = {}): AgentRuntime {
  return createCodexRuntime({
    command: process.execPath,
    args: [fakeServer],
    models: MODELS,
    defaultModel: 'gpt-5.1-codex',
    ...(hooks.refs === undefined
      ? {}
      : {
          onAgentSessionRef: (_sessionId: string, ref: string) => {
            hooks.refs!.push(ref);
          }
        })
  });
}

function collect(session: RuntimeSession): SessionEvent[] {
  const events: SessionEvent[] = [];
  void (async () => {
    for await (const event of session.events()) events.push(event);
  })();
  return events;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  events: readonly SessionEvent[],
  label: string,
  predicate: (event: SessionEvent) => boolean,
  timeoutMs = 5_000
): Promise<SessionEvent> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = events.find(predicate);
    if (found !== undefined) return found;
    await sleep(10);
  }
  assert.fail(`等不到 ${label}；已收到：${events.map((event) => event.kind).join(' / ') || '（空）'}`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number | null): Promise<void> {
  assert.notEqual(pid, null, '会话没有 pid');
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!isAlive(pid!)) return;
    await sleep(10);
  }
  assert.fail(`codex 进程 ${pid} 还活着`);
}

/** 起一条会话跑用例；无论断言成败都 dispose 并确认进程退出，测试之间不留进程。 */
async function withSession(
  runtime: AgentRuntime,
  startSpec: StartSpec,
  body: (session: RuntimeSession, pid: number | null, events: SessionEvent[]) => Promise<void>
): Promise<void> {
  const result = await runtime.start(startSpec);
  assert.ok(result.ok, result.ok ? '' : result.error.message);
  if (!result.ok) return;
  const session = result.value;
  const pid = session.pid?.() ?? null;
  const events = collect(session);
  try {
    await body(session, pid, events);
  } finally {
    await session.dispose();
    await waitForExit(pid);
  }
}

test('端到端：握手 → 开会话 → 一轮（审批 accept）→ 文本 / 思考 / 工具 / 用量 → dispose', async () => {
  const root = workdir();
  const refs: string[] = [];
  try {
    await withSession(makeRuntime({ refs }), spec(root), async (session, _pid, events) => {
      assert.deepEqual(refs, ['th_fake_1'], 'thread/start 的 id 要报成 agentSessionRef');
      assert.ok((await session.prompt({ text: '看看目录', parts: [] })).ok);

      const request = await waitFor(events, '命令审批', (event) => event.kind === 'approval');
      assert.ok(request.kind === 'approval');
      assert.equal(request.title, '要跑 ls');
      assert.equal(request.detail, 'ls -la');

      const allowed = await session.respondApproval!(request.id, 'allow');
      assert.ok(allowed.ok, allowed.ok ? '' : allowed.error.message);

      await waitFor(events, '工具结果', (event) => event.kind === 'tool_result');
      const ended = await waitFor(events, 'ended', (event) => event.kind === 'ended');
      assert.ok(ended.kind === 'ended');
      assert.equal(ended.outcome, 'done');

      const text = events
        .filter((event): event is Extract<SessionEvent, { kind: 'text' }> => event.kind === 'text')
        .map((event) => event.delta)
        .join('');
      assert.equal(text, '我来看看。目录里有 a.txt 和 b.ts。');
      const thinking = events
        .filter((event): event is Extract<SessionEvent, { kind: 'thinking' }> => event.kind === 'thinking')
        .map((event) => event.delta)
        .join('');
      assert.equal(thinking, '先看看目录。');

      const call = events.find((event) => event.kind === 'tool_call');
      assert.ok(call !== undefined && call.kind === 'tool_call');
      assert.equal(call.name, 'ls -la');
      const toolResult = events.find((event) => event.kind === 'tool_result');
      assert.ok(toolResult !== undefined && toolResult.kind === 'tool_result');
      assert.equal(toolResult.ok, true);
      assert.equal(toolResult.output, 'a.txt\nb.ts\n');
      assert.equal(toolResult.durationMs, 12);

      const usage = events.find((event) => event.kind === 'context_usage');
      assert.ok(usage !== undefined && usage.kind === 'context_usage');
      assert.equal(usage.usedTokens, 125);
      assert.equal(usage.windowTokens, 1000);
      assert.equal(usage.percent, 12.5);

      const resolved = await waitFor(
        events,
        '审批收尾',
        (event) => event.kind === 'approval' && event.phase === 'resolved'
      );
      assert.ok(resolved.kind === 'approval');
      assert.equal(resolved.decision, 'allow');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('端到端：审批 decline → 不发 artifact，这一轮仍正常收尾', async () => {
  const root = workdir();
  try {
    await withSession(makeRuntime(), spec(root), async (session, _pid, events) => {
      assert.ok((await session.prompt({ text: 'decline 一下', parts: [] })).ok);
      const request = await waitFor(events, '文件审批', (event) => event.kind === 'approval');
      assert.ok(request.kind === 'approval');
      assert.equal(request.title, '要改 notes.txt');
      // 0.168.0 的 fileChange 审批参数里没有文件清单，detail 只能缺省。
      assert.equal(request.detail, undefined);

      assert.ok((await session.respondApproval!(request.id, 'deny')).ok);
      const ended = await waitFor(events, 'ended', (event) => event.kind === 'ended');
      assert.ok(ended.kind === 'ended');
      assert.equal(ended.outcome, 'done');
      assert.equal(events.filter((event) => event.kind === 'artifact').length, 0);
      assert.equal(events.filter((event) => event.kind === 'tool_result').length, 0);
      const resolved = events.find((event) => event.kind === 'approval' && event.phase === 'resolved');
      assert.ok(resolved !== undefined && resolved.kind === 'approval');
      assert.equal(resolved.decision, 'deny');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('端到端：interrupt 让这一轮以 stopped 收尾，dispose 杀干净进程', async () => {
  const root = workdir();
  try {
    await withSession(makeRuntime(), spec(root), async (session, _pid, events) => {
      assert.ok((await session.prompt({ text: 'hang 住', parts: [] })).ok);
      await waitFor(events, '运行中的命令', (event) => event.kind === 'tool_call');
      assert.equal(events.find((event) => event.kind === 'ended'), undefined, '还没打断，不应该有 ended');

      await session.interrupt();
      const ended = await waitFor(events, 'ended', (event) => event.kind === 'ended');
      assert.ok(ended.kind === 'ended');
      assert.equal(ended.outcome, 'stopped');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('端到端：dispose 时还挂着的审批不会把进程吊住', async () => {
  const root = workdir();
  try {
    await withSession(makeRuntime(), spec(root), async (session, _pid, events) => {
      assert.ok((await session.prompt({ text: '看看目录', parts: [] })).ok);
      await waitFor(events, '命令审批', (event) => event.kind === 'approval');

      const startedAt = Date.now();
      await session.dispose();
      const elapsed = Date.now() - startedAt;
      assert.ok(elapsed < 4_000, `dispose 用了 ${elapsed}ms`);

      const late = await session.respondApproval!('codex-item_cmd', 'allow');
      assert.equal(late.ok, false);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('端到端：thread 在 Codex 里丢了 → invalid，不静默新开', async () => {
  const root = workdir();
  try {
    const result = await makeRuntime().start(spec(root, 'th_missing'));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'invalid');
    assert.match(result.error.message, /已经不存在/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('options：非法值被拒，合法值改到下一轮', async () => {
  const root = workdir();
  try {
    await withSession(makeRuntime(), { ...spec(root), options: { effort: 'medium' } }, async (session) => {
      const bad = await session.changeOption('effort', 'turbo');
      assert.equal(bad.ok, false);
      if (!bad.ok) {
        assert.equal(bad.error.code, 'invalid');
        assert.match(bad.error.message, /minimal \/ low \/ medium \/ high/);
      }

      const good = await session.changeOption('effort', 'high');
      assert.ok(good.ok);
      if (good.ok) assert.equal(good.value.find((option) => option.id === 'effort')?.current, 'high');

      const unknown = await session.changeOption('telepathy', 'on');
      assert.ok(unknown.ok);

      const boolean = await session.changeOption('model', true);
      assert.equal(boolean.ok, false);

      const model = await session.changeOption('model', 'gpt-5.1-codex-mini');
      assert.ok(model.ok);
      if (model.ok) {
        assert.equal(model.value.find((option) => option.id === 'model')?.current, 'gpt-5.1-codex-mini');
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('descriptor 与 provider 拒绝', async () => {
  const runtime = makeRuntime();
  assert.equal(String(runtime.descriptor.id), 'codex');
  assert.ok(runtime.descriptor.models.includes('gpt-5.1-codex'));
  const root = workdir();
  try {
    const result = await runtime.start({
      ...spec(root),
      provider: {
        slug: 'openrouter',
        name: 'OpenRouter',
        protocol: 'openai-chat',
        models: [],
        baseUrl: 'http://127.0.0.1:1',
        token: 'x'
      }
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'invalid');
      assert.match(result.error.message, /不支持 hub 模型提供商/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
