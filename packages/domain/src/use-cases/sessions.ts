import { principalOfSubject, type Subject } from '../access.ts';
import { applyEvent, deriveSession, forkSession, isContainerSession, isNeverPrompted, markInterrupted, normalizeMcpDisabled, withOptions, MODEL_PINNED } from '../session.ts';
import type { Session } from '../session.ts';
import { findOption, optionValues, type RuntimeOption } from '../option.ts';
import type { Seq, SessionId, TaskId, WorkspaceGroupId } from '../ids.ts';
import { asAgentId, asProjectId, asSessionId, asTaskId, asWorkspaceGroupId, asWorkspaceId } from '../ids.ts';
import { groupReady } from '../workspace-group.ts';
import { isUsable, setupNotReady } from '../workspace.ts';
import type { DomainError } from '../errors.ts';
import { conflict, invalid, notFound } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import { createArtifact } from '../artifact.ts';
import type { SessionEvent } from '../event.ts';
import type { Deps } from './deps.ts';
import { ensureHosted } from './hosting.ts';
import { startSessionUseCase } from './start-session.ts';
import { parseHubModel, type ProviderProtocol } from '../provider.ts';
import type { DeliveryQueue } from '../ports/delivery-queue.ts';
import { mergeAgentRef, type AgentRef } from '../agent-ref.ts';
import { checkModelOn, placeSession } from '../worker.ts';
import { markStarted } from '../task.ts';
import { recordSystemLog } from './work-log.ts';
import { defaultWorkspaceFor, locationOf, usableByProject } from './workspaces.ts';
import { authorizeSession, authorizeWorker, projectOfSessionOrigin } from './authorization.ts';
import { agentProfileForUse } from './agent-profiles.ts';
import { resolveDefaultAgent } from './resolve-default-agent.ts';
import { withActiveTask } from './task-admission.ts';
import { readInFlightTurn, readJournalTail, readRecentTurnDeliveries, turnVerdictInTail } from './turn-evidence.ts';

export interface DeriveCommand {
  /** 归属任务。容器会话（群角色 / bot P2P，#221 步骤 7）不传，改用 `projectId` 定位项目。 */
  readonly taskId?: string;
  /** 容器会话用的项目归属：没有任务时靠它决定工作空间 / 落点规则。 */
  readonly projectId?: string;
  /** 三件套：runtime + model + 启动选项。新调用点用它，旧字段只为兼容保留。 */
  readonly ref?: AgentRef;
  /** @deprecated 用 `ref`；给了就覆盖 `ref.runtime`。 */
  readonly agentId?: string;
  /** @deprecated 用 `ref`；给了就覆盖 `ref.model`。 */
  readonly model?: string;
  /** 人在对话框里点名的 Worker；不点名就由落点规则挑。 */
  readonly workerId?: string | null;
  /** 运行面板里选定的工作空间：会话就落在它所在的机器、在它的目录里干活。 */
  readonly workspaceId?: string | null;
  /** 组合工作空间（多仓库）：给了就整组跟随；workspaceId 记 primary 成员（兼容），cwd 是主仓库目录（老组仍是容器根）。 */
  readonly groupId?: string | null;
  /** 预分配的会话 id（组合建组时写进分支名的那个）；已存在则忽略。 */
  readonly sessionId?: string | null;
  /** 谁发起的：开跑前要过 authorizeWorker（本机 Worker 单独授权）。 */
  readonly actor?: Subject | null;
  /** 要求的能力：只落到这些能力可信的机器上（ADR 0021 §8）。 */
  readonly requires?: readonly string[];
  /** 派生前已核对的 hub 提供商协议。用来拒绝 agent 不认的协议；不是 hub 模型就不传。 */
  readonly hubProtocol?: ProviderProtocol;
  /** 用一份 Agent 配置启动；profile 里的 ref 作为默认，command.options 可覆盖选项。 */
  readonly profileId?: string;
  /** 直接指定启动选项（例如从 Agent 配置套用后用户又改过）。@deprecated 用 `ref.options`。 */
  readonly options?: Readonly<Record<string, string | boolean>>;
  /** 谁拥有新会话；工具派生时继承父会话主人，人类请求默认取 actor。 */
  readonly createdBy?: string | null;
  /** 这个会话是哪个 bot 开的（按 id，不按名字）。人开的 / 老入口不传。 */
  readonly botId?: string | null;
  /** `side` = 侧聊：挂在 parentSessionId 上，继承父会话的落点与运行参数，不进常规列表。 */
  readonly kind?: 'side';
  readonly parentSessionId?: string | null;
  /** 只带这些资产（asset id）；null / 缺省 = 项目生效集。 */
  readonly assetIds?: readonly string[] | null;
  /** 只带这些资产组合（覆盖项目默认）；null / 缺省 = 项目默认组合。 */
  readonly assetSetIds?: readonly string[] | null;
}

