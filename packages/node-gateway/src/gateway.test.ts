import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AsyncQueue } from '@agent-hub/contract';
import type { AgentDto } from '@agent-hub/contract';
import {
  CAPABILITY_NAMES,
  available,
  asAgentId,
  asSessionId,
  asTaskId,
  capabilityMatrix,
  type AgentRuntime,
  type Capability,
  type CapabilityName,
  type RuntimeStatus,
  type SessionEvent,
  type StartSpec,
  type WorkerStatus
} from '@agent-hub/domain';
import { createServerGateway, type GatewayHooks } from './server-gateway.ts';
import { connectWorkerLink, type WorkerLink } from './worker-link.ts';

/** 一个只会把 prompt 回声成 text 再结束的 agent：够验证指令下行、事件上行。 */
function echoRuntime(seen: StartSpec[]): AgentRuntime {
  const all = Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, available])) as Record<CapabilityName, Capability>;
  return {
    descriptor: {
      id: asAgentId('echo'),
      label: 'Echo',
      capabilities: capabilityMatrix(all),
      models: [],
      defaultModel: '',
      options: []
    },
    async start(spec) {
      seen.push(spec);
      const queue = new AsyncQueue<SessionEvent>();
      return {
        ok: true,
        value: {
          sessionId: spec.sessionId,
          async prompt({ text }) {
            queue.push({ kind: 'text', delta: text });
            queue.push({ kind: 'ended', outcome: 'done' });
            return { ok: true, value: undefined };
          },
          async interrupt() {},
          events: () => queue,
          async adopt() {},
          options: () => [],
          async changeOption() {
            return { ok: true, value: [] };
          },
          async dispose() {
            queue.close();
          }
        }
      };
    }
  };
}

interface Recorder {
  hooks: GatewayHooks;
  hellos: { worker: WorkerStatus; agents: AgentDto[] }[];
  events: SessionEvent[];
  statuses: RuntimeStatus[];
  refs: string[];
  gone: string[];
  until(predicate: () => boolean): Promise<void>;
}

function recorder(token: string | null): Recorder {
  const r: Recorder = {
    hellos: [],
    events: [],
    statuses: [],
    refs: [],
    gone: [],
    hooks: {
      token,
      onHello: (worker, agents) => r.hellos.push({ worker, agents }),
      onEvent: (_id, event) => r.events.push(event),
      onAgentSession: (_id, ref) => r.refs.push(ref),
      onOptions: () => {},
      onStatus: (_id, status) => r.statuses.push(status),
      onWorkerGone: (id) => r.gone.push(id)
    },
    async until(predicate) {
      const deadline = Date.now() + 3000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error('等待超时');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  };
  return r;
}

async function harness(token: string | null) {
  const rec = recorder(token);
  const gateway = createServerGateway(rec.hooks);
  const server: Server = createServer();
  server.on('upgrade', (request, socket, head) => gateway.handleUpgrade(request, socket, head));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const stop = async (link?: WorkerLink) => {
    await link?.close();
    gateway.close();
    await new Promise((resolve) => server.close(resolve));
  };
  return { rec, gateway, url, stop };
}

test('握手：worker 带着 agent 清单与 origin 上线，断开时 server 收到 gone', async () => {
  const { rec, gateway, url, stop } = await harness('t0k');
  const link = connectWorkerLink({ url, token: 't0k', workerId: 'w1', label: '笔记本', origin: 'remote', runtimes: [echoRuntime([])] });
  await rec.until(() => rec.hellos.length === 1);
  assert.equal(rec.hellos[0]?.agents[0]?.id, 'echo');
  assert.deepEqual(await gateway.gateway.status(), [{ workerId: 'w1', label: '笔记本', origin: 'remote', state: 'online' }]);
  await link.close();
  await rec.until(() => rec.gone.length === 1);
  assert.deepEqual(gateway.workers(), []);
  await stop();
});

test('token 不对的 worker 被拒，不会出现在节点列表里', async () => {
  const { rec, gateway, url, stop } = await harness('right');
  let closed = false;
  const link = connectWorkerLink({ url, token: 'wrong', workerId: 'w1', label: 'x', runtimes: [], onClose: () => (closed = true) });
  await rec.until(() => closed);
  assert.equal(rec.hellos.length, 0);
  assert.deepEqual(gateway.workers(), []);
  await stop(link);
});

test('start + prompt 连发：worker 串行执行，事件与状态回到 server，模型只走 options', async () => {
  const { rec, gateway, url, stop } = await harness(null);
  const seen: StartSpec[] = [];
  const link = connectWorkerLink({ url, token: '', workerId: 'w1', label: 'x', runtimes: [echoRuntime(seen)] });
  await rec.until(() => rec.hellos.length === 1);

  const sessionId = asSessionId('s1');
  const started = await gateway.gateway.dispatch({
    kind: 'start_session',
    sessionId,
    taskId: asTaskId('t1'),
    agentId: 'echo',
    workspaceRoot: '/tmp',
    origin: { kind: 'derive' },
    resume: null,
    options: { model: 'm-1' }
  });
  assert.equal(started.ok, true);
  await gateway.gateway.dispatch({ kind: 'prompt', parts: [], sessionId, text: '你好' });

  await rec.until(() => rec.statuses.includes('ended'));
  assert.deepEqual(seen[0]?.options, { model: 'm-1' });
  assert.deepEqual(
    rec.events.map((event) => event.kind),
    ['text', 'ended']
  );
  assert.deepEqual(rec.statuses, ['running', 'ended']);

  link.notifyAgentSessionRef('s1', 'agent-ref-1');
  await rec.until(() => rec.refs.length === 1);
  assert.equal(rec.refs[0], 'agent-ref-1');
  await stop(link);
});

test('发给不存在的会话：worker 回 gone，让 server 下次重新拉起', async () => {
  const { rec, gateway, url, stop } = await harness(null);
  const link = connectWorkerLink({ url, token: '', workerId: 'w1', label: 'x', runtimes: [] });
  await rec.until(() => rec.hellos.length === 1);
  await gateway.gateway.dispatch({ kind: 'prompt', parts: [], sessionId: asSessionId('nope'), text: 'hi' });
  await rec.until(() => rec.statuses.includes('gone'));
  await stop(link);
});

test('没有在线 worker 时 dispatch 返回 unavailable 而不是抛错', async () => {
  const { gateway, stop } = await harness(null);
  const result = await gateway.gateway.dispatch({ kind: 'interrupt', sessionId: asSessionId('s') });
  assert.equal(result.ok, false);
  await stop();
});
