import { homedir } from 'node:os';
import { applyStartExtras, checkStartExtras } from './session-start-extras.ts';
import {
  createAgentOrchestrationToolProvider,
  createAgentTaskToolProvider,
  createArtifactToolProvider,
  createContextToolProvider,
  createGitToolProvider,
  createMemoryToolProvider,
  createMessageToolProvider,
  createProjectToolProvider,
  createSessionControlToolProvider,
  createSessionToolProvider,
  createTaskToolProvider,
  createToolGateway,
  createWorkspaceToolProvider,
  deriveSessionUseCase,
  err,
  interruptSessionUseCase,
  invalid,
  notFound,
  ok,
  prepareRepoWorktreeUseCase,
  prepareTemporaryWorkspaceUseCase,
  proposeWorkspaceDelegationUseCase,
  promptSessionUseCase,
  renameSessionUseCase,
  setProjectChecksUseCase,
  setProjectDescriptionUseCase,
  systemSubject,
  authorizeWorker,
  usableByProject,
  type AgentTaskRequest,
  type Deps,
  type DomainError,
  type MessageBus,
  type MessageStore,
  type Result,
  type SessionId,
  type SpawnAgentAction,
  type SpawnedAgent,
  type Subject,
  type ToolGateway,
  type ToolProvider,
  type Workspace,
  changeSessionOption
} from '@agent-hub/domain';
import { createTokenIssuer } from '@agent-hub/adapter-accounts';
import { createGithubToolProvider, githubParams, parseIssueKey, type GithubClient } from '@agent-hub/connector-github';
import type { SqliteStore } from '@agent-hub/storage-sqlite';
import type { createBotOfSession } from './bot-session.ts';
import { createGitWriteSubjectOf } from './git-write-identity.ts';
import { loadActor } from './role-session.ts';
import { createWorkspaceDelegationBridges } from './workspace-delegation.ts';
import { createWorkspaceDelegationToolProvider } from './workspace-delegation-tool.ts';
import type { createGroupChat, createMessageBus } from '@agent-hub/domain';
import type { createProviderWiring, ProviderWiringApi } from './providers.ts';
import type { createWorkspaceFilesService } from '@agent-hub/domain';
import type { createGitWorkflowService } from '@agent-hub/domain';
import type { createMemoryService } from '@agent-hub/domain';
import type { createContextService } from '@agent-hub/domain';
import { asSessionId, asTaskId, asWorkspaceId } from '@agent-hub/domain';

export type SpawnWorkerSource = 'explicit' | 'session' | 'workspace';

export interface SpawnWorkerTarget {
  readonly workerId: string;
  readonly source: SpawnWorkerSource;
}

const WORKER_REQUIRED =
  '这次派生要准备工作空间，但当前会话没有记录可用的 Worker：请显式传 worker_id（不要默认按 Hub 本机处理）';

/**
 * 派生时准备工作空间到底落到哪台机器：
 * 1. 显式 worker_id 优先（由调用方再按 owner 的 worker.use 授权）；
 * 2. 否则用发起会话自己的 workerId；
 * 3. 会话没有记录 workerId 时，才采用它绑定的工作空间的 workerId，且必须和会话/项目对得上；
 * 4. 都没有 / 不在线 / 对不上都报错，明确让人补 worker_id，绝不把 null 当成 Hub 本机。
 */
