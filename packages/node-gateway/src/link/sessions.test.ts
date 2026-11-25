import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncQueue } from '@agent-hub/contract';
import type { ServerToWorker, WorkerToServer } from '@agent-hub/contract';
import {
  CAPABILITY_NAMES,
  asAgentId,
  asSessionId,
  available,
  capabilityMatrix,
  type AgentRuntime,
  type Capability,
  type CapabilityName,
  type RuntimeSession,
  type SessionEvent
} from '@agent-hub/domain';
import { createLinkCtx } from './ctx.ts';
import { installSessions, type Sessions } from './sessions.ts';
import type { Transport } from './transport.ts';

type StartCommand = Extract<ServerToWorker, { kind: 'start_session' }>;
interface TaggedSession extends RuntimeSession {
  readonly tag: string;
}

const startCommand = (sessionId: string, workspaceRoot: string, extra: Partial<StartCommand> = {}): StartCommand => ({
  kind: 'start_session',
  sessionId: asSessionId(sessionId),
  taskId: null,
  agentId: 'echo',
  workspaceRoot,
  origin: { kind: 'derive' },
  resume: null,
  options: {},
  ...extra
});

function descriptor(): AgentRuntime['descriptor'] {
  const all = Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, available])) as Record<CapabilityName, Capability>;
  return {
    id: asAgentId('echo'),
    label: 'Echo',
    capabilities: capabilityMatrix(all),
    models: [],
    defaultModel: '',
    options: []
  };
}

function fakeSession(sessionId: string, tag: string, log: string[]): TaggedSession {
  const queue = new AsyncQueue<SessionEvent>();
  return {
    sessionId: asSessionId(sessionId),
    tag,
    async prompt() {
      return { ok: true, value: undefined };
    },
    async interrupt() {
      log.push(`interrupt:${tag}`);
    },
    events: () => queue,
    async adopt() {},
    options: () => [],
    async changeOption() {
      return { ok: true, value: [] };
    },
    async dispose() {
      log.push(`dispose:${tag}`);
      queue.close();
    }
  };
}

function setup(runtime: AgentRuntime): { ctx: ReturnType<typeof createLinkCtx>; sessions: Sessions; frames: WorkerToServer[] } {
  const ctx = createLinkCtx({
    url: 'ws://127.0.0.1:9/worker',
    token: 't',
    workerId: 'w1',
    label: 'test',
    runtimes: [runtime],
    // 测试里不要空闲回收 / 保活上限：只观察 start 的串行关系。
    sessionIdleMs: 0,
    keepAliveMax: 0
  });
  const channel = {
    request: async () => ({ ok: false as const, error: { code: 'closed', message: '测试没有 hub' } }),
    handle: () => undefined
  };
  const frames: WorkerToServer[] = [];
  const transport = {
    channel: channel as unknown as Transport['channel'],
    send: (frame: WorkerToServer) => frames.push(frame),
    sendOnOrigin: (_command: ServerToWorker, frame: WorkerToServer) => {
      if (frame.type === 'branch_attempt_result' && frame.outcome !== 'both_failed') assert.equal(ctx.sessions.has(frame.sessionId), true);
      frames.push(frame);
    }
  } as unknown as Transport;
  return { ctx, sessions: installSessions(ctx, transport), frames };
}

test('attested branch installs exact session before result; unknown never falls back', async () => {
  const log: string[] = [];
  let fallbackCalls = 0;
  const runtime: AgentRuntime = {
    descriptor: descriptor(),
    async start() { fallbackCalls++; throw new Error('unexpected fallback'); },
    async startBranchAttempt(spec) {
      if (spec.sessionId === 'unknown') return { state: 'unknown' };
      if (spec.sessionId === 'failed') return { state: 'both_failed' };
      if (spec.sessionId === 'invalid') return { state: 'started', outcome: 'plain', session: fakeSession(spec.sessionId, 'invalid', log), agentSessionRef: 'pending' };
      return { state: 'started', outcome: 'native', session: fakeSession(spec.sessionId, 'exact', log), agentSessionRef: 'ref' };
    }
  };
  const { ctx, sessions, frames } = setup(runtime);
  const keyed = (id: string) => startCommand(id, '/tmp', { branch: { fromAgentSessionRef: 'parent', turnRef: null, previousTurnRef: null }, branchAttemptId: `attempt-${id}` });
  await sessions.run(keyed('unknown'));
  assert.equal(ctx.sessions.has('unknown'), false);
  assert.equal(frames.some((f) => f.type === 'branch_attempt_result' || f.type === 'branch_result'), false);
  await sessions.run(keyed('invalid'));
  assert.equal(ctx.sessions.has('invalid'), false);
  assert.equal(log.includes('dispose:invalid'), true);
  assert.equal(frames.some((f) => f.type === 'branch_attempt_result' || f.type === 'branch_result'), false);
  await sessions.run(keyed('failed'));
  assert.deepEqual(frames.filter((f) => f.type === 'branch_attempt_result'), [{ type: 'branch_attempt_result', sessionId: 'failed', attemptId: 'attempt-failed', outcome: 'both_failed' }]);
  await sessions.run(keyed('success'));
  assert.equal((ctx.sessions.get('success') as TaggedSession).tag, 'exact');
  assert.deepEqual(frames.filter((f) => f.type === 'branch_attempt_result').at(-1), { type: 'branch_attempt_result', sessionId: 'success', attemptId: 'attempt-success', outcome: 'native', agentSessionRef: 'ref' });
  assert.equal(frames.some((f) => f.type === 'branch_result'), false);
  assert.equal(fallbackCalls, 0);
  await sessions.closeAll();
});

