import {
  asSessionId,
  createConnectorHub,
  createDispatcher,
  createGroupChat,
  createMessageBus,
  createOutboxPump,
  createPersistentAgents,
  createSessionInbox,
  createSessionLane,
  defaultWorkspaceFor,
  deriveSessionUseCase,
  err,
  forbidden,
  interruptSessionUseCase,
  isBusy,
  isContainerSession,
  notFound,
  ok,
  promptSessionUseCase,
  recordProvenance,
  releaseAfterTurn,
  setTaskStatusUseCase,
  type AgentTaskRequest,
  type Deps,
  type ProjectId,
  type SessionId,
  type Session,
  type Subject,
  type TaskId,
} from '@agent-hub/domain';
import { createFeishuClient, createFeishuSink, createFeishuSource, createFeishuTurnReplies } from '@agent-hub/connector-feishu';
import { createGithubClient, createGithubSink, createGithubSource, githubParams } from '@agent-hub/connector-github';
import { createTimerSource } from '@agent-hub/connector-timer';
import { createSqliteGitHostTokens, createSqlitePullRequests, type SqliteStore } from '@agent-hub/storage-sqlite';
import { createBotOfSession } from './bot-session.ts';
import { createFakeChannel, createFakeOutbound, createFakeReplies } from './fake-channel.ts';
import { loadActor, openRoleSession } from './role-session.ts';
import { createTaskProgress } from './task-progress.ts';
import type { Schedules } from './schedules.ts';

export interface ConnectorWiringInput {
  readonly deps: Deps;
  readonly store: SqliteStore;
  readonly log: (message: string) => void;
  readonly readEnv: (name: string) => string | null;
  readonly secretKey: Buffer;
  readonly sessionLane: ReturnType<typeof createSessionLane>;
  readonly schedules: Schedules;
}

export interface ConnectorWiring {
  readonly messageBus: ReturnType<typeof createMessageBus>;
  readonly groupChat: ReturnType<typeof createGroupChat>;
  readonly inbox: ReturnType<typeof createSessionInbox>;
  readonly persistentAgents: ReturnType<typeof createPersistentAgents>;
  readonly botOfSession: ReturnType<typeof createBotOfSession>;
  readonly subjectOf: (sessionId: SessionId) => Promise<Subject | null>;
  readonly githubClient: ReturnType<typeof createGithubClient>;
  readonly teamTokenOf: (projectId: string) => Promise<string | null>;
  readonly githubReposFor: (projectId: string) => Promise<string[]>;
  readonly pullRequestRepo: ReturnType<typeof createSqlitePullRequests>;
  readonly gitHostTokens: ReturnType<typeof createSqliteGitHostTokens>;
  readonly feishuReplies: ReturnType<typeof createFeishuTurnReplies> | null;
  readonly fakeReplies: ReturnType<typeof createFakeReplies> | null;
  readonly connectorHub: ReturnType<typeof createConnectorHub>;
  readonly taskProgress: ReturnType<typeof createTaskProgress>;
  readonly dispatcher: ReturnType<typeof createDispatcher>;
  readonly enqueueDispatch: (request: AgentTaskRequest) => Promise<void>;
}

/** 消息总线 / 群聊 / 收件箱 / 连接器 / 调度器 / 出站泵：按原顺序装配，对外只暴露 main 后续用得到的句柄。 */
export function wireConnectors(input: ConnectorWiringInput): ConnectorWiring {
  const { deps, store, log, readEnv, secretKey, sessionLane, schedules } = input;

  // agent 间通信（ADR 0018 · P2P）：消息总线 + 工具；回合结束（journal 里的 ended）时收回复、投下一条。
  // P2P 消息和群聊共用一道按会话的投递闸：同一条会话同一时间只有一个通道在等它的回复。
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
  schedules.every(30_000, () => void messageBus.sweep().catch(() => undefined));

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
  schedules.every(15_000, () => void groupChat.sweep().catch(() => undefined));

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
  const pullRequestRepo = createSqlitePullRequests(store.db);
  const githubSource = createGithubSource({
    client: githubClient,
    tokenFor: (b) => teamTokenOf(b.projectId ?? b.agentProjectId),
    sessionForPr: async (repo, number) => {
      const link = (await pullRequestRepo.openSyncedBefore(Number.MAX_SAFE_INTEGER, 1000)).find((l) => l.repo.toLowerCase() === repo.toLowerCase() && l.number === number);
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
        afterDerive: async (session: Session) => {
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
  schedules.every(15_000, () => void connectorHub.tick().catch((error: unknown) => log(`连接器重试失败：${String(error)}`)));
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
    sinks: [createGithubSink({ outbox: store.outbox, now: () => Date.now(), client: githubClient, tokenFor: teamTokenOf, boundRepos: githubReposFor, prLinks: async (taskId) => (await pullRequestRepo.byTask(taskId)).map((l) => l.url), log })],
    log
  });
  const enqueueDispatch = async (r: AgentTaskRequest) => {
    const creator = await deps.sessions.byId(r.sessionId as SessionId);
    const bot = await botOfSession(r.sessionId as SessionId);
    const role = bot ? (await messageBus.config(bot.projectId as ProjectId)).roles.find((x) => x.name === bot.name) : null;
    await dispatcher.enqueue(r, { agentId: role?.ref.runtime ?? creator?.agentId ?? null, model: role?.ref.model ?? creator?.model ?? null });
    void dispatcher.tick().catch((error: unknown) => log(`调度失败：${String(error)}`));
  };
  schedules.every(10_000, () => void dispatcher.tick().catch((error: unknown) => log(`调度失败：${String(error)}`)));

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
  schedules.every(1_000, () => {
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
  });
  // 飞书出站：只认领 `feishu:` 前缀的 external 行，github 的回帖继续留在队列里等各自的发送侧。
  const feishuOutboxPump = feishuSink
    ? createOutboxPump({ store: store.outbox, now: () => Date.now(), kinds: ['external'], targetPrefixes: ['feishu:'], deliver: feishuSink.deliver })
    : null;
  let feishuOutboxBusy = false;
  schedules.every(1_000, () => {
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
  });
  let outboxBusy = false;
  schedules.every(1_000, () => {
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
  });

  return { messageBus, groupChat, inbox, persistentAgents, botOfSession, subjectOf, githubClient, teamTokenOf, githubReposFor, pullRequestRepo, gitHostTokens, feishuReplies, fakeReplies, connectorHub, taskProgress, dispatcher, enqueueDispatch };
}
