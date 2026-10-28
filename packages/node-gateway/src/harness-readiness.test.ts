import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentDto } from '@agent-hub/contract';
import {
  CAPABILITY_NAMES,
  asAgentId,
  available,
  capabilityMatrix,
  type AgentRuntime,
  type Capability,
  type CapabilityName,
  type HarnessProbe,
  type HarnessReadiness,
  type WorkerStatus
} from '@agent-hub/domain';
import { createHarnessRegistry, sameReadiness } from './harness-registry.ts';
import { createServerGateway } from './server-gateway.ts';
import { connectWorkerLink } from './worker-link.ts';

const READY: HarnessProbe = { readiness: { state: 'ready' }, models: [], defaultModel: '' };
const down = (reason: string): HarnessProbe => ({ readiness: { state: 'unavailable', reason }, models: [], defaultModel: '' });

function runtime(id: string): AgentRuntime {
  const all = Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, available])) as Record<CapabilityName, Capability>;
  return {
    descriptor: { id: asAgentId(id), label: id, capabilities: capabilityMatrix(all), models: [], defaultModel: '', options: [] },
    async start() {
      throw new Error('不该被调用');
    }
  };
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('注册表：每个探测各自兜底——抛错算「检测失败」，卡住算「检测超时」，其它照常', async () => {
  const registry = createHarnessRegistry(
    [
      { agentId: 'ok', probe: async () => READY },
      { agentId: 'boom', probe: async () => Promise.reject(new Error('secret-token-xyz')) },
      { agentId: 'hang', probe: () => new Promise<HarnessProbe>(() => undefined) }
    ],
    { timeoutMs: 50 }
  );
  const result = await registry.probeAll();
  assert.deepEqual(result.get('ok')?.readiness, { state: 'ready' });
  assert.deepEqual(result.get('boom')?.readiness, { state: 'unavailable', reason: '检测失败' });
  assert.deepEqual(result.get('hang')?.readiness, { state: 'unavailable', reason: '检测超时' });
  assert.equal(registry.latest(), result);
});

test('注册表：并发的探测合并成一次', async () => {
  let calls = 0;
  const registry = createHarnessRegistry([
    {
      agentId: 'x',
      probe: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return READY;
      }
    }
  ]);
  await Promise.all([registry.probeAll(), registry.probeAll(), registry.probeAll()]);
  assert.equal(calls, 1);
  await registry.probeAll();
  assert.equal(calls, 2);
});

test('sameReadiness 只比就绪状态与原因', () => {
  assert.ok(sameReadiness(new Map([['a', READY]]), new Map([['a', { ...READY, models: ['m'] }]])));
  assert.ok(!sameReadiness(new Map([['a', READY]]), new Map([['a', down('未登录')]])));
  assert.ok(!sameReadiness(new Map([['a', down('未登录')]]), new Map([['a', down('未安装')]])));
});

test('端到端：连上就探测并经 agents 帧上报；hub 的「重新检测」触发再探测；网关不认识具体 harness', async () => {
  const agentFrames: AgentDto[][] = [];
  const gateway = createServerGateway({
    token: null,
    onHello: () => {},
    onAgents: (_worker, agents) => void agentFrames.push(agents),
    onEvent: () => {},
    onAgentSession: () => {},
    onOptions: () => {},
    onStatus: () => {},
    onWorkerGone: () => {}
  });
  const server: Server = createServer();
  server.on('upgrade', (request, socket, head) => gateway.handleUpgrade(request, socket, head));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;

  let grokLoggedIn = false;
  let probes = 0;
  const grok: HarnessReadiness = {
    agentId: 'grok',
    probe: async () => {
      probes += 1;
      return grokLoggedIn ? READY : down('未登录');
    }
  };
  const link = connectWorkerLink({
    url,
    token: '',
    workerId: 'w1',
    label: 'omarchy',
    origin: 'remote',
    reconnect: false,
    runtimes: [runtime('pi'), runtime('grok')],
    readiness: createHarnessRegistry([{ agentId: 'pi', probe: async () => READY }, grok]),
    probeIntervalMs: 0
  });
  const worker = (): WorkerStatus | undefined => gateway.workers()[0];
  try {
    await until(() => agentFrames.length === 1);
    const reported = worker()?.agentModels ?? [];
    assert.deepEqual(reported.find((entry) => entry.agentId === 'pi')?.readiness, { state: 'ready' });
    assert.deepEqual(reported.find((entry) => entry.agentId === 'grok')?.readiness, { state: 'unavailable', reason: '未登录' });

    grokLoggedIn = true;
    assert.equal(gateway.requestProbe('w1'), true);
    await until(() => agentFrames.length === 2);
    assert.equal(probes, 2);
    assert.deepEqual(worker()?.agentModels?.find((entry) => entry.agentId === 'grok')?.readiness, { state: 'ready' });
    assert.equal(gateway.requestProbe('nope'), false);
  } finally {
    await link.close();
    gateway.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('老 Worker（不探测）不报 readiness：hub 一律当能用', async () => {
  const gateway = createServerGateway({
    token: null,
    onHello: () => {},
    onEvent: () => {},
    onAgentSession: () => {},
    onOptions: () => {},
    onStatus: () => {},
    onWorkerGone: () => {}
  });
  const server: Server = createServer();
  server.on('upgrade', (request, socket, head) => gateway.handleUpgrade(request, socket, head));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const link = connectWorkerLink({ url, token: '', workerId: 'old', label: 'old', reconnect: false, runtimes: [runtime('grok')] });
  try {
    await until(() => gateway.workers().length === 1);
    assert.equal(gateway.workers()[0]?.agentModels?.[0]?.readiness, undefined);
  } finally {
    await link.close();
    gateway.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});
