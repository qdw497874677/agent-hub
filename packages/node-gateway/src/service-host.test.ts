import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServiceHost, ServiceHostError, type ServiceStateEvent } from './service-host.ts';

/** 每个用例一个临时 WORKER_ROOT：服务目录、services.json 都落在这里，跑完删掉。 */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'agent-hub-svc-'));
  const events: ServiceStateEvent[] = [];
  const logs: Array<{ serviceId: string; chunk: string }> = [];
  const host = createServiceHost({
    roots: [root],
    onState: (event) => events.push(event),
    onLog: (serviceId, chunk) => logs.push({ serviceId, chunk }),
    statePath: join(root, '.agent-hub', 'services.json'),
  });
  return {
    root,
    events,
    logs,
    host,
    latest: (serviceId: string) => events.filter((event) => event.serviceId === serviceId).at(-1) ?? null,
    cleanup: () => {
      host.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => (port === 0 ? reject(new Error('没拿到空闲端口')) : resolvePort(port)));
    });
  });
}

test('起停一条没有端口的服务：进程组起来就是 running，停掉是 stopped', async () => {
  const box = sandbox();
  try {
    const { pid } = await box.host.start({
      serviceId: 'svc_0000aaaa',
      root: box.root,
      command: 'sleep 5',
      port: null,
      env: {},
      restart: 'never',
    });
    assert.equal(typeof pid, 'number');
    assert.equal(box.latest('svc_0000aaaa')?.state, 'running');
    assert.equal(box.host.list()[0]?.pid, pid);

    const stopped = await box.host.stop('svc_0000aaaa');
    assert.equal(stopped.exited, true);
    assert.equal(box.latest('svc_0000aaaa')?.state, 'stopped');
    assert.equal(box.host.list()[0]?.pid, null);
  } finally {
    box.cleanup();
  }
});

test('目录跑出 WORKER_ROOTS 直接拒绝，不 spawn', async () => {
  const box = sandbox();
  try {
    await assert.rejects(
      box.host.start({ serviceId: 'svc_0000aaab', root: '/etc', command: 'sleep 1', port: null, env: {}, restart: 'never' }),
      (error: unknown) => error instanceof ServiceHostError && error.code === 'invalid',
    );
    assert.equal(box.host.list().length, 0);
  } finally {
    box.cleanup();
  }
});

test('声明了端口：30 秒内真的在听才算 running', async () => {
  const box = sandbox();
  try {
    const port = await freePort();
    await box.host.start({
      serviceId: 'svc_0000aaac',
      root: box.root,
      // 真在 127.0.0.1 上 listen，/proc/net/tcp 能扫到；不对公网发任何请求。
      command: `${process.execPath} -e 'require("net").createServer().listen(Number(process.env.SVC_PORT),"127.0.0.1")'`,
      port,
      env: { SVC_PORT: String(port) },
      restart: 'never',
    });
    const deadline = Date.now() + 10_000;
    while (box.latest('svc_0000aaac')?.state !== 'running' && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 100));
    }
    assert.equal(box.latest('svc_0000aaac')?.state, 'running');
    assert.equal(box.latest('svc_0000aaac')?.port, port);
    await box.host.stop('svc_0000aaac');
  } finally {
    box.cleanup();
  }
});

test('restart: always 退出后按退避重拉；第一次是 1 秒，detail 带退出码', async () => {
  const box = sandbox();
  try {
    await box.host.start({
      serviceId: 'svc_0000aaad',
      root: box.root,
      command: 'exit 3',
      port: null,
      env: {},
      restart: 'always',
    });
    const deadline = Date.now() + 10_000;
    while (box.latest('svc_0000aaad')?.state !== 'failed' && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 50));
    }
    const first = box.latest('svc_0000aaad');
    assert.equal(first?.state, 'failed');
    assert.match(first?.detail ?? '', /退出码 3/);
    assert.match(first?.detail ?? '', /1 秒后第 1 次重拉/);

    // 退避到点后真的又起了一次：状态回到 starting / running，事件数增加。
    const before = box.events.length;
    while (box.events.length <= before && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.ok(box.events.length > before, '没有按退避重拉');
    await box.host.stop('svc_0000aaad');
  } finally {
    box.cleanup();
  }
});
