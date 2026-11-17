import { backupArgs, runBackup } from './backup.ts';
import { createInstallArtifacts } from './install-artifacts.ts';
import { PREVIEW_WS_PATH, STALL_NOTICE_MARKER } from '@agent-hub/contract';
import { spawn, type ChildProcess } from 'node:child_process';
import { createTimerSource } from '@agent-hub/connector-timer';
import { createGithubClient, createGithubSink, createGithubSource, createGithubToolProvider, githubParams, parseIssueKey } from '@agent-hub/connector-github';
import { createFeishuClient, createFeishuSink, createFeishuSource, createFeishuTurnReplies } from '@agent-hub/connector-feishu';
import { randomBytes, timingSafeEqual } from 'node:crypto';
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
import { createBotOfSession } from './bot-session.ts';
import { createSecretVault, createSqliteApiTokens, createSqliteComponents, createSqliteProviders, createSqlitePullRequests, createSqliteGitHostTokens, createSqliteWorkspaceSweeps, loadSecretKey, openSqliteStore } from '@agent-hub/storage-sqlite';
import { createNpmResolver } from './components.ts';
import { createProviderWiring } from './providers.ts';
import { createSessionEnvironment } from './session-environment.ts';
import { createGitTextWriter } from './git-text-writer.ts';
import { createGitHubApi } from './github-api.ts';
import { createModelDistiller } from './model-distiller.ts';
import type { AssetReviewDeps, Deps, EnrollmentDeps, EnvironmentPlanner, ProjectId, RuntimeJob, ServiceGateway, SessionId, Subject, TaskId, ToolGateway, UserId, WorkerMetrics, WorkspaceGroupGit } from '@agent-hub/domain';
import { authenticateWorker, createTaskToolProvider, createToolGateway, withToolAccess,
  createMessageBus,
  createBotUseCase,
  getBotUseCase,
  listBotsUseCase,
  botGrantsUseCase,
  listTeamBotsUseCase,
  grantBotUseCase,
  revokeBotUseCase,
  removeBotUseCase,
  updateBotUseCase,
  interruptSessionUseCase,
  renameSessionUseCase,
  createGroupChat,
  createPersistentAgents,
  createSessionLane,
  createContextService,
  createWorkspaceFilesService,
  createGitWorkflowService,
  createRewindService,
  recordProvenance,
  recordServiceLogUseCase,
  recordServiceStateUseCase,
  createMessageToolProvider,
  createMemoryService,
  checkProviderModel,
  invalid,
  ok,
  createMemoryToolProvider,
  createContextToolProvider,
  createSessionToolProvider,
  createAgentOrchestrationToolProvider,
  createGitToolProvider,
  createArtifactToolProvider,
  createWorkspaceToolProvider,
  createSessionControlToolProvider,
  createProjectToolProvider,
  setProjectChecksUseCase,
  setProjectDescriptionUseCase,
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
  recoverOrphanedTurns,
  releaseAfterTurn,
  sweepTemporaryWorkspacesUseCase,
  prepareTemporaryWorkspaceUseCase,
  asTaskId,
  adoptLocalWorkspacesUseCase,
  migrateAssetOwnership,
  sweepGitForReview,
  revokeLegacyLocalWorkerGrants,
  terminalAccess,
  terminalTarget,
  asSessionId,
  asProjectId,
  authorizeProject,
  resolveSessionAssets,
  createPreviewLinkUseCase,
  createOutboxPump,
  projectOfSession,
  createSessionInbox,
  markWorkerPreviewsOfflineUseCase,
  matchPreviewShare,
  parsePreviewPortRange,
  authorizeSession
} from '@agent-hub/domain';
import { createFakeChannel, createFakeOutbound, createFakeReplies } from './fake-channel.ts';
import {
  authenticate,
  err,
  ingestAgentSessionRef,
  ingestRuntimeStatus,
  ingestWorkerEvent,
  flagStalledSessions,
  frameAccepted,
  ingestWorkerOptions,
  reconcileInterrupted,
  syncWorkerAssets,
  remoteMcpTarget,
  withAssetNeeds,
  unavailable,
  workerAttached,
  workerGone,
  withAccess
} from '@agent-hub/domain';
import type { ServerGateway } from '@agent-hub/node-gateway';
import { autoLinkCandidates, type WorkspaceOwner } from './preview-autolink.ts';
import { createApp } from './http.ts';
import { createConnectorObserveReader } from './observe-connector.ts';
import { createStreamHub } from './stream-hub.ts';
import { createLiveCatalog } from './agent-catalog.ts';
import { createGitWorkspace, createLocalFs, readBuildInfo, createWorkspaceBrowser, offlineWorkspaceBrowser } from '@agent-hub/node-gateway';
import { createSessionQueue } from './session-queue.ts';
import { createMemoryHosting } from './session-hosting.ts';
import { createOptionWaiters } from './option-waiters.ts';
import { createRequestGuard } from './request-guard.ts';
import { createTerminalBridge, loginTokenOf, type TerminalBridge } from './terminal-bridge.ts';
import { createTaskProgress } from './task-progress.ts';
import { createPreviewChannel, type PreviewChannel } from './preview-channel.ts';
import { createPreviewProxy, type PreviewProxy } from './preview-proxy.ts';
import { createPreviewPrefix } from './preview-prefix.ts';
import { createScryptHasher, createTokenIssuer, mailFromEnv } from '@agent-hub/adapter-accounts';
import type { AccountDeps, PreviewLink, PreviewLinkId } from '@agent-hub/domain';
import { componentJobFinished, createAccessPolicy, isContainerSession, loadResourcePolicy } from '@agent-hub/domain';
import { seedTestAccount } from './account-setup.ts';

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

await mkdir(dataDir, { recursive: true });
console.log(`[hub] 数据目录：${dataDir}`);

const store = openSqliteStore(join(dataDir, 'hub.db'));
// 运行时套件 P2（ADR 0021）：组件目录 + 每台机器钉住的组件（漂移检测的期望状态）
const componentStore = createSqliteComponents(store.db);
const hub = createStreamHub();
const catalog = createLiveCatalog();
let serverGateway: ServerGateway | null = null;
/** 会话终端桥接：浏览器 WS ↔ worker PTY。装配在 serverGateway 之后。 */
let terminalBridge: TerminalBridge | null = null;
let sessionEnvironment: EnvironmentPlanner | null = null;
const optionWaiters = createOptionWaiters();

/** 通道没起来 / 老网关没有 groups 时的替身：每个方法都返回可读的失败，不抛。 */
const missingGroups: WorkspaceGroupGit = {
  init: async () => err(unavailable('worker 通道尚未就绪')),
  remove: async () => err(unavailable('worker 通道尚未就绪')),
  newWorktree: async () => err(unavailable('worker 通道尚未就绪'))
};

/** 服务通道没起来时的替身：每个方法都返回可读的失败，不抛。 */
const missingServices: ServiceGateway = {
  start: async () => err(unavailable('worker 通道尚未就绪')),
  stop: async () => err(unavailable('worker 通道尚未就绪')),
  list: async () => err(unavailable('worker 通道尚未就绪')),
  logs: async () => err(unavailable('worker 通道尚未就绪'))
};