/**
 * 派生会话：唯一入口。
 * 常规会话必须落到一个真实任务上；容器会话（群角色 / bot P2P）没有任务，靠 `projectId` 落项目。
 */
type DeriveSessionDeps = Pick<Deps, 'agents' | 'gateway' | 'hosting' | 'now' | 'projects' | 'sessions' | 'tasks' | 'taskGate' | 'workLog' | 'workspaces' | 'access' | 'agentProfiles' | 'workspaceGroups' | 'agentDefaults'>;

export async function deriveSessionUseCase(
  deps: DeriveSessionDeps,
  command: DeriveCommand
): Promise<Result<Session, DomainError>> {
  const taskId = command.taskId ? asTaskId(command.taskId) : null;
  return withActiveTask(deps, taskId, () => deriveSessionAdmitted(deps, command));
}

async function deriveSessionAdmitted(
  deps: Pick<Deps, 'agents' | 'gateway' | 'hosting' | 'now' | 'projects' | 'sessions' | 'tasks' | 'workLog' | 'workspaces' | 'access' | 'agentProfiles' | 'workspaceGroups' | 'agentDefaults'>,
  command: DeriveCommand
): Promise<Result<Session, DomainError>> {
  const task = command.taskId ? await deps.tasks.byId(asTaskId(command.taskId)) : null;
  if (command.taskId && !task) return err(notFound('任务不存在'));
  let projectId = task ? task.projectId : command.projectId ? asProjectId(command.projectId) : null;

  // 侧聊（I4）：只为顺口问一句，完全继承父会话的落点与运行参数。
  // 调用方给的 workspaceId / workerId / agentId / model / options / groupId 一律忽略。
  let parent: Session | null = null;
  if (command.kind === 'side') {
    const found = command.parentSessionId ? await deps.sessions.byId(asSessionId(command.parentSessionId)) : null;
    // 父会话是容器会话时没有任务可继承项目：侧聊只挂在有任务的会话上（边界见 #221 步骤 7）。
    const parentTask = found && !isContainerSession(found) ? await deps.tasks.byId(found.taskId as TaskId) : null;
    if (!found || !parentTask || !found.workspaceId || !found.workerId) {
      return err(invalid('侧聊要挂在一条已有会话上'));
    }
    if (projectId === null) projectId = parentTask.projectId;
    if (parentTask.projectId !== projectId) {
      return err(invalid('侧聊要挂在一条已有会话上，而且要和它同一个项目'));
    }
    parent = found;
    command = {
      ...command,
      agentId: parent.agentId,
      model: parent.model,
      ref: undefined,
      profileId: undefined,
      options: parent.options,
      workspaceId: parent.workspaceId,
      workerId: parent.workerId,
      groupId: parent.groupId ?? null,
      requires: undefined,
      hubProtocol: undefined,
      createdBy: principalOfSubject(command.actor)?.user.id ?? command.createdBy ?? parent.createdBy ?? null
    };
  }

  if (projectId === null) return err(invalid('派生会话要落到一个项目上：给 taskId（有任务的会话）或 projectId（容器会话）'));
  const project = await deps.projects.byId(projectId);
  if (!project) return err(notFound('项目不存在'));

  // 归一成 ref：旧字段（agentId/model/options）优先，保持既有调用点语义。
  const commandRef: AgentRef = {
    runtime: command.agentId ?? command.ref?.runtime ?? '',
    model: command.model ?? command.ref?.model ?? '',
    options: { ...(command.ref?.options ?? {}), ...(command.options ?? {}) }
  };
  // profile 打底：runtime / model 听 profile 的，选项让 command 覆盖（与旧行为一致）。
  let ref = commandRef;
  if (command.profileId) {
    const profile = await agentProfileForUse(deps, principalOfSubject(command.actor)?.user.id ?? null, command.profileId);
    if (!profile.ok) return profile;
    ref = mergeAgentRef(profile.value.ref, { options: commandRef.options });
  }

  // 默认 Agent 的层级（从低到高）：团队按运行时的默认模型 < 项目默认 < 任务默认 < 显式选择。
  ref = (await resolveDefaultAgent(deps, { project, task, explicit: ref })).effective;
  const agentId = asAgentId(ref.runtime);
  const descriptor = deps.agents.descriptor(agentId);
  if (!descriptor) return err(conflict(`没有在线节点提供 ${ref.runtime}`));
  if (descriptor.capabilities.prompt.state === 'denied') {
    return err(conflict(descriptor.capabilities.prompt.reason ?? '该 agent 不可发送消息'));
  }

  // 组合工作空间优先：会话跟着整组走，workspaceId 由 primary 成员决定（多仓库时前端不再传 workspaceId）。
  let groupId: WorkspaceGroupId | null = null;
  if (command.groupId) {
    const group = deps.workspaceGroups ? await deps.workspaceGroups.byId(asWorkspaceGroupId(command.groupId)) : null;
    if (!group || group.projectId !== project.id) return err(notFound('组合工作空间不存在'));
    if (!groupReady(group)) return err(conflict('这组工作空间还没准备好'));
    const primary = group.members[0];
    if (!primary) return err(conflict('这组工作空间还没有成员仓库'));
    groupId = group.id;
    command = { ...command, workspaceId: primary.workspaceId };
    if (!command.sessionId && group.sessionId) command = { ...command, sessionId: group.sessionId };
  }
  const chosen = command.workspaceId ? await deps.workspaces.byId(asWorkspaceId(command.workspaceId)) : null;
  const waitForSetup = project.worktree?.setup?.waitForSetup ?? true;
  if (command.workspaceId) {
    if (!chosen || !(await usableByProject(deps, chosen, project.id))) return err(notFound('工作空间不存在'));
    const blocked = chosen ? setupNotReady(chosen, waitForSetup) : null;
    if (blocked) return err(conflict(blocked));
    if (!isUsable(chosen)) return err(conflict('这个工作空间现在用不了（准备中、失败或已删除）'));
    if (chosen.kind === 'temporary' && (task === null || chosen.ownerTaskId !== task.id)) return err(conflict('这个临时工作空间属于别的任务'));
  }
  // 机器跟着工作空间走（null = Server 本机）；没选就用项目的默认工作空间
  const workspace = chosen ?? (await defaultWorkspaceFor(deps, project.id));
  if (!workspace) return err(conflict('这个项目还没有工作空间：先选在哪台机器、哪个工作空间干活'));
  const notReady = setupNotReady(workspace, waitForSetup);
  if (notReady) return err(conflict(notReady));
  const workers = await deps.gateway.status();
  // 令牌永远不能用本机。先于就绪检查拒绝，避免「未配置模型」把本机拒绝盖成 503。
  const homeWorker = workspace.workerId ?? workers.find((worker) => worker.origin === 'local')?.workerId ?? null;
  if (homeWorker !== null) {
    const early = await authorizeWorker(deps.access, command.actor ?? null, homeWorker);
    if (!early.ok) return early;
  }
  const placed = placeSession(workers, {
    agentId,
    requested: chosen ? chosen.workerId : (command.workerId ?? null),
    projectWorker: workspace.workerId,
    model: ref.model,
    ...(command.requires?.length ? { requires: command.requires } : {})
  });
  if (!placed.ok) return placed;
  const allowed = await authorizeWorker(deps.access, command.actor ?? null, placed.value);
  if (!allowed.ok) return allowed;
  const model = checkModelOn(workers, placed.value, agentId, ref.model, command.hubProtocol);
  if (!model.ok) return model;
  const reservedId = command.sessionId?.trim() || null;
  const reserved = reservedId ? await deps.sessions.byId(asSessionId(reservedId)) : null;
  const created = deriveSession({
    task,
    agentId,
    model: model.value,
    kind: parent ? 'side' : 'chat',
    parentSessionId: parent ? parent.id : null,
    now: deps.now(),
    workerId: placed.value,
    workspaceId: workspace.id,
    groupId,
    // #243：容器会话的来源项目在建会话时定死，后续工作空间/组怎么变都不改授权归属。
    originProjectId: task === null ? project.id : undefined,
    ...(reserved || !reservedId ? {} : { id: asSessionId(reservedId) }),
    createdBy: command.createdBy !== undefined ? command.createdBy : principalOfSubject(command.actor)?.user.id ?? null,
    botId: command.botId ?? null,
    ...(command.assetIds == null ? {} : { assetIds: command.assetIds }),
    ...(command.assetSetIds == null ? {} : { assetSetIds: command.assetSetIds }),
    options: ref.options
  });
  if (!created.ok) return created;

  const session = { ...created.value, workerId: placed.value };
  await deps.sessions.save(session);
  // 组合会话的 cwd 是主仓库目录（locationOf；老组是容器根）；单仓仍是 workspace.path。
  const { root } = await locationOf(deps, project, session);
  const started = await startSessionUseCase(deps, { session, workspaceRoot: root, resume: null });
  if (!started.ok) return started;
  await noteSessionStarted(deps, session, `开了 ${session.agentId} 会话${session.model ? `（${session.model}）` : ''}`);
  return ok(session);
}

