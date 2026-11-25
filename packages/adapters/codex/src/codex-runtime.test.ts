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
  type PromptInput,
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

function keyedPrompt(text: string, deliveryId: string): PromptInput {
  return { text, parts: [], deliveryId };
}

function nativeRef(session: RuntimeSession): string | null {
  return (session as RuntimeSession & { nativeSessionRef(): string | null }).nativeSessionRef();
}

test('native ref follows the confirmed resumed thread and excludes placeholders', async () => {
  const root = workdir();
  try {
    await withSession(makeRuntime(), spec(root, 'th_resumed'), async (session) => {
      assert.equal(nativeRef(session), 'th_resumed');
    });
    await withSession(makeRuntime(), spec(root, ' PENDING '), async (session) => {
      assert.equal(nativeRef(session), null);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function endedEvents(events: readonly SessionEvent[]): Extract<SessionEvent, { kind: 'ended' }>[] {
  return events.filter((event): event is Extract<SessionEvent, { kind: 'ended' }> => event.kind === 'ended');
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
      assert.equal(nativeRef(session), 'th_fake_1');
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

test('送达确认：ended 带回本轮 prompt 的 deliveryId，旧轮的迟到完成不会顶掉新一轮', async () => {
  const root = workdir();
  try {
    await withSession(makeRuntime(), spec(root), async (session, _pid, events) => {
      // 第一轮：没有旧轮可重复，结束必须带上 d-1。
      assert.ok((await session.prompt(keyedPrompt('stale 第一轮', 'd-1'))).ok);
      const first = await waitFor(events, '第一轮 ended', (event) => event.kind === 'ended');
      assert.ok(first.kind === 'ended');
      assert.equal(first.deliveryId, 'd-1');

      // 第二轮：假 codex 先补发 turn_1 的重复 completed，再正常结束 turn_2。
      assert.ok((await session.prompt(keyedPrompt('stale 第二轮', 'd-2'))).ok);
      const second = await waitFor(
        events,
        '第二轮 tagged ended',
        (event) => event.kind === 'ended' && event.deliveryId === 'd-2'
      );
      assert.ok(second.kind === 'ended');
      assert.equal(second.outcome, 'done');

      // 旧轮的重复完成不能再发一条 ended，也不能把 d-2 抢走。
      const ended = endedEvents(events);
      assert.equal(ended.length, 2);
      assert.deepEqual(
        ended.map((event) => event.deliveryId),
        ['d-1', 'd-2']
      );
      const text = events
        .filter((event): event is Extract<SessionEvent, { kind: 'text' }> => event.kind === 'text')
        .map((event) => event.delta)
        .join('');
      assert.match(text, /这一轮正常结束/);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('送达确认：turn/completed 早于 turn/start 响应到达也能归属到本轮', async () => {
  const root = workdir();
  try {
    await withSession(makeRuntime(), spec(root), async (session, _pid, events) => {
      // 假 codex 在回 turn/start 之前就把 started / 文本 / completed 都推过来了。
      assert.ok((await session.prompt(keyedPrompt('early 的回复', 'd-early'))).ok);
      const ended = await waitFor(events, 'tagged ended', (event) => event.kind === 'ended');
      assert.ok(ended.kind === 'ended');
      assert.equal(ended.deliveryId, 'd-early');
      assert.equal(ended.outcome, 'done');
      assert.equal(endedEvents(events).length, 1);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('first output marker 只标记已绑定的精确首个文本，早到文本不延迟也不重复', async () => {
  const cases: { mode: string; prefix: string[]; marked: boolean; early?: boolean }[] = [
    { mode: 'normal', prefix: [], marked: true },
    { mode: 'wrong-thread', prefix: ['wrong-thread'], marked: true },
    { mode: 'stale', prefix: ['stale'], marked: true },
    { mode: 'malformed-item', prefix: ['malformed'], marked: false },
    { mode: 'malformed-thread', prefix: ['malformed'], marked: false },
    { mode: 'malformed-turn', prefix: ['malformed'], marked: false },
    { mode: 'empty-delta', prefix: [], marked: true },
    { mode: 'nontext-delta', prefix: [], marked: true },
    { mode: 'early-match', prefix: ['early'], marked: false, early: true },
    { mode: 'early-stale', prefix: ['stale'], marked: false, early: true },
    { mode: 'early-unknown', prefix: ['unknown'], marked: false, early: true },
    { mode: 'early-empty', prefix: [], marked: true },
    { mode: 'early-nontext', prefix: [], marked: true },
    { mode: 'early-conflict', prefix: ['stale', 'early'], marked: false, early: true },
    { mode: 'early-overflow', prefix: Array.from({ length: 9 }, (_, i) => String(i)), marked: false, early: true }
  ];
  for (const { mode, prefix, marked, early } of cases) {
    const root = workdir();
    try {
      await withSession(makeRuntime(), spec(root), async (session, _pid, events) => {
        let resolved = false;
        const prompting = session.prompt(keyedPrompt(`marker:${mode}`, `delivery-${mode}`)).then((result) => {
          resolved = true;
          return result;
        });
        if (early) {
          await waitFor(events, `${mode} early text`, (event) => event.kind === 'text');
          assert.equal(resolved, false, `${mode}: early text must arrive before the start response`);
        }
        assert.ok((await prompting).ok, mode);
        await waitFor(events, `${mode} after end`, (event) => event.kind === 'text' && event.delta === 'after-end');
        const texts = events.filter((event): event is Extract<SessionEvent, { kind: 'text' }> => event.kind === 'text');
        assert.deepEqual(texts.map((event) => event.delta), [...prefix, 'normal', 'second', 'after-end'], mode);
        assert.deepEqual(texts.filter((event) => event.firstOutputDeliveryId !== undefined).map((event) => [event.delta, event.firstOutputDeliveryId]),
          marked ? [['normal', `delivery-${mode}`]] : [], mode);
        assert.deepEqual(endedEvents(events).map((event) => event.deliveryId), [`delivery-${mode}`], mode);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('native lifecycle 仅接收当前 thread，缺失 thread 的旧无键结束仍兼容', async () => {
  for (const mode of ['native', 'missing-keyed', 'foreign-keyed', 'legacy', 'legacy-foreign']) {
    const root = workdir();
    try {
      await withSession(makeRuntime(), spec(root), async (session, _pid, events) => {
        const legacy = mode.startsWith('legacy');
        const input = legacy
          ? { text: `lifecycle:${mode}`, parts: [] }
          : keyedPrompt(`lifecycle:${mode}`, `delivery-${mode}`);
        assert.ok((await session.prompt(input)).ok);
        await waitFor(events, `${mode} ended`, (event) => event.kind === 'ended');
        assert.deepEqual(endedEvents(events).map((event) => [event.outcome, event.deliveryId]), [
          ['done', legacy ? undefined : `delivery-${mode}`]
        ]);
        const texts = events.filter((event): event is Extract<SessionEvent, { kind: 'text' }> => event.kind === 'text');
        assert.deepEqual(texts, [{ kind: 'text', delta: 'lifecycle text', ...(legacy ? {} : { firstOutputDeliveryId: `delivery-${mode}` }) }]);
        assert.deepEqual(events.filter((event) => event.kind === 'diagnostic'), legacy
          ? [{ kind: 'diagnostic', level: 'error', text: 'other thread' }]
          : []);
        if (mode === 'legacy-foreign') {
          assert.ok((await session.prompt({ text: 'marker:normal', parts: [] })).ok, 'legacy completion must release the prompt');
          await waitFor(events, 'second legacy end', () => endedEvents(events).length === 2);
          assert.deepEqual(endedEvents(events).map((event) => event.deliveryId), [undefined, undefined]);
        }
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('first output marker 不用于没有 deliveryId 或空 deliveryId 的 prompt', async () => {
  const root = workdir();
  try {
    await withSession(makeRuntime(), spec(root), async (session, _pid, events) => {
      for (const input of [{ text: 'marker:normal', parts: [] }, keyedPrompt('marker:normal', '')]) {
        const endCount = endedEvents(events).length;
        assert.ok((await session.prompt(input)).ok);
        await waitFor(events, 'after end', () => endedEvents(events).length > endCount);
      }
      assert.equal(events.some((event) => event.kind === 'text' && event.firstOutputDeliveryId !== undefined), false);
      assert.deepEqual(endedEvents(events).map((event) => event.deliveryId), [undefined, undefined]);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('送达确认：turn id 已确认后进程退出 → failed ended 仍带 deliveryId', async () => {
  const root = workdir();
  try {
    await withSession(makeRuntime(), spec(root), async (session, _pid, events) => {
      assert.ok((await session.prompt(keyedPrompt('die-mid 一下', 'd-die'))).ok);
      const ended = await waitFor(events, '进程退出后的 ended', (event) => event.kind === 'ended');
      assert.ok(ended.kind === 'ended');
      assert.equal(ended.outcome, 'failed');
      assert.equal(ended.deliveryId, 'd-die');
      assert.match(ended.reason ?? '', /codex 进程退出了/);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('送达确认：turn id 没确认进程就没了 → 不确认送达（ended 不带 deliveryId）', async () => {
  const root = workdir();
  try {
    await withSession(makeRuntime(), spec(root), async (session, _pid, events) => {
      // 假 codex 连 turn/start 响应都不回就退出：这一轮到底是不是 d-now 无法证明。
      const result = await session.prompt(keyedPrompt('die-now 一下', 'd-now'));
      assert.equal(result.ok, false);
      const ended = await waitFor(events, '进程退出后的 ended', (event) => event.kind === 'ended');
      assert.ok(ended.kind === 'ended');
      assert.equal(ended.deliveryId, undefined);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('无法解析的 stdout 记录 → 固定诊断，会话照常启动和收尾', async () => {
  const root = workdir();
  // 内联假 server：握手 / 开会话都正常，随后往 stdout 塞一行非 JSON。
  const script = [
    "const readline = require('node:readline');",
    "const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');",
    "const rl = readline.createInterface({ input: process.stdin });",
    "rl.on('line', (line) => {",
    "  let msg;",
    "  try { msg = JSON.parse(line); } catch { return; }",
    "  if (msg.id === undefined) return;",
    "  if (msg.method === 'initialize') { reply(msg.id, {}); return; }",
    "  if (msg.method === 'thread/start') {",
    "    reply(msg.id, { thread: { id: 'th_invalid' }, model: 'gpt-5.1-codex' });",
    "    process.stdout.write('this is not json\\n');",
    '  }',
    '});'
  ].join('\n');
  const runtime = createCodexRuntime({
    command: process.execPath,
    args: ['-e', script],
    models: MODELS,
    defaultModel: 'gpt-5.1-codex'
  });
  try {
    await withSession(runtime, spec(root), async (_session, _pid, events) => {
      const diagnostic = await waitFor(events, '无法解析记录的诊断', (event) => event.kind === 'diagnostic');
      assert.ok(diagnostic.kind === 'diagnostic');
      // 固定文案，不含任何对端原文。
      assert.equal(diagnostic.text, 'Codex 发来一条无法解析的记录，已忽略');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
