import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createServerGateway } from '@agent-hub/node-gateway';
import { openSqliteStore } from '@agent-hub/storage-sqlite';
import type { Deps, SessionId } from '@agent-hub/domain';
import {
  err,
  ingestAgentSessionRef,
  ingestRuntimeStatus,
  ingestWorkerEvent,
  frameAccepted,
  ingestWorkerOptions,
  reconcileInterrupted,
  unavailable,
  workerAttached,
  workerGone
} from '@agent-hub/domain';
import type { ServerGateway } from '@agent-hub/node-gateway';
import { createApp } from './http.ts';
import { createStreamHub } from './stream-hub.ts';
import { createLiveCatalog } from './agent-catalog.ts';
import { createLocalFs } from '@agent-hub/node-gateway';
import { createSessionQueue } from './session-queue.ts';
import { createMemoryHosting } from './session-hosting.ts';
import { createOptionWaiters } from './option-waiters.ts';
import { createRequestGuard } from './request-guard.ts';
import { createLogSender, createResendSender, createScryptHasher, createTokenIssuer } from '@agent-hub/adapter-accounts';
import type { AccountDeps } from '@agent-hub/domain';
import { hubTokenWindow, seedTestAccount } from './account-setup.ts';

const LOOPBACKS = new Set(['127.0.0.1', 'localhost', '::1']);

function readEnv(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value === '' ? null : value;
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const dataDir = readEnv('HUB_DATA_DIR') ?? join(homedir(), '.local', 'share', 'agent-hub');
const host = readEnv('HUB_HOST') ?? '127.0.0.1';
const port = Number(readEnv('HUB_PORT') ?? 7878);
const token = readEnv('HUB_TOKEN');
const webDist = join(repoRoot, 'apps', 'web', 'dist');
// 浏览器从哪些主机名访问：IP 字面量和 localhost 总是放行，用域名访问（如 MagicDNS）就配在这里，逗号分隔。
const guard = createRequestGuard([host, ...(readEnv('HUB_ALLOWED_HOSTS') ?? '').split(',')]);
// 只给自己拉起的本机 worker：它凭这个证明 origin: 'local' 不是自封的。每次启动换一个。
const localSecret = randomBytes(32).toString('hex');
const spawnWorker = readEnv('HUB_SPAWN_WORKER') ?? '1';

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
let serverGateway: ServerGateway | null = null;
const optionWaiters = createOptionWaiters();

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
      serverGateway ? serverGateway.gateway.dispatch(command) : err(unavailable('worker 通道尚未就绪')),
    listDirectories: async (workerId, path) =>
      serverGateway
        ? serverGateway.gateway.listDirectories(workerId, path)
        : err(unavailable('worker 通道尚未就绪')),
    listFiles: async (workerId, root, limit) =>
      serverGateway ? serverGateway.gateway.listFiles(workerId, root, limit) : err(unavailable('worker 通道尚未就绪')),
    readFile: async (workerId, path, maxBytes) =>
      serverGateway ? serverGateway.gateway.readFile(workerId, path, maxBytes) : err(unavailable('worker 通道尚未就绪'))
  },
  agents: catalog,
  fs: createLocalFs(),
  search: store.search,
  hosting: createMemoryHosting(),
  queue: createSessionQueue(),
  now: () => Date.now(),
};

const log = (message: string) => console.log(`[hub] ${message}`);

// 账号体系是独立的限界上下文：不塞进 Deps。
const resendKey = readEnv('RESEND_API_KEY');
const accounts: AccountDeps = {
  users: store.users,
  logins: store.logins,
  settings: store.settings,
  hasher: createScryptHasher(),
  tokens: createTokenIssuer(),
  mail: resendKey
    ? createResendSender({ apiKey: resendKey, from: readEnv('HUB_MAIL_FROM') ?? 'agent-hub <onboarding@resend.dev>' })
    : createLogSender(log),
  now: () => Date.now()
};
const testAccount = readEnv('HUB_TEST_ACCOUNT') ?? 'test@agent-hub.local';
if (testAccount !== 'off') {
  await seedTestAccount(
    accounts,
    {
      email: testAccount,
      passwordFile: readEnv('HUB_TEST_ACCOUNT_FILE') ?? join(homedir(), '.config', 'agent-hub', 'test-account')
    },
    log
  );
}
const hubToken = await hubTokenWindow(dataDir, token, Number(readEnv('HUB_TOKEN_SUNSET_DAYS') ?? 30), Date.now());
if (token !== null && hubToken === null) log('HUB_TOKEN 已过 30 天过渡期：不再能登录或调 API（worker 通道仍用它）');