/** 会话开跑：todo 推到 in_progress，并记一条系统日志。容器会话没有任务，什么都不做。 */
async function noteSessionStarted(
  deps: Pick<Deps, 'now' | 'tasks' | 'workLog'>,
  session: Session,
  body: string
): Promise<void> {
  // 手上只有 session 上取下来的 taskId，不是 Session 对象：保留 null 判据。
  const taskId = session.taskId;
  if (taskId === null) return;
  const task = await deps.tasks.byId(taskId);
  if (task) {
    const started = markStarted(task, deps.now());
    if (started !== task) await deps.tasks.save(started);
  }
  await recordSystemLog(deps, taskId, body, session.id);
}

export interface ForkCommand {
  readonly sessionId: string;
  /**
   * 只为兼容老客户端保留，已被忽略：分叉一律从来源的最新处（lastSeq）开。
   * 原因见 docs/adr：底层 agent 都没有「按 entry 分叉」，挑中间某一步得到的上下文会和标记对不上。
   */
  readonly atSeq?: Seq;
  readonly agentId: string;
  readonly model: string;
  readonly actor?: Subject | null;
}

export async function forkSessionUseCase(
  deps: Pick<Deps, 'agents' | 'gateway' | 'hosting' | 'now' | 'projects' | 'sessions' | 'tasks' | 'taskGate' | 'workLog' | 'workspaces' | 'access'>,
  command: ForkCommand
): Promise<Result<Session, DomainError>> {
  const source = await deps.sessions.byId(asSessionId(command.sessionId));
  if (!source) return err(notFound('来源会话不存在'));

  const sourceDescriptor = deps.agents.descriptor(source.agentId);
  const forkCap = sourceDescriptor?.capabilities.fork;
  if (!forkCap || forkCap.state === 'denied') {
    return err(conflict(forkCap?.reason ?? '该 agent 不支持会话分叉，所以不能作为血缘起点'));
  }

  if (source.lastSeq < 1) return err(conflict('来源会话还没有内容，没有可以分叉的地方'));
  const atSeq = source.lastSeq;

  const sourceTaskId = source.taskId;
  if (sourceTaskId === null) {
    // 边界（#221 步骤 7）：容器会话不挂在任务上，分叉要按任务算项目与落点，这里先明确拒绝。
    return err(invalid('容器会话（不属于任何任务）暂不支持分叉'));
  }
  return withActiveTask(deps, sourceTaskId, async () => {
    const sourceTask = await deps.tasks.byId(sourceTaskId);
    if (!sourceTask) return err(notFound('来源会话所属的任务不存在'));
    const project = await deps.projects.byId(sourceTask.projectId);
    if (!project) return err(notFound('项目不存在'));

    // 分叉会继承 agentSessionRef，等于能读来源会话的 agent 文件：和 prompt 一样只认会话创建者
    // （团队 owner / admin 或被显式授权的人也放行），不能因为项目被共享就越权。
    const sourceAllowed = await authorizeSession(deps.access, command.actor ?? null, project, source, 'session.fork');
    if (!sourceAllowed.ok) return sourceAllowed;

    const agentId = asAgentId(command.agentId);
    if (!deps.agents.descriptor(agentId)) {
      return err(conflict(`没有在线节点提供 ${command.agentId}`));
    }

    // 分叉要读来源会话的 agent 会话文件，那份文件只在来源的那台机器上：钉死在它上面。
    const workers = await deps.gateway.status();
    const homeWorker = source.workerId ?? workers.find((worker) => worker.origin === 'local')?.workerId ?? null;
    if (homeWorker !== null) {
      const early = await authorizeWorker(deps.access, command.actor ?? null, homeWorker);
      if (!early.ok) return early;
    }
    const placed = placeSession(workers, {
      agentId,
      requested: source.workerId,
      projectWorker: source.workerId,
      model: command.model
    });
    if (!placed.ok) return placed;
    const allowed = await authorizeWorker(deps.access, command.actor ?? null, placed.value);
    if (!allowed.ok) return allowed;
    const model = checkModelOn(workers, placed.value, agentId, command.model);
    if (!model.ok) return model;

    const created = forkSession({
      source,
      atSeq,
      agentId,
      model: model.value,
      now: deps.now(),
      workerId: placed.value,
      createdBy: principalOfSubject(command.actor)?.user.id ?? null,
      options: source.options
    });
    if (!created.ok) return created;

    const session = { ...created.value, workerId: placed.value };
    await deps.sessions.save(session);

    const { root } = await locationOf(deps, project, session);
    const started = await startSessionUseCase(deps, {
      session,
      workspaceRoot: root,
      resume: { agentSessionRef: source.agentSessionRef, cursor: atSeq },
      inheritedOptions: source.options
    });
    if (!started.ok) return started;
    await noteSessionStarted(deps, session, `从会话 ${source.id.slice(0, 8)} 的最新处（第 ${atSeq} 步）分叉出 ${session.agentId} 会话`);
    return ok(session);
  });
}

