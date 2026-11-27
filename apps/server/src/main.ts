import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';

import { PREVIEW_WS_PATH, STALL_NOTICE_MARKER } from '@agent-hub/contract';
import { createServerGateway } from '@agent-hub/node-gateway';
import { createAssetReader } from '@agent-hub/adapter-assets';
import { createSecretVault, createSqliteAgentObserve, createSqliteApiTokens, createSqliteComponents, createSqliteMachineObserve, createSqliteMessageObserve, createSqlitePlannedWorktrees, createSqliteProviders, createSqliteWorkObserve, createSqliteWorkspaceSweeps, createTaskArchiveBlockers, loadSecretKey, openSqliteStore } from '@agent-hub/storage-sqlite';
import type { AssetReviewDeps, Deps, EnrollmentDeps, EnvironmentPlanner, ProjectId, RuntimeJob, ServiceGateway, SessionId, SessionStartReadiness, TaskId, ToolGateway, UserId, WorkerMetrics, WorkspaceGroupGit } from '@agent-hub/domain';
import { authenticateWorker, withToolAccess,
  createBotUseCase,
  getBotUseCase,
  listBotsUseCase,
  botGrantsUseCase,
  listTeamBotsUseCase,
  grantBotUseCase,
  revokeBotUseCase,
  removeBotUseCase,
  updateBotUseCase,
  createSessionLane,
  createContextService,
  createWorkspaceFilesService,
  createGitWorkflowService,
  createRewindService,
  recordServiceLogUseCase,
  recordServiceStateUseCase,
  createMemoryService,
  checkProviderModel,
  invalid,
  ok,
  handoffCapFromEnv,
  defaultMemoryRegistry,
  MEMORY_GUIDANCE,
  MEMORY_SWEEP_INTERVAL_MS,
  MEMORY_GUIDANCE_VERSION,
  pumpDeliveries,
  releaseAfterTurn,
  requeueRefusedPrompt,
  reconcileSendingDeliveries,
  recoverOrphanedTurns,
  resolveOrphanTurnMs,
  sweepTemporaryWorkspacesUseCase,
  adoptLocalWorkspacesUseCase,
  migrateAssetOwnership,
  sweepGitForReview,
  revokeLegacyLocalWorkerGrants,
  terminalAccess,
  terminalTarget,
  asServiceId,
  asProjectId,
  asAgentId,
  asSessionId,
  asTaskId,
  asWorkspaceId,
  asUserId,
  authorizeProject,
  authorizeSession,
  authorizeWorker,
  grantActive,
  handoffRecord,
  handoffFirstEnded,
  optionValues,
  parseHubModel,
  projectOfSessionOrigin,
  placeSession,
  setupNotReady,
  forbidden,
  projectToolScope,
  resolveSessionAssets,
  projectOfSession,
} from '@agent-hub/domain';
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
  mcpAssetProblems,
  workerNeedsBrowser,
  withAssetNeeds,
  unavailable,
  loginUsable,
  workerAttached,
  workerGone,
  withAccess
} from '@agent-hub/domain';
import type { ServerGateway } from '@agent-hub/node-gateway';
import { createGitWorkspace, createLocalFs, readBuildInfo, createWorkspaceBrowser, offlineWorkspaceBrowser } from '@agent-hub/node-gateway';
import { createScryptHasher, createTokenIssuer, mailFromEnv } from '@agent-hub/adapter-accounts';
import type { AccountDeps } from '@agent-hub/domain';
import { componentJobFinished, createAccessPolicy, isFileAssetKind, isUnknownOutcomeEnded, loadResourcePolicy } from '@agent-hub/domain';

import { backupArgs, runBackup } from './backup.ts';
import { createTaskGate } from './task-gate.ts';
import { createInstallArtifacts } from './install-artifacts.ts';
import { createRepoAuth } from './repo-auth.ts';
import { createRemoteClients, serveMcpRelay } from './mcp-relay.ts';
import { serveAssetFetch } from './asset-relay.ts';
import { createMemorySources } from './memory-sources.ts';
import { createWorkerEnroll } from './worker-enroll.ts';
import { loadActor } from './role-session.ts';
import { createNpmResolver } from './components.ts';
import { createProviderWiring } from './providers.ts';
import { createSessionEnvironment } from './session-environment.ts';
import { createGitTextWriter } from './git-text-writer.ts';
import { createGitHubApi } from './github-api.ts';
import { createDelegationHeadResolver, createDelegationPublisher } from './workspace-delegation-publish.ts';
import { createWorkspaceDelegationHandoffProjection } from './workspace-delegation-handoff.ts';
import { createWorkspaceDelegateScopeResolverFromDelegation } from './workspace-delegation-tool.ts';
import { createWorkspaceReportToolProvider } from './workspace-delegation-report.ts';
import { createProjectSessionGrantService } from './project-session-grant.ts';
import { createProjectSessionGrantRoutes } from './project-session-grant-routes.ts';
import { createProjectSessionActions } from './project-session-actions.ts';
import { createProjectSessionToolProvider } from './project-session-tools.ts';
import { createProjectAssetToolProvider } from './project-session-asset-tools.ts';
import { createProjectSessionAssetActions } from './project-session-assets.ts';
import { importProjectCandidate } from './project-session-candidate.ts';
import { createProjectSessionHandoffActions } from './project-session-handoff.ts';
import { managedCredentialAdminTransport, setupHubCredentialBroker } from './hub-credential-activation.ts';
import { createProjectRepoReadTool } from './project-repo-read-tool.ts';
import { createManagedCredentialLogin } from './auth.ts';
import { createAgentHandoffService } from './agent-handoff.ts';
import { createAgentHandoffStartup } from './agent-handoff-startup.ts';
import { gitForWorker } from './workspace-delegation.ts';
import { createModelDistiller } from './model-distiller.ts';
import { createApp } from './http.ts';
import { setupProjectGitProbe } from './project-git-probe-activation.ts';
import { createConnectorObserveReader } from './observe-connector.ts';
import { createAgentObserveReader } from './observe-agent.ts';
import { createMachineObserveReader } from './observe-machine.ts';
import { createMessageObserveReader } from './observe-message.ts';
import { createWorkObserveReaders } from './observe-work.ts';
import { createStreamHub } from './stream-hub.ts';
import { createTurnFinisher, finishFromJournalTail, type TurnOutcome } from './turn-finish.ts';
import { wireTools } from './wire-tools.ts';
import { wireConnectors } from './wire-connectors.ts';
import { createSchedules } from './schedules.ts';
import { wirePreviews } from './wire-preview.ts';
import { createLiveCatalog } from './agent-catalog.ts';
import { createSessionQueue } from './session-queue.ts';
import { createMemoryHosting } from './session-hosting.ts';
import { createOptionWaiters, ingestOptionReceipt } from './option-waiters.ts';
import { createRequestGuard } from './request-guard.ts';
import { createTerminalBridge, type TerminalBridge } from './terminal-bridge.ts';
import { createWorkdirTerminalService } from './workdir-terminal-service.ts';
import { createWorktreePlans, plannedWorktreeGuard, type WorktreePlanProgress, type WorktreePlanSpec } from './worktree-plans.ts';
import { authHeaderFor } from './repo-auth.ts';
import { repoTokenKey } from '@agent-hub/domain';
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
const observeEnabled = readEnv('OBSERVE') !== '0';
const machineObserve = observeEnabled ? createSqliteMachineObserve(store.db) : null;
// 运行时套件 P2（ADR 0021）：组件目录 + 每台机器钉住的组件（漂移检测的期望状态）
const componentStore = createSqliteComponents(store.db);
const hub = createStreamHub();
const catalog = createLiveCatalog();
let serverGateway: ServerGateway | null = null;
/** 会话终端桥接：浏览器 WS ↔ worker PTY。装配在 serverGateway 之后。 */
let terminalBridge: TerminalBridge | null = null;
let workdirTerminals: ReturnType<typeof createWorkdirTerminalService> | null = null;
let sessionEnvironment: EnvironmentPlanner | null = null;
const optionWaiters = createOptionWaiters();
const preparingStarts = new Map<SessionId, symbol>();
const failedStartPreparations = new Map<SessionId, string | null>();