export async function resolveSpawnWorker(
  deps: Pick<Deps, 'sessions' | 'workspaces' | 'gateway'>,
  input: { readonly callerSessionId: string; readonly projectId: string; readonly requestedWorkerId?: string | null }
): Promise<Result<SpawnWorkerTarget, DomainError>> {
  const requested = input.requestedWorkerId?.trim() || null;
  const workers = await deps.gateway.status();

  const usable = (workerId: string, source: SpawnWorkerSource): Result<SpawnWorkerTarget, DomainError> => {
    const worker = workers.find((candidate) => candidate.workerId === workerId);
    if (!worker) {
      return err(
        requested !== null
          ? notFound(`没有这台 Worker：${requested}；请换一个可用的 worker_id`)
          : invalid(`当前会话记录的 Worker「${workerId}」已经不存在：请显式传一个可用的 worker_id`)
      );
    }
    if (worker.state !== 'online') {
      return err(invalid(`Worker「${worker.label}」当前离线，不能准备派生工作空间：请换一台在线的 Worker 或显式传 worker_id`));
    }
    return ok({ workerId: worker.workerId, source });
  };

  if (requested !== null) return usable(requested, 'explicit');

  const caller = await deps.sessions.byId(asSessionId(input.callerSessionId));
  if (!caller) return err(notFound('发起派生的会话不存在'));

  let workspace: Workspace | null = null;
  if (caller.workspaceId) {
    const found = await deps.workspaces.byId(asWorkspaceId(caller.workspaceId));
    if (found && (await usableByProject(deps, found, input.projectId))) workspace = found;
  }

  // 两边都记了机器却对不上：说明数据本身矛盾，不能替调用方二选一。
  if (caller.workerId !== null && workspace?.workerId != null && caller.workerId !== workspace.workerId) {
    return err(
      invalid(
        `当前会话记录的 Worker「${caller.workerId}」和它绑定的工作空间 Worker「${workspace.workerId}」不一致，不能替你猜：请显式传 worker_id`
      )
    );
  }

  const workerId = caller.workerId ?? workspace?.workerId ?? null;
  if (workerId === null) return err(invalid(WORKER_REQUIRED));

  const checked = usable(workerId, caller.workerId !== null ? 'session' : 'workspace');
  if (!checked.ok) {
    return err(
      invalid(`当前会话记录的 Worker「${workerId}」不能用于准备工作空间（${checked.error.message}）：请显式传 worker_id`)
    );
  }
  return checked;
}

export interface SpawnAgentContext {
  readonly messages?: Pick<MessageStore, 'sessionByHandle'>;
  readonly subjectOf: (sessionId: SessionId) => Promise<Subject | null>;
  readonly checkModel: ProviderWiringApi['checkModel'];
  readonly messageBus: Pick<MessageBus, 'setHandle' | 'handleOf'>;
  readonly home: () => string;
}

/**
 * agent.spawn 的服务端实现。抽出来是为了让「派生到哪台机器」可以脱离完整 server 接线做单测。
 * 未指定 workspace_mode / repo_id 时保持旧行为：只按显式 worker_id 和项目默认工作空间派生。
 */