const deps: Deps = {
  handoffTokenCap: handoffCapFromEnv(readEnv('HUB_HANDOFF_TOKEN_CAP') ?? undefined),
  projects: store.projects,
  tasks: store.tasks,
  workLog: store.workLog,
  sessions: store.sessions,
  workspaces: store.workspaces,
  // 组合工作空间的组行（docs/design/multi-repo.md §11.2）。
  workspaceGroups: store.workspaceGroups,
  artifacts: store.artifacts,
  layout: store.layout,
  links: store.links,
  sessionServices: store.sessionServices,
  agentProfiles: store.agentProfiles,
  bots: store.bots,
  toolGrants: store.toolGrants,
  // 环境端口在资产依赖就绪后才构造；这里用委托保持组合根的单向初始化。
  environment: {
    prepare: async (command) => (sessionEnvironment ? sessionEnvironment.prepare(command) : { command, revision: null }),
    revision: async (session) => (sessionEnvironment ? sessionEnvironment.revision(session) : null),
    upgrade: async (session) => (sessionEnvironment?.upgrade ? sessionEnvironment.upgrade(session) : null)
  },
  workerPresence: {
    online: async (workerId) =>
      (serverGateway?.workers() ?? []).some(
        (worker) => worker.state === 'online' && (workerId === null ? worker.origin === 'local' : worker.workerId === workerId)
      )
  },
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
      // #221 步骤 3：授权里冻结「以谁的名义、经哪条渠道」。群会话是群体授权，其余先记 web。
      let effective = granted.value;
      if (toolGateway) {
        const live = await deps.sessions.byId(command.sessionId);
        const actor = live
          ? { userId: live.createdBy ?? null, via: live.groupId ? ('group' as const) : ('web' as const) }
          : undefined;
        effective = await withToolAccess(toolGateway, toolEndpoint, granted.value, actor);
      }
      // 环境准备（资产/MCP）必须排在工具令牌之后：MCP 启动配置以 command.tools 为准。
      // 全仓只有这一处 prepare；domain 的启动入口只负责把回执里的版本落库。
      let environmentRevision: string | null = null;
      const prepared = await deps.environment?.prepare(effective);
      if (prepared) {
        // #223：资产/MCP 没准备好就不下发——不能退回「不带 assetIds = 全给」。
        if (prepared.blocked) return err(unavailable(prepared.blocked));
        effective = prepared.command;
        environmentRevision = prepared.revision;
      }
      const sent = await serverGateway.gateway.dispatch(effective);
      if (!sent.ok) return sent;
      // 记下会话开始时的 HEAD（ADR 0025 决定 7）：diff 默认对它比；失败不影响会话
      if (command.kind === 'start_session') {
        void filesService.recordBase(command.sessionId).catch(() => undefined);
        return ok({ environmentRevision });
      }
      return ok(undefined);
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
    git: (workerId) => (serverGateway ? serverGateway.gateway.git(workerId) : createGitWorkspace(async () => 'worker 通道尚未就绪')),
    // 组合工作空间要的是容器 / worktree 的组级操作（§11.1）。通道没起来时和 git 一样直接抛，
    // 用例只在拿不到 groups 时才回「这台机器不支持组合工作空间」。
    // groups 挂在网关外层（不是 gateway 对象上）：ServerGateway 的 gateway 只实现 domain 端口那部分。
    groups: (workerId) => (serverGateway ? serverGateway.groups(workerId) : missingGroups),
    // 会话服务（docs/design/session-service.md）：和 groups 一样挂在网关外层，通道没起来时给替身。
    services: (workerId) => (serverGateway ? serverGateway.services(workerId) : missingServices),
    // 只读进程 / 端口清单：同样挂在网关外层；通道没起来时按不可用处理。
    processes: async (workerId) =>
      serverGateway ? serverGateway.processes(workerId) : err(unavailable('worker 通道尚未就绪'))
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
  occupied: (sessionId) => inbox.occupied(sessionId),
  now: deps.now,
  sessions: deps.sessions,
  projects: deps.projects,
  tasks: deps.tasks,
  messages: store.messages,
  bots: store.bots,
  workspaces: deps.workspaces,
  workspaceGroups: store.workspaceGroups,
  links: store.links,
  policy: deps.access,
  principalOf: (userId) => loadActor(store.users, store.access, userId, 'agent-message'),
  deliver: (sessionId, text, author) => promptSessionUseCase(deps, { sessionId, text, author }),
  spawn: ({ project, role, actor, title }) => openRoleSession(deps, { provenance: store.provenance, audit: store.audit, now: deps.now }, {
    projectId: project.id, title, ownerId: actor.user.id, agentId: role.ref.runtime, model: role.ref.model, options: role.ref.options, botId: role.id, actor, via: 'bot'
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
    projectId: project.id, title, ownerId: actor.user.id, agentId: role.ref.runtime, model: role.ref.model, options: role.ref.options, botId: role.id, actor, via: 'group'
  }),
  interrupt: (sessionId) => interruptSessionUseCase(deps, sessionId),
  lane: sessionLane,
  occupied: (sessionId) => inbox.occupied(sessionId),
  // #219 C3 出站：群帖里的 agent 回复镜回外部渠道（群目标 binding，飞书优先）。
  external: {
    outbox: store.outbox,
    bindingOf: async (groupId) =>
      (await store.connectors.allBindings()).find((b) => b.groupId === groupId && b.targetKind === 'group' && b.enabled) ?? null
  }
});
// 会话收件箱（#221 步骤 5）：各投递来源共用「占用」判断与回合结束归属。
// 顺序即优先级：P2P / 群聊先收（它们要在本轮文字上做判断），连接器与调度随后，最后才放开送达队列投下一条。
const inbox = createSessionInbox({
  sources: [
    { id: 'p2p', open: async (sid: string) => (await store.messages.deliveredTo(asSessionId(sid))).length > 0, end: async (sid, outcome) => { await messageBus.turnEnded(asSessionId(sid), outcome); } },
    { id: 'group', open: async (sid: string) => (await store.groups.deliveredTo(asSessionId(sid))).length > 0, end: async (sid, outcome, reason) => { await groupChat.turnEnded(asSessionId(sid), outcome, reason); } },
    { id: 'connector', open: async () => false, end: async (sid, outcome) => { await connectorHub.turnEnded(asSessionId(sid), outcome); } },
    { id: 'dispatch', open: async () => false, end: async (sid) => { await dispatcher.sessionEnded(asSessionId(sid)); } },
    { id: 'delivery', open: async (sid: string) => (await store.deliveries.pendingFor(sid)).length > 0, end: async (sid) => { await releaseAfterTurn({ ...deps, deliveries: store.deliveries }, asSessionId(sid)); } }
  ]
});
// 持久智能体（界面上叫 bot）：按条读写 bots 表；删除时从所有群移出。
const persistentAgents = createPersistentAgents({
  projects: deps.projects,
  sessions: deps.sessions,
  now: deps.now,
  policy: deps.access,
  bots: store.bots,
  messages: store.messages,
  workspaces: store.workspaces,
  connectors: store.connectors,
  contextSettings: store.contextSettings,
  groupsOf: (projectId) => store.groups.groupsOf(projectId),
  detach: (actor: Parameters<typeof groupChat.detachAgent>[0], projectId: Parameters<typeof groupChat.detachAgent>[1], name: string) => groupChat.detachAgent(actor, projectId, name)
});
// 连接器（ADR 0032 R1）：入站来源只经 InboundSource 端口接进来；核心不认识具体连接器。
// bot 的会话：优先按 sessions.bot_id 查；老会话没有 botId，按派生记录 / 群成员里的名字反查（兼容路径）。
const botOfSession = createBotOfSession({
  sessions: deps.sessions,
  tasks: deps.tasks,
  bots: store.bots,
  workspaces: store.workspaces,
  workspaceGroups: store.workspaceGroups,
  projects: store.projects,
  spawnOf: (sessionId) => store.messages.spawnOf(sessionId),
  memberOfSession: (sessionId) => store.groups.memberOfSession(sessionId)
});
/**
 * git 工具的权限主体（docs/design/agent-git-tools.md §3）：bot 没有自己的账号，
 * 用任务 owner（bot 代表的那个人）/ 会话创建者的用户 principal；普通会话用会话创建者。
 * 找不到人时返回 null，工作流按匿名拒绝，工具不在这里崩。
 */
