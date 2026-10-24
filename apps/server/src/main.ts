import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createServerGateway } from '@agent-hub/node-gateway';
import { openSqliteStore } from '@agent-hub/storage-sqlite';
import type {
  CapacityPolicy,
  Deps,
  NodeProvisioner,
  SessionEvent,
  SessionId
} from '@agent-hub/domain';
import {
  notImplemented,
  ok,
  reconcileInterrupted,
  recordEvent
} from '@agent-hub/domain';
import { err, unavailable } from '@agent-hub/domain';
import type { ServerGateway } from '@agent-hub/node-gateway';
import { createApp } from './http.ts';
import { createStreamHub } from './stream-hub.ts';
import { createLiveCatalog } from './agent-catalog.ts';
import { createLocalFs } from './local-fs.ts';
import { createSessionQueue } from './session-queue.ts';

const LOOPBACKS = new Set(['127.0.0.1', 'localhost', '::1']);

function readEnv(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value === '' ? null : value;
}

/** 空实现，但签名是真的：将来换调度器只换这个文件。 */
const capacity: CapacityPolicy = {
  async admit() {
    return ok(undefined);
  },
  async release() {
    return ok(undefined);
  }
};

const provisioner: NodeProvisioner = {
  install: async () => err(notImplemented('自动下发安装')),
  upgrade: async () => err(notImplemented('自动下发升级')),
  revoke: async () => err(notImplemented('撤销节点'))
};

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const dataDir = readEnv('HUB_DATA_DIR') ?? join(homedir(), '.local', 'share', 'agent-hub');
const host = readEnv('HUB_HOST') ?? '127.0.0.1';
const port = Number(readEnv('HUB_PORT') ?? 7878);
const token = readEnv('HUB_TOKEN');
const webDist = join(repoRoot, 'apps', 'web', 'dist');

if (!LOOPBACKS.has(host) && token === null) {
  console.error(
    `拒绝启动：绑定到 ${host} 却没设 HUB_TOKEN。\n` +
      '定位 §6 反故事 1 写的是「不管 key」，但那指的是不管模型的 key；\n' +
      '把自己的 agent 集群暴露在网络上而不设 token 是另一件事。\n' +
      '设一个 HUB_TOKEN 再启动。'
  );
  process.exit(1);
}

await mkdir(dataDir, { recursive: true });
console.log(`[hub] 数据目录：${dataDir}`);

const store = openSqliteStore(join(dataDir, 'hub.db'));
const hub = createStreamHub();
const catalog = createLiveCatalog();
const live = new Set<SessionId>();

let serverGateway: ServerGateway | null = null;
const events = createSessionQueue();

const deps: Deps = {
  projects: store.projects,
  tasks: store.tasks,
  sessions: store.sessions,
  artifacts: store.artifacts,
  layout: store.layout,
  stream: hub.stream,
  gateway: {
    status: async () => serverGateway?.workers() ?? [],
    dispatch: async (command) =>
      serverGateway ? serverGateway.gateway.dispatch(command) : err(unavailable('worker 通道尚未就绪'))
  },
  agents: catalog,
  fs: createLocalFs(),
  capacity,
  provisioner,
  search: store.search,
  now: () => Date.now(),
  newId: () => crypto.randomUUID()
};

const log = (message: string) => console.log(`[hub] ${message}`);

/** 字节数由 server 补：adapter 只知道路径，只有这里能 stat 到真实大小。 */
async function withBytes(event: SessionEvent, workspaceRoot: string): Promise<SessionEvent> {
  if (event.kind !== 'artifact') return event;
  const absolute = event.path.startsWith('/') ? event.path : join(workspaceRoot, event.path);
  const bytes = await deps.fs.stat(absolute);
  return bytes === null ? event : { ...event, bytes };
}

async function workspaceOf(sessionId: SessionId): Promise<string> {
  const session = await deps.sessions.byId(sessionId);
  const task = session ? await deps.tasks.byId(session.taskId) : null;
  const project = task ? await deps.projects.byId(task.projectId) : null;
  return project?.rootPath ?? process.cwd();
}

serverGateway = createServerGateway({
  token,
  onHello(worker, agents) {
    catalog.upsert(worker.workerId, agents);
    log(`worker 上线：${worker.label}（${worker.workerId}），提供 ${agents.map((a) => a.label).join('、')}`);
  },
  onEvent(sessionId, event) {
    // 同一会话的事件必须串行：recordEvent 是读改写，并发会算出同一个 seq 而被静默丢弃。
    void events.run(sessionId, async () => {
      const enriched = await withBytes(event, await workspaceOf(sessionId));
      const result = await recordEvent(deps, { sessionId, event: enriched });
      if (!result.ok) log(`落盘事件失败：${result.error.message}`);
    });
  },
  onAgentSession(sessionId, agentSessionRef) {
    void (async () => {
      const session = await deps.sessions.byId(sessionId);
      if (!session) return;
      await deps.sessions.save({ ...session, agentSessionRef, updatedAt: deps.now() });
    })();
  },
  onStatus(sessionId, status) {
    if (status === 'ended') live.delete(sessionId);
  },
  onWorkerGone(workerId) {
    catalog.removeWorker(workerId);
    live.clear();
    log(`worker 离线：${workerId}`);
  },
  onLog: log
});

const recovered = await reconcileInterrupted(deps);
if (recovered > 0) log(`${recovered} 个会话上次没跑完，已标记为「中断」`);

const app = createApp({
  deps,
  hub,
  workers: () => serverGateway?.workers() ?? [],
  live: {
    has: (sessionId) => live.has(sessionId),
    add: (sessionId) => void live.add(sessionId),
    drop: (sessionId) => void live.delete(sessionId)
  },
  token
});

app.use('/*', serveStatic({ root: webDist }));
app.get('/*', serveStatic({ root: webDist, path: 'index.html' }));

const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  log(`控制台：http://${host}:${info.port}`);
});
server.on('upgrade', (request, socket, head) => {
  serverGateway?.handleUpgrade(request, socket, head);
});

const spawnWorker = readEnv('HUB_SPAWN_WORKER') ?? '1';
if (spawnWorker === '1') {
  const child = spawn(process.execPath, [join(repoRoot, 'apps', 'worker', 'src', 'main.ts')], {
    stdio: 'inherit',
    env: { ...process.env, HUB_URL: `ws://${host}:${port}/worker`, HUB_TOKEN: token ?? '' }
  });
  child.on('exit', (code) => log(`本地 worker 退出（code ${code}）`));
  const shutdown = () => {
    child.kill('SIGTERM');
    serverGateway?.close();
    store.close();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