function startReadiness(sessionId: SessionId, workerId?: string | null): SessionStartReadiness {
  const observed = serverGateway?.gateway.sessionStartReadiness?.(sessionId, workerId) ?? { state: 'offline' };
  if (observed.state === 'offline' || observed.state === 'upgrade_required') return observed;
  if (preparingStarts.has(sessionId)) return { state: 'starting' };
  if (failedStartPreparations.has(sessionId) && (workerId == null || failedStartPreparations.get(sessionId) === workerId)) {
    return { state: 'failed', reason: 'configuration' };
  }
  return observed;
}

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

const secretKey = await loadSecretKey({ env: readEnv('HUB_SECRET_KEY') ?? undefined, file: join(dataDir, 'secret.key') });
// 密钥箱：资产令牌、项目仓库令牌都存这里（私有 HTTPS 仓库的 PAT）。
const secretsVault = createSecretVault(store.db, secretKey);
// Frozen until restart: outstanding durable reservations or fences keep all
// safety guards active even if rollout was subsequently disabled. Storage errors
// intentionally abort startup rather than permit unsafe mutations.
const workdirTerminalsEnabled = readEnv('HUB_WORKDIR_TERMINALS') === '1';
const worktreePlansEnabled = readEnv('HUB_WORKTREE_PLANS') === '1';
const plannedWorktrees = createSqlitePlannedWorktrees<WorktreePlanSpec, WorktreePlanProgress>(store.db);
const hasUsedPlans = store.db.prepare("SELECT 1 FROM planned_worktrees WHERE state NOT IN ('draft','failed') LIMIT 1").get() !== undefined;
const workdirSafetyRequired = workdirTerminalsEnabled || worktreePlansEnabled || hasUsedPlans || store.workdirSafety.hasOutstanding();
// A restart loses in-memory capability history. Preserve the legacy-open gate
// for machines with durable shells at boot even after those shells are drained.
const workdirHeldWorkersAtBoot = new Set(store.workdirTerminals.listNonEnded().map((row) => row.workerId));

const deps: Deps = {
  handoffTokenCap: handoffCapFromEnv(readEnv('HUB_HANDOFF_TOKEN_CAP') ?? undefined),
  projects: store.projects,
  tasks: store.tasks,
  taskGate: createTaskGate(),
  workLog: store.workLog,
  sessions: store.sessions,
  workspaces: store.workspaces,
  plannedWorktreeGuard: plannedWorktreeGuard(plannedWorktrees, (workerId) => deps.gateway.git(workerId)),
  ...(workdirSafetyRequired ? { workdirSafety: store.workdirSafety } : {}),
  // 组合工作空间的组行（docs/design/multi-repo.md §11.2）。
  workspaceGroups: store.workspaceGroups,
  artifacts: store.artifacts,
  layout: store.layout,
  links: store.links,
  // 会话通信 P1a：同伴简报由消息总线生成（短名、机器、仓库、分支、未读；变了才垫）。
  peerBriefing: (session) => messageBus.briefing(session.id),
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
    sessionStartReadiness: startReadiness,
    sessionStartConnection: (workerId) => serverGateway?.gateway.sessionStartConnection?.(workerId) ?? null,
    retrySessionStart: (sessionId, workerId) => {
      failedStartPreparations.delete(sessionId);
      serverGateway?.gateway.retrySessionStart?.(sessionId, workerId);
    },
    // 发给 worker 前给 start_session 配上工具令牌（换新、旧的作废），dispose 时作废。
    dispatch: async (command) => {
      const gateway = serverGateway?.gateway;
      if (!gateway) return err(unavailable('worker 通道尚未就绪'));
      const start = command.kind === 'start_session' ? command : null;
      const preparation = start ? Symbol() : undefined;
      if (preparation) {
        preparingStarts.set(command.sessionId, preparation);
        failedStartPreparations.delete(command.sessionId);
      } else if (command.kind === 'dispose') {
        preparingStarts.delete(command.sessionId);
        failedStartPreparations.delete(command.sessionId);
      }
      let gatewayInvoked = false;
      const send = async () => {
      if (command.kind === 'dispose') providerWiring.revoke(command.sessionId);
      // hub 模型提供商：只给选中的那一个（ADR 0013 D3）；不能用就让这次启动失败，不静默换模型
      // 回合检查点（ADR 0027 D2）：问话发给 agent 之前先给工作区拍一张；最多等 5 秒，拍不成也照发
      if (command.kind === 'prompt' && command.deliveryId !== undefined) {
        const claimed = await store.deliveries.inFlight(command.sessionId);
        if (claimed?.id === command.deliveryId) {
          const cutoff = new AbortController();
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              filesService.beginTurn(command.sessionId, claimed.seq, claimed.id, cutoff.signal).catch(() => null),
              new Promise<void>((resolve) => { timer = setTimeout(() => { cutoff.abort(); resolve(); }, 5_000); })
            ]);
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
        }
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
        effective = await withToolAccess(toolGateway, toolEndpoint, granted.value, actor, {
          scopes: projectSessionGrant.toolScopes,
          extraScopes: async (input) => [
            ...await workspaceDelegateScopes(input),
            ...await projectSessionGrant.projectExtraScopes(input)
          ]
        });
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
      if (preparation && preparingStarts.get(command.sessionId) !== preparation) return err(unavailable('启动请求已被替换'));
      if (command.kind === 'prompt' && command.startAttemptId !== undefined) {
        const ready = startReadiness(command.sessionId);
        if (ready.state !== 'ready' || ready.startAttemptId !== command.startAttemptId)
          return err({ ...unavailable('运行时已发生变化，消息尚未发送'), deliveryDeferred: true as const });
      }
      gatewayInvoked = true;
      const sent = await gateway.dispatch(effective);
      if (!sent.ok) return sent;
      // 记下会话开始时的 HEAD（ADR 0025 决定 7）：diff 默认对它比；失败不影响会话
      if (command.kind === 'start_session') {
        void filesService.recordBase(command.sessionId).catch(() => undefined);
        return ok({ environmentRevision });
      }
      return ok(undefined);
      };
      if (!start || !preparation) return send();
      const rememberPrepFailure = () => {
        if (!gatewayInvoked && preparingStarts.get(start.sessionId) === preparation) failedStartPreparations.set(start.sessionId, start.workerId);
      };
      try {
        const result = await send();
        if (!result.ok) rememberPrepFailure();
        return result;
      } catch (error) {
        if (gatewayInvoked) throw error;
        rememberPrepFailure();
        return err(unavailable('运行时启动配置准备失败'));
      } finally {
        if (preparingStarts.get(command.sessionId) === preparation) preparingStarts.delete(command.sessionId);
      }
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
  secrets: secretsVault,
  // 私有 HTTPS 仓库的令牌解析：按仓库 URL / 工作空间路径反查项目仓库的 tokenSecret。
  repoAuth: createRepoAuth({ projects: store.projects, workspaces: store.workspaces, secrets: secretsVault }),
  // 团队级的运行时默认模型：新会话没点名模型时按运行时补。
  agentDefaults: store.agentDefaults,
  search: store.search,
  metadataSearch: store.metadataSearch,
  hosting: createMemoryHosting(),
  queue: createSessionQueue(),
  now: () => Date.now(),
  deliveries: store.deliveries,
  branchAttempts: store.branchAttempts,
  agentHandoffs: store.agentHandoffs,
  // 授权（ADR 0011）：can() 要的团队 / 本机授权从这里拿；机器状态延迟到调用时再读 deps.gateway。
  access: createAccessPolicy({
    users: store.users,
    settings: store.settings,
    enrollment: store.enrollment,
    gateway: { status: () => deps.gateway.status() }
  }),
};