export interface RecordEventCommand {
  readonly sessionId: SessionId;
  readonly event: SessionEvent;
}

/** 事件落盘 + 广播。seq 由平台分配，worker 不参与编号。 */
export async function recordEvent(
  deps: Pick<Deps, 'artifacts' | 'now' | 'sessions' | 'stream'>,
  command: RecordEventCommand
): Promise<Result<Session, DomainError>> {
  const session = await deps.sessions.byId(command.sessionId);
  if (!session) return err(notFound('会话不存在'));

  const now = deps.now();
  const next = applyEvent(session, command.event, now);
  await deps.sessions.append(next, command.event, now);

  const artifactTaskId = session.taskId;
  if (command.event.kind === 'artifact' && artifactTaskId !== null) {
    const artifact = createArtifact({
      sessionId: session.id,
      taskId: artifactTaskId,
      path: command.event.path,
      bytes: command.event.bytes,
      now
    });
    if (artifact.ok) await deps.artifacts.save(artifact.value);
  }
  // 容器会话（#221 步骤 7）：产出物目前按任务汇总（artifacts.task_id NOT NULL），
  // 没有任务的会话先不落 artifact 行，事件本身照常广播。

  deps.stream.publish({
    sessionId: session.id,
    seq: next.lastSeq,
    event: command.event,
    status: next.status
  });
  return ok(next);
}

