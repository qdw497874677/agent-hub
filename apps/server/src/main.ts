import { STALL_NOTICE_MARKER } from '@agent-hub/contract';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createServerGateway } from '@agent-hub/node-gateway';
import { createRemoteClients, serveMcpRelay } from './mcp-relay.ts';
import { serveAssetFetch } from './asset-relay.ts';
import { createAssetReader } from '@agent-hub/adapter-assets';
import { createWorkerEnroll } from './worker-enroll.ts';
import { createSecretVault, loadSecretKey, openSqliteStore } from '@agent-hub/storage-sqlite';
import type { AssetDeps, Deps, EnrollmentDeps, ProjectId, SessionId, ToolGateway, WorkerCommand } from '@agent-hub/domain';
import { authenticateWorker, createTaskToolProvider, createToolGateway, withToolAccess,
  sweepTemporaryWorkspacesUseCase,
  adoptLocalWorkspacesUseCase
} from '@agent-hub/domain';
import {
  err,
  ingestAgentSessionRef,
  ingestRuntimeStatus,
  ingestWorkerEvent,
  flagStalledSessions,
  frameAccepted,
  ingestWorkerOptions,
  reconcileInterrupted,
  syncWorkerAssets,
  sessionMcpLaunch,
  remoteMcpTarget,
  sessionAssetPlan,
  withAssetNeeds,
  unavailable,
  workerAttached,
  workerGone
} from '@agent-hub/domain';
import type { ServerGateway } from '@agent-hub/node-gateway';
import { createApp } from './http.ts';
import { createStreamHub } from './stream-hub.ts';
import { createLiveCatalog } from './agent-catalog.ts';
import { createGitWorkspace, createLocalFs, readBuildInfo } from '@agent-hub/node-gateway';
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

let toolGateway: ToolGateway | null = null;
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
/** hub 自己的版本：机器列表里「过期」的参照，也是远程更新的目标。 */
const hubBuild = readBuildInfo(repoRoot);
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
  workLog: store.workLog,
  sessions: store.sessions,
  workspaces: store.workspaces,
  artifacts: store.artifacts,
  layout: store.layout,
  stream: hub.stream,
  gateway: {
    status: async () => withAssetNeeds(serverGateway?.workers() ?? [], await mcpWorkers()),
    probe: async (workerId) => serverGateway?.gateway.probe?.(workerId) ?? false,
    // 发给 worker 前给 start_session 配上工具令牌（换新、旧的作废），dispose 时作废。
    dispatch: async (command) =>
      serverGateway
        ? serverGateway.gateway.dispatch(await withSessionAssets(toolGateway ? await withToolAccess(toolGateway, toolEndpoint, command) : command))
        : err(unavailable('worker 通道尚未就绪')),
    listDirectories: async (workerId, path) =>
      serverGateway
        ? serverGateway.gateway.listDirectories(workerId, path)
        : err(unavailable('worker 通道尚未就绪')),
    makeDirectory: async (workerId, parent, name) =>
      serverGateway ? serverGateway.gateway.makeDirectory(workerId, parent, name) : err(unavailable('worker 通道尚未就绪')),
    listFiles: async (workerId, root, limit) =>
      serverGateway ? serverGateway.gateway.listFiles(workerId, root, limit) : err(unavailable('worker 通道尚未就绪')),
    readFile: async (workerId, path, maxBytes) =>
      serverGateway ? serverGateway.gateway.readFile(workerId, path, maxBytes) : err(unavailable('worker 通道尚未就绪')),
    git: (workerId) => (serverGateway ? serverGateway.gateway.git(workerId) : createGitWorkspace(async () => 'worker 通道尚未就绪'))
  },
  agents: catalog,
  fs: createLocalFs(),
  git: createGitWorkspace(),
  search: store.search,
  hosting: createMemoryHosting(),
  queue: createSessionQueue(),
  now: () => Date.now(),
};

const log = (message: string) => console.log(`[hub] ${message}`);

// 能力层：agent 经 MCP 回调 hub 的工具。HUB_TOOLS=0 关掉。
// 唯一的传输是 relay：agent 连 worker 本机的入口，经 /worker 长连接到 hub，hub 不开 HTTP /mcp。
const toolEndpoint = readEnv('HUB_TOOLS') === '0' ? null : { url: '', transport: 'relay' as const };
if (readEnv('HUB_TOOLS_TRANSPORT') === 'http') log('HUB_TOOLS_TRANSPORT=http 已移除，忽略：工具一律经 worker 长连接中转');
toolGateway = createToolGateway({
  now: deps.now,
  toolGrants: store.toolGrants,
  tokens: createTokenIssuer(),
  providers: [createTaskToolProvider(deps)]
});

// 启动时清掉陈旧授权：只有库里还是「运行中」的会话可能被重连的 worker 接回来，其余一律作废。
{
  const running = (await store.sessions.listAll()).filter((session) => session.status === 'running').map((session) => session.id);
  const revoked = await toolGateway.revokeAllExcept(running);
  if (revoked > 0) log(`作废了 ${revoked} 条陈旧的工具授权`);
}

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
      passwordFile: readEnv('HUB_TEST_ACCOUNT_FILE') ?? join(homedir(), '.config', 'agent-hub', 'test-account'),
      password: readEnv('HUB_TEST_ACCOUNT_PASSWORD') ?? undefined
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