const subjectOf = async (sessionId: SessionId): Promise<Subject | null> => {
  const session = await deps.sessions.byId(sessionId);
  if (!session) return null;
  // #221 步骤 3：授权签发时冻了身份，工具调用优先读它；旧授权没有 actor 才回落下面的推导。
  const grant = await deps.toolGrants?.activeForSession(sessionId, deps.now());
  const frozen = grant?.actor?.userId ?? null;
  if (frozen !== null) return loadActor(store.users, store.access, frozen, 'agent-git');
  const bot = await botOfSession(sessionId);
  const task = isContainerSession(session) ? null : await deps.tasks.byId(session.taskId as TaskId);
  const userId = bot ? task?.ownerId ?? session.createdBy ?? null : session.createdBy ?? task?.ownerId ?? null;
  return userId ? loadActor(store.users, store.access, userId, bot ? 'agent-bot' : 'agent-git') : null;
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
// 飞书（issue #219 C4 的第一个真实 IM 渠道）：长连接入站，不需要公网回调；出站走已有 channel_outbox。
// 两个环境变量都非空才启用；只配一个是配置错误，启动时就报出来。
const feishuAppId = readEnv('FEISHU_APP_ID');
const feishuAppSecret = readEnv('FEISHU_APP_SECRET');
if (Boolean(feishuAppId) !== Boolean(feishuAppSecret)) throw new Error('飞书连接器：FEISHU_APP_ID 与 FEISHU_APP_SECRET 要同时设置');
const feishuCreds = feishuAppId && feishuAppSecret ? { appId: feishuAppId, appSecret: feishuAppSecret } : null;
const feishuClient = feishuCreds ? createFeishuClient({ ...feishuCreds, log }) : null;
const feishuSink = feishuClient ? createFeishuSink({ outbox: store.outbox, client: feishuClient, now: () => Date.now(), log }) : null;
const feishuSource = feishuCreds ? createFeishuSource({ ...feishuCreds, log }) : null;
const feishuReplies = feishuSink
  ? createFeishuTurnReplies({
    runs: store.connectors,
    tail: (sessionId, limit) => store.sessions.tail(sessionId as SessionId, limit),
    enqueueReply: feishuSink.enqueueReply
  })
  : null;
if (feishuCreds) log('飞书连接器已启用（长连接）');
// 假渠道（#221 步骤 8）：只在 HUB_FAKE_CHANNEL=1 时注册，用来跑通入站/出站/回声整条链。
const fakeChannel = readEnv('HUB_FAKE_CHANNEL') === '1' ? createFakeChannel() : null;
const fakeOutbound = fakeChannel ? createFakeOutbound() : null;
const fakeReplies = fakeChannel
  ? createFakeReplies({ enqueue: (input) => fakeOutboxPump!.enqueue(input as never), tail: (sessionId, limit) => store.sessions.tail(sessionId as never, limit) })
  : null;
if (fakeChannel) log('假渠道已启用：connector=fake（仅测试用，不要在生产打开）');
const connectorHub = createConnectorHub({
  now: deps.now, projects: deps.projects, sessions: deps.sessions, policy: deps.access,
  store: store.connectors,
  sources: [...(fakeChannel ? [fakeChannel.source] : []), createTimerSource(), githubSource, ...(feishuSource ? [feishuSource] : [])],
  agentExists: async (projectId, name) => (await messageBus.config(projectId)).roles.some((r) => r.name === name),
  spawn: async ({ bindingId, connector, projectId, agentName, ownerId, title }) => {
    const role = (await messageBus.config(projectId)).roles.find((r) => r.name === agentName);
    if (!role) return err(notFound(`bot @${agentName} 已不存在`));
    const actor = await loadActor(store.users, store.access, ownerId, 'agent-connector');
    if (!actor) return err(forbidden('建这个触发的账号已停用'));
    const opened = await openRoleSession(deps, { provenance: store.provenance, audit: store.audit, now: deps.now }, {
      projectId, title, ownerId, agentId: role.ref.runtime, model: role.ref.model, options: role.ref.options, botId: role.id, actor, via: 'bot',
      afterDerive: async (session) => {
        // 记成这个 bot 的派生会话：职责说明（系统提示）照常垫进去。先于来历。
        await store.messages.saveSpawn({ sessionId: session.id, projectId: projectId as ProjectId, role: agentName, spawnerSessionId: session.id, traceId: `connector:${session.id}`, createdAt: Date.now() });
      }
    });
    // 假渠道（步骤 8）：记下这条会话从哪来，回合结束后把回复投进出站队列。
    if (opened.ok && fakeReplies && connector === 'fake') fakeReplies.remember(opened.value.id, bindingId);
    return opened;
  },
  // 占用判断统一走收件箱：新增通道只要注册一个 InboxSource，不必再维护第二份旗标。
  busy: (sessionId) => inbox.occupied(asSessionId(sessionId)),
  deliver: (sessionId, text, author) => promptSessionUseCase(deps, { sessionId, text, author }),
  // #219 C3：外部消息可以直接以群为目标。落帖走群聊用例（外部作者 + 创建者身份派生会话）。
  outbox: store.outbox,
  groupOf: async (groupId) => {
    const group = await store.groups.group(groupId);
    return group ? { id: group.id, projectId: group.projectId } : null;
  },
  principalOf: (userId) => loadActor(store.users, store.access, userId, 'agent-connector-group'),
  postExternal: async ({ groupId, author, text, externalId, actor }) => {
    const posted = await groupChat.postExternal({ groupId, author, text, externalId, actor });
    return posted.ok ? ok({ postId: posted.value.post.id }) : posted;
  }
});
connectorHub.start();
// 回滚保护（C1）：旧二进制不认识 target_kind，会把群目标读成主会话；回滚前先禁用这些 binding。
void store.connectors.allBindings().then((all) => {
  const groups = all.filter((b) => b.targetKind === 'group').length;
  if (groups > 0) log(`连接器：有 ${groups} 条群目标 binding；回滚到旧版本前请先禁用它们`);
}).catch(() => undefined);
setInterval(() => void connectorHub.tick().catch((error: unknown) => log(`连接器重试失败：${String(error)}`)), 15_000).unref();
// 调度器（ADR 0032 R3）：task.create 建出的任务排队 → 按上限开任务智能体会话 → 一轮结束经送达队列通知建它的 bot。
// 只经端口：开会话 / 发消息复用现有派生 + 送达流程；人直接开的会话不经过这里。
const sessionOwner = (ownerId: string) => loadActor(store.users, store.access, ownerId, 'agent-dispatch');
const taskProgress = createTaskProgress({
  now: deps.now,
  workLog: store.workLog,
  groupOfSession: async (sessionId) => {
    const member = await groupChat.memberOf(asSessionId(sessionId));
    return member ? { groupId: member.groupId } : null;
  },
  postToGroup: (groupId, body) => groupChat.postSystem(groupId, body),
  log
});

const dispatcher = createDispatcher({
  now: deps.now,
  store: store.dispatches,
  progress: (d, kind, detail) => taskProgress.emit(d, kind, detail),
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
    // 调度出来的会话也继承建任务的 bot 的启动选项（与 P2P / 群聊 / 连接器三条派生同源）。
    const bot = d.notifySessionId ? await botOfSession(d.notifySessionId as SessionId) : null;
    const role = bot ? (await messageBus.config(bot.projectId as ProjectId)).roles.find((x) => x.name === bot.name) : null;
    const created = await deriveSessionUseCase(deps, {
      taskId: d.taskId,
      agentId: d.agentId,
      model: d.model ?? '',
      actor,
      ...(role?.ref.options ? { options: role.ref.options } : {})
    });
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
    return (s ? isBusy(s) : false) || (await inbox.occupied(asSessionId(sid)));
  },
  notify: (sid, text) => promptSessionUseCase(deps, { sessionId: sid, text, author: { id: 'dispatch', name: '调度器', via: 'dispatch' } }),
  abandonTask: async (taskId, reason) => { await setTaskStatusUseCase(deps, taskId as TaskId, 'abandoned', 'system', reason).catch(() => undefined); },
  sinks: [createGithubSink({ outbox: store.outbox, now: () => Date.now(), client: githubClient, tokenFor: teamTokenOf, boundRepos: githubReposFor, prLinks: async (taskId) => (await pullRequestRepoEarly.byTask(taskId)).map((l) => l.url), log })],
  log
});
const enqueueDispatch = async (r: AgentTaskRequest) => {
  const creator = await deps.sessions.byId(r.sessionId as SessionId);
  const bot = await botOfSession(r.sessionId as SessionId);
  const role = bot ? (await messageBus.config(bot.projectId as ProjectId)).roles.find((x) => x.name === bot.name) : null;
  await dispatcher.enqueue(r, { agentId: role?.ref.runtime ?? creator?.agentId ?? null, model: role?.ref.model ?? creator?.model ?? null });
  void dispatcher.tick().catch((error: unknown) => log(`调度失败：${String(error)}`));
};
setInterval(() => void dispatcher.tick().catch((error: unknown) => log(`调度失败：${String(error)}`)), 10_000).unref();

// 出站队列（#221 步骤 6）：会话要发到外部渠道的回复先落库，再按租约投递。
// 目前只消费 session 目标；github 等 external 行保持 queued，等平台发送侧接线。
const outboxPump = createOutboxPump({
  store: store.outbox,
  now: () => Date.now(),
  deliver: async (message) => {
    const sent = await promptSessionUseCase(deps, {
      sessionId: message.target.id as SessionId,
      text: message.body,
      author: { id: 'outbox', name: message.author.name, via: 'connector' }
    });
    return sent.ok ? { ok: true } : { ok: false, error: sent.error };
  }
});
// 假渠道的出站：只消费 external 目标（真实渠道的 external 行仍保持 queued）。
const fakeOutboxPump = fakeOutbound
  ? createOutboxPump({ store: store.outbox, now: () => Date.now(), kinds: ['external'], deliver: fakeOutbound.deliver })
  : null;