/** 启动对账：仍在 running 的会话一律降级为 interrupted（S7.1）。 */
export async function reconcileInterrupted(deps: Pick<Deps, 'now' | 'sessions'>): Promise<number> {
  const all = await deps.sessions.listAll();
  let changed = 0;
  for (const session of all) {
    if (session.status !== 'running') continue;
    const next = markInterrupted(session, deps.now());
    await deps.sessions.save(next);
    changed += 1;
  }
  return changed;
}

export interface SessionOptionsCommand {
  readonly sessionId: string;
  /** agent 报上来的全量清单（含候选值）。 */
  readonly options: readonly RuntimeOption[];
  /** Only an exact, current receipt may establish a pinned model selection. */
  readonly confirmedModel?: string;
}

/** agent 报上来的可调项当前值落库。它不是事件，所以不进 journal——不进就不占 seq。 */
export async function recordSessionOptions(
  deps: Pick<Deps, 'now' | 'sessions'>,
  command: SessionOptionsCommand
): Promise<Result<Session, DomainError>> {
  const session = await deps.sessions.byId(asSessionId(command.sessionId));
  if (!session) return err(notFound('会话不存在'));
  const values: Record<string, string | boolean> = {};
  let reportedModel: string | null = null;
  for (const option of command.options) {
    // 模型不跟 agent 的回报走：回报的是「这次启动它自己解析出来的默认值」，
    // 会被机器上的插件 / 配置影响，也可能随版本变。把它钉进会话之后，下次启动
    // 就会拿这个旧值去覆盖运行时的真实默认——机器上换了配置，会话却还指着一个不再用的模型。
    // 只有用户显式选过（session.model 非空）才写；否则留给运行时每次启动自己决定。
    //
    // 注意：不能在这里用「回报值 != session.model」判定陈旧。同一提供商里换模型
    // （changeSessionOption → set_option）走的正是这条回报：hub 不写乐观值，等 agent
    // 回报新值才落库；一刀切跳过会把合法的 A→B 改动静默丢掉。
    if (option.id === 'model') {
      if (command.confirmedModel !== undefined) {
        if (option.current !== command.confirmedModel) continue;
        reportedModel = command.confirmedModel;
        values[option.id] = command.confirmedModel;
        continue;
      }
      if (session[MODEL_PINNED]) continue;
      if (session.model === '') continue;
      if (typeof option.current === 'string') {
        // 跨提供商切换会重启进程。模型和选项来自同一快照，不能部分接受旧进程的回报。
        if (parseHubModel(session.model)?.slug !== parseHubModel(option.current)?.slug) return ok(session);
        reportedModel = option.current;
      }
    }
    values[option.id] = option.current;
  }
  const next: Session = {
    ...withOptions(session, values, deps.now()),
    // `Session.options` 的注释写明「模型仍以 model 字段为准」，所以运行中换模型不能只改
    // options.model / optionSpec：界面和下一次 start_session 都读 model 字段，漏了它就会
    // 停在旧模型。只有用户显式选过（非空）才同步，留空的会话仍由运行时每次决定。
    ...(reportedModel !== null && reportedModel !== session.model ? { model: reportedModel } : {}),
    ...(command.confirmedModel !== undefined && reportedModel !== null ? { [MODEL_PINNED]: true } : {}),
    optionSpec: command.options
  };
  await deps.sessions.save(next, { modelWrite: command.confirmedModel !== undefined && reportedModel !== null, optionSpecWrite: true });
  return ok(next);
}

export interface ChangeOptionCommand {
  readonly sessionId: string;
  readonly id: string;
  readonly value: string | boolean;
  readonly requestId?: string;
  readonly onSaved?: () => void;
  /** Exact opt-in: only save if actually unhosted; an idle hosted runtime is still live. */
  readonly exactModel?: boolean;
}