/** 装了 MCP 资产的机器：这些机器上缺 MCP 适配器的 harness（Pi）判为不可用。 */
async function mcpWorkers(): Promise<Set<string>> {
  const rows = await store.assets.installations();
  const kinds = new Map<string, string>();
  const out = new Set<string>();
  for (const { workerId, assetId } of rows) {
    if (!kinds.has(assetId)) kinds.set(assetId, (await store.assets.get(assetId))?.kind ?? '');
    if (kinds.get(assetId) === 'mcp') out.add(workerId);
  }
  return out;
}

// 单台机器接入：接入码换专属凭据，hello 时按凭据认机器（docs/design/worker-enrollment.md）。
const workerControl = {
  list: async () => withAssetNeeds(serverGateway?.workers() ?? [], await mcpWorkers()),
  disconnect: async (workerId: string, why?: 'admin' | 'revoked') => serverGateway?.disconnect(workerId, why) ?? false,
  hubBuild: () => hubBuild,
  update: async (workerId: string, commit: string) => serverGateway?.requestUpdate(workerId, commit) ?? false
};
const enrollmentDeps: EnrollmentDeps = {
  enrollment: store.enrollment,
  tokens: createTokenIssuer(),
  settings: store.settings,
  users: store.users,
  audit: store.audit,
  workers: workerControl,
  now: () => Date.now()
};

// 资产中心（docs/design/asset-hub.md）：技能 / 指令按 Worker 安装，经长连接下发。同步状态落库，hub 重启后照样显示；Worker 每次上线都会再同步。
const assetDeps: AssetDeps = {
  assets: store.assets,
  reader: createAssetReader(),
  delivery: { push: async (workerId, manifest) => (serverGateway ? serverGateway.assets.push(workerId, manifest) : err(unavailable('worker 通道尚未就绪'))) },
  board: store.assetSync,
  workers: workerControl,
  projects: { byId: (id) => store.projects.byId(id as ProjectId) },
  secrets: createSecretVault(store.db, await loadSecretKey({ env: readEnv('HUB_SECRET_KEY') ?? undefined, file: join(dataDir, 'secret.key') })),
  now: () => Date.now()
};
const remoteMcpClients = createRemoteClients();

/**
 * 有工具令牌的 start_session 才带 MCP 资产（远端那些要凭令牌走中转）。stdio 的密钥此刻才展开，
 * 随这条指令直接发给 Worker，不落库、不进日志；缺密钥的只记名字。
 */
async function withSessionAssets(command: WorkerCommand): Promise<WorkerCommand> {
  if (command.kind !== 'start_session') return command;
  try {
    // 项目作用域（就近优先 + 项目开关）∩ 这台机器装了的；找不到任务就只给全局的。
    const task = await store.tasks.byId(command.taskId);
    const plan = await sessionAssetPlan(assetDeps, command.workerId, task?.projectId ?? null);
    let next: WorkerCommand = { ...command, assetIds: plan.assetIds };
    if (command.tools) {
      const { launch, skipped } = await sessionMcpLaunch(assetDeps, command.workerId, new Set(plan.assetIds));
      for (const item of skipped) log(`MCP「${item.name}」这次没给会话 ${command.sessionId}：${item.reason}`);
      if (launch.length > 0) next = { ...next, mcp: launch };
    }
    return next;
  } catch (failure) {
    log(`会话资产展开失败：${(failure as Error).message}`);
    return command;
  }
}
const syncAssets = (workerId: string) =>
  void syncWorkerAssets(assetDeps, workerId)
    .then((status) => {
      if (status.state === 'failed') log(`资产同步失败（${workerId}）：${status.error}`);
    })
    .catch((failure: unknown) => log(`资产同步失败（${workerId}）：${(failure as Error).message}`));