let fakeOutboxBusy = false;
setInterval(() => {
  if (!fakeOutboxPump || fakeOutboxBusy) return;
  fakeOutboxBusy = true;
  void (async () => {
    try {
      for (let i = 0; i < 10; i++) if ((await fakeOutboxPump.tick()) === 0) break;
    } catch (error) {
      log(`假渠道出站失败：${String(error)}`);
    } finally {
      fakeOutboxBusy = false;
    }
  })();
}, 1_000).unref();
// 飞书出站：只认领 `feishu:` 前缀的 external 行，github 的回帖继续留在队列里等各自的发送侧。
const feishuOutboxPump = feishuSink
  ? createOutboxPump({ store: store.outbox, now: () => Date.now(), kinds: ['external'], targetPrefixes: ['feishu:'], deliver: feishuSink.deliver })
  : null;
let feishuOutboxBusy = false;
setInterval(() => {
  if (!feishuOutboxPump || feishuOutboxBusy) return;
  feishuOutboxBusy = true;
  void (async () => {
    try {
      for (let i = 0; i < 10; i++) if ((await feishuOutboxPump.tick()) === 0) break;
    } catch (error) {
      log(`飞书出站失败：${String(error)}`);
    } finally {
      feishuOutboxBusy = false;
    }
  })();
}, 1_000).unref();
let outboxBusy = false;
setInterval(() => {
  if (outboxBusy) return;
  outboxBusy = true;
  void (async () => {
    try {
      for (let i = 0; i < 10; i++) if ((await outboxPump.tick()) === 0) break;
    } catch (error) {
      log(`出站队列失败：${String(error)}`);
    } finally {
      outboxBusy = false;
    }
  })();
}, 1_000).unref();
const contextService = createContextService({ projects: deps.projects, tasks: deps.tasks, sessions: deps.sessions, access: deps.access, now: () => Date.now(), contextSettings: store.contextSettings, audit: store.audit, gateway: deps.gateway,
  // 角色层（ADR 0020 §8）：派生出来的角色会话 → 角色；否则群里的成员 → 角色
  roleOf: async (sessionId) => (await store.messages.spawnOf(sessionId as SessionId))?.role ?? (await store.groups.memberOfSession(sessionId as SessionId))?.role ?? null,
  // bot 职责说明（系统提示）：DM / 派生会话 / 群成员会话都在会话开头垫一次
  agentOf: async (projectId, role) => (await messageBus.config(projectId as ProjectId)).roles.find((r) => r.name === role) ?? null });
(deps as { sessionInstructions?: (sessionId: string) => Promise<string | null> }).sessionInstructions = (sessionId) => contextService.instructionsFor(sessionId);
const offlineBrowser = offlineWorkspaceBrowser('worker 通道尚未就绪');
const filesService = createWorkspaceFilesService({
  projects: deps.projects, tasks: deps.tasks, sessions: deps.sessions, workspaces: deps.workspaces, workspaceGroups: store.workspaceGroups, bots: store.bots, gateway: deps.gateway, access: deps.access, audit: store.audit,
  local: createWorkspaceBrowser(),
  remote: (workerId) => (serverGateway ? serverGateway.browser(workerId) : offlineBrowser),
  bases: store.sessionBases,
  checkpoints: store.checkpoints,
  now: () => Date.now()
});
const rewindService = createRewindService({ ...deps, files: filesService, turnRefs: store.turnRefs });
type TurnOutcome = 'done' | 'stopped' | 'interrupted' | 'failed';
/**
 * 一轮结束的收尾。回合结束（event `ended`）与进程保活（status `idle`）都会到这里：
 * 各钩子自己幂等（开放的投递 / 未收尾的检查点处理过一次就空转），重复调用无害。
 */