const log = (message: string) => console.log(`[hub] ${message}`);
// 所有常驻定时器登记到一处，关停时统一 clear。
const schedules = createSchedules();

// 能力层：agent 经 MCP 回调 hub 的工具。HUB_TOOLS=0 关掉。
// 唯一的传输是 relay：agent 连 worker 本机的入口，经 /worker 长连接到 hub，hub 不开 HTTP /mcp。
const toolEndpoint = readEnv('HUB_TOOLS') === '0' ? null : { url: '', transport: 'relay' as const };
if (readEnv('HUB_TOOLS_TRANSPORT') === 'http') log('HUB_TOOLS_TRANSPORT=http 已移除，忽略：工具一律经 worker 长连接中转');
// P2P 消息和群聊共用一道按会话的投递闸：同一条会话同一时间只有一个通道在等它的回复。
const sessionLane = createSessionLane();
// 消息 / 群聊 / 收件箱 / 连接器 / 调度 / 出站：整块装配在 wire-connectors.ts，这里只按原顺序调用。
const {
  messageBus, groupChat, inbox, releaseDelivery, persistentAgents, botOfSession, subjectOf,
  githubClient, teamTokenOf, githubReposFor, pullRequestRepo, gitHostTokens, feishuReplies, fakeReplies,
  connectorHub, taskProgress, dispatcher, enqueueDispatch
} = wireConnectors({ deps, store, log, readEnv, secretKey, sessionLane, schedules });
const contextService = createContextService({ projects: deps.projects, tasks: deps.tasks, sessions: deps.sessions, workspaces: deps.workspaces, workspaceGroups: store.workspaceGroups, access: deps.access, now: () => Date.now(), contextSettings: store.contextSettings, audit: store.audit, gateway: deps.gateway,
  // 角色层（ADR 0020 §8）：派生出来的角色会话 → 角色；否则群里的成员 → 角色
  roleOf: async (sessionId) => (await store.messages.spawnOf(sessionId as SessionId))?.role ?? (await store.groups.memberOfSession(sessionId as SessionId))?.role ?? null,
  // bot 职责说明（系统提示）：DM / 派生会话 / 群成员会话都在会话开头垫一次
  agentOf: async (projectId, role) => (await messageBus.config(projectId as ProjectId)).roles.find((r) => r.name === role) ?? null });
deps.sessionInstructions = (sessionId) => contextService.instructionsFor(sessionId);
const offlineBrowser = offlineWorkspaceBrowser('worker 通道尚未就绪');
const filesService = createWorkspaceFilesService({
  projects: deps.projects, tasks: deps.tasks, sessions: deps.sessions, workspaces: deps.workspaces, workspaceGroups: store.workspaceGroups, bots: store.bots, gateway: deps.gateway, access: deps.access, audit: store.audit,
  local: createWorkspaceBrowser(),
  remote: (workerId) => (serverGateway ? serverGateway.browser(workerId) : offlineBrowser),
  bases: store.sessionBases,
  checkpoints: store.checkpoints,
  git: deps.git,
  now: () => Date.now()
});
const rewindService = createRewindService({
  ...deps, files: filesService, turnRefs: store.turnRefs, branchAttemptWriter: store.branchAttempts,
  supportsNativeBranch: (workerId, agentId) => serverGateway?.supportsBranchAttempt(workerId, agentId) === true
});
/**
 * 一轮结束的收尾总闸。回合结束（event `ended`）、进程保活（status `idle`）、
 * 卡顿巡检、送达回收都走这一处；同一回合的重复信号按 journal 末尾去重。
 */
const turnFinished = createTurnFinisher({
  log,
  inbox,
  files: filesService,
  // 有 durable sending 时，ended 必须与它同会话、同 deliveryId 才收尾；身份检查先于去重水位。
  inFlight: (sessionId) => store.deliveries.inFlight(sessionId),
  // 送达队列在 inbox 钩子之后放行；expected id 直接取这条 ended 的 deliveryId。
  releaseDelivery,
  // 假渠道：把这轮回复投进出站队列（只在 HUB_FAKE_CHANNEL=1 时有路由）。
  ...(fakeReplies ? { fakeReplies } : {}),
  // 飞书：这一轮若由飞书消息触发，把回复写进 outbox 并回在原消息下面。
  ...(feishuReplies ? { feishuReplies } : {})
});
const finishTurn = (
  sessionId: SessionId,
  seq: number,
  outcome: TurnOutcome,
  reason?: string,
  deliveryId?: string
): void => {
  void turnFinished
    .finish({ sessionId, seq, outcome, ...(reason === undefined ? {} : { reason }), ...(deliveryId === undefined ? {} : { deliveryId }) })
    .catch((error: unknown) => log(`回合收尾失败：${String(error)}`));
};
// `ended` 帧里的 seq / outcome / reason / deliveryId 都是落盘时定下的：直接当作回合身份交给总闸。
// `idle` 状态帧走 finishFromJournalTail，只有 journal 末尾确实是 ended 才收尾。
hub.stream.subscribe((frame) => {
  if (frame.event?.kind === 'ended' && !isUnknownOutcomeEnded(frame.event)) {
    finishTurn(frame.sessionId, frame.seq, frame.event.outcome, frame.event.reason, frame.event.deliveryId);
  }
});
// 重启不重发在途消息；只有 journal 中属于同一投递的结束证据才能收尾。
void reconcileSendingDeliveries({ ...deps, deliveries: store.deliveries })
  .then((n) => n > 0 && log(`送达队列：已按落盘结束事件对账 ${n} 条投递`))
  .catch((error: unknown) => log(`送达队列启动对账失败：${String(error)}`));
let pumping = false;
schedules.every(1_000, () => {
  if (pumping) return;
  pumping = true;
  void pumpDeliveries({ ...deps, deliveries: store.deliveries })
    .catch((error: unknown) => log(`送达队列失败：${String(error)}`))
    .finally(() => { pumping = false; });
});
// 送出去却一直没进展的回合（#269 第 2 项）：
// - 托管进程还在：最多请求一次运行时 interrupt，让 Worker 自己按真实结果收尾；
// - 托管进程不在：只记诊断，不收尾、不放行（掉线 / 托管记录缺失都不是「已停止」的证据）；
// - 任何情况下都不代写 ended、不替用户放行下一句。
// 阈值独立于卡顿巡检，默认 2 分钟，可用 HUB_ORPHAN_TURN_MS（毫秒）覆盖。
const orphanTurnMs = resolveOrphanTurnMs(readEnv('HUB_ORPHAN_TURN_MS'));
log(`送达回收：送达后 ${Math.round(orphanTurnMs / 1_000)} 秒仍无进展才请求中断；不代写结束、不自动放行（HUB_ORPHAN_TURN_MS）`);
let recovering = false;
schedules.every(10_000, () => {
  if (recovering) return;
  recovering = true;
  void recoverOrphanedTurns({ ...deps, deliveries: store.deliveries }, Date.now(), orphanTurnMs)
    .then((n) => n > 0 && log(`送达队列：${n} 条送出去没有进展，已请求中断或记诊断（不代写结束、不放行后面的消息）`))
    .catch((error: unknown) => log(`处理没有进展的回合失败：${String(error)}`))
    .finally(() => { recovering = false; });
});
schedules.every(3_600_000, () => void filesService.sweepCheckpoints().catch(() => undefined));
// groupChat.sweep 已在 wire-connectors 里登记。