serverGateway = createServerGateway({
  token,
  authenticate: (hello) => authenticateWorker(enrollmentDeps, hello),
  localSecret: spawnWorker === '1' ? localSecret : null,
  onAgents(worker, agents) {
    // 重新探测的结果：只换清单，不重跑上线流程（同步资产、接回会话）。
    catalog.upsert(worker.workerId, agents);
  },
  onHello(worker, agents, sessions) {
    catalog.upsert(worker.workerId, agents);
    syncAssets(worker.workerId);
    log(`worker 上线：${worker.label}（${worker.workerId}），提供 ${agents.map((a) => a.label).join('、')}`);
    void adoptLocalWorkspacesUseCase(deps, worker)
      .then((count) => {
        if (count > 0) log(`${count} 个本机工作空间改记为 Worker ${worker.workerId}`);
      })
      .catch((failure: unknown) => log(`迁移本机工作空间失败：${(failure as Error).message}`));
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
    fromWorker(workerId, sessionId, () => {
      void ingestRuntimeStatus(deps, sessionId, status);
      // 会话跑完 / 进程没了：它的工具令牌立刻作废（再说话会重新托管、换新令牌）
      if (status !== 'running' && toolGateway) void toolGateway.revoke({ id: sessionId }).catch(() => undefined);
    });
  },
  onWorkerGone(workerId, reason) {
    catalog.removeWorker(workerId);
    workerGone(deps, workerId);
    log(`worker 离线：${workerId}（${reason}）`);
  },
  // 每条认证过的长连接：挂上 MCP 中转（RPC 端口 → MCP 服务端 → ToolGateway），绑定这台 Worker。
  serve(workerId, channel) {
    serveAssetFetch(channel, workerId, assetDeps);
    if (!toolGateway) return;
    serveMcpRelay(channel, workerId, {
      gateway: toolGateway,
      hostOf: (sessionId) => serverGateway?.hostOf(sessionId) ?? null,
      remote: (worker, server) => remoteMcpTarget(assetDeps, worker, server),
      remoteClients: remoteMcpClients
    });
  },
  enroll: createWorkerEnroll(enrollmentDeps, { rateMax: Number(readEnv('HUB_ENROLL_RATE_MAX') ?? 10) }),
  onUpdateStatus(workerId, update) {
    log(`worker ${workerId} 更新：${update.state} ${update.message}`);
  },
  onLog: log
});

const recovered = await reconcileInterrupted(deps);
if (recovered > 0) log(`${recovered} 个会话上次没跑完，已标记为「中断」`);

// 卡顿巡检：一轮跑着却长时间没新事件，记一条 warn 诊断（卡片上显示提醒，可一键中断）并写日志。
const stallMs = Number(readEnv('HUB_STALL_MS') ?? 5 * 60_000);
if (stallMs > 0) {
  const timer = setInterval(() => {
    flagStalledSessions(deps, { idleMs: stallMs, marker: STALL_NOTICE_MARKER })
      .then((ids) => {
        for (const id of ids) log(`会话 ${id} 已 ${Math.round(stallMs / 60_000)} 分钟以上没有新输出，可能卡住了`);
      })
      .catch((failure: unknown) => log(`卡顿巡检失败：${(failure as Error).message}`));
  }, Math.min(30_000, stallMs));
  timer.unref();
}

// 临时工作空间清理（workspaces.md §5）：启动后一会儿（等 Worker 连上）跑一次，之后每小时一次
const sweep = (why: string) =>
  sweepTemporaryWorkspacesUseCase(deps)
    .then((report) => {
      if (report.removed.length + report.kept.length > 0) {
        log(`临时工作空间清理（${why}）：删了 ${report.removed.length} 个，保留 ${report.kept.length} 个（有未保存的改动）`);
      }
    })
    .catch((failure: unknown) => log(`临时工作空间清理失败：${(failure as Error).message}`));
setTimeout(() => void sweep('启动'), 60_000).unref();
setInterval(() => void sweep('每小时'), 60 * 60_000).unref();

const app = createApp({ deps, hub, token, waitOptions: optionWaiters.wait, guard, 
  auth: { accounts, hubToken, loginRateMax: Number(readEnv('HUB_LOGIN_RATE_MAX') ?? 10) },
  admin: {
    deps: {
      users: store.users,
      logins: store.logins,
      settings: store.settings,
      audit: store.audit,
      now: () => Date.now(),
      sessions: store.sessions,
      workers: workerControl
    },
    enrollment: enrollmentDeps
  },
  assets: { deps: assetDeps, audit: store.audit },
  projectDeletion: { toolGrants: store.toolGrants, audit: store.audit },
  enrollment: {
    deps: enrollmentDeps,
    bootstrapScript: join(repoRoot, 'scripts', 'bootstrap-worker.sh'),
    commit: hubBuild.commit
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
  /**
   * 本机 Worker 意外退出（崩溃、或更新后以 75 退出要求重启）时由 hub 重新拉起；
   * 一分钟内退出超过 5 次就不再拉，免得刷屏。hub 自己关停时不拉。
   */
  let stopping = false;
  const exits: number[] = [];
  const startLocalWorker = (): ChildProcess => {
    const next = spawn(process.execPath, [join(repoRoot, 'apps', 'worker', 'src', 'main.ts')], {
      stdio: 'inherit',
      env: {
        ...process.env,
        HUB_URL: `ws://${loopback}:${port}/worker`,
        HUB_TOKEN: token ?? '',
        HUB_LOCAL_SECRET: localSecret,
        HUB_PARENT_PID: String(process.pid)
      }
    });
    next.on('exit', (code) => {
      log(`本地 worker 退出（code ${code}）`);
      if (stopping) return;
      const at = Date.now();
      exits.push(at);
      while (exits.length > 0 && at - (exits[0] ?? at) > 60_000) exits.shift();
      if (exits.length > 5) {
        log('本地 worker 一分钟内退出太多次，不再自动拉起');
        return;
      }
      setTimeout(() => {
        if (!stopping) child = startLocalWorker();
      }, 2_000).unref();
    });
    return next;
  };
  let child = startLocalWorker();
  const shutdown = () => {
    stopping = true;
    child.kill('SIGTERM');
    serverGateway?.close();
    store.close();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