/**
 * 改一项可调项。
 *
 * 顺序不能反：先让 agent 改，再拿它回的全量状态落库。反过来的话，
 * agent 拒绝了这个值（比如那个模型不在它的清单里），库里就会留下一个
 * 「平台以为在跑 A、其实跑的是 B」的谎话。
 */
export async function changeSessionOption(
  deps: Pick<Deps, 'gateway' | 'hosting' | 'projects' | 'sessions' | 'tasks' | 'workspaces' | 'workspaceGroups' | 'bots' | 'now'>,
  command: ChangeOptionCommand
): Promise<Result<Session, DomainError>> {
  const session = await deps.sessions.byId(asSessionId(command.sessionId));
  if (!session) return err(notFound('会话不存在'));

  // 会话没在跑（这一轮已经结束）时，改选项是给「下一轮」预备的：
  // 不为了写一个值把 agent 进程拉起来（拉起也会被下一轮启动冲掉），直接落库并改本地的
  // optionSpec.current，界面立刻能看到新值，下次启动按 session.options 应用。
  if (command.exactModel ? !deps.hosting.has(session.id) : session.status !== 'running') {
    const saved = await changeSavedOption(deps, session, command);
    if (saved.ok) command.onSaved?.();
    return saved;
  }

  // 改模型也是在改一条会话的运行状态；它没在跑就先拉起来，否则指令会打空。
  if (!command.exactModel) {
    const hosted = await ensureHosted(deps, session);
    if (!hosted.ok) return hosted;
  }

  if (command.exactModel && !session[MODEL_PINNED]) {
    await deps.sessions.save({ ...session, [MODEL_PINNED]: true }, { modelWrite: true });
  }

  const changed = await deps.gateway.dispatch({
    kind: 'set_option',
    sessionId: session.id,
    optionId: command.id,
    value: command.value,
    ...(command.requestId ? { requestId: command.requestId } : {})
  });
  if (!changed.ok) return err(changed.error);

  // Legacy APIs have no exact receipt; an explicitly dispatched selection opts
  // back into their existing snapshot semantics, without doing so on failure.
  if (!command.exactModel && command.id === 'model' && session[MODEL_PINNED]) {
    const latest = await deps.sessions.byId(session.id);
    if (latest) await deps.sessions.save({ ...latest, [MODEL_PINNED]: false }, { modelWrite: true });
  }

  // 这里**不**自己往库里写一个乐观值：换模型会连带改变思考档位的可选值，
  // 只有 agent 知道换完之后整体长什么样。落库交给它的回报（recordSessionOptions），
  // 那一步走 per-session 串行队列，所以不会和我们抢。
  return ok((await deps.sessions.byId(session.id)) ?? session);
}

/**
 * 这条会话是否真的还有一回合没结束。
 *
 * 证据按优先级：
 * 1. 送达队列里精确的 `sending`——和 `session.status` 无关；状态帧把它写成
 *    interrupted / done 也照样算在跑；
 * 2. status 不是 running：视为已停止（与送达门的 `turnInProgress` 一致）。用户中断、
 *    掉线降级之后应当允许重启恢复，否则「非 running、journal 尾部却留着半截 prompt」
 *    的会话会永远切不了；
 * 3. status 是 running：退回 journal 尾部，最后一条 prompt 之后没有 ended 才算在跑。
 *    但还没派发的 prompt（对应送达记录 queued / undelivered / cancelled）不算开局——
 *    机器离线时发出的消息可以排队很久，不能拿它把切换永远堵死。尾部被截断时证明不了
 *    已经结束，按仍在跑处理（fail closed）。
 *
 * 这里刻意不 import `delivery.ts` 的 `turnInProgress`：那个模块反过来依赖本模块的
 * 事件写入，直接引会形成循环；这里的判断只服务于「能不能安全重启」。
 *
 * 送达侧现在把 `attemptDelivery` 也放在同一条 per-session 队列里，所以 `claimSend`
 * （把 queued 翻成 sending）不会在切换持锁期间插进来；`claimPrompt` 的入队写入仍在
 * 队列外，但它只产生 queued 行，不占回合。若送达侧的串行化退化，这里读到的就只是
 * 检查那一刻的快照。
 *
 * 有界读与尾部扫描骨架和送达门共用 `turn-evidence.ts`；**这里的优先级不同**：
 * 精确 sending → 非 running 即已停止 → journal 尾部。不要把两套顺序合并成一个 isBusy。
 */
async function turnStillRunning(
  deps: Pick<Deps, 'sessions'> & { readonly deliveries?: DeliveryQueue },
  session: Session
): Promise<boolean> {
  if (await readInFlightTurn(deps.deliveries, session.id)) return true;
  if (session.status !== 'running') return false;
  // queued = 还没认领；undelivered = 已放弃；cancelled = 用户撤回。三种都还没开局。
  const notStarted = new Set(
    (await readRecentTurnDeliveries(deps.deliveries, session.id))
      .filter(
        (delivery) =>
          delivery.kind === 'prompt' &&
          (delivery.state === 'queued' || delivery.state === 'undelivered' || delivery.state === 'cancelled')
      )
      .map((delivery) => delivery.seq)
  );
  const tail = await readJournalTail(deps, session.id);
  // 没开局的老 prompt 跳过；没有 ended 证据且窗口被截断时按仍在跑（fail closed）。
  return turnVerdictInTail(tail, (entry) => notStarted.has(entry.seq)) !== 'idle';
}