// 记忆（ADR 0019 · P1）：SQLite + FTS5 默认适配器；来源就地索引（ADR、文档、任务）；只经工具读，第一轮只垫一行静态引导。
// 记忆适配器都经注册表装配（memory.md §16）：来源、提炼、检索 / 排序、维护任务、治理各是一个端口。
const providerRepo = createSqliteProviders(store.db, secretKey);
const projectTeamOf = async (projectId: string) => (await store.projects.byId(projectId as ProjectId))?.teamId ?? null;
const workspaceSweeps = createSqliteWorkspaceSweeps(store.db);
// 清理（ADR 0027 阶段 3）：按 PR 合并 / 任务结束判断，删工作空间时一起删检查点 ref
deps.cleanup = {
  sweeps: workspaceSweeps,
  pullRequests: pullRequestRepo,
  dropCheckpoints: (sessionId: string) => filesService.dropSession(sessionId),
  // 终端桥在下面才装配，这里留一个晚绑定的钩子：terminalId 形如 `<sessionId>:<n>`。
  liveSessions: () => (terminalBridge === null ? [] : [...terminalBridge.knownTerminals()].map((id) => id.split(':')[0] ?? '').filter(Boolean))
};
// 提交 / 推送 / PR（ADR 0027 阶段 2）：文字由提炼模型写（D4），PR 走团队 token → gh → 链接（D3）
const gitHost = createGitHubApi({ base: readEnv('HUB_GITHUB_API') ?? undefined });
const gitService = createGitWorkflowService({
  projects: deps.projects, tasks: deps.tasks, sessions: deps.sessions, workspaces: deps.workspaces, workspaceGroups: store.workspaceGroups, bots: store.bots, gateway: deps.gateway, access: deps.access, audit: store.audit,
  workLog: store.workLog, git: deps.git,
  delegations: store.workspaceDelegations,
  pullRequests: pullRequestRepo,
  tokens: gitHostTokens,
  host: gitHost,
  writer: createGitTextWriter({ settings: store.memory.settings, providers: providerRepo, projectTeam: projectTeamOf, audit: store.audit, now: () => Date.now(), log }),
  hubTeamId: async () => (await store.users.firstClusterAdmin())?.teamId ?? null,
  now: () => Date.now()
});
// PR 状态每 10 分钟同步一次（打开任务时也会顺手同步）
schedules.every(600_000, () => void gitService.syncDue(20).catch(() => undefined));
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
schedules.after(10 * 60_000, memorySweep);
schedules.every(MEMORY_SWEEP_INTERVAL_MS, memorySweep);
if (toolEndpoint) {
  deps.memoryGuidance = {
    text: MEMORY_GUIDANCE,
    version: MEMORY_GUIDANCE_VERSION,
    injected: (sessionId, version) => memoryService.guidanceInjected(sessionId, version)
  };
}


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
function fromWorker(workerId: string, sessionId: SessionId, ingest: () => void | Promise<void>): void {
  inbound = inbound
    .then(async () => {
      if (await frameAccepted(deps, workerId, sessionId)) await ingest();
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
  // #261 HIGH2：probe 点名 workerId 时先过 worker.use 授权。
  access: deps.access,
  log
});
// 工具网关依赖上面建好的 providerWiring（模型检查），所以放在它后面。
const workspaceDelegateScopes = createWorkspaceDelegateScopeResolverFromDelegation({
  delegationDeps: deps,
  coordinators: store.workspaceCoordinators,
  loadActor: (userId) => loadActor(store.users, store.access, userId, 'tool-workspace-delegate')
});
const projectToolActor = (accountId: string) => loadActor(store.users, store.access, accountId, 'tool-project-session');
const hubCredentials = await setupHubCredentialBroker({
  readEnv, spawnWorker, host, dataDir, db: store.db, projects: store.projects, warn: log,
  audit(event) {
    if (!event.context) return;
    const actorId = asUserId(event.context.actorId);
    void store.users.byId(actorId).then((user) => store.audit.append({
      id: randomBytes(16).toString('hex'), actorId, actorEmail: user?.email ?? '',
      action: 'project.hub_credential', target: event.projectId, at: deps.now(), ip: null,
      teamId: user?.teamId ?? null, detail: JSON.stringify({
        operation: event.operation, repoId: event.repoId, credentialId: event.credentialId,
        version: event.version, status: event.status, sessionId: event.context?.sessionId ?? null
      })
    })).catch(() => log('Hub 托管凭证审计写入失败'));
  }
});
const credentialAdmin = hubCredentials ? createManagedCredentialLogin({
  allows: (c) => managedCredentialAdminTransport(c, hubCredentials.adminOrigin), now: accounts.now
}) : undefined;
const workspaceReport = createWorkspaceReportToolProvider({
  sessions: deps.sessions,
  tasks: deps.tasks,
  projects: deps.projects,
  delegations: store.workspaceDelegations,
  access: deps.access!,
  loadActor: projectToolActor,
  bus: messageBus
});
const projectSessionGrant = createProjectSessionGrantService({
  now: deps.now,
  projectSessionGrants: store.projectSessionGrants,
  sessions: deps.sessions,
  tasks: deps.tasks,
  workspaceDelegations: store.workspaceDelegations,
  canReportDelegation: workspaceReport.canReport,
  loadActor: async (accountId) => (await projectToolActor(accountId)) ? { userId: accountId, via: 'web' } : null,
  sourceEligible: async ({ action, actor, session }) => {
    if (action === 'revoke' || action === 'list') return true; // 旧授权始终可由归属人清理。
    if (session.botId != null || session.groupId != null) return false;
    const [provenance, spawn, group, dispatch] = await Promise.all([
      store.provenance.get(session.id), store.messages.spawnOf(session.id),
      store.groups.memberOfSession(session.id), store.dispatches.bySession(session.id)
    ]);
    return !spawn && !group && !dispatch && provenance !== null && !provenance.backfilled
      && provenance.actor.kind === 'user' && provenance.actor.id === actor.userId
      && (provenance.via === 'web' || provenance.via === 'mobile');
  },
  invalidateSessionTools: async (sessionId) => { await toolGateway?.revoke({ id: sessionId }); },
  checkCurrentPermission: async ({ accountId, sessionId, projectId, scope }) => {
    const actor = await projectToolActor(accountId);
    if (!actor) return err(forbidden('当前账号不可用'));
    const project = await deps.projects.byId(projectId);
    const session = await deps.sessions.byId(sessionId);
    const visible = await authorizeSession(deps.access, actor, project, session, 'session.read');
    if (!visible.ok) return visible;
    const permission = (() => {
      switch (scope) {
        case 'task:write': return 'task.create';
        case 'worktree:open': return 'project.update';
        case 'project:read': return 'project.read';
        case 'repo:read': return hubCredentials?.allowsProject(projectId) ? 'workspace.files.read' : null;
        case 'candidate:import': return 'workspace.files.read';
        case 'message:send': return 'agent.message.send';
        case 'asset:write': return 'project.update';
        default: return null;
      }
    })();
    if (!permission) return err(forbidden('不支持的项目工具授权范围'));
    const allowed = await authorizeProject(deps.access, actor, project, permission);
    return allowed.ok ? ok(undefined) : allowed;
  }
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
  secrets: secretsVault,
  now: () => Date.now()
};
toolGateway = wireTools({
  deps, store, readEnv, messageBus, groupChat, botOfSession, contextService, filesService, gitService, memoryService,
  providerWiring, githubClient, teamTokenOf, githubReposFor, subjectOf, enqueueDispatch,
  workspaceReportTools: workspaceReport.provider,
  ...(hubCredentials ? { projectRepositoryTools: createProjectRepoReadTool({
    deps, grants: projectSessionGrant, broker: hubCredentials.broker, now: deps.now, allowsProject: hubCredentials.allowsProject,
    async toolGrantStillActive(grant) {
      const current = await store.toolGrants.byTokenHash(grant.tokenHash);
      return !!current && current.id === grant.id && current.sessionId === grant.sessionId
        && current.actor?.via === 'web' && current.actor.userId === grant.actor?.userId
        && current.scopes.includes(projectToolScope('repo:read')) && grantActive(current, deps.now());
    }
  }) } : {}),
  projectSessionTools: createProjectSessionToolProvider({
    ...createProjectSessionActions({
      grants: projectSessionGrant,
      delegationDeps: deps,
      delegations: store.workspaceDelegations,
      taskCreations: store.taskCreations,
      loadActor: projectToolActor
    }),
    ...createProjectSessionHandoffActions({
      grants: projectSessionGrant, access: deps.access, projects: deps.projects, sessions: deps.sessions,
      tasks: deps.tasks, delegations: store.workspaceDelegations, messageBus, loadActor: projectToolActor,
      listTasklessByOriginProject: (projectId) => store.listTasklessSessionsByOriginProject(asProjectId(projectId))
    }),
    importCandidate: (command) => importProjectCandidate({
      grants: projectSessionGrant, access: deps.access, projects: deps.projects, workspaces: deps.workspaces,
      sessions: deps.sessions, delegations: store.workspaceDelegations, operationReceipts: store.operationReceipts,
      loadActor: projectToolActor, gitForWorker: (workerId) => gitForWorker(deps, workerId)
    }, command),
    scopes: {
      taskCreate: projectToolScope('task:write'), worktreeStart: projectToolScope('worktree:open'),
      candidateImport: projectToolScope('candidate:import'), handoff: projectToolScope('message:send'),
      sessionList: projectToolScope('project:read')
    }
  }),
  projectAssetTools: createProjectAssetToolProvider({
    ...createProjectSessionAssetActions({
      grants: projectSessionGrant, assets: assetDeps, sessions: deps.sessions,
      operationReceipts: store.operationReceipts, loadActor: projectToolActor
    }),
    scopes: { read: projectToolScope('project:read'), write: projectToolScope('asset:write') }
  }),
  projectSessionScopeCap: projectSessionGrant.toolScopeCap
});
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
  // 会话级 MCP 开关：关掉的服务器这次不给（改完要重启会话进程才生效）。
  disabledMcp: async (sessionId) => (await store.sessions.byId(sessionId as SessionId))?.mcpDisabled ?? null,
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
        return { failed: assetIds, reason: status.error ? `同步失败：${status.error}` : '同步失败' };
      }
      if (status.state !== 'synced') {
        log(`资产预热没完成（${workerId}）：${status.state}`);
        return { failed: assetIds, reason: '机器不在线，资产没同步过去' };
      }
      const landed: Record<string, string> = {};
      const notLanded: string[] = [];
      for (const assetId of assetIds) {
        // MCP 资产没有文件清单（它由会话启动时的 mcp 项下发），只要求安装记录；
        // 把它当文件资产检查 landed 会让所有带 MCP 的会话都「预热失败」。
        const asset = await store.assets.get(assetId);
        if (asset !== null && !isFileAssetKind(asset.kind)) continue;
        const digest = status.installed[assetId];
        if (digest === undefined) notLanded.push(assetId);
        else landed[assetId] = digest;
      }
      if (notLanded.length) {
        log(`资产预热没落地（${workerId}）：${notLanded.join(', ')}`);
        return { failed: notLanded, reason: '机器没有回报装好' };
      }
      return landed;
    } catch (failure) {
      log(`资产预热失败（${workerId}）：${(failure as Error).message}`);
      return { failed: assetIds, reason: (failure as Error).message };
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

const handoffStartup = createAgentHandoffStartup({
  store: store.agentHandoffs,
  gateway: {
    dispatch: (command) => deps.gateway.dispatch(command),
    sessionStartConnection: (workerId) => deps.gateway.sessionStartConnection?.(workerId) ?? null,
    sessionStartReadiness: (sessionId, workerId) => serverGateway?.gateway.sessionStartReadiness?.(sessionId, workerId) ?? { state: 'untracked' }
  },
  now: deps.now,
  newAttemptId: () => globalThis.crypto.randomUUID(),
  onReady(workerId, sessionId, isCurrent) {
    if (!isCurrent()) return;
    const id = asSessionId(sessionId);
    deps.hosting.add(id, workerId);
    void releaseAfterTurn({ ...deps, deliveries: store.deliveries }, id).catch(() => log('交接启动后检查送达队列失败'));
  }
});
const agentHandoff = createAgentHandoffService({
  store: store.agentHandoffs,
  session: (id) => store.sessions.byId(asSessionId(id)),
  task: (id) => store.tasks.byId(asTaskId(id)),
  workspace: (id) => store.workspaces.byId(asWorkspaceId(id)),
  sessionAllowed: async (actor, session, permission) =>
    (await authorizeSession(deps.access, actor, await projectOfSessionOrigin(deps, session), session, permission)).ok,
  taskCreateAllowed: async (actor, task) =>
    (await authorizeProject(deps.access, actor, await store.projects.byId(task.projectId), 'session.create')).ok,
  taskActive: async (task) => {
    const [live, project] = await Promise.all([store.tasks.byId(task.id), store.projects.byId(task.projectId)]);
    return !!live && live.projectId === task.projectId && live.archivedAt == null && live.status !== 'abandoned' && !!project && project.deletedAt == null;
  },
  workspaceReady: async (task, workspace) => {
    const project = await store.projects.byId(task.projectId);
    return !!project && project.deletedAt == null && setupNotReady(workspace, project.worktree?.setup?.waitForSetup ?? true) === null;
  },
  workerUseAllowed: async (actor, workerId) => (await authorizeWorker(deps.access, actor, workerId)).ok,
  readyDescriptors: async (workerId) => {
    if (!deps.gateway.sessionStartConnection?.(workerId)) return null;
    return catalog.list().flatMap(({ id }) => {
      const descriptor = catalog.descriptorOn?.(workerId, id);
      return descriptor ? [descriptor] : [];
    });
  },
  providerAllowed: async (_actor, workerId, descriptor, model) => {
    // First release supports native, advertised models only. A Hub provider changes startup wiring.
    if (parseHubModel(model)) return false;
    const placement = placeSession(await deps.gateway.status(), { agentId: descriptor.id, requested: workerId, projectWorker: workerId, model });
    if (!placement.ok || placement.value !== workerId) return false;
    const option = descriptor.options.find(({ category }) => category === 'model');
    const choice = option && optionValues(option).find(({ value }) => value === model);
    return !choice || choice.metadata?.selectable !== false;
  },
  history: (id, cursor) => store.agentHandoffs.historyFor(id, cursor),
  targetWindow: async (workerId, agentId, model) => {
    const option = catalog.descriptorOn?.(workerId, asAgentId(agentId))?.options.find(({ category }) => category === 'model');
    const size = option && optionValues(option).find(({ value }) => value === model)?.metadata?.contextWindow;
    return typeof size === 'number' && Number.isSafeInteger(size) && size > 0 ? size : null;
  },
  startupState: handoffStartup.metadataState,
  firstCompleted: (record) => handoffFirstEnded(deps, record),
  now: deps.now,
  async onAdmitted(record) {
    const first = record.first;
    if (!first) return;
    const sessionId = record.reservation.target.id;
    deps.stream.publish({ sessionId, seq: first.delivery.seq, event: first.event, status: 'running' });
    void handoffStartup.start(record).catch(() => log('交接会话启动失败，未自动重试'));
  }
});

serverGateway = createServerGateway({
  token,
  authenticate: (hello) => authenticateWorker(enrollmentDeps, hello),
  ...(machineObserve ? {
    onConnectionObservation: (observation) => machineObserve.append(observation),
    onObservedRuntimeInstall: (observation) => machineObserve.appendInstall(observation)
  } : {}),
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
  onOptionReceipt(workerId, sessionId, requestId, optionId, outcome, options, isCurrent) {
    fromWorker(workerId, sessionId, () => ingestOptionReceipt(deps, optionWaiters, sessionId, requestId, optionId, outcome, options, isCurrent));
  },
  onTurnRef(workerId, sessionId, turnRef, deliveryId) {
    fromWorker(workerId, sessionId, () => void rewindService.recordTurnRef(sessionId, turnRef, workerId, deliveryId).catch((e) => log(`记录原生标识失败：${String(e)}`)));
  },
  onBranchAttemptResult(workerId, sessionId, attemptId, outcome, agentSessionRef) {
    // Gateway already verifies the exact socket/start attempt; the durable CAS checks it again against the staged child.
    const receipt = outcome === 'both_failed' ? { outcome } as const : agentSessionRef === undefined ? null : { outcome, agentSessionRef };
    if (receipt) void rewindService.branchResult(sessionId, attemptId, workerId, receipt).catch((e) => log(`处理分叉结果失败：${String(e)}`));
  },
  onSessionStartChanged(workerId, sessionId, sessionStart) {
    // This hook is emitted only after gateway acceptance on the exact socket/start.
    // Startup is not a completed turn: wake a queued head without releasing in-flight work.
    fromWorker(workerId, sessionId, async () => {
      const handoff = await handoffRecord(deps, sessionId);
      if (!handoff.ok) return;
      if (handoff.value && !(await handoffFirstEnded(deps, handoff.value))) {
        await handoffStartup.changed(workerId, sessionId, sessionStart);
        return;
      }
      if (serverGateway?.gateway.sessionStartReadiness?.(sessionId, workerId).state !== 'ready') return;
      void releaseAfterTurn({ ...deps, deliveries: store.deliveries }, sessionId).catch(() => log('运行时就绪后检查送达队列失败'));
    });
  },
  onSessionStartEnded(workerId, sessionId, _startAttemptId, isCurrent) {
    fromWorker(workerId, sessionId, () => {
      void deps.queue.run(sessionId, async () => {
        const valid = () => isCurrent() && !preparingStarts.has(sessionId);
        const session = await store.sessions.byId(sessionId);
        if (!session || !valid() || (session.workerId !== null && session.workerId !== workerId)) return;
        deps.hosting.drop(sessionId);
        providerWiring.revoke(sessionId);
        terminalBridge?.closeSession(sessionId);
        const interrupted = session.status === 'running' && await store.sessions.markInterrupted(sessionId, deps.now());
        if (valid()) deps.stream.publish({ sessionId, seq: session.lastSeq, event: null, status: interrupted ? 'interrupted' : session.status });
      }).catch(() => log('运行时结束状态处理失败'));
      // A process end is not a durable turn end or proof of an unsent prompt.
    });
  },
  onPromptStartRefused(workerId, sessionId, deliveryId) {
    // The authenticated worker proved this exact frame did not reach the adapter.
    fromWorker(workerId, sessionId, () => {
      void requeueRefusedPrompt({ ...deps, deliveries: store.deliveries }, sessionId, deliveryId).catch(() => log('重新排队未提交的消息失败'));
    });
  },
  onAgentSession(workerId, sessionId, agentSessionRef) {
    fromWorker(workerId, sessionId, () => void ingestAgentSessionRef(deps, sessionId, agentSessionRef));
  },
  onStatus(workerId, sessionId, status) {
    fromWorker(workerId, sessionId, () => {
      void (async () => {
        await ingestRuntimeStatus(deps, sessionId, status);
        // idle / ended 只当作「可能结束了」的提示：等已经到达的 ended 事件落盘后看 journal 末尾，
        // 只有末尾真的是 ended 才收尾（outcome / reason / seq 取自那条落盘事件，不从 session.status 推断）。
        // idle 时进程还活着、托管不撤；ended 才是真结束，额外撤 provider 句柄与终端。
        if (status === 'idle' || status === 'ended') {
          await finishFromJournalTail(deps, turnFinished, sessionId).catch((error: unknown) =>
            log(`回合收尾失败：${String(error)}`)
          );
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
    workdirTerminals?.onWorkerGone(workerId);
    log(`worker 离线：${workerId}（${reason}）`);
  },
  // 每条认证过的长连接：挂上 MCP 中转（RPC 端口 → MCP 服务端 → ToolGateway），绑定这台 Worker。
  serve(workerId, channel) {
    serveAssetFetch(channel, workerId, assetDeps);
    if (!toolGateway) return;
    serveMcpRelay(channel, workerId, {
      gateway: toolGateway,
      hostOf: (sessionId) => serverGateway?.hostOf(sessionId) ?? null,
      // 会话有资产清单就按清单找（MCP 不用装到机器）；老会话没清单才退回看机器分配
      remote: async (worker, server, sessionId) => {
        const manifest = await assetDeps.assets.sessionAssets(sessionId).catch(() => null);
        return remoteMcpTarget(assetDeps, worker, server, manifest ? new Set(manifest.entries.map((entry) => entry.assetId)) : undefined);
      },
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
  onWorkdirTerminalData(workerId, epoch, terminalId, data) {
    workdirTerminals?.onData(workerId, epoch, terminalId, data);
  },
  onWorkdirTerminalExit(workerId, epoch, terminalId, code) {
    workdirTerminals?.onExit(workerId, epoch, terminalId, code);
  },
  onWorkdirTerminalConnected() { void workdirTerminals?.reconcile(); },
  // 会话服务（docs/design/session-service.md）：worker 推的状态 / 输出直接落库；hub 不做乐观状态。
  knownServices: async (workerId) =>
    new Set(
      (await store.sessionServices.listByWorker(workerId))
        .filter((service) => service.state === 'running' || service.state === 'starting')
        .map((service) => service.id)
    ),
  onServiceState(workerId, event) {
    void (async () => {
      // 每台 Worker 只能改自己那条服务：先按 id 取出来比对来源，域名层还会再挡一次。
      const service = await store.sessionServices.byId(asServiceId(event.serviceId));
      if (!service || service.workerId !== workerId) {
        log(`丢弃服务状态帧：${event.serviceId} 不属于 ${workerId}`);
        return;
      }
      await recordServiceStateUseCase({ sessionServices: store.sessionServices, now: deps.now }, event.serviceId, workerId, {
        state: event.state,
        pid: event.pid ?? null,
        detail: event.detail ?? null
      });
    })().catch((error: unknown) => log(`记录服务状态失败（${workerId}/${event.serviceId}）：${String(error)}`));
  },
  onServiceLog(workerId, serviceId, chunk) {
    void (async () => {
      const service = await store.sessionServices.byId(asServiceId(serviceId));
      if (!service || service.workerId !== workerId) {
        log(`丢弃服务日志帧：${serviceId} 不属于 ${workerId}`);
        return;
      }
      await recordServiceLogUseCase({ sessionServices: store.sessionServices, now: deps.now }, serviceId, workerId, chunk);
    })().catch((error: unknown) => log(`记录服务日志失败（${workerId}/${serviceId}）：${String(error)}`));
  },
  onServiceMissing(workerId, serviceId) {
    void recordServiceStateUseCase({ sessionServices: store.sessionServices, now: deps.now }, serviceId, workerId, {
      state: 'failed',
      pid: null,
      detail: '机器重启后没有拉起来'
    }).catch((error: unknown) => log(`标记服务失联失败（${workerId}/${serviceId}）：${String(error)}`));
  },
  onLog: log
}, { workspaceMutationSafetyRequired: workdirSafetyRequired });

// 会话终端（docs/design/terminal.md）：浏览器 WS 的鉴权沿用 cookie + session.prompt
// （能往 PTY 里打字等于能以会话身份执行命令，viewer 不该有，issue #213）；
// 目标机器 / 目录由 domain 的 terminalTarget 决定，桥接只管帧和生命周期。
terminalBridge = createTerminalBridge({
  gateway: serverGateway,
  blocksLegacyOpen: (workerId) => workdirHeldWorkersAtBoot.has(workerId) || serverGateway!.workdirTerminalSupported(workerId),
  authenticate: async (value) => withAccess(store.access, await authenticate(accounts, value), accounts.now()),
  target: (subject, sessionId) => terminalTarget(deps, subject, sessionId),
  access: (subject, sessionId) => terminalAccess(deps, subject, sessionId),
  hostAllowed: (hostname) => guard.hostAllowed(hostname),
  log
});

workdirTerminals = createWorkdirTerminalService({
  enabled: workdirTerminalsEnabled,
  access: {
    deps,
    localWorkerId: () => {
      const locals = (serverGateway?.workers() ?? []).filter((worker) => worker.state === 'online' && worker.origin === 'local');
      return locals.length === 1 ? locals[0]!.workerId : null;
    },
    grants: () => readEnv('HUB_WORKDIR_SHELL_GRANTS') ?? undefined
  },
  terminals: store.workdirTerminals,
  safety: store.workdirSafety,
  gateway: (workerId) => serverGateway!.workdirTerminals(workerId),
  authenticate: async (value) => withAccess(store.access, await authenticate(accounts, value), accounts.now()),
  owner: async (userId) => {
    const user = await store.users.byId(userId as import('@agent-hub/domain').UserId);
    if (!user || user.disabledAt !== null || user.deletedAt !== null) return null;
    return withAccess(store.access, { user, loginId: '' as import('@agent-hub/domain').LoginId }, accounts.now());
  },
  hostAllowed: (hostname) => guard.hostAllowed(hostname)
});

const previews = wirePreviews({
  deps, store, log, readEnv, host, port, spawnWorker, localSecret,
  enrollment: enrollmentDeps.enrollment,
  tokens: enrollmentDeps.tokens,
  subjectOfCookie: async (value) => withAccess(store.access, await authenticate(accounts, value), accounts.now()),
  now: () => accounts.now(),
  schedules
});
const { ports: previewPorts, reconcile: reconcilePreviews, channel: previewChannel } = previews;
void loadResourcePolicy({ metrics: workerMetrics, settings: store.settings }).catch((failure: unknown) => log(`同步资源策略失败：${(failure as Error).message}`));

const recovered = await reconcileInterrupted({
  now: deps.now,
  sessions: {
    ...store.sessions,
    listAll: async () => {
      const recoverable = [];
      for (const session of await store.sessions.listAll()) {
        if (session.status !== 'running') continue;
        const handoff = await handoffRecord(deps, session.id);
        if (handoff.ok && (!handoff.value || await handoffFirstEnded(deps, handoff.value))) recoverable.push(session);
      }
      return recoverable;
    }
  }
});
if (recovered > 0) log(`${recovered} 个会话上次没跑完，已标记为「中断」`);

// 卡顿巡检：一轮跑着却长时间没新事件，只记一条 warn 诊断（卡片上显示提醒）。
// 不补 ended、不收尾、不放行——模型可能只是在跑很慢的工具；是否中断交给人。
// 「送达后没有进展」那条独立的有界策略最多请求一次运行时 interrupt，也不代写结束。
const stallMs = Number(readEnv('HUB_STALL_MS') ?? 5 * 60_000);
if (stallMs > 0) {
  schedules.every(Math.min(30_000, stallMs), () => {
    void (async () => {
      const ids = await flagStalledSessions(deps, { idleMs: stallMs, marker: STALL_NOTICE_MARKER });
      for (const id of ids) {
        const minutes = Math.max(1, Math.round(stallMs / 60_000));
        log(`会话 ${id} 已 ${minutes} 分钟以上没有新输出，已记诊断提醒；不会自动收尾`);
      }
    })().catch((failure: unknown) => log(`卡顿巡检失败：${(failure as Error).message}`));
  });
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
schedules.after(60_000, () => void sweep('startup'));
schedules.every(60 * 60_000, () => void sweep('hourly'));

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
  schedules.after(Math.min(120_000, assetCheckMs), () => void checkAssets('启动'));
  schedules.every(assetCheckMs, () => void checkAssets('定时'));
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

const botDeps = {
  ...deps,
  messages: store.messages,
  connectors: store.connectors,
  contextSettings: store.contextSettings,
  detach: (actor: Parameters<typeof groupChat.detachAgent>[0], projectId: Parameters<typeof groupChat.detachAgent>[1], name: string) => groupChat.detachAgent(actor, projectId, name)
};
// 隔离探测只能在不运行本机 Agent 的 Hub 上显式启用。旧的 Worker Git 路径不认识专用密钥名。
const projectGitProbe = await setupProjectGitProbe({
  readEnv,
  spawnWorker,
  dataDir,
  db: store.db,
  secretKey
});
const app = createApp({ deps, hub, token, connectors: { hub: connectorHub, agentTasks: store.agentTasks, dispatcher, onCreated: enqueueDispatch }, waitOptions: optionWaiters.wait, optionConfirmations: optionWaiters, guard,
  ...(hubCredentials && credentialAdmin ? { hubCredentials: {
    broker: hubCredentials.broker,
    async authorize(c, projectId) {
      if (!hubCredentials.allowsProject(projectId)) return false;
      const principal = await withAccess(store.access, await authenticate(accounts, credentialAdmin.token(c)), accounts.now());
      if (!principal || principal.via || principal.user.emailVerifiedAt === null
        || (principal.user.role !== 'owner' && principal.user.role !== 'admin')) return false;
      const project = await store.projects.byId(asProjectId(projectId));
      if (!project?.teamId || principal.user.teamId !== project.teamId) return false;
      return (await authorizeProject(deps.access, principal, project, 'project.update')).ok;
    }
  } } : {}),
  agentHandoff,
  ...(projectGitProbe ? { projectGitProbe: {
    projects: deps.projects, secrets: projectGitProbe.vault, access: deps.access, probe: projectGitProbe.probe, now: deps.now,
    allows: projectGitProbe.allows
  } } : {}),
  taskArchiveBlockers: createTaskArchiveBlockers(store.db),
  observe: {
    enabled: observeEnabled,
    readers: observeEnabled ? [
      createConnectorObserveReader({
        now: deps.now, projects: deps.projects, sessions: deps.sessions, tasks: deps.tasks,
        deliveries: store.deliveries, store: store.connectors, requests: store.agentTasks, dispatches: store.dispatches, policy: deps.access
      }),
      createAgentObserveReader({
        projects: deps.projects, sessions: deps.sessions, tasks: deps.tasks,
        records: createSqliteAgentObserve(store.db), policy: deps.access
      }),
      ...createWorkObserveReaders({
        projects: deps.projects, sessions: deps.sessions, tasks: deps.tasks,
        records: createSqliteWorkObserve(store.db), policy: deps.access
      }),
      createMessageObserveReader({
        projects: deps.projects, sessions: deps.sessions, tasks: deps.tasks,
        records: createSqliteMessageObserve(store.db), policy: deps.access
      }),
      ...(machineObserve && deps.access ? [createMachineObserveReader({
        records: machineObserve, enrollment: store.enrollment, users: store.users, policy: deps.access
      })] : [])
    ] : []
  },
  auth: { accounts, access: store.access, team: { ...accounts, invites: store.invites, projects: store.projects, roles: store.access.roles, agentDefaults: store.agentDefaults }, accessAdmin: { ...store.access, users: store.users, teams: store.teams, audit: store.audit, now: () => Date.now() }, loginRateMax: Number(readEnv('HUB_LOGIN_RATE_MAX') ?? 30), mailRateMax: Number(readEnv('HUB_MAIL_RATE_MAX') ?? 5), mailDelivery: mailSetup.transport !== 'log', ...(credentialAdmin ? { credentialAdmin } : {}) },
  workdirTerminals,
  ...(worktreePlansEnabled ? { worktreePlans: createWorktreePlans({ deps, store: plannedWorktrees,
    // Keep missing-base clone unavailable until cross-process recovery and the TLS path are proven.
    async refreshActor(actor) {
      const user = await store.users.byId(actor.user.id);
      const login = (await store.logins.forUser(actor.user.id)).find((entry) => entry.id === actor.loginId);
      const now = accounts.now();
      return login && loginUsable(login, user, now) && user.emailVerifiedAt !== null
        ? withAccess(store.access, { user, loginId: login.id }, now) : null;
    },
    async authForRepo(project, repo) {
      if (!repo.url.startsWith('https://')) return err(forbidden('缺少底座时只支持获机器允许的 HTTPS 仓库'));
      if (!repo.tokenSecret) return { ok: true, value: null };
      const key = repoTokenKey(project.id, repo.id);
      if (repo.tokenSecret !== key) return err(forbidden('仓库凭证与当前登记不匹配，未访问远端'));
      const secret = (await secretsVault.reveal([key]))[key];
      return secret ? { ok: true, value: authHeaderFor(secret, repo.url) } : err(forbidden('仓库已配置凭证但当前不可用，未访问远端'));
    }
  }) } : {}),
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
        // 和真正派生同一口径（允许清单）：文件类资产派生时会自动预热，预览按钉住的版本算；MCP 本来就不用装。
        // 不给 ensure 会退回「必须已经装到这台机器」的老语义，预览里就看不到还没装的资产。
        ensure: async (_worker, ids) => {
          const out: Record<string, string> = {};
          for (const id of ids) {
            const asset = await assetDeps.assets.get(id);
            if (asset) out[id] = asset.pinned;
          }
          return out;
        },
        log
      });
      const problems = await mcpAssetProblems(assetDeps, plan.entries.filter((entry) => entry.kind === 'mcp').map((entry) => entry.assetId));
      // 内置 Playwright 要浏览器：这台机器没有 hub 装的 Chromium 就标「需安装浏览器」（默认不勾）
      const worker = workerId ? (await workerControl.list()).find((candidate) => candidate.workerId === workerId) : undefined;
      for (const entry of plan.entries) {
        if (problems[entry.assetId]) continue;
        const asset = entry.kind === 'mcp' ? await assetDeps.assets.get(entry.assetId) : null;
        if (asset && workerNeedsBrowser(worker, asset)) problems[entry.assetId] = '需安装浏览器：到「资产」里给这台机器装 Chromium';
      }
      return plan.entries.map((entry) => (problems[entry.assetId] ? { ...entry, problem: problems[entry.assetId] } : entry));
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
  diffReview: store.diffReview,
  git: gitService,
  rewind: rewindService,
  coordinators: { coordinators: store.workspaceCoordinators },
  workspaceDelegation: { coordinators: store.workspaceCoordinators, delegations: store.workspaceDelegations },
  projectSessionGrants: createProjectSessionGrantRoutes(deps, projectSessionGrant, hubCredentials?.allowsProject),
  delegationPublish: {
    publisher: createDelegationPublisher({ ...deps, gitHost, gitHostTokens }, store.workspaceDelegations, store.delegationPublishAttempts),
    resolveHead: createDelegationHeadResolver(deps),
    delegations: store.workspaceDelegations,
    attempts: store.delegationPublishAttempts,
    projects: deps.projects,
    access: deps.access
  },
  delegationAcceptance: {
    delegations: store.workspaceDelegations,
    acceptances: store.delegationAcceptances,
    projects: deps.projects,
    tasks: deps.tasks,
    sessions: deps.sessions,
    access: deps.access,
    taskGate: deps.taskGate,
    now: deps.now,
    resolveHead: createDelegationHeadResolver(deps)
  },
  delegationHandoff: createWorkspaceDelegationHandoffProjection({
    delegations: store.workspaceDelegations,
    projects: deps.projects,
    tasks: deps.tasks,
    sessions: deps.sessions,
    messages: store.messages,
    access: deps.access,
    loadActor: (accountId) => loadActor(store.users, store.access, accountId, 'delegation-handoff-read')
  }),
  memory: { memory: memoryService },
  openApi: {
    tokens: apiTokenDeps,
    manage: apiTokenDeps,
    replays: store.mcpReplays,
    settings: store.settings,
    audit: store.audit,
    teams: store.teams,
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
previews.attachPrefix(app, readEnv('HUB_PREVIEW_PREFIX') ?? '');

const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  log(`控制台：http://${host}:${info.port}`);
});
// 端口被占是最常见的一种「起不来」，不该打一坨堆栈了事
previews.start();

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
  if (/^\/api\/projects\/[^/]+\/workdir-tabs\/[^/]+\/terminals\/[^/]+\/socket$/.test(path)) {
    if (workdirTerminals) workdirTerminals.attach(request, socket, head);
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
    schedules.clear();
    child.kill('SIGTERM');
    terminalBridge?.close();
    workdirTerminals?.close();
    void previews.proxy?.close();
    previews.channel?.close();
    serverGateway?.close();
    store.close();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
