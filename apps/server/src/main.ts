import { backupArgs, runBackup } from './backup.ts';
import { createInstallArtifacts } from './install-artifacts.ts';
import { STALL_NOTICE_MARKER } from '@agent-hub/contract';
import { spawn, type ChildProcess } from 'node:child_process';
import { createTimerSource } from '@agent-hub/connector-timer';
import { createGithubClient, createGithubSink, createGithubSource, createGithubToolProvider, githubParams, parseIssueKey } from '@agent-hub/connector-github';
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
import { createMemorySources } from './memory-sources.ts';
import { createAssetReader } from '@agent-hub/adapter-assets';
import { createWorkerEnroll } from './worker-enroll.ts';
import { loadActor, openRoleSession } from './role-session.ts';
import { createSecretVault, createSqliteApiTokens, createSqliteComponents, createSqliteProviders, createSqlitePullRequests, createSqliteGitHostTokens, createSqliteWorkspaceSweeps, loadSecretKey, openSqliteStore } from '@agent-hub/storage-sqlite';
import { createNpmResolver } from './components.ts';
import { createProviderWiring } from './providers.ts';
import { createGitTextWriter } from './git-text-writer.ts';
import { createGitHubApi } from './github-api.ts';
import { createModelDistiller } from './model-distiller.ts';
import type { AssetReviewDeps, Deps, EnrollmentDeps, ProjectId, RuntimeJob, SessionId, TaskId, ToolGateway, UserId, WorkerCommand, WorkerMetrics } from '@agent-hub/domain';
import { authenticateWorker, createTaskToolProvider, createToolGateway, withToolAccess,
  createMessageBus,
  interruptSessionUseCase,
  createGroupChat,
  createPersistentAgents,
  createSessionLane,
  createContextService,
  createWorkspaceFilesService,
  createGitWorkflowService,
  createRewindService,
  recordProvenance,
  createMessageToolProvider,
  createMemoryService,
  checkProviderModel,
  invalid,
  ok,
  createMemoryToolProvider,
  createContextToolProvider,
  createSessionToolProvider,
  createAgentOrchestrationToolProvider,
  changeSessionOption,
  systemSubject,
  createConnectorHub,
  createAgentTaskToolProvider,
  createDispatcher,
  setTaskStatusUseCase,
  defaultWorkspaceFor,
  isBusy,
  type AgentTaskRequest,
  notFound, forbidden,
  handoffCapFromEnv,
  defaultMemoryRegistry,
  MEMORY_GUIDANCE,
  MEMORY_SWEEP_INTERVAL_MS,
  MEMORY_GUIDANCE_VERSION,
  type MemoryGuidance,
  deriveSessionUseCase,
  promptSessionUseCase,
  pumpDeliveries,
  releaseAfterTurn,
  sweepTemporaryWorkspacesUseCase,
  adoptLocalWorkspacesUseCase,
  migrateAssetOwnership,
  sweepGitForReview,
  revokeLegacyLocalWorkerGrants
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
import { createConnectorObserveReader } from './observe-connector.ts';
import { createStreamHub } from './stream-hub.ts';
import { createLiveCatalog } from './agent-catalog.ts';
import { createGitWorkspace, createLocalFs, readBuildInfo, createWorkspaceBrowser, offlineWorkspaceBrowser } from '@agent-hub/node-gateway';
import { createSessionQueue } from './session-queue.ts';
import { createMemoryHosting } from './session-hosting.ts';
import { createOptionWaiters } from './option-waiters.ts';
import { createRequestGuard } from './request-guard.ts';
import { createScryptHasher, createTokenIssuer, mailFromEnv } from '@agent-hub/adapter-accounts';
import type { AccountDeps } from '@agent-hub/domain';
import { componentJobFinished, createAccessPolicy, loadResourcePolicy } from '@agent-hub/domain';
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
if (process.argv[2] === 'backup') {
  // 部署前快照（ADR 0030 D2）：只碰数据库文件，不起服务。
  const result = runBackup({ dataDir, ...backupArgs(process.argv.slice(3)), commit: hubBuild.commit });
  console.log(JSON.stringify(result.report));
  process.exit(result.code);
}
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
// 运行时套件 P2（ADR 0021）：组件目录 + 每台机器钉住的组件（漂移检测的期望状态）
const componentStore = createSqliteComponents(store.db);
const hub = createStreamHub();
const catalog = createLiveCatalog();
let serverGateway: ServerGateway | null = null;
const optionWaiters = createOptionWaiters();

const deps: Deps = {
  handoffTokenCap: handoffCapFromEnv(readEnv('HUB_HANDOFF_TOKEN_CAP') ?? undefined),
  projects: store.projects,
  tasks: store.tasks,
  workLog: store.workLog,
  sessions: store.sessions,
  workspaces: store.workspaces,
  artifacts: store.artifacts,
  layout: store.layout,
  links: store.links,
  agentProfiles: store.agentProfiles,
  toolGrants: store.toolGrants,
  stream: hub.stream,
  gateway: {
    status: async () => withAssetNeeds(serverGateway?.workers() ?? [], await mcpWorkers()),
    probe: async (workerId) => serverGateway?.gateway.probe?.(workerId) ?? false,
    // 发给 worker 前给 start_session 配上工具令牌（换新、旧的作废），dispose 时作废。
    dispatch: async (command) => {
      if (!serverGateway) return err(unavailable('worker 通道尚未就绪'));
      if (command.kind === 'dispose') providerWiring.revoke(command.sessionId);
      // hub 模型提供商：只给选中的那一个（ADR 0013 D3）；不能用就让这次启动失败，不静默换模型
      // 回合检查点（ADR 0027 D2）：问话发给 agent 之前先给工作区拍一张；最多等 5 秒，拍不成也照发
      if (command.kind === 'prompt') {
        const seq = (await store.sessions.byId(command.sessionId))?.lastSeq ?? 0;
        await Promise.race([filesService.beginTurn(command.sessionId, seq).catch(() => null), new Promise((r) => setTimeout(r, 5_000))]);
      }
      const granted = await providerWiring.grantFor(command);
      if (!granted.ok) return granted;
      const sent = await serverGateway.gateway.dispatch(await withSessionAssets(toolGateway ? await withToolAccess(toolGateway, toolEndpoint, granted.value) : granted.value));
      // 记下会话开始时的 HEAD（ADR 0025 决定 7）：diff 默认对它比；失败不影响会话
      if (sent.ok && command.kind === 'start_session') void filesService.recordBase(command.sessionId).catch(() => undefined);
      return sent;
    },
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
  deliveries: store.deliveries,
  // 授权（ADR 0011）：can() 要的团队 / 本机授权从这里拿；机器状态延迟到调用时再读 deps.gateway。
  access: createAccessPolicy({
    users: store.users,
    settings: store.settings,
    enrollment: store.enrollment,
    gateway: { status: () => deps.gateway.status() }
  }),
};

const log = (message: string) => console.log(`[hub] ${message}`);

// 能力层：agent 经 MCP 回调 hub 的工具。HUB_TOOLS=0 关掉。
// 唯一的传输是 relay：agent 连 worker 本机的入口，经 /worker 长连接到 hub，hub 不开 HTTP /mcp。
const toolEndpoint = readEnv('HUB_TOOLS') === '0' ? null : { url: '', transport: 'relay' as const };
if (readEnv('HUB_TOOLS_TRANSPORT') === 'http') log('HUB_TOOLS_TRANSPORT=http 已移除，忽略：工具一律经 worker 长连接中转');
// agent 间通信（ADR 0018 · P2P）：消息总线 + 工具；回合结束（journal 里的 ended）时收回复、投下一条。
// P2P 消息和群聊共用一道按会话的投递闸：同一条会话同一时间只有一个通道在等它的回复。
const sessionLane = createSessionLane();
const messageBus = createMessageBus({
  lane: sessionLane,
  occupied: async (sessionId) => (await store.groups.deliveredTo(sessionId)).length > 0,
  now: deps.now,
  sessions: deps.sessions,
  projects: deps.projects,
  tasks: deps.tasks,
  messages: store.messages,
  links: store.links,
  policy: deps.access,
  principalOf: (userId) => loadActor(store.users, store.access, userId, 'agent-message'),
  deliver: (sessionId, text, author) => promptSessionUseCase(deps, { sessionId, text, author }),
  spawn: ({ project, role, actor, title }) => openRoleSession(deps, { provenance: store.provenance, audit: store.audit, now: deps.now }, {
    projectId: project.id, title, ownerId: actor.user.id, agentId: role.agentId, model: role.model, actor, via: 'bot'
  })
});
setInterval(() => void messageBus.sweep().catch(() => undefined), 30_000).unref();

// 群聊（ADR 0018 · 群组）：每个群每个角色一条常驻会话；主持人分派 / 竞价 / @ 直达；回合结束时收成员的回复。
const groupChat = createGroupChat({
  now: deps.now,
  sessions: deps.sessions,
  projects: deps.projects,
  tasks: deps.tasks,
  groups: store.groups,
  policy: deps.access,
  roles: async (projectId) => (await messageBus.config(projectId)).roles,
  principalOf: (userId) => loadActor(store.users, store.access, userId, 'agent-group'),
  deliver: (sessionId, text, author) => promptSessionUseCase(deps, { sessionId, text, author }),
  spawn: ({ project, role, actor, title }) => openRoleSession(deps, { provenance: store.provenance, audit: store.audit, now: deps.now }, {
    projectId: project.id, title, ownerId: actor.user.id, agentId: role.agentId, model: role.model, actor, via: 'group'
  }),
  interrupt: (sessionId) => interruptSessionUseCase(deps, sessionId),
  lane: sessionLane,
  occupied: async (sessionId) => (await store.messages.deliveredTo(sessionId)).length > 0
});
// 持久智能体（界面上叫 bot）：按条读写项目的 agent 消息配置；删除时从所有群移出。
const persistentAgents = createPersistentAgents({
  projects: deps.projects,
  policy: deps.access,
  config: (projectId) => messageBus.config(projectId),
  saveConfig: (projectId, input) => messageBus.saveConfig(projectId, input),
  groupsOf: (projectId) => store.groups.groupsOf(projectId),
  detach: (actor, projectId, name) => groupChat.detachAgent(actor, projectId, name)
});
// 连接器（ADR 0032 R1）：入站来源只经 InboundSource 端口接进来；核心不认识具体连接器。
// bot 的会话：派生出来的 → 角色；群成员 → 角色；项目 = 那条会话所在任务的项目（bot 定义在那个项目里，即默认项目）。
const botOfSession = async (sessionId: SessionId): Promise<{ projectId: string; name: string } | null> => {
  const role = (await store.messages.spawnOf(sessionId))?.role ?? (await store.groups.memberOfSession(sessionId))?.role ?? null;
  if (!role) return null;
  const session = await deps.sessions.byId(sessionId);
  const task = session ? await deps.tasks.byId(session.taskId) : null;
  return task ? { projectId: task.projectId, name: role } : null;
};
// GitHub 连接器（ADR 0032 R4）：规则全在 @agent-hub/connector-github；这里只给它项目绑定的 token、PR 和会话的对应。
const secretKey = await loadSecretKey({ env: readEnv('HUB_SECRET_KEY') ?? undefined, file: join(dataDir, 'secret.key') });
const gitHostTokens = createSqliteGitHostTokens(store.db, secretKey);
const githubClient = createGithubClient({ base: readEnv('HUB_GITHUB_API') ?? undefined });
const teamTokenOf = async (projectId: string) => {
  const teamId = (await store.projects.byId(projectId as ProjectId))?.teamId ?? null;
  return teamId ? gitHostTokens.reveal(teamId) : null;
};
/** 某项目能回帖的仓库：智能体（默认项目 + 关联项目）覆盖到它的 github Binding。 */
const githubReposFor = async (projectId: string) => {
  const repos: string[] = [];
  for (const b of await store.connectors.bindingsFor('github')) {
    const scope = b.projectId ? [b.projectId] : [b.agentProjectId, ...(await store.connectors.agentProjects(b.agentProjectId, b.agentName))];
    if (scope.includes(projectId)) repos.push(githubParams(b.params).repo);
  }
  return repos;
};
const pullRequestRepoEarly = createSqlitePullRequests(store.db);
const githubSource = createGithubSource({
  client: githubClient,
  tokenFor: (b) => teamTokenOf(b.projectId ?? b.agentProjectId),
  sessionForPr: async (repo, number) => {
    const link = (await pullRequestRepoEarly.openSyncedBefore(Number.MAX_SAFE_INTEGER, 1000)).find((l) => l.repo.toLowerCase() === repo.toLowerCase() && l.number === number);
    return link?.sessionId ?? null;
  },
  log
});
const connectorHub = createConnectorHub({
  now: deps.now, projects: deps.projects, sessions: deps.sessions, policy: deps.access,
  store: store.connectors,
  sources: [createTimerSource(), githubSource],
  agentExists: async (projectId, name) => (await messageBus.config(projectId)).roles.some((r) => r.name === name),
  spawn: async ({ projectId, agentName, ownerId, title }) => {
    const role = (await messageBus.config(projectId)).roles.find((r) => r.name === agentName);
    if (!role) return err(notFound(`bot @${agentName} 已不存在`));
    const actor = await loadActor(store.users, store.access, ownerId, 'agent-connector');
    if (!actor) return err(forbidden('建这个触发的账号已停用'));
    return openRoleSession(deps, { provenance: store.provenance, audit: store.audit, now: deps.now }, {
      projectId, title, ownerId, agentId: role.agentId, model: role.model, actor, via: 'bot',
      afterDerive: async (session) => {
        // 记成这个 bot 的派生会话：职责说明（系统提示）照常垫进去。先于来历。
        await store.messages.saveSpawn({ sessionId: session.id, projectId: projectId as ProjectId, role: agentName, spawnerSessionId: session.id, traceId: `connector:${session.id}`, createdAt: Date.now() });
      }
    });
  },
  busy: async (sessionId) => (await store.deliveries.pendingFor(sessionId)).length > 0
    || (await store.messages.deliveredTo(sessionId)).length > 0 || (await store.groups.deliveredTo(sessionId)).length > 0,
  deliver: (sessionId, text, author) => promptSessionUseCase(deps, { sessionId, text, author })
});
connectorHub.start();
setInterval(() => void connectorHub.tick().catch((error: unknown) => log(`连接器重试失败：${String(error)}`)), 15_000).unref();
hub.stream.subscribe((frame) => {
  const event = frame.event;
  if (event?.kind === 'ended') void connectorHub.turnEnded(frame.sessionId, event.outcome).catch(() => undefined);
});
// 调度器（ADR 0032 R3）：task.create 建出的任务排队 → 按上限开任务智能体会话 → 一轮结束经送达队列通知建它的 bot。
// 只经端口：开会话 / 发消息复用现有派生 + 送达流程；人直接开的会话不经过这里。
const sessionOwner = (ownerId: string) => loadActor(store.users, store.access, ownerId, 'agent-dispatch');
const dispatcher = createDispatcher({
  now: deps.now,
  store: store.dispatches,
  placement: async (projectId) => {
    const ws = await defaultWorkspaceFor(deps, projectId as ProjectId);
    const workerId = ws?.workerId ?? null;
    const workers = await deps.gateway.status();
    return { workerId, online: workers.some((w) => w.state === 'online' && (workerId === null ? w.origin === 'local' : w.workerId === workerId)) };
  },
  start: async (d) => {
    const actor = await sessionOwner(d.accountId);
    if (!actor) return err(forbidden('建这个任务的账号已停用'));
    if (!d.agentId) return err(notFound('不知道用哪个运行时'));
    const created = await deriveSessionUseCase(deps, { taskId: d.taskId, agentId: d.agentId, model: d.model ?? '', actor });
    if (!created.ok) return created;
    await recordProvenance({ provenance: store.provenance, audit: store.audit, now: deps.now }, { session: created.value, subject: actor, via: 'bot' }).catch(() => undefined);
    const text = [`你是被调度器派来推进这个任务的任务智能体。任务：「${d.title}」`, d.goal ? `目标：\n${d.goal}` : '',
      '直接动手完成它；做完后用一段简短的文字总结结果（做了什么、产出在哪、有没有没做完的）。这段总结会转给建这个任务的 bot。'].filter(Boolean).join('\n\n');
    const sent = await promptSessionUseCase(deps, { sessionId: created.value.id, text, author: { id: d.accountId, name: '调度器', via: 'dispatch' } });
    if (!sent.ok) return sent;
    return ok({ sessionId: created.value.id as string, workerId: created.value.workerId ?? null });
  },
  sessionState: async (sid) => {
    const s = await deps.sessions.byId(sid as SessionId);
    if (!s) return null;
    const pending = (await store.deliveries.pendingFor(sid)).length > 0;
    if (s.status === 'running' || pending || s.lastSeq === 0) return { running: true, outcome: null, reply: '' };
    const tail = await deps.sessions.tail(sid as SessionId, 400);
    let reply = '';
    for (const e of tail) { if (e.event.kind === 'prompt') reply = ''; else if (e.event.kind === 'text') reply += e.event.delta; }
    return { running: false, outcome: s.status === 'done' ? 'done' : 'failed', reply: reply.trim() };
  },
  busy: async (sid) => {
    const s = await deps.sessions.byId(sid as SessionId);
    // 与连接器同一组旗标。isBusy 在第一轮 ended 之后经常为假，不能单独当互斥。
    // 群 / P2P 已经写成 delivered 的投递，调度不能再往同一条会话插一句。
    return (s ? isBusy(s) : false)
      || (await store.deliveries.pendingFor(sid)).length > 0
      || (await store.messages.deliveredTo(sid as SessionId)).length > 0
      || (await store.groups.deliveredTo(sid as SessionId)).length > 0;
  },
  notify: (sid, text) => promptSessionUseCase(deps, { sessionId: sid, text, author: { id: 'dispatch', name: '调度器', via: 'dispatch' } }),
  abandonTask: async (taskId, reason) => { await setTaskStatusUseCase(deps, taskId as TaskId, 'abandoned', 'system', reason).catch(() => undefined); },
  sinks: [createGithubSink({ client: githubClient, tokenFor: teamTokenOf, boundRepos: githubReposFor, prLinks: async (taskId) => (await pullRequestRepoEarly.byTask(taskId)).map((l) => l.url), log })],
  log
});
const enqueueDispatch = async (r: AgentTaskRequest) => {
  const creator = await deps.sessions.byId(r.sessionId as SessionId);
  const bot = await botOfSession(r.sessionId as SessionId);
  const role = bot ? (await messageBus.config(bot.projectId as ProjectId)).roles.find((x) => x.name === bot.name) : null;
  await dispatcher.enqueue(r, { agentId: role?.agentId ?? creator?.agentId ?? null, model: role?.model ?? creator?.model ?? null });
  void dispatcher.tick().catch((error: unknown) => log(`调度失败：${String(error)}`));
};
setInterval(() => void dispatcher.tick().catch((error: unknown) => log(`调度失败：${String(error)}`)), 10_000).unref();
hub.stream.subscribe((frame) => {
  if (frame.event?.kind === 'ended') void dispatcher.sessionEnded(frame.sessionId).catch(() => undefined);
});
// 回合结束：先让 P2P 收尾（它投的就收它的），再让群聊收尾；两边各自收完都会试着投下一条，闸保证只投进一个。
hub.stream.subscribe((frame) => {
  const event = frame.event;
  if (event?.kind !== 'ended') return;
  void (async () => {
    await messageBus.turnEnded(frame.sessionId, event.outcome).catch((error: unknown) => log(`agent 消息回合收尾失败：${String(error)}`));
    await groupChat.turnEnded(frame.sessionId).catch((error: unknown) => log(`群聊回合收尾失败：${String(error)}`));
  })();
});
const contextService = createContextService({ projects: deps.projects, tasks: deps.tasks, sessions: deps.sessions, access: deps.access, now: () => Date.now(), contextSettings: store.contextSettings, audit: store.audit, gateway: deps.gateway,
  // 角色层（ADR 0020 §8）：派生出来的角色会话 → 角色；否则群里的成员 → 角色
  roleOf: async (sessionId) => (await store.messages.spawnOf(sessionId as SessionId))?.role ?? (await store.groups.memberOfSession(sessionId as SessionId))?.role ?? null,
  // bot 职责说明（系统提示）：DM / 派生会话 / 群成员会话都在会话开头垫一次
  agentOf: async (projectId, role) => (await messageBus.config(projectId as ProjectId)).roles.find((r) => r.name === role) ?? null });
(deps as { sessionInstructions?: (sessionId: string) => Promise<string | null> }).sessionInstructions = (sessionId) => contextService.instructionsFor(sessionId);
const offlineBrowser = offlineWorkspaceBrowser('worker 通道尚未就绪');
const filesService = createWorkspaceFilesService({
  projects: deps.projects, tasks: deps.tasks, sessions: deps.sessions, workspaces: deps.workspaces, gateway: deps.gateway, access: deps.access, audit: store.audit,
  local: createWorkspaceBrowser(),
  remote: (workerId) => (serverGateway ? serverGateway.browser(workerId) : offlineBrowser),
  bases: store.sessionBases,
  checkpoints: store.checkpoints,
  now: () => Date.now()
});
const rewindService = createRewindService({ ...deps, files: filesService, turnRefs: store.turnRefs });
// 回合结束后拍「之后」那张（ADR 0027 D2）；保留期清理每小时一次（D1）
hub.stream.subscribe((frame) => {
  if (frame.event?.kind === 'ended') void filesService.endTurn(frame.sessionId).catch((error: unknown) => log(`回合检查点失败：${String(error)}`));
});
// 回合结束：等上一轮的那条消息（人在定时触发跑着时发的话等）马上送，不等下一次泵
hub.stream.subscribe((frame) => {
  if (frame.event?.kind !== 'ended') return;
  void releaseAfterTurn({ ...deps, deliveries: store.deliveries }, frame.sessionId).catch((error: unknown) => log(`送达队列收尾失败：${String(error)}`));
});
// 送达队列（ADR 0031 D2）：重启时把上次停在「发送中」的退回排队，之后每秒泵一次
void store.deliveries.recoverSending(Date.now()).then((n) => n > 0 && log(`送达队列：${n} 条上次没送完，重新排队`));
let pumping = false;
setInterval(() => {
  if (pumping) return;
  pumping = true;
  void pumpDeliveries({ ...deps, deliveries: store.deliveries })
    .catch((error: unknown) => log(`送达队列失败：${String(error)}`))
    .finally(() => { pumping = false; });
}, 1_000).unref();
setInterval(() => void filesService.sweepCheckpoints().catch(() => undefined), 3_600_000).unref();
setInterval(() => void groupChat.sweep().catch(() => undefined), 15_000).unref();

// 记忆（ADR 0019 · P1）：SQLite + FTS5 默认适配器；来源就地索引（ADR、文档、任务）；只经工具读，第一轮只垫一行静态引导。
// 记忆适配器都经注册表装配（memory.md §16）：来源、提炼、检索 / 排序、维护任务、治理各是一个端口。
const providerRepo = createSqliteProviders(store.db, secretKey);
const projectTeamOf = async (projectId: string) => (await store.projects.byId(projectId as ProjectId))?.teamId ?? null;
const pullRequestRepo = pullRequestRepoEarly;
const workspaceSweeps = createSqliteWorkspaceSweeps(store.db);
// 清理（ADR 0027 阶段 3）：按 PR 合并 / 任务结束判断，删工作空间时一起删检查点 ref
(deps as { cleanup?: Deps["cleanup"] }).cleanup = { sweeps: workspaceSweeps, pullRequests: pullRequestRepo, dropCheckpoints: (sessionId: string) => filesService.dropSession(sessionId) };
// 提交 / 推送 / PR（ADR 0027 阶段 2）：文字由提炼模型写（D4），PR 走团队 token → gh → 链接（D3）
const gitService = createGitWorkflowService({
  projects: deps.projects, tasks: deps.tasks, sessions: deps.sessions, workspaces: deps.workspaces, gateway: deps.gateway, access: deps.access, audit: store.audit,
  workLog: store.workLog, git: deps.git,
  pullRequests: pullRequestRepo,
  tokens: gitHostTokens,
  host: createGitHubApi({ base: readEnv('HUB_GITHUB_API') ?? undefined }),
  writer: createGitTextWriter({ settings: store.memory.settings, providers: providerRepo, projectTeam: projectTeamOf, audit: store.audit, now: () => Date.now(), log }),
  hubTeamId: async () => (await store.users.firstClusterAdmin())?.teamId ?? null,
  now: () => Date.now()
});
// PR 状态每 10 分钟同步一次（打开任务时也会顺手同步）
setInterval(() => void gitService.syncDue(20).catch(() => undefined), 600_000).unref();
const memoryRegistry = defaultMemoryRegistry();
for (const source of createMemorySources(deps, store.groups)) memoryRegistry.source(source);
// 会后提炼（ADR 0024）：项目选了模型就由 hub 直接调它，没选 / 失败回落规则版
memoryRegistry.distiller(
  createModelDistiller({ settings: store.memory.settings, providers: providerRepo, projectTeam: projectTeamOf, audit: store.audit, now: () => Date.now(), log })
);
const memoryService = createMemoryService({
  now: deps.now,
  sessions: deps.sessions,
  projects: deps.projects,
  tasks: deps.tasks,
  ...store.memory,
  ...memoryRegistry.build({ index: store.memory.index, store: store.memory.store }),
  audit: store.audit,
  access: deps.access,
  principalOf: (userId) => loadActor(store.users, store.access, userId, 'agent-memory'),
  roleOf: async (sessionId) => (await store.messages.spawnOf(sessionId))?.role ?? null,
  checkDistillModel: async (principal, projectId, model) => {
    const checked = await checkProviderModel({ providers: providerRepo }, principal, model, await projectTeamOf(projectId));
    if (!checked.ok) return checked;
    if (!checked.value) return err(invalid('提炼模型要选已注册的 hub 模型（hub-<slug>/<model>）'));
    if (checked.value.scope === 'personal') return err(invalid('个人模型提供商不能用于项目提炼'));
    return ok(true as const);
  },
  sourceTtlMs: 5 * 60_000
});
// 记忆 P2：运行时压缩完把摘要交给记忆（session: 摘要 + 会后提炼）；后台整理一天一次（启动 10 分钟后先跑一次）。
hub.stream.subscribe((frame) => {
  const event = frame.event;
  if (event?.kind !== 'compaction' || event.phase !== 'end' || event.ok !== true || !event.summary) return;
  void memoryService
    .ingestCompaction(frame.sessionId as SessionId, { seq: Number(frame.seq), summary: event.summary, ...(event.tokensBefore !== undefined ? { tokensBefore: event.tokensBefore } : {}) })
    .catch((error: unknown) => log(`压缩摘要写记忆失败：${String(error)}`));
});
const memorySweep = () => void memoryService.sweep().catch((error: unknown) => log(`记忆后台整理失败：${String(error)}`));
setTimeout(memorySweep, 10 * 60_000).unref();
setInterval(memorySweep, MEMORY_SWEEP_INTERVAL_MS).unref();
if (toolEndpoint) {
  (deps as { memoryGuidance?: MemoryGuidance }).memoryGuidance = {
    text: MEMORY_GUIDANCE,
    version: MEMORY_GUIDANCE_VERSION,
    injected: (sessionId, version) => memoryService.guidanceInjected(sessionId, version)
  };
}

toolGateway = createToolGateway({
  now: deps.now,
  toolGrants: store.toolGrants,
  tokens: createTokenIssuer(),
  providers: [createTaskToolProvider(deps), createMessageToolProvider(messageBus, groupChat), createMemoryToolProvider(memoryService), createContextToolProvider(contextService),
    createSessionToolProvider({ ...deps, extraProjects: async (sid) => { const bot = await botOfSession(sid as SessionId); return bot ? store.connectors.agentProjects(bot.projectId, bot.name) : []; } }),
    createAgentOrchestrationToolProvider({
      agentProfiles: deps.agentProfiles,
      sessions: deps.sessions,
      tasks: deps.tasks,
      projects: deps.projects,
      agents: deps.agents,
      now: deps.now,
      spawn: async (input) => {
        const created = await deriveSessionUseCase(deps, {
          taskId: input.taskId,
          agentId: input.agentId,
          model: input.model,
          options: input.options,
          actor: systemSubject('agent.spawn'),
          createdBy: input.createdBy
        });
        if (!created.ok) return created;
        const session = created.value;
        if (input.prompt) {
          const sent = await promptSessionUseCase(deps, {
            sessionId: session.id,
            text: input.prompt,
            author: { id: 'agent-orchestrator', name: '编排 Agent', via: 'agent' }
          });
          if (!sent.ok) return sent;
        }
        return ok({ sessionId: session.id, taskId: session.taskId, agentId: session.agentId, model: session.model, status: session.status });
      },
      setOption: (sessionId, optionId, value) => changeSessionOption(deps, { sessionId, id: optionId, value })
    }),
    // R2：bot 建任务 / 读关联项目；权限 = 关联关系，配额只算触发唤醒的回合（HUB_ROUTER_COUNT_HUMAN=1 时人发起的也算）
    createAgentTaskToolProvider({
      ...deps, requests: store.agentTasks, agentOf: botOfSession, onCreated: enqueueDispatch,
      associations: (projectId, name) => store.connectors.agentProjects(projectId, name),
      wakeOf: async (sid) => { const run = await store.connectors.deliveredRunFor(sid); const b = run ? await store.connectors.binding(run.bindingId) : null; return run && b ? { runId: run.id, timeZone: b.timeZone } : null; },
      countHuman: readEnv('HUB_ROUTER_COUNT_HUMAN') === '1',
      defaultTimeZone: readEnv('HUB_TIME_ZONE') ?? 'Asia/Shanghai'
    }),
    // R4：github.comment / github.react；只对绑给这个 bot（或这个任务来源）的仓库，能力按 Worker 预设映射
    createGithubToolProvider({
      client: githubClient,
      tokenFor: teamTokenOf,
      workerCapabilities: async (sid) => {
        const s = await deps.sessions.byId(sid as SessionId);
        return s?.workerId ? ((await store.enrollment.credentialFor(s.workerId))?.capabilities ?? null) : null;
      },
      bindingsOf: async (sid) => {
        const bot = await botOfSession(sid as SessionId);
        if (bot) {
          return (await store.connectors.bindingsOf(bot.projectId, bot.name)).filter((b) => b.connector === 'github')
            .map((b) => ({ repo: githubParams(b.params).repo, projectId: b.projectId ?? b.agentProjectId }));
        }
        const d = await store.dispatches.bySession(sid);
        const at = d?.originConnector === 'github' && d.originExternalId ? parseIssueKey(d.originExternalId) : null;
        return at && d && (await githubReposFor(d.projectId)).includes(at.repo) ? [{ repo: at.repo, projectId: d.projectId }] : [];
      }
    })]
});

// 工具授权不随 hub 重启回收：ACP 进程里的 MCP Authorization 无法热换，
// 重启后旧会话仍可能继续使用同一把会话令牌。过期由授权自身的 TTL 负责。


// 账号体系是独立的限界上下文：不塞进 Deps。
const mailSetup = mailFromEnv({ env: readEnv, log, fallbackUrl: `http://127.0.0.1:${port}` });
log(mailSetup.note);
const maxUsers = Number(readEnv('HUB_MAX_USERS') ?? 0);
if (maxUsers > 0) log(`注册名额上限 HUB_MAX_USERS=${maxUsers}（按全部账号算，停用的也占名额）`);
const accounts: AccountDeps = {
  users: store.users,
  logins: store.logins,
  settings: store.settings,
  hasher: createScryptHasher(),
  tokens: createTokenIssuer(),
  mail: mailSetup.sender,
  oneTimeTokens: store.oneTimeTokens,
  teams: store.teams,
  invites: store.invites,
  audit: store.audit,
  ...(Number.isFinite(maxUsers) && maxUsers > 0 ? { maxUsers } : {}),
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
// ADR 0017 决定 1A：老的「单独授权用本机 Worker」全部撤销（每人一条审计），幂等。
{
  const revoked = await revokeLegacyLocalWorkerGrants({ settings: store.settings, users: store.users, audit: store.audit, now: () => Date.now() });
  if (revoked > 0) log(`撤销了 ${revoked} 条本机 Worker 单独授权（ADR 0017：hub 本机 Worker 只给集群管理员）`);
  const admins = (await store.users.list()).filter((u) => u.clusterAdmin && u.deletedAt === null);
  if (admins.length > 0) log(`集群管理员：${admins.map((u) => u.email).join(', ')}`);
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
// 资源采样（ADR 0014）只在网关内存里；策略开关持久化在 hub 设置里，启动时同步回网关。
const workerMetrics: WorkerMetrics = {
  history: (workerId) => serverGateway?.metrics(workerId) ?? [],
  applyRefuseWhenFull: (ids) => serverGateway?.setRefuseWhenFull(ids)
};
const workerControl = {
  list: async () => withAssetNeeds(serverGateway?.workers() ?? [], await mcpWorkers()),
  disconnect: async (workerId: string, why?: 'admin' | 'revoked') => serverGateway?.disconnect(workerId, why) ?? false,
  hubBuild: () => hubBuild,
  update: async (workerId: string, commit: string) => serverGateway?.requestUpdate(workerId, commit) ?? false,
  runtimeJob: async (workerId: string, job: RuntimeJob) => serverGateway?.requestRuntimeJob(workerId, job) ?? false,
  rotateCredential: async (workerId: string, credential: string) => serverGateway?.rotateCredential(workerId, credential) ?? false
};
const enrollmentDeps: EnrollmentDeps = {
  enrollment: store.enrollment,
  tokens: createTokenIssuer(),
  settings: store.settings,
  users: store.users,
  audit: store.audit,
  workers: workerControl,
  now: () => Date.now(),
  access: deps.access
};

// 资产中心（docs/design/asset-hub.md）：技能 / 指令按 Worker 安装，经长连接下发。同步状态落库，hub 重启后照样显示；Worker 每次上线都会再同步。
const providerWiring = createProviderWiring({
  deps: { providers: providerRepo, audit: store.audit, now: () => Date.now() },
  projectTeam: async (taskId) => {
    const task = await store.tasks.byId(taskId as TaskId);
    return task ? ((await store.projects.byId(task.projectId))?.teamId ?? null) : null;
  },
  projectTeamOf: projectTeamOf,
  userTeam: async (userId) => (await store.users.byId(userId as UserId))?.teamId ?? null,
  hostOf: (sessionId) => serverGateway?.hostOf(sessionId as SessionId) ?? null,
  testFromWorker: async (workerId, input) => (serverGateway ? serverGateway.testProvider(workerId, input) : err(unavailable('worker 通道尚未就绪'))),
  log
});
const assetDeps: AssetReviewDeps = {
  assets: store.assets,
  hubAdminId: async () => (await store.users.firstClusterAdmin())?.id ?? null,
  review: store.assetReview,
  notifications: store.notifications,
  audit: store.audit,
  users: store.users,
  teams: store.teams,
  policy: deps.access!,
  reader: createAssetReader(),
  delivery: { push: async (workerId, manifest) => (serverGateway ? serverGateway.assets.push(workerId, manifest) : err(unavailable('worker 通道尚未就绪'))) },
  board: store.assetSync,
  workers: workerControl,
  projects: { byId: (id) => store.projects.byId(id as ProjectId) },
  secrets: createSecretVault(store.db, secretKey),
  now: () => Date.now()
};
// ADR 0016 迁移：老资产记到 hub 管理员名下（全局 / 项目级，已发布）；幂等，重启不重复。
{
  const migrated = await migrateAssetOwnership(assetDeps);
  if (migrated.migrated > 0) log(`资产审核迁移：${migrated.migrated} 个老资产记到 hub 管理员名下，${migrated.pending} 个未钉的新版本转成待审提交`);
}
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
    const project = task ? await store.projects.byId(task.projectId) : null;
    const viewer = task?.ownerId ? { userId: task.ownerId, teamId: project?.teamId ?? null } : null;
    const plan = await sessionAssetPlan(assetDeps, command.workerId, task?.projectId ?? null, viewer);
    let next: WorkerCommand = { ...command, assetIds: plan.assetIds };
    const launched = new Set<string>();
    if (command.tools) {
      const { launch, skipped } = await sessionMcpLaunch(assetDeps, command.workerId, new Set(plan.assetIds));
      for (const item of skipped) log(`MCP「${item.name}」这次没给会话 ${command.sessionId}：${item.reason}`);
      for (const item of launch) launched.add(item.name);
      if (launch.length > 0) next = { ...next, mcp: launch };
    }
    // 会话资产清单：实际给出去的那些（MCP 只算真的启动了的），会话界面展示用
    const entries = plan.entries.filter((entry) => entry.kind !== 'mcp' || launched.has(entry.name));
    await store.assets.recordSessionAssets({ sessionId: command.sessionId, workerId: command.workerId, entries, at: Date.now() });
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
  trustProxy: process.env['HUB_TRUST_PROXY'] === '1',
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
    // 机器回来了：排队的消息不等退避，马上再试（ADR 0031）
    void store.deliveries.wakeAll(Date.now()).then((n) => n > 0 && log(`送达队列：${n} 条因 ${worker.label} 上线提前重试`));
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
  onTurnRef(workerId, sessionId, turnRef) {
    fromWorker(workerId, sessionId, () => void rewindService.recordTurnRef(sessionId, turnRef).catch((e) => log(`记录原生标识失败：${String(e)}`)));
  },
  onBranchResult(workerId, sessionId, outcome, reason) {
    fromWorker(workerId, sessionId, () => void rewindService.branchResult(sessionId, outcome, reason).catch((e) => log(`处理分叉结果失败：${String(e)}`)));
  },
  onAgentSession(workerId, sessionId, agentSessionRef) {
    fromWorker(workerId, sessionId, () => void ingestAgentSessionRef(deps, sessionId, agentSessionRef));
  },
  onStatus(workerId, sessionId, status) {
    fromWorker(workerId, sessionId, () => {
      void ingestRuntimeStatus(deps, sessionId, status);
      // 一轮结束/进程消失都不回收工具令牌：ACP 进程只在 session/new|load 时拿到
      // MCP Authorization，后续 prompt 无法热换 token。授权随会话保留，dispose 时再作废。
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
  expectedComponents: (workerId) => componentStore.pins.pinsFor(workerId),
  onRuntimeJob(workerId, job) {
    if (!job.component) return;
    void componentJobFinished({ pins: componentStore.pins, audit: store.audit, now: () => Date.now() }, workerId, job).catch((failure: unknown) =>
      log(`记录组件任务结果失败：${(failure as Error).message}`)
    );
  },
  onUpdateStatus(workerId, update) {
    log(`worker ${workerId} 更新：${update.state} ${update.message}`);
  },
  onLog: log
});
void loadResourcePolicy({ metrics: workerMetrics, settings: store.settings }).catch((failure: unknown) => log(`同步资源策略失败：${(failure as Error).message}`));

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
const sweep = (why: 'startup' | 'hourly') =>
  sweepTemporaryWorkspacesUseCase(deps, { trigger: why })
    .then((report) => {
      if (report.removed.length + report.kept.length > 0) {
        log(`临时工作空间清理（${why}）：删了 ${report.removed.length} 个，保留 ${report.kept.length} 个`);
      }
    })
    .catch((failure: unknown) => log(`临时工作空间清理失败：${(failure as Error).message}`));
setTimeout(() => void sweep('startup'), 60_000).unref();
setInterval(() => void sweep('hourly'), 60 * 60_000).unref();

// 资产更新提醒：定时去 Git 来源看有没有新版本（默认每 6 小时；HUB_ASSET_CHECK_MS=0 关掉）。只记「有新版本」，升级仍要主人看对比后确认。
const assetCheckMs = Number(readEnv('HUB_ASSET_CHECK_MS') ?? 6 * 60 * 60_000);
let assetCheckRunning = false; // 上一轮没跑完就跳过，免得同一个新版本记两遍
const checkAssets = (why: string) => {
  if (assetCheckRunning) return Promise.resolve();
  assetCheckRunning = true;
  return sweepGitForReview(assetDeps)
    .then((report) => {
      if (report.submitted > 0 || report.failed > 0) log(`资产更新检查（${why}）：查了 ${report.checked} 个，${report.submitted} 个有新版本已进审核，${report.failed} 个查不了`);
    })
    .catch((failure: unknown) => log(`资产更新检查失败：${(failure as Error).message}`))
    .finally(() => {
      assetCheckRunning = false;
    });
};
if (assetCheckMs > 0) {
  setTimeout(() => void checkAssets('启动'), Math.min(120_000, assetCheckMs)).unref();
  setInterval(() => void checkAssets('定时'), assetCheckMs).unref();
}

// 开放 API 令牌（ADR 0015）：只存哈希。
const apiTokenDeps = { apiTokens: createSqliteApiTokens(store.db), users: store.users, tokens: createTokenIssuer(), audit: store.audit, now: () => Date.now() };
const envNumber = (name: string): number | undefined => {
  const value = readEnv(name);
  return value === null || value === undefined ? undefined : Number(value);
};

const observeEnabled = readEnv('OBSERVE') !== '0';
const app = createApp({ deps, hub, token, connectors: { hub: connectorHub, agentTasks: store.agentTasks, dispatcher, onCreated: enqueueDispatch }, waitOptions: optionWaiters.wait, guard,
  observe: {
    enabled: observeEnabled,
    readers: observeEnabled ? [createConnectorObserveReader({
      now: deps.now, projects: deps.projects, sessions: deps.sessions, tasks: deps.tasks,
      deliveries: store.deliveries, store: store.connectors, requests: store.agentTasks, dispatches: store.dispatches, policy: deps.access
    })] : []
  }, 
  auth: { accounts, access: store.access, team: { ...accounts, invites: store.invites, projects: store.projects, roles: store.access.roles }, accessAdmin: { ...store.access, users: store.users, teams: store.teams, audit: store.audit, now: () => Date.now() }, hubToken, loginRateMax: Number(readEnv('HUB_LOGIN_RATE_MAX') ?? 30), mailRateMax: Number(readEnv('HUB_MAIL_RATE_MAX') ?? 5), mailDelivery: mailSetup.transport !== 'log' },
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
  providers: providerWiring,
  resources: { metrics: workerMetrics, settings: store.settings, workers: workerControl, audit: store.audit, now: () => Date.now(), access: deps.access },
  ...(deps.access ? { components: {
    catalog: componentStore.catalog,
    pins: componentStore.pins,
    workers: workerControl,
    sessions: store.sessions,
    audit: store.audit,
    access: deps.access,
    resolveNpm: createNpmResolver(readEnv('HUB_NPM_REGISTRY') ?? 'https://registry.npmjs.org'),
    // 双人审核（P3）：默认 1 人；设成 2 就要两个不同的集群管理员批准，提交人不算
    requiredApprovals: Number(readEnv('HUB_COMPONENT_REVIEWERS') ?? '1') || 1,
    now: () => Date.now()
  } } : {}),
  runtimeInstall: { workers: workerControl, enrollment: store.enrollment, sessions: store.sessions, audit: store.audit, now: () => Date.now(), access: deps.access },
  projectDeletion: { toolGrants: store.toolGrants, audit: store.audit },
  activity: { audit: store.audit, users: store.users, provenance: store.provenance },
  attention: { store: store.attention, pullRequests: pullRequestRepo },
  messaging: { bus: messageBus, messages: store.messages },
  groups: { groups: groupChat, agents: persistentAgents },
  context: contextService,
  files: filesService,
  git: gitService,
  rewind: rewindService,
  memory: { memory: memoryService },
  openApi: {
    tokens: apiTokenDeps,
    manage: apiTokenDeps,
    rate: { general: envNumber('HUB_API_RATE_MAX'), prompt: envNumber('HUB_API_PROMPT_RATE_MAX'), streams: envNumber('HUB_API_STREAM_MAX') }
  },
  enrollment: {
    deps: enrollmentDeps,
    bootstrapScript: join(repoRoot, 'scripts', 'bootstrap-worker.sh'),
    commit: hubBuild.commit,
    artifacts: createInstallArtifacts({ repoDir: repoRoot, commit: hubBuild.commit, cacheDir: join(dataDir, 'install-cache') })
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