/**
 * 换模型提供商（或 hub 模型 ↔ agent 原生模型）：这不是一个「选项值」，
 * 因为提供商的 Base URL 与密钥是在 agent 启动时写进配置里的，运行中改不了。
 *
 * 做法是丢掉托管记录，按新模型重新托管，靠 `start_session(resume)` 的
 * `session/load` 把对话接回来（见 `ensureHosted`）。Worker 同 id 启动会先 dispose
 * 旧进程，所以这里**不**先发 interrupt：中途打断一轮会把正在写的回合切成半截，
 * 而回合没结束时我们干脆拒绝切换，让调用方决定是等还是先中断。
 *
 * 整个「读 → 判断 → 写 → 重新托管」都在 per-session 队列里（和 journal 写入、其它
 * 切换同一条队列），否则两个快速切换会交错，最后落库的模型和最后下发的 start_session
 * 可能不是一个。送达侧现在也把 attemptDelivery / claimSend 放进这条队列；claimPrompt
 * 的入队写入仍在队列外，但只产生 queued 行（本用例按「还没开局」放行）。队列里的
 * `ensureHosted` 不会重入队列：启动回执是 `dispatch` 的同步返回值，Worker 事件走异步
 * 消息入口，之后才排队。
 *
 * 校验新模型能不能用是调用方的事（hub 提供商要看团队与权限，原生模型要看运行时
 * 上报名单）——这里只管「换、重启、接回」。
 */
export async function switchSessionModel(
  deps: Pick<
    Deps,
    | 'artifacts'
    | 'bots'
    | 'gateway'
    | 'hosting'
    | 'now'
    | 'projects'
    | 'queue'
    | 'sessions'
    | 'stream'
    | 'tasks'
    | 'workspaceGroups'
    | 'workspaces'
  > &
    Partial<Pick<Deps, 'environment' | 'toolGrants' | 'deliveries'>>,
  command: { readonly sessionId: string; readonly model: string }
): Promise<Result<Session, DomainError>> {
  return deps.queue.run(command.sessionId, async () => {
    // 队列里重新读：等锁期间可能有新事件落库，拿旧快照 save 会把它们盖回去。
    const session = await deps.sessions.byId(asSessionId(command.sessionId));
    if (!session) return err(notFound('会话不存在'));
    if (session.model === command.model) return ok(session);

    if (await turnStillRunning(deps, session)) {
      return err(
        conflict(
          '这条会话还有一轮没结束（正在回复，或刚发的消息还没送到运行时），现在切换模型会打断它。等这一轮结束，或者先中断，再切换。'
        )
      );
    }

    const optionSpec = session.optionSpec.map((entry) =>
      entry.id === 'model' ? { ...entry, current: command.model } : entry
    );
    const next: Session = {
      ...session,
      model: command.model,
      [MODEL_PINNED]: false,
      options: { ...session.options, model: command.model },
      optionSpec
    };
    await deps.sessions.save(next, { modelWrite: true });

    // 丢掉托管记录，下面的 ensureHosted 会按 session.model 重新算提供商配置并带 resume 启动。
    deps.hosting.drop(session.id);
    const hosted = await ensureHosted(deps, next);
    if (!hosted.ok) return err(hosted.error);
    return ok((await deps.sessions.byId(session.id)) ?? next);
  });
}

export interface SetSessionMcpDisabledCommand {
  readonly sessionId: string;
  /** 要关掉的 MCP 服务器名；空数组 = 全部开启。 */
  readonly disabled: readonly string[];
  readonly actor: Subject | null;
}

/**
 * 生成一条会话启动时要关掉的 MCP 服务器清单。
 *
 * 只改 `session.mcpDisabled` 并广播一条状态帧：不重启进程、不动资产 / 机器安装，
 * 下一条 `start_session` 才会按新清单下发。不做 running 限制——正在跑的会话也能先存下，
 * 下次重新托管时生效。权限与说话同一档（session.prompt）。
 */