test('attested native and plain sessions cannot reuse the source reference', async () => {
  const log: string[] = [];
  let fallbackCalls = 0;
  const runtime: AgentRuntime = {
    descriptor: descriptor(),
    async start() { fallbackCalls++; throw new Error('unexpected fallback'); },
    async startBranchAttempt(spec) {
      const outcome = spec.sessionId === 'native' ? 'native' as const : 'plain' as const;
      return { state: 'started', outcome, session: fakeSession(spec.sessionId, outcome, log), agentSessionRef: 'parent' };
    }
  };
  const { ctx, sessions, frames } = setup(runtime);
  for (const outcome of ['native', 'plain']) {
    await sessions.run(startCommand(outcome, '/tmp', { branch: { fromAgentSessionRef: 'parent', turnRef: null, previousTurnRef: null }, branchAttemptId: `attempt-${outcome}` }));
    assert.equal(ctx.sessions.has(outcome), false);
    assert.equal(log.includes(`dispose:${outcome}`), true);
  }
  assert.equal(frames.some((frame) => frame.type === 'branch_attempt_result' || frame.type === 'branch_result'), false);
  assert.equal(fallbackCalls, 0);
  await sessions.closeAll();
});

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('同一会话的 start 串行：B 不能抢在被阻塞的 A 前面安装，A 落地后 B 先 dispose 再替换', async () => {
  const log: string[] = [];
  let releaseA!: () => void;
  const gateA = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  let releaseB!: () => void;
  const gateB = new Promise<void>((resolve) => {
    releaseB = resolve;
  });
  let s1Starts = 0;

  const runtime: AgentRuntime = {
    descriptor: descriptor(),
    async start(spec) {
      const sessionId = String(spec.sessionId);
      if (sessionId !== 's1') {
        log.push(`start:${sessionId}`);
        return { ok: true, value: fakeSession(sessionId, sessionId, log) };
      }
      s1Starts += 1;
      const tag = s1Starts === 1 ? 'A' : 'B';
      log.push(`start:${tag}`);
      await (tag === 'A' ? gateA : gateB);
      return { ok: true, value: fakeSession('s1', tag, log) };
    }
  };

  const { ctx, sessions } = setup(runtime);
  const a = sessions.run(startCommand('s1', '/tmp/a'));
  await until(() => log.includes('start:A'));

  // B 同一会话、换工作目录（复用不了 → 必须 dispose A 再拉起）。
  const b = sessions.run(startCommand('s1', '/tmp/b'));
  // 普通指令（interrupt）也要等「最近提交」的那次 start（B），不能被 A 的完成提前放行。
  let interruptDone = false;
  const interrupt = sessions.run({ kind: 'interrupt', sessionId: asSessionId('s1') }).then(() => {
    interruptDone = true;
  });
  await flush();
  assert.deepEqual(log, ['start:A'], 'A 还被阻塞时，B 与普通指令都不能越过它');
  assert.equal(interruptDone, false);

  releaseA();
  await a;
  await until(() => log.includes('start:B'));
  // dispose:A 只能来自 B 的替换路径：说明 A 先装进了 sessions，B 再按「先 dispose 后 replace」走。
  assert.deepEqual(log, ['start:A', 'dispose:A', 'start:B'], 'B 拉起前必须先收掉 A');
  // A 的 finally 已经跑过：它不能把 B 登记的等待点删掉（identity-safe）。
  assert.ok(ctx.starting.has('s1'), 'A 结束时不能清掉 B 的 starting 链尾');
  assert.equal(interruptDone, false, '普通指令要等最近提交的 B 落地');

  releaseB();
  await b;
  await interrupt;
  assert.equal((ctx.sessions.get('s1') as TaggedSession | undefined)?.tag, 'B', '最终生效的是后提交的 B');
  assert.deepEqual(log, ['start:A', 'dispose:A', 'start:B', 'interrupt:B'], 'interrupt 作用在 B 的进程上');
  assert.equal(ctx.starting.has('s1'), false, 'B 完成后自己的链尾要清掉');
  await sessions.closeAll();
});