const turnFinished = (sessionId: SessionId, outcome: TurnOutcome, reason?: string): void => {
  // 各来源自己幂等：先让它们收这一轮（P2P/群聊要读本轮的最后一句话），送达队列最后放开投下一条。
  void inbox.end(sessionId, outcome, reason).catch((error: unknown) => log(`回合收尾失败：${String(error)}`));
  // 回合结束后拍「之后」那张（ADR 0027 D2）
  void filesService.endTurn(sessionId).catch((error: unknown) => log(`回合检查点失败：${String(error)}`));
  // 假渠道：把这轮回复投进出站队列（只在 HUB_FAKE_CHANNEL=1 时有路由）。
  void fakeReplies?.finish(sessionId).catch((error: unknown) => log(`假渠道回程失败：${String(error)}`));
  // 飞书：这一轮若由飞书消息触发，把回复写进 outbox 并回在原消息下面。
  void feishuReplies?.finish(sessionId).catch((error: unknown) => log(`飞书回程失败：${String(error)}`));
};
hub.stream.subscribe((frame) => {
  if (frame.event?.kind === 'ended') turnFinished(frame.sessionId, frame.event.outcome, frame.event.reason);
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
// 送出去却一直没下文的回合：Worker 丢过任务、掉线或旧协议不认这条会话时，别让队首永远堵着。
let recovering = false;
setInterval(() => {
  if (recovering) return;
  recovering = true;
  void recoverOrphanedTurns({ ...deps, deliveries: store.deliveries })
    .then((n) => n > 0 && log(`送达队列：${n} 条送出去没有下文，按失败收尾并放行后面的消息`))
    .catch((error: unknown) => log(`回收没有下文的回合失败：${String(error)}`))
    .finally(() => { recovering = false; });
}, 10_000).unref();
setInterval(() => void filesService.sweepCheckpoints().catch(() => undefined), 3_600_000).unref();
setInterval(() => void groupChat.sweep().catch(() => undefined), 15_000).unref();

// 记忆（ADR 0019 · P1）：SQLite + FTS5 默认适配器；来源就地索引（ADR、文档、任务）；只经工具读，第一轮只垫一行静态引导。
// 记忆适配器都经注册表装配（memory.md §16）：来源、提炼、检索 / 排序、维护任务、治理各是一个端口。
const providerRepo = createSqliteProviders(store.db, secretKey);
const projectTeamOf = async (projectId: string) => (await store.projects.byId(projectId as ProjectId))?.teamId ?? null;
const pullRequestRepo = pullRequestRepoEarly;
const workspaceSweeps = createSqliteWorkspaceSweeps(store.db);
// 清理（ADR 0027 阶段 3）：按 PR 合并 / 任务结束判断，删工作空间时一起删检查点 ref
(deps as { cleanup?: Deps["cleanup"] }).cleanup = {
  sweeps: workspaceSweeps,
  pullRequests: pullRequestRepo,
  dropCheckpoints: (sessionId: string) => filesService.dropSession(sessionId),
  // 终端桥在下面才装配，这里留一个晚绑定的钩子：terminalId 形如 `<sessionId>:<n>`。
  liveSessions: () => (terminalBridge === null ? [] : [...terminalBridge.knownTerminals()].map((id) => id.split(':')[0] ?? '').filter(Boolean))
};
// 提交 / 推送 / PR（ADR 0027 阶段 2）：文字由提炼模型写（D4），PR 走团队 token → gh → 链接（D3）
const gitService = createGitWorkflowService({
  projects: deps.projects, tasks: deps.tasks, sessions: deps.sessions, workspaces: deps.workspaces, workspaceGroups: store.workspaceGroups, bots: store.bots, gateway: deps.gateway, access: deps.access, audit: store.audit,
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
  bots: store.bots,
  workspaceGroups: store.workspaceGroups,
  workspaces: deps.workspaces,
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
    // issue #216：agent 不 shell git/gh 也能 commit / push / 开 PR；权限与审计走工作流。
    createGitToolProvider({ workflow: gitService, subjectOf }),
    // issue #216 P2：产物列表 / 引用登记与工作空间文件只读。
    createArtifactToolProvider({ sessions: deps.sessions, artifacts: deps.artifacts, tasks: deps.tasks, workLog: deps.workLog, now: deps.now }),
    createWorkspaceToolProvider({ files: filesService, subjectOf }),
    // issue #216 P1：agent 可以改项目约定、在机器上跑项目声明的检查命令。
    createProjectToolProvider({
      sessions: deps.sessions,
      tasks: deps.tasks,
      projects: deps.projects,
      workspaceGroups: deps.workspaceGroups,
      bots: deps.bots,
      workspaces: deps.workspaces,
      gateway: deps.gateway,
      access: deps.access,
      subjectOf,
      update: async ({ projectId, description, checks }) => {
        let current = await deps.projects.byId(projectId as never);
        if (!current) return err(notFound('项目不存在'));
        if (description !== undefined) {
          const next = await setProjectDescriptionUseCase(deps, { projectId, description });
          if (!next.ok) return next;
          current = next.value;
        }
        if (checks !== undefined) {
          const next = await setProjectChecksUseCase(deps, { projectId, checks });
          if (!next.ok) return next;
          current = next.value;
        }
        return ok(current);
      }
    }),
    // issue #216 P1：agent 可以派生子会话、收掉跑偏的会话（同项目才允许）。
    createSessionControlToolProvider({
      sessions: deps.sessions,
      tasks: deps.tasks,
      projects: deps.projects,
      workspaceGroups: deps.workspaceGroups,
      bots: deps.bots,
      workspaces: deps.workspaces,
      access: deps.access,
      subjectOf,
      derive: (command) => deriveSessionUseCase(deps, command),
      interrupt: (sessionId) => interruptSessionUseCase(deps, sessionId),
      rename: (command) => renameSessionUseCase(deps, command)
    }),
    createAgentOrchestrationToolProvider({
      agentProfiles: deps.agentProfiles,
      sessions: deps.sessions,
      tasks: deps.tasks,
      projects: deps.projects,
      agents: deps.agents,
      now: deps.now,
      spawn: async (input) => {
        // 档位：agent 要求隔离时现建 worktree（按项目配置跑准备命令），与 /api/sessions/derive 同一条路径。
        let workspaceId: string | undefined;
        if (input.workspaceMode) {
          const task = await deps.tasks.byId(asTaskId(input.taskId));
          if (!task) return err(notFound('任务不存在'));
          const prepared = await prepareTemporaryWorkspaceUseCase(deps, {
            projectId: task.projectId,
            taskId: task.id,
            workerId: null,
            home: homedir(),
            mode: input.workspaceMode,
            actor: systemSubject('agent.spawn')
          });
          if (!prepared.ok) return prepared;
          workspaceId = prepared.value.id;
        }
        const created = await deriveSessionUseCase(deps, {
          taskId: input.taskId,
          agentId: input.agentId,
          model: input.model,
          options: input.options,
          ...(workspaceId === undefined ? {} : { workspaceId }),
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
// 公网绑定必须能证明「这台 hub 有主」：要么配了 HUB_TOKEN（给脚本/worker），要么已经有主人账号。
// 放在账号仓库打开之后（才知道有没有主人），又放在种测试账号之前（测试账号不算主人的证明）。
if (!LOOPBACKS.has(host) && token === null && (await accounts.users.firstClusterAdmin()) === null) {
  console.error(
    `拒绝启动：绑定到 ${host}，但既没设 HUB_TOKEN，也还没有主人账号。\n` +
      '先在本机注册主人账号，或设置 HUB_TOKEN 再启动。'
  );
  store.close();
  process.exit(1);
}
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

/**
 * 同一台 Worker 的 attached / gone 串行。两条路各自异步查库、写库，交错时后写的一方会拿
 * 旧快照把状态写回去（重连刚接回的 running 被迟到的掉线覆盖）。按 workerId 排成一条链，
 * 回调到达的顺序就是执行顺序。
 */
const workerTurns = new Map<string, Promise<void>>();
function workerTurn(workerId: string, run: () => Promise<unknown>): Promise<unknown> {
  const previous = workerTurns.get(workerId) ?? Promise.resolve();
  const executed = previous.then(() => run());
  const settled = executed.then(
    () => undefined,
    () => undefined
  );
  workerTurns.set(workerId, settled);
  void settled.then(() => {
    if (workerTurns.get(workerId) === settled) workerTurns.delete(workerId);
  });
  return executed;
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
  updateProvider: (sessionId, workerId, models) => serverGateway?.updateProvider(sessionId, workerId, models) ?? false,
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
  delivery: {
    push: async (workerId, manifest, retain, sessions) =>
      serverGateway ? serverGateway.assets.push(workerId, manifest, retain, sessions) : err(unavailable('worker 通道尚未就绪'))
  },
  board: store.assetSync,
  workers: workerControl,
  projects: store.projects,
  secrets: createSecretVault(store.db, secretKey),
  now: () => Date.now()
};
// ADR 0016 迁移：老资产记到 hub 管理员名下（全局 / 项目级，已发布）；幂等，重启不重复。
{
  const migrated = await migrateAssetOwnership(assetDeps);
  if (migrated.migrated > 0) log(`资产审核迁移：${migrated.migrated} 个老资产记到 hub 管理员名下，${migrated.pending} 个未钉的新版本转成待审提交`);
}
const remoteMcpClients = createRemoteClients();
sessionEnvironment = createSessionEnvironment({
  assetDeps,
  assetSets: store.assetSets,
  tasks: store.tasks,
  projects: store.projects,
  containerProject: async (sessionId) => {
    const session = await store.sessions.byId(sessionId as SessionId);
    if (!session) return null;
    const project = await projectOfSession({ tasks: store.tasks, projects: store.projects, bots: store.bots, workspaces: store.workspaces, workspaceGroups: store.workspaceGroups }, session);
    return project ? { projectId: project.id as ProjectId, ownerId: session.createdBy ?? null } : null;
  },
  // 预览与下发必须用同一个人（会话发起人）：否则个人资产在勾选列表与真实清单之间分叉。
  sessionOwner: async (sessionId) => (await store.sessions.byId(sessionId as SessionId))?.createdBy ?? null,
  // 会话级资产选择（#226）：显式清单就只带那些，未选的（比如 grill-me）不会下发。
  selectedAssetIds: async (sessionId) => (await store.sessions.byId(sessionId as SessionId))?.assetIds ?? null,
  // 会话显式资产组合优先；没有就用项目默认（planFor 内处理）。
  selectedAssetSetIds: async (sessionId) => (await store.sessions.byId(sessionId as SessionId))?.assetSetIds ?? null,
  // 允许清单 + 自动预热（#226）：候选资产先装到这台机器并同步，装不上就拦住启动。
  preheat: async (workerId, assetIds) => {
    try {
      const installed = new Set(
        (await store.assets.installations()).filter((row) => row.workerId === workerId).map((row) => row.assetId)
      );
      const missing = assetIds.filter((assetId) => !installed.has(assetId));
      for (const assetId of missing) await store.assets.install(workerId, assetId, Date.now());
      const status = await syncWorkerAssets(assetDeps, workerId);
      if (status.state === 'failed') {
        log(`资产预热失败（${workerId}）：${status.error ?? '同步失败'}`);
        return null;
      }
      const landed: Record<string, string> = {};
      for (const assetId of assetIds) {
        const digest = status.installed[assetId];
        if (digest === undefined) {
          log(`资产预热没落地（${workerId}）：${assetId}`);
          return null;
        }
        landed[assetId] = digest;
      }
      return landed;
    } catch (failure) {
      log(`资产预热失败（${workerId}）：${(failure as Error).message}`);
      return null;
    }
  },
  log
});
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
  /** 自定义运行时别名（CAP-1）：连上就把这台机器存着的配置推下去。没配过 = null，不发帧。 */
  agentConfig: (workerId) => store.workerAgents.get(workerId),
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
      void workerTurn(worker.workerId, async () => {
        const ids = await workerAttached(deps, worker.workerId, sessions);
        serverGateway?.adopt(worker.workerId, ids);
        log(`接回 ${ids.length} 个还在跑的会话`);
      }).catch((failure: unknown) => log(`接回会话失败：${(failure as Error).message}`));
    }
  },
  // 组合根只负责「把回调接到用例上、失败了打日志」，业务规则都在 domain 里。
  onEvent(workerId, sessionId, event) {
    if (event.kind === 'tool_call') {
      void store.dispatches
        .bySession(sessionId)
        .then((d) => taskProgress.emit(d, 'milestone', event.name))
        .catch(() => undefined);
    }
    // 注意：`ended` 是**回合**事件（且进程会保活），不能在这里收 provider 句柄 / 终端；
    // 那些等真正的进程结束（onStatus 的 'ended'）再做。
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
      void (async () => {
        await ingestRuntimeStatus(deps, sessionId, status);
        // idle / ended 都意味着「这一轮结束了」：补一遍回合收尾（幂等）。
        // idle 时进程还活着、托管不撤；ended 才是真结束，额外撤 provider 句柄与终端。
        if (status === 'idle' || status === 'ended') {
          // 事件帧和状态帧是两条路：这里先排一次这条会话的队，等已经到达的 ended 事件落盘，
          // 再照库里的结果补一遍收尾——否则可能把正常回合判成 failed。
          await deps.queue.run(sessionId, async () => undefined);
          const session = await deps.sessions.byId(sessionId);
          turnFinished(sessionId, session?.status === 'done' ? 'done' : 'failed');
        }
        if (status === 'ended') {
          providerWiring.revoke(sessionId);
          terminalBridge?.closeSession(sessionId);
        }
        // 一轮结束/进程消失都不回收工具令牌：ACP 进程只在 session/new|load 时拿到
        // MCP Authorization，后续 prompt 无法热换 token。授权随会话保留，dispose 时再作废。
      })();
    });
  },
  onWorkerGone(workerId, reason) {
    catalog.removeWorker(workerId);
    // 异步收尾：把挂在这台机器上还停着 running 的会话降级成 interrupted（表里不留假运行）。
    void workerTurn(workerId, () => workerGone(deps, workerId)).catch((error: unknown) => log(`worker 离线收尾失败：${String(error)}`));
    // 机器没了，它上面的 PTY 也没了：只关对应的浏览器 WS，不发 terminal.close。
    terminalBridge?.closeWorker(workerId);
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
  // 终端：worker 重连后对账（清掉 hub 不知道的残留 PTY）与数据 / 退出帧都转给桥接。
  knownTerminals: (workerId) => terminalBridge?.knownTerminals(workerId) ?? new Set<string>(),
  onTerminalData(workerId, terminalId, data) {
    terminalBridge?.onWorkerData(workerId, terminalId, data);
  },
  onTerminalExit(workerId, terminalId, code) {
    terminalBridge?.onWorkerExit(workerId, terminalId, code);
  },
  // 会话服务（docs/design/session-service.md）：worker 推的状态 / 输出直接落库；hub 不做乐观状态。
  knownServices: async (workerId) =>
    new Set(
      (await store.sessionServices.listByWorker(workerId))
        .filter((service) => service.state === 'running' || service.state === 'starting')
        .map((service) => service.id)
    ),
  onServiceState(workerId, event) {
    void recordServiceStateUseCase({ sessionServices: store.sessionServices, now: deps.now }, event.serviceId, {
      state: event.state,
      pid: event.pid ?? null,
      detail: event.detail ?? null
    }).catch((error: unknown) => log(`记录服务状态失败（${workerId}/${event.serviceId}）：${String(error)}`));
  },
  onServiceLog(workerId, serviceId, chunk) {
    void recordServiceLogUseCase({ sessionServices: store.sessionServices }, serviceId, chunk).catch((error: unknown) =>
      log(`记录服务日志失败（${workerId}/${serviceId}）：${String(error)}`)
    );
  },
  onServiceMissing(workerId, serviceId) {
    void recordServiceStateUseCase({ sessionServices: store.sessionServices, now: deps.now }, serviceId, {
      state: 'failed',
      pid: null,
      detail: '机器重启后没有拉起来'
    }).catch((error: unknown) => log(`标记服务失联失败（${workerId}/${serviceId}）：${String(error)}`));
  },
  onLog: log
});

// 会话终端（docs/design/terminal.md）：浏览器 WS 的鉴权沿用 cookie + session.prompt
// （能往 PTY 里打字等于能以会话身份执行命令，viewer 不该有，issue #213）；
// 目标机器 / 目录由 domain 的 terminalTarget 决定，桥接只管帧和生命周期。
terminalBridge = createTerminalBridge({
  gateway: serverGateway,
  authenticate: async (value) => withAccess(store.access, await authenticate(accounts, value), accounts.now()),
  target: (subject, sessionId) => terminalTarget(deps, subject, sessionId),
  access: (subject, sessionId) => terminalAccess(deps, subject, sessionId),
  hostAllowed: (hostname) => guard.hostAllowed(hostname),
  log
});

/**
 * 预览转发（docs/design/preview.md）：每一条预览链接在 hub 上占一个端口，
 * 浏览器访问那个端口时按帧转发给 worker 的 `/preview` 通道，再由 worker 打到本机回环端口。
 * `HUB_PREVIEW_PORTS` 为空串或 `0` 时整块关闭。
 */
const previewPorts = parsePreviewPortRange(readEnv('HUB_PREVIEW_PORTS'), port);
let previewChannel: PreviewChannel | null = null;
let previewProxy: PreviewProxy | null = null;
if (previewPorts !== null) {
  const previewLog = (message: string) => log(`[preview] ${message}`);
  const sameSecret = (given: string, expected: string): boolean => {
    const left = Buffer.from(given);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
  };
  previewChannel = createPreviewChannel({
    verifyWorker: async (request) => {
      const header = request.headers.authorization;
      if (typeof header === 'string' && header.startsWith('Bearer ')) {
        const credential = header.slice('Bearer '.length).trim();
        if (credential === '') return null;
        const found = await enrollmentDeps.enrollment.credentialByHash(enrollmentDeps.tokens.hashOf(credential));
        if (found === null || found.revokedAt !== null) return null;
        return { workerId: found.workerId };
      }
      // 本机 Worker 没有专属凭据：用它自报的 workerId + hub 生成的 localSecret。
      const secret = request.headers['x-hub-local-secret'];
      const workerId = request.headers['x-hub-worker-id'];
      if (spawnWorker !== '1' || typeof secret !== 'string' || typeof workerId !== 'string') return null;
      return sameSecret(secret, localSecret) ? { workerId } : null;
    },
    // P2：worker 每 10 秒报一次自己回环上在监听的端口，用来把链接标 ready / stale。
    onPorts: (workerId, ports) => {
      void (async () => {
        const listening = new Set(ports);
        const links = (await store.previewLinks.listAll()).filter((link) => link.workerId === workerId);
        let changed = 0;
        for (const link of links) {
          const wanted = listening.has(link.port);
          const state: PreviewLink['state'] = wanted ? 'ready' : link.state === 'offline' ? 'offline' : 'stale';
          if (state === link.state && !wanted) continue;
          await store.previewLinks.save({
            ...link,
            state,
            ...(wanted ? { lastSeenAt: accounts.now() } : {})
          });
          changed += 1;
        }
        if (changed > 0) previewLog(`端口状态更新：${changed} 条（${workerId}）`);
      })().catch((failure: unknown) => previewLog(`同步端口状态失败：${(failure as Error).message}`));
    },
    // P2：终端输出里认出端口就自动挂一条预览（幂等、上限与端口分配都走领域用例）。
    onDetected: (workerId, event) => {
      void (async () => {
        if (previewProxy === null || previewPorts === null) return;
        const created = await createPreviewLinkUseCase(
          {
            projects: deps.projects,
            tasks: deps.tasks,
            sessions: deps.sessions,
            workspaces: deps.workspaces,
            access: deps.access,
            previewLinks: store.previewLinks,
            previewPorts,
            now: accounts.now
          },
          systemSubject('preview.detected'),
          { sessionId: event.sessionId, port: event.port, source: 'detected', ...(event.label === undefined ? {} : { label: event.label }) }
        );
        if (!created.ok) {
          // 「最多 8 条」「端口用完了」这类是正常上限，不打扰日志。
          if (created.error.code !== 'conflict') previewLog(`自动挂预览失败：${created.error.message}`);
          return;
        }
        if (created.value.workerId !== workerId) return;
        await previewProxy.listen(created.value);
        previewLog(`自动发现端口 ${created.value.port}（会话 ${event.sessionId.slice(0, 8)}）`);
      })().catch((failure: unknown) => previewLog(`自动挂预览失败：${(failure as Error).message}`));
    },
    onWorkerDown: (workerId) => {
      void markWorkerPreviewsOfflineUseCase({ previewLinks: store.previewLinks }, workerId)
        .then((changed) => {
          if (changed > 0) log(`${changed} 条预览链接随机器离线（${workerId}）`);
        })
        .catch((failure: unknown) => previewLog(`标记离线失败：${(failure as Error).message}`));
    },
    onLog: previewLog
  });
  // 预览端口上的 302 要跳回 hub 自己的登录页（预览 origin 上没有 SPA）。
  const hubOrigin =
    readEnv('HUB_PUBLIC_URL') ??
    `http://${host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host}:${port}`;
  previewProxy = createPreviewProxy({
    resolve: (hubPort) => store.previewLinks.byHubPort(hubPort),
    loginUrl: (_request, _link, target) => `${hubOrigin}/login?next=${encodeURIComponent(target)}`,
    authorize: async (request, link) => {
      const token = loginTokenOf(request.headers.cookie);
      if (token === '') return false;
      const subject = await withAccess(store.access, await authenticate(accounts, token), accounts.now());
      if (subject === null) return false;
      const session = await store.sessions.byId(link.sessionId);
      if (session === null) return false;
      const project = await projectOfSession({ tasks: store.tasks, projects: store.projects, bots: store.bots, workspaces: store.workspaces, workspaceGroups: store.workspaceGroups }, session);
      return (await authorizeSession(deps.access, subject, project, session, 'session.read')).ok;
    },
    matchShare: (link, token) =>
      matchPreviewShare({ previewLinks: store.previewLinks }, link.id, token, accounts.now()).then(
        (result) => result.ok
      ),
    channel: previewChannel,
    host,
    onConflict: (linkId) => {
      void (async () => {
        const link = await store.previewLinks.byId(linkId as PreviewLinkId);
        if (link !== null && link.state !== 'stale') await store.previewLinks.save({ ...link, state: 'stale' });
      })().catch((failure: unknown) => previewLog(`端口冲突处理失败：${(failure as Error).message}`));
    },
    onLog: previewLog
  });
}

/**
 * 预览自动发现（docs/design/session-service.md §9）：进程的工作目录落在某条会话的工作目录里、
 * 端口又在听，就替这条会话挂一条预览链接——人不用再手填端口。
 * `HUB_PREVIEW_AUTO=0` 可以关掉；上限、去重、端口合法性都在 `preview-autolink.ts` 里。
 */
const autoDiscoverPreviews = async (): Promise<void> => {
  if (previewProxy === null || previewPorts === null) return;
  if (readEnv('HUB_PREVIEW_AUTO') === '0') return;
  const links = await store.previewLinks.listAll();
  const spaces = [...(await store.workspaces.temporaries()), ...(await store.workspaces.longLived())];
  const owners: WorkspaceOwner[] = [];
  const allowed = new Set<string>();
  const workerIds = new Set<string>();
  for (const space of spaces) {
    if (space.workerId === null) continue;
    for (const session of await store.sessions.listByWorkspace(space.id)) {
      if (session.status === 'failed') continue;
      if (session.workerId !== space.workerId) continue;
      owners.push({ sessionId: session.id, workerId: space.workerId, path: space.path });
      allowed.add(session.id);
      workerIds.add(space.workerId);
    }
  }
  if (owners.length === 0) {
    if (readEnv('HUB_PREVIEW_DEBUG') === '1') log(`预览自动发现：没有可挂的会话（空间 ${spaces.length} 个）`);
    return;
  }
  for (const workerId of workerIds) {
    const listed = await deps.gateway.processes?.(workerId);
    if (listed === undefined) {
      if (readEnv('HUB_PREVIEW_DEBUG') === '1') log('预览自动发现：网关没有提供进程清单');
      continue;
    }
    if (!listed.ok) {
      if (readEnv('HUB_PREVIEW_DEBUG') === '1') log(`预览自动发现：${workerId} 的进程清单拿不到：${listed.error.message}`);
      continue;
    }
    if (readEnv('HUB_PREVIEW_DEBUG') === '1') log(`预览自动发现：${workerId} ${listed.value.length} 个进程，会话 ${owners.length} 条`);
    const candidates = autoLinkCandidates(
      listed.value.map((process) => ({ pid: process.pid, cwd: process.cwd, ports: process.ports })),
      owners,
      { links, allowedSessions: allowed }
    );
    for (const candidate of candidates) {
      const created = await createPreviewLinkUseCase(
        {
          projects: deps.projects,
          tasks: deps.tasks,
          sessions: deps.sessions,
          workspaces: deps.workspaces,
          access: deps.access,
          previewLinks: store.previewLinks,
          previewPorts,
          now: accounts.now
        },
        systemSubject('preview.detected'),
        { sessionId: candidate.sessionId as SessionId, port: candidate.port, source: 'detected' }
      );
      if (!created.ok) {
        if (created.error.code !== 'conflict') log(`按进程自动挂预览失败：${created.error.message}`);
        continue;
      }
      await previewProxy.listen(created.value);
      log(`按进程自动挂了预览：${candidate.sessionId} 端口 ${candidate.port}`);
    }
  }
};

/** 预览端口和库里的链接对齐：新加的开监听、删掉的关掉。启动时一次，之后每 30 秒一次。 */
const reconcilePreviews = async (): Promise<void> => {
  if (previewProxy === null) return;
  await autoDiscoverPreviews().catch((failure: unknown) => log(`自动发现预览失败：${(failure as Error).message}`));
  const links = await store.previewLinks.listAll();
  const wanted = new Set<string>(links.map((link) => link.id));
  for (const listening of previewProxy.listening()) {
    if (!wanted.has(listening.linkId)) await previewProxy.unlisten(listening.linkId as PreviewLinkId);
  }
  const active = new Set(previewProxy.listening().map((entry) => entry.linkId));
  for (const link of links) {
    if (!active.has(link.id)) await previewProxy.listen(link);
  }
};
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
const apiTokenDeps = {
  apiTokens: createSqliteApiTokens(store.db),
  users: store.users,
  projects: store.projects,
  tokens: createTokenIssuer(),
  audit: store.audit,
  botExists: async (projectId: string, name: string) => (await messageBus.config(projectId as never)).roles.some((role) => role.name === name),
  now: () => Date.now()
};
const envNumber = (name: string): number | undefined => {
  const value = readEnv(name);
  return value === null || value === undefined ? undefined : Number(value);
};

const observeEnabled = readEnv('OBSERVE') !== '0';
const botDeps = {
  ...deps,
  messages: store.messages,
  connectors: store.connectors,
  contextSettings: store.contextSettings,
  detach: (actor: Parameters<typeof groupChat.detachAgent>[0], projectId: Parameters<typeof groupChat.detachAgent>[1], name: string) => groupChat.detachAgent(actor, projectId, name)
};
const app = createApp({ deps, hub, token, connectors: { hub: connectorHub, agentTasks: store.agentTasks, dispatcher, onCreated: enqueueDispatch }, waitOptions: optionWaiters.wait, guard,
  observe: {
    enabled: observeEnabled,
    readers: observeEnabled ? [createConnectorObserveReader({
      now: deps.now, projects: deps.projects, sessions: deps.sessions, tasks: deps.tasks,
      deliveries: store.deliveries, store: store.connectors, requests: store.agentTasks, dispatches: store.dispatches, policy: deps.access
    })] : []
  }, 
  auth: { accounts, access: store.access, team: { ...accounts, invites: store.invites, projects: store.projects, roles: store.access.roles }, accessAdmin: { ...store.access, users: store.users, teams: store.teams, audit: store.audit, now: () => Date.now() }, loginRateMax: Number(readEnv('HUB_LOGIN_RATE_MAX') ?? 30), mailRateMax: Number(readEnv('HUB_MAIL_RATE_MAX') ?? 5), mailDelivery: mailSetup.transport !== 'log' },
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
  assets: {
    deps: assetDeps,
    audit: store.audit,
    assetSets: store.assetSets,
    sessions: store.sessions,
    environment: sessionEnvironment ?? undefined,
    // 派生前预览：这台机器上这个项目实际会带哪些资产（#226 会话级资产选择）。
    // 派生前还没有会话：约定「发起这次派生的人就是未来的 owner」，预览按他算个人/团队资产。
    // 下发时用会话自己的 createdBy（planFor 的 sessionOwner），两者不匹配时以会话为准。
    planOf: async (projectId, workerId, principal) => {
      const project = await store.projects.byId(asProjectId(projectId));
      const visible = await authorizeProject(deps.access, principal, project, 'session.read');
      if (!visible.ok) return 'forbidden';
      const plan = await resolveSessionAssets({ assets: assetDeps.assets, board: assetDeps.board, assetSets: store.assetSets }, {
        sessionId: 'preview',
        workerId,
        projectId,
        viewer: { userId: principal.user.id, teamId: visible.value.teamId ?? null },
        setIds: project?.assetSetIds ?? [],
        log
      });
      return plan.entries;
    }
  },
  providers: providerWiring,
  // 预览链接（docs/design/preview.md §4）：只装 `/api/sessions/:id/previews` 三条路由，转发在代理层。
  ...(previewPorts === null ? {} : { previews: { deps: { ...deps, previewLinks: store.previewLinks }, ports: previewPorts, afterChange: () => reconcilePreviews(), ...(readEnv('HUB_PUBLIC_URL') === null ? {} : { publicHost: new URL(readEnv('HUB_PUBLIC_URL') as string).hostname, https: new URL(readEnv('HUB_PUBLIC_URL') as string).protocol === 'https:' }) } }),
  services: { deps: { ...deps, sessionServices: store.sessionServices } },
  resources: { metrics: workerMetrics, settings: store.settings, workers: workerControl, audit: store.audit, now: () => Date.now(), access: deps.access },
  /** 每台 Worker 的自定义运行时别名（CAP-1）：存库 + 推给在线 Worker（离线就等它下次连上自动推）。 */
  workerAgents: {
    repo: store.workerAgents,
    send: (workerId, aliases) => serverGateway?.sendAgentConfig(workerId, aliases) ?? false,
    audit: store.audit,
    now: () => Date.now()
  },
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
  projectDeletion: {
    toolGrants: store.toolGrants,
    audit: store.audit,
    onSessionsPurged: (sessionIds) => {
      for (const sessionId of sessionIds) terminalBridge?.closeSession(sessionId);
    }
  },
  activity: { audit: store.audit, users: store.users, provenance: store.provenance },
  attention: { store: store.attention, pullRequests: pullRequestRepo },
  messaging: { bus: messageBus, messages: store.messages },
  bots: {
    listBots: (actor, projectId) => listBotsUseCase(botDeps, actor, projectId),
    botGrants: (actor, id) => botGrantsUseCase(botDeps, actor, id),
    teamBots: (actor, teamId) => listTeamBotsUseCase(botDeps, actor, teamId),
    grantBot: (actor, id, projectId, workspaceId) => grantBotUseCase(botDeps, actor, id, projectId, workspaceId),
    revokeBot: (actor, id, projectId) => revokeBotUseCase(botDeps, actor, id, projectId),
    getBot: (actor, id) => getBotUseCase(botDeps, actor, id),
    createBot: (actor, projectId, input) => createBotUseCase(botDeps, actor, projectId, input),
    updateBot: (actor, id, patch) => updateBotUseCase(botDeps, actor, id, patch),
    // 删 bot 时自动从群里移出（老 /agents 路径在 createPersistentAgents 里做，这里补一等 bot 的路径）
    removeBot: async (actor, id) => {
      const current = await store.bots.byId(id);
      const grants = current ? await store.bots.grantsOf(id) : [];
      const removed = await removeBotUseCase(botDeps, actor, id);
      // 授权是「这个 bot 在哪些项目里可用」：删 bot 时逐个项目把它从群里移出。
      if (removed.ok && current && actor) for (const grant of grants) await groupChat.detachAgent(actor, grant.projectId, current.name);
      return removed;
    }
  },
  groups: { groups: groupChat, agents: persistentAgents, agentTokens: apiTokenDeps.apiTokens },
  context: contextService,
  files: filesService,
  git: gitService,
  rewind: rewindService,
  memory: { memory: memoryService },
  openApi: {
    tokens: apiTokenDeps,
    manage: apiTokenDeps,
    replays: store.mcpReplays,
    rate: { general: envNumber('HUB_API_RATE_MAX'), prompt: envNumber('HUB_API_PROMPT_RATE_MAX'), streams: envNumber('HUB_API_STREAM_MAX') }
  },
  enrollment: {
    deps: enrollmentDeps,
    bootstrapScript: join(repoRoot, 'scripts', 'bootstrap-worker.sh'),
    commit: hubBuild.commit,
    artifacts: createInstallArtifacts({ repoDir: repoRoot, commit: hubBuild.commit, cacheDir: join(dataDir, 'install-cache') })
  }
});

// 页面壳引用的是带哈希的资源名：它自己不能长缓存，否则发版之后手机上还在跑旧 bundle
// （Android Chrome 对没有 cache-control 的 HTML 会启发式缓存）。
app.use('/*', async (c, next) => {
  await next();
  const type = c.res.headers.get('content-type') ?? '';
  if (type.startsWith('text/html')) c.res.headers.set('cache-control', 'no-cache');
});
app.use('/*', serveStatic({ root: webDist }));
app.get('/*', serveStatic({ root: webDist, path: 'index.html' }));

// 预览的路径前缀模式（docs/design/preview.md §5，P4）：云上只放通 hub 一个端口时用。
// WebSocket（HMR）不走这条路，需要它就用端口模式。
const previewPrefixPath = (readEnv('HUB_PREVIEW_PREFIX') ?? '').trim().replace(/\/+$/, '');
const previewPrefixActive = previewPrefixPath !== '' && previewPrefixPath !== '/' && previewChannel !== null;
if (previewPrefixActive && previewChannel !== null) {
  const prefixChannel = previewChannel;
  const previewPrefix = createPreviewPrefix({
    prefix: previewPrefixPath,
    resolve: async (linkId) => store.previewLinks.byId(linkId as PreviewLinkId),
    authorize: async (request, link) => {
      const shared = new URL(request.url).searchParams.get('share');
      if (shared !== null && shared !== '') {
        const matched = await matchPreviewShare(
          { previewLinks: store.previewLinks },
          link.id,
          shared,
          accounts.now()
        );
        if (matched.ok) return true;
      }
      const token = loginTokenOf(request.headers.get('cookie') ?? '');
      if (token === '') return false;
      const subject = await withAccess(store.access, await authenticate(accounts, token), accounts.now());
      if (subject === null) return false;
      const session = await store.sessions.byId(link.sessionId);
      if (session === null) return false;
      const project = await projectOfSession({ tasks: store.tasks, projects: store.projects, bots: store.bots, workspaces: store.workspaces, workspaceGroups: store.workspaceGroups }, session);
      return (await authorizeSession(deps.access, subject, project, session, 'session.read')).ok;
    },
    channel: prefixChannel,
    onLog: (message) => log(`[preview] ${message}`)
  });
  app.all(`${previewPrefixPath}/*`, async (c) => (await previewPrefix.handle(c.req.raw)) ?? c.notFound());
  log(`预览路径前缀模式：${previewPrefixPath}/<链接 id>/（不支持 WebSocket / HMR）`);
  // 前缀模式和 hub 同源：预览页里的脚本能读到 hub_csrf，等于拿到了以用户身份发请求的能力。
  // 只建议在「预览的就是自己写的页面」时开启。
  log('注意：前缀模式与 Hub 同源，预览页脚本能读到 hub_csrf');
}

const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  log(`控制台：http://${host}:${info.port}`);
});
// 端口被占是最常见的一种「起不来」，不该打一坨堆栈了事
if (previewProxy !== null) {
  void reconcilePreviews().catch((failure: unknown) => log(`预览端口对齐失败：${(failure as Error).message}`));
  const previewTimer = setInterval(() => {
    void reconcilePreviews().catch((failure: unknown) => log(`预览端口对齐失败：${(failure as Error).message}`));
  }, 30_000);
  previewTimer.unref();
}

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${port} 已被占用：先停掉上一个 agent-hub（或者换 HUB_PORT）`);
    process.exit(1);
  }
  throw error;
});
server.on('upgrade', (request, socket, head) => {
  const path = (request.url ?? '').split('?')[0] ?? '';
  const hostHeader = request.headers.host;
  // Host 校验对所有升级请求先做（防 DNS rebinding）。
  if (!guard.hostAllowed(hostHeader)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }
  // 预览通道：worker 主动连上来（凭据或本机口令在 verifyWorker 里校验）。
  if (path === PREVIEW_WS_PATH) {
    if (previewChannel !== null) previewChannel.handleUpgrade(request, socket, head);
    else socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    return;
  }
  // 会话终端：Origin / 双 cookie / session.read 由桥接按设计稿 §2.3 的顺序自己校验。
  if (/^\/api\/sessions\/[^/]+\/terminal$/.test(path)) {
    if (terminalBridge) terminalBridge.attach(request, socket, head);
    else socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }
  // 其余只有 worker 通道走 WebSocket；浏览器发起的（带 Origin 的跨站请求）和重绑定来的一律不升级。
  if (path !== '/worker' || !guard.originAllowed(request.headers.origin, hostHeader)) {
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
    terminalBridge?.close();
    void previewProxy?.close();
    previewChannel?.close();
    serverGateway?.close();
    store.close();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