/**
 * Worker 发来的会话帧先过领域的落点核对，再交给 ingest*。
 * 核对是异步的（要查库），串成一条链才能保证 ingest 的调用顺序和帧到达的顺序一致。
 */
let inbound: Promise<unknown> = Promise.resolve();
function fromWorker(workerId: string, sessionId: SessionId, ingest: () => void): void {
  inbound = inbound
    .then(async () => {
      if (await frameAccepted(deps, workerId, sessionId)) ingest();
      else log(`忽略 ${workerId} 发来的会话帧：会话 ${sessionId} 不在它身上`);
    })
    .catch((failure: unknown) => log(`处理 worker 帧失败：${(failure as Error).message}`));
}

serverGateway = createServerGateway({
  token,
  localSecret: spawnWorker === '1' ? localSecret : null,
  onHello(worker, agents, sessions) {
    catalog.upsert(worker.workerId, agents);
    log(`worker 上线：${worker.label}（${worker.workerId}），提供 ${agents.map((a) => a.label).join('、')}`);
    if (sessions.length > 0) {
      void workerAttached(deps, worker.workerId, sessions).then((ids) => {
        serverGateway?.adopt(worker.workerId, ids);
        log(`接回 ${ids.length} 个还在跑的会话`);
      });
    }
  },
  // 组合根只负责「把回调接到用例上、失败了打日志」，业务规则都在 domain 里。
  onEvent(workerId, sessionId, event) {
    fromWorker(workerId, sessionId, () =>
      void ingestWorkerEvent(deps, sessionId, event).then((result) => {
        if (!result.ok) log(`落盘事件失败：${result.error.message}`);
      })
    );
  },
  onOptions(workerId, sessionId, options) {
    fromWorker(workerId, sessionId, () =>
      void ingestWorkerOptions(deps, sessionId, options).then((result) => {
        if (!result.ok) log(`记录可调项失败：${result.error.message}`);
        optionWaiters.resolve(sessionId);
      })
    );
  },
  onAgentSession(workerId, sessionId, agentSessionRef) {
    fromWorker(workerId, sessionId, () => void ingestAgentSessionRef(deps, sessionId, agentSessionRef));
  },
  onStatus(workerId, sessionId, status) {
    fromWorker(workerId, sessionId, () => void ingestRuntimeStatus(deps, sessionId, status));
  },
  onWorkerGone(workerId, reason) {
    catalog.removeWorker(workerId);
    workerGone(deps, workerId);
    log(`worker 离线：${workerId}（${reason}）`);
  },
  onLog: log
});

const recovered = await reconcileInterrupted(deps);
if (recovered > 0) log(`${recovered} 个会话上次没跑完，已标记为「中断」`);

const app = createApp({ deps, hub, token, waitOptions: optionWaiters.wait, guard,
  auth: { accounts, hubToken },
  admin: {
    deps: {
      users: store.users,
      logins: store.logins,
      settings: store.settings,
      audit: store.audit,
      now: () => Date.now(),
      sessions: store.sessions,
      workers: {
        list: async () => serverGateway?.workers() ?? [],
        disconnect: async (workerId) => serverGateway?.disconnect(workerId) ?? false
      }
    }
  }
});

app.use('/*', serveStatic({ root: webDist }));
app.get('/*', serveStatic({ root: webDist, path: 'index.html' }));

const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  log(`控制台：http://${host}:${info.port}`);
});
// 端口被占是最常见的一种「起不来」，不该打一坨堆栈了事
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${port} 已被占用：先停掉上一个 agent-hub（或者换 HUB_PORT）`);
    process.exit(1);
  }
  throw error;
});
server.on('upgrade', (request, socket, head) => {
  // 只有 worker 通道走 WebSocket；浏览器发起的（带 Origin 的跨站请求）和重绑定来的一律不升级。
  const path = (request.url ?? '').split('?')[0];
  const hostHeader = request.headers.host;
  if (path !== '/worker' || !guard.hostAllowed(hostHeader) || !guard.originAllowed(request.headers.origin, hostHeader)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }
  serverGateway?.handleUpgrade(request, socket, head);
});

if (spawnWorker === '1') {
  // 绑 0.0.0.0 时本机 worker 仍该连回环地址：0.0.0.0 是「监听所有网卡」，不是可连的地址。
  const loopback = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const child = spawn(process.execPath, [join(repoRoot, 'apps', 'worker', 'src', 'main.ts')], {
    stdio: 'inherit',
    env: {
      ...process.env,
      HUB_URL: `ws://${loopback}:${port}/worker`,
      HUB_TOKEN: token ?? '',
      HUB_LOCAL_SECRET: localSecret,
      HUB_PARENT_PID: String(process.pid)
    }
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