test('不同会话的 start 保持并行：一条被阻塞不影响另一条', async () => {
  const log: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const runtime: AgentRuntime = {
    descriptor: descriptor(),
    async start(spec) {
      const sessionId = String(spec.sessionId);
      log.push(`start:${sessionId}`);
      if (sessionId === 's1') await gate;
      return { ok: true, value: fakeSession(sessionId, sessionId, log) };
    }
  };

  const { ctx, sessions } = setup(runtime);
  const a = sessions.run(startCommand('s1', '/tmp/a'));
  await until(() => log.includes('start:s1'));

  const b = sessions.run(startCommand('s2', '/tmp/b'));
  await b;
  assert.equal((ctx.sessions.get('s2') as TaggedSession | undefined)?.tag, 's2', 's2 不等 s1');
  assert.equal(ctx.sessions.has('s1'), false);

  release();
  await a;
  assert.equal((ctx.sessions.get('s1') as TaggedSession | undefined)?.tag, 's1');
  await sessions.closeAll();
});

/** 一次 start 带的工具授权 + MCP 接线（token 是 hub 签的 bearer）。 */
const grants = (token: string): Partial<StartCommand> => ({
  tools: { transport: 'relay', url: '', token },
  mcp: [{ transport: 'http', name: 'gitea', url: '' }]
});

function countingRuntime(log: string[]): { runtime: AgentRuntime; starts: () => number } {
  let starts = 0;
  return {
    starts: () => starts,
    runtime: {
      descriptor: descriptor(),
      async start(spec) {
        starts += 1;
        const tag = `r${starts}`;
        log.push(`start:${tag}`);
        return { ok: true, value: fakeSession(String(spec.sessionId), tag, log) };
      }
    }
  };
}

test('工具授权 / MCP 接线不变：同一会话直接复用进程', async () => {
  const log: string[] = [];
  const counted = countingRuntime(log);
  const { ctx, sessions } = setup(counted.runtime);
  const command = startCommand('s1', '/tmp/a', grants('bearer-a'));

  await sessions.run(command);
  await sessions.run(command);

  assert.equal(counted.starts(), 1, '接线一致时不能重建运行时');
  assert.deepEqual(log, ['start:r1'], '复用不 dispose 旧进程');
  assert.equal((ctx.sessions.get('s1') as TaggedSession | undefined)?.tag, 'r1');
  assert.equal(
    JSON.stringify(log).includes('bearer-a'),
    false,
    '指纹只存摘要，不下发 / 不记录原始令牌'
  );
  await sessions.closeAll();
  await sessions.mcpEndpoint.close();
});

test('新工具令牌：重建运行时，旧进程不能被复用', async () => {
  const log: string[] = [];
  const counted = countingRuntime(log);
  const { ctx, sessions } = setup(counted.runtime);

  await sessions.run(startCommand('s1', '/tmp/a', grants('bearer-old')));
  // hub 撤销旧 bearer 后用新令牌重新托管：ACP 里还留着旧 URL / 旧令牌，必须换进程。
  await sessions.run(startCommand('s1', '/tmp/a', grants('bearer-new')));

  assert.equal(counted.starts(), 2, '换了 bearer 必须重新拉起运行时');
  assert.deepEqual(log, ['start:r1', 'dispose:r1', 'start:r2']);
  assert.equal((ctx.sessions.get('s1') as TaggedSession | undefined)?.tag, 'r2');

  // 再拿已经撤销的旧令牌 start：同样不能复用，也不能复用更早的进程。
  await sessions.run(startCommand('s1', '/tmp/a', grants('bearer-old')));
  assert.equal(counted.starts(), 3);
  assert.deepEqual(log, ['start:r1', 'dispose:r1', 'start:r2', 'dispose:r2', 'start:r3']);
  await sessions.closeAll();
  await sessions.mcpEndpoint.close();
});

test('工具授权被移除：接线从有到无也要重建运行时', async () => {
  const log: string[] = [];
  const counted = countingRuntime(log);
  const { ctx, sessions } = setup(counted.runtime);

  await sessions.run(startCommand('s1', '/tmp/a', grants('bearer-a')));
  await sessions.run(startCommand('s1', '/tmp/a'));

  assert.equal(counted.starts(), 2, '撤销所有工具 / MCP 后旧进程不能继续跑');
  assert.deepEqual(log, ['start:r1', 'dispose:r1', 'start:r2']);
  assert.equal((ctx.sessions.get('s1') as TaggedSession | undefined)?.tag, 'r2');
  await sessions.closeAll();
  await sessions.mcpEndpoint.close();
});