export async function spawnAgentAction(
  deps: Deps,
  context: SpawnAgentContext,
  input: SpawnAgentAction
): Promise<Result<SpawnedAgent, DomainError>> {
  // 会话通信 P1b：派生出来的会话自动和发起方连线；起短名、挑机器、一仓一会话都按会话主人的权限算。
  const owner = await context.subjectOf(asSessionId(input.callerSessionId));
  const extras = { ...(input.handle ? { handle: input.handle } : {}), linkWith: [input.callerSessionId] };
  const linkIds = await checkStartExtras(deps, context.messages, input.taskId, extras, owner);
  if (!linkIds.ok) return linkIds;
  // hub 托管模型（hub-xxx/模型）要先过提供商检查拿到协议，和 /api/sessions/derive 一样；按会话主人算权限
  const modelCheck = await context.checkModel(owner, input.model, input.taskId);
  if (!modelCheck.ok) return modelCheck;

  const preparing = Boolean(input.repoId || input.workspaceMode);
  let workspaceId: string | undefined;
  if (preparing) {
    const task = await deps.tasks.byId(asTaskId(input.taskId));
    if (!task) return err(notFound('任务不存在'));
    // 隔离空间必须有明确的落点：显式 worker_id，或发起会话真实记录的 Worker。
    // null 不是「Hub 本机」的同义词——不能拿它去让 resolveMachine 默默挑一台机器。
    const target = await resolveSpawnWorker(deps, {
      callerSessionId: input.callerSessionId,
      projectId: task.projectId,
      ...(input.workerId === undefined ? {} : { requestedWorkerId: input.workerId })
    });
    if (!target.ok) return target;
    // 机器是会话主人选的，就按主人的 worker.use 授权；工作空间准备不再用 systemSubject 绕过。
    const usable = await authorizeWorker(deps.access, owner, target.value.workerId);
    if (!usable.ok) return usable;

    if (input.repoId) {
      const prepared = await prepareRepoWorktreeUseCase(deps, {
        projectId: task.projectId,
        taskId: task.id,
        repoId: input.repoId,
        workerId: target.value.workerId,
        home: context.home(),
        actor: owner
      });
      if (!prepared.ok) return prepared;
      workspaceId = prepared.value.id;
    } else {
      const prepared = await prepareTemporaryWorkspaceUseCase(deps, {
        projectId: task.projectId,
        taskId: task.id,
        workerId: target.value.workerId,
        home: context.home(),
        mode: input.workspaceMode as 'shared' | 'isolated',
        actor: owner
      });
      if (!prepared.ok) return prepared;
      workspaceId = prepared.value.id;
    }
  } else if (input.workerId) {
    const usable = await authorizeWorker(deps.access, owner, input.workerId);
    if (!usable.ok) return usable;
  }

  const created = await deriveSessionUseCase(deps, {
    taskId: input.taskId,
    agentId: input.agentId,
    model: input.model,
    options: input.options,
    ...(modelCheck.value ? { hubProtocol: modelCheck.value } : {}),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(input.workerId && workspaceId === undefined ? { workerId: input.workerId } : {}),
    actor: systemSubject('agent.spawn'),
    createdBy: input.createdBy
  });
  if (!created.ok) return created;
  const session = created.value;
  await applyStartExtras(deps, context.messageBus, session, extras, linkIds.value, input.createdBy);
  if (input.prompt) {
    const sent = await promptSessionUseCase(deps, {
      sessionId: session.id,
      text: input.prompt,
      promptActor: 'system',
      author: { id: 'agent-orchestrator', name: '编排 Agent', via: 'agent' }
    });
    if (!sent.ok) return sent;
  }
  return ok({
    sessionId: session.id,
    taskId: session.taskId,
    agentId: session.agentId,
    model: session.model,
    status: session.status,
    handle: await context.messageBus.handleOf(session),
    workspaceId: session.workspaceId ?? null
  });
}

export interface ToolWiringInput {
  readonly deps: Deps;
  readonly store: SqliteStore;
  readonly readEnv: (name: string) => string | null;
  readonly messageBus: ReturnType<typeof createMessageBus>;
  readonly groupChat: ReturnType<typeof createGroupChat>;
  readonly botOfSession: ReturnType<typeof createBotOfSession>;
  readonly contextService: ReturnType<typeof createContextService>;
  readonly filesService: ReturnType<typeof createWorkspaceFilesService>;
  readonly gitService: ReturnType<typeof createGitWorkflowService>;
  readonly memoryService: ReturnType<typeof createMemoryService>;
  readonly providerWiring: ReturnType<typeof createProviderWiring>;
  readonly githubClient: GithubClient;
  readonly teamTokenOf: (projectId: string) => Promise<string | null>;
  readonly githubReposFor: (projectId: string) => Promise<string[]>;
  readonly subjectOf: (sessionId: SessionId) => Promise<Subject | null>;
  readonly enqueueDispatch: (request: AgentTaskRequest) => Promise<void>;
  readonly projectSessionTools?: ToolProvider;
  readonly projectAssetTools?: ToolProvider;
  readonly workspaceReportTools?: ToolProvider;
  readonly projectSessionScopeCap?: NonNullable<Parameters<typeof createToolGateway>[0]['scopeCap']>;
}