export async function setSessionMcpDisabledUseCase(
  deps: Pick<Deps, 'sessions' | 'projects' | 'tasks' | 'access' | 'workspaceGroups' | 'bots' | 'workspaces' | 'stream' | 'now'>,
  command: SetSessionMcpDisabledCommand
): Promise<Result<Session, DomainError>> {
  const session = await deps.sessions.byId(asSessionId(command.sessionId));
  if (!session) return err(notFound('会话不存在'));
  const project = await projectOfSessionOrigin(deps, session);
  const allowed = await authorizeSession(deps.access, command.actor, project, session, 'session.prompt');
  if (!allowed.ok) return allowed;

  const normalized = normalizeMcpDisabled(command.disabled);
  if (!normalized.ok) return normalized;

  const next: Session = { ...allowed.value, mcpDisabled: normalized.value, updatedAt: deps.now() };
  await deps.sessions.save(next);
  // 让别的窗口也立刻换掉清单：只发状态帧，不占 seq、不写 journal。
  deps.stream.publish({ sessionId: next.id, seq: next.lastSeq, event: null, status: next.status });
  return ok((await deps.sessions.byId(next.id)) ?? next);
}

/**
 * 已经结束的会话改选项：按它上次上报的 optionSpec 校验，然后写回会话。
 * 传进来的 spec 是 agent 上次说的，选值范围以它为准；agent 不认的 Id 直接拒，
 * 免得写进库里一个下次启动会被丢掉的值。
 */
async function changeSavedOption(
  deps: Pick<Deps, 'sessions'>,
  session: Session,
  command: ChangeOptionCommand
): Promise<Result<Session, DomainError>> {
  const option = findOption(session.optionSpec, command.id);
  if (!option) {
    return err(invalid(`这台机器没上报可调项 ${command.id}：先跑一轮，看它到底有哪些`));
  }
  if (option.kind === 'boolean') {
    if (typeof command.value !== 'boolean') return err(invalid(`${option.label} 只有开和关`));
  } else if (typeof command.value !== 'string' || !optionValues(option).some((choice) => choice.value === command.value)) {
    const choices = optionValues(option).join(' / ');
    return err(invalid(`${option.label} 只能是 ${choices || '它上报的候选'} 之一`));
  }

  // A saved exact model is only a desired value; the last runtime observation
  // remains historical until a later runtime actually reports the change.
  const optionSpec = command.exactModel && option.id === 'model' ? session.optionSpec : session.optionSpec.map((entry) =>
    entry.id === option.id ? { ...entry, current: command.value } : entry
  );
  const next: Session = {
    ...session,
    model: option.id === 'model' && typeof command.value === 'string' ? command.value : session.model,
    ...(option.id === 'model' ? { [MODEL_PINNED]: command.exactModel === true } : {}),
    options: { ...session.options, [option.id]: command.value },
    optionSpec
  };
  await deps.sessions.save(next, { modelWrite: option.id === 'model', optionSpecWrite: true });
  return ok(next);
}

/**
 * 中断 / 停止。正在跑的一轮交给 agent 去停，它会发 ended 收尾。
 * 但从没发过话的会话没有「这一轮」可停，agent 不会发 ended——
 * 那就由平台记一条 ended(stopped)，让它离开 running（否则它会永远挡着删项目）。
 */
export async function interruptSessionUseCase(
  deps: Pick<Deps, 'artifacts' | 'gateway' | 'now' | 'queue' | 'sessions' | 'stream'>,
  sessionId: string
): Promise<Result<void, DomainError>> {
  const id = asSessionId(sessionId);
  const session = await deps.sessions.byId(id);
  if (!session) return err(notFound('会话不存在'));
  if (session.status === 'running' && isNeverPrompted(session)) {
    // 进程可能根本没托管着（比如 hub 重启过）：停不掉也照样收尾。
    await deps.gateway.dispatch({ kind: 'interrupt', sessionId: id });
    const ended = await deps.queue.run(id, () =>
      recordEvent(deps, { sessionId: id, event: { kind: 'ended', outcome: 'stopped', reason: '还没开始就停止了' } })
    );
    return ended.ok ? ok(undefined) : ended;
  }
  const stopped = await deps.gateway.dispatch({ kind: 'interrupt', sessionId: id });
  return stopped.ok ? ok(undefined) : err(stopped.error);
}

export const SESSION_TITLE_MAX = 80;

/** 会话改名：去首尾空白、压掉换行；空串 = 清掉名字（回退到默认显示）。权限在入口按 session.prompt 判（能在这条会话里说话的人）。 */
export async function renameSessionUseCase(
  deps: Pick<Deps, 'sessions' | 'now'>,
  command: { readonly sessionId: string; readonly title: string }
): Promise<Result<Session, DomainError>> {
  const id = asSessionId(command.sessionId);
  const session = await deps.sessions.byId(id);
  if (!session) return err(notFound('会话不存在'));
  const title = command.title.replace(/\s+/g, ' ').trim();
  if (title.length > SESSION_TITLE_MAX) return err(invalid(`会话名最多 ${SESSION_TITLE_MAX} 个字`));
  await deps.sessions.setTitle(id, title === '' ? null : title, deps.now());
  return ok((await deps.sessions.byId(id)) ?? session);
}