/** 工具网关：把各工具 provider 按会话/项目权限接起来；main 只拿回网关给 worker 中转。 */
export function wireTools(input: ToolWiringInput): ToolGateway {
  const { deps, store, readEnv, messageBus, groupChat, botOfSession, contextService, filesService, gitService, memoryService, providerWiring, githubClient, teamTokenOf, githubReposFor, subjectOf, enqueueDispatch } = input;
  // #217：写工具的身份闸。共享会话（bot / 群 / 连接器 / 调度）没有可验证的当轮人类身份，直接拒写。
  const gitWriteSubjectOf = createGitWriteSubjectOf({
    sessions: deps.sessions,
    botOfSession,
    spawnOf: (sessionId) => store.messages.spawnOf(sessionId),
    memberOfSession: (sessionId) => store.groups.memberOfSession(sessionId),
    provenance: store.provenance,
    dispatches: store.dispatches,
    delegations: store.workspaceDelegations,
    subjectOf
  });
  return createToolGateway({
    now: deps.now,
    toolGrants: store.toolGrants,
    tokens: createTokenIssuer(),
    scopeCap: input.projectSessionScopeCap,
    providers: [createTaskToolProvider(deps), createMessageToolProvider(messageBus, groupChat), createMemoryToolProvider(memoryService), createContextToolProvider(contextService),
      ...(input.projectSessionTools ? [input.projectSessionTools] : []),
      ...(input.projectAssetTools ? [input.projectAssetTools] : []),
      ...(input.workspaceReportTools ? [input.workspaceReportTools] : []),
      createSessionToolProvider({ ...deps, extraProjects: async (sid) => { const bot = await botOfSession(sid as SessionId); return bot ? store.connectors.agentProjects(bot.projectId, bot.name) : []; } }),
      // issue #216：agent 不 shell git/gh 也能 commit / push / 开 PR；权限与审计走工作流。
      createGitToolProvider({ workflow: gitService, subjectOf, writeSubjectOf: gitWriteSubjectOf, resolvePeer: (from, address) => messageBus.resolvePeer(from, address) }),
      // issue #216 P2：产物列表 / 引用登记与工作空间文件只读。
      createArtifactToolProvider({ sessions: deps.sessions, artifacts: deps.artifacts, tasks: deps.tasks, workLog: deps.workLog, now: deps.now }),
      // 会话通信 P1c：session 参数只读看已连线同伴；workspace.changes 复用 git 工作流的 state。
      createWorkspaceToolProvider({ files: filesService, subjectOf, resolvePeer: (from, address) => messageBus.resolvePeer(from, address), gitState: (subject, sessionId, member) => gitService.state(subject, sessionId, member) }),
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
      // 派工提案：主会话只能把请求登记成 pending；身份取授权快照并与会话归属人核对，不读 payload actor。
      createWorkspaceDelegationToolProvider({
        sessions: deps.sessions,
        bridgesFor: ({ baseBranch, agentId }) =>
          createWorkspaceDelegationBridges(deps, store.workspaceCoordinators, { baseBranch, agentId }),
        propose: (command, bridges) =>
          proposeWorkspaceDelegationUseCase(deps, store.workspaceDelegations, bridges, command),
        loadActor: (userId) => loadActor(store.users, store.access, userId, 'tool-workspace-delegate')
      }),
      createAgentOrchestrationToolProvider({
        agentProfiles: deps.agentProfiles,
        sessions: deps.sessions,
        tasks: deps.tasks,
        projects: deps.projects,
        agents: deps.agents,
        now: deps.now,
        spawn: async (input) =>
          spawnAgentAction(deps, {
            messages: store.messages,
            subjectOf,
            checkModel: providerWiring.checkModel,
            messageBus,
            home: homedir
          }, input),
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
}
