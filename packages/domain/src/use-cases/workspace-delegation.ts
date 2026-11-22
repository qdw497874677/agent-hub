import { principalOfSubject, type Subject } from '../access.ts';
import type { ProjectId, SessionId, TaskId, WorkspaceId } from '../ids.ts';
import { newId, newSessionId } from '../ids.ts';
import type { Project, ProjectRepo } from '../project.ts';
import type { Task } from '../task.ts';
import type { DomainError } from '../errors.ts';
import { conflict, forbidden, invalid, notFound, unavailable } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import type { Deps } from './deps.ts';
import { authorizeProject, authorizeWorker } from './authorization.ts';
import {
  newDelegationClaim,
  type DelegationAllocation,
  type DelegationClaimResult,
  type DelegationFailureKind,
  type DelegationMode,
  type DelegationStartupConfig,
  type WorkspaceDelegation,
  type WorkspaceDelegationStore
} from '../workspace-delegation.ts';

const REQUEST_KEY_MAX = 200;
const BRANCH_NAME_PATTERN = /^[\w./-]+$/;
const BASE_SHA_PATTERN = /^[0-9a-f]{40}$/;

/**
 * 持久工作空间派工（docs/design/workspace-delegation.md，阶段 A「建链」）的用例。
 *
 * 这一层只编排状态与权限：
 * - 提案车道：主会话必须由注册表桥（`resolveCoordinator`）核实，**不按 session 猜**，也不接受 token / bot 主体；
 * - 直接车道：普通任务 / 无任务会话由 `resolveDirectSource` 核实不可变项目来源，并强制注入
 *   当前授权谓词 `DelegationDirectAuthorizer`；两条车道共享同一套准备 / 启动 / 关联顺序；
 * - 目标必须是来源会话同项目里的既有任务；
 * - 项目 `session.create` / `agent.spawn`、Worker `worker.use`、仓库归属都过了才允许产生 Git 副作用；
 *   直接车道在此之上还必须每次重新通过注入的当前授权谓词（来源 / 目标 / 仓库 / 授权主体）；
 * - 先只读规划（baseline / worker / worktree path / branch），再分配幂等记录与预留执行会话身份，最后 claim；
 * - 记录存在后同键重试只复用，不重放 `uncertain`，不重复创建执行会话；
 * - 准备（worktree）失败分 `fatal` / `uncertain`；准备之后（start / link）的未知失败一律 `uncertain`。
 *
 * 外部副作用（Git worktree、进程、会话）没有事务。这里保证的是「同键不会静默再开一个执行身份」
 * 和「不确定状态停下来可查」，不是 exactly-once。
 */

/** 由主会话注册表核实后的派工来源；`accountId` 必须是这条主会话的普通人类创建者。 */
export interface DelegationCoordinator {
  readonly sessionId: SessionId;
  readonly projectId: ProjectId;
  readonly accountId: string;
}

/**
 * 直接执行车道的来源会话。`projectId` 只能来自服务端绑定的不可变字段：
 * 任务会话用任务的项目，无任务会话用 `session.originProjectId`；两者同时存在但冲突时
 * `resolveDirectSource` 必须返回 null。
 */
export interface DelegationDirectSource {
  readonly sessionId: SessionId;
  readonly projectId: ProjectId;
  /** 来源会话自己的任务；无任务会话为 null。 */
  readonly taskId: TaskId | null;
  /** 必须是 `session.createdBy`。 */
  readonly accountId: string;
}

/** 一次派工里由路由 / 服务端冻结的请求上下文，交给各个桥。 */
export interface DelegationRequest {
  readonly actor: Subject;
  readonly coordinator: DelegationCoordinator;
  readonly project: Project;
  readonly task: Task;
  readonly repo: ProjectRepo;
  /** 让桥知道该用注册表还是普通会话的来源上下文；也让记录 / 指纹按车道隔离。 */
  readonly mode: DelegationMode;
}

export interface DelegationPlanInput extends DelegationRequest {
  /** 稳定的幂等键；同一键的重试必须得到同一份计划。 */
  readonly requestKey: string;
}

/** 只读规划：基线、落点机器、独立工作树路径、功能分支。 */
export interface DelegationPlan {
  readonly workerId: string;
  readonly baseBranch: string;
  readonly worktreePath: string;
  readonly branch: string;
}

export interface DelegationPrepared {
  readonly workspaceId: WorkspaceId;
  /** 必须是小写 40 位提交号；解析不到基线（null / 大写 / 其它长度）按 `uncertain` 停下，不能进入 start。 */
  readonly baseSha: string;
}

export interface DelegationStarted {
  readonly sessionId: SessionId;
  readonly taskId: TaskId | null;
  readonly workspaceId: WorkspaceId | null;
}

export interface DelegationLinked {
  readonly sessionId: SessionId;
}

export interface DelegationPrepareInput extends DelegationRequest {
  readonly record: WorkspaceDelegation;
  readonly plan: DelegationPlan;
}

export interface DelegationStartInput extends DelegationPrepareInput {
  readonly prepared: DelegationPrepared;
}

export interface DelegationLinkInput extends DelegationStartInput {
  readonly started: DelegationStarted;
}

/**
 * 副作用的结果必须显式分类：
 * - `fatal`：确定没有留下副作用，可安全地用同一条记录重试；
 * - `uncertain`：可能已经留下副作用，必须人工对账，不能自动重放。
 *
 * 桥实现如果无法确定，必须报 `uncertain`，不能猜 `fatal`。
 */
export type DelegationEffectResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly kind: DelegationFailureKind; readonly message: string };

/**
 * 可注入的外部动作。真实 Git / 会话创建 / 关联分别由其他车道实现，本用例只负责顺序、权限和状态。
 *
 * `plan` 必须是只读、**确定性**的：同一 `(coordinatorSessionId, requestKey)` 的两次首次请求（包括并发）
 * 必须得到完全相同的计划。路径 / 分支只能从请求上下文与键推导，**不能使用随机运行时 id 或时间**；
 * 预留执行会话 id 在 plan 之后才生成，也不能反过来影响计划。否则同键重试会算出不同指纹。
 */
export interface WorkspaceDelegationBridges {
  /** 从已核实的主会话注册表取；不是注册表里的活主会话就返回 null。不要退回“按会话猜”。 */
  readonly resolveCoordinator: (sessionId: SessionId) => Promise<DelegationCoordinator | null>;
  readonly plan: (input: DelegationPlanInput) => Promise<DelegationPlan>;
  readonly prepare: (input: DelegationPrepareInput) => Promise<DelegationEffectResult<DelegationPrepared>>;
  readonly start: (input: DelegationStartInput) => Promise<DelegationEffectResult<DelegationStarted>>;
  /** 建链完成后的关联（任务分支回写 / 工作日志等）。执行会话已经存在，失败按 `uncertain` 处理。 */
  readonly link: (input: DelegationLinkInput) => Promise<DelegationEffectResult<DelegationLinked>>;
}

/** 只读提案只需要核实来源和规划；不得提供 prepare / start / link。 */
export type WorkspaceDelegationProposalBridges = Pick<
  WorkspaceDelegationBridges,
  'resolveCoordinator' | 'plan'
>;

/** 直接车道额外需要从普通会话解析不可变项目来源。 */
export interface WorkspaceDelegationDirectBridges extends WorkspaceDelegationBridges {
  readonly resolveDirectSource: (sessionId: SessionId) => Promise<DelegationDirectSource | null>;
}

/**
 * 直接执行车道必须在这些步骤**之前**重新确认当前授权；`create` 在分配记录前、
 * `prepare` 在 worktree 副作用前、`start` 在执行会话副作用前、`instruction` 在关联 / 说明送达前。
 */
export type DelegationDirectStep = 'create' | 'prepare' | 'start' | 'instruction';

export interface DelegationDirectAuthorizeInput {
  readonly step: DelegationDirectStep;
  readonly actor: Subject;
  /** 本次重新解析出的来源；调用方应同时核对它没有漂移。 */
  readonly source: DelegationDirectSource;
  readonly project: Project;
  /** 执行会话要归属的目标任务。 */
  readonly task: Task;
  readonly repo: ProjectRepo;
  readonly plan: DelegationPlan;
  /** `create` 且尚未分配时为 null；之后是当前持久记录。 */
  readonly record: WorkspaceDelegation | null;
  /** 只在对应步骤已经成功发生后有值；授权方可用它核对精确工作区 / 会话。 */
  readonly prepared: DelegationPrepared | null;
  readonly started: DelegationStarted | null;
}

/**
 * 显式注入的当前授权谓词。直接车道除共享的域内项目 / Worker 检查外，还必须调用本谓词；
 * 授权车道应在这里重新读取会话、归属人、项目 grant、目标仓库与 Worker，而不是信任入参快照。
 * 任何拒绝都必须返回错误；返回 ok 才允许继续到下一步。
 */
export type DelegationDirectAuthorizer = (
  input: DelegationDirectAuthorizeInput
) => Promise<Result<void, DomainError>>;

export interface DelegateWorkspaceCommand {
  /** 路由传入的当前登录主体；必须是普通人类（不能带 `via`）。 */
  readonly actor: Subject | null;
  /**
   * 主会话给出的稳定请求键，必填且原样使用（不 trim / 不改大小写）。
   * 运行时校验：trim 后非空，长度 <= 200。域内不再自动生成键：没有键就无法保证重试幂等。
   */
  readonly requestKey: string;
  /** 提案车道 = 主会话；直接车道 = 来源普通会话（由 `DirectDelegateWorkspaceCommand` 映射）。 */
  readonly coordinatorSessionId: SessionId;
  /** 执行会话必须归属的目标任务；必须和主会话同项目。 */
  readonly taskId: TaskId;
  /** 项目仓库清单里的仓库 id（不是 URL，也不是任意字符串）。 */
  readonly repoId: string;
  /** 用户明确选择的基线分支；trim 后非空、合法分支名，且必须与 plan 完全一致。 */
  readonly baseBranch: string;
  readonly instructions: string;
  readonly agentId: string;
  readonly model?: string | null;
  readonly profileId?: string | null;
  readonly options?: Readonly<Record<string, string | boolean>>;
}

/** 直接车道的命令：来源是普通会话，不是主会话登记簿。 */
export type DirectDelegateWorkspaceCommand = Omit<DelegateWorkspaceCommand, 'coordinatorSessionId'> & {
  readonly sourceSessionId: SessionId;
};

export interface DelegationRun {
  readonly record: WorkspaceDelegation;
  readonly allocation: 'created' | 'reused';
  /** 本次调用是否真正领取并尝试了副作用。复用的终态 / busy 都是 false。 */
  readonly claimed: boolean;
}

/**
 * 纯提案的结果：只可能是刚分配的 pending（`created`）或既有记录（`reused`）。
 * 不包含 `claimed`，因为提案永远不领取、不产生外部副作用。
 */
export interface DelegationProposal {
  readonly record: WorkspaceDelegation;
  readonly allocation: 'created' | 'reused';
}

/** 用例只碰这几个存储操作；完整契约见 `WorkspaceDelegationStore`。 */
export type DelegationStore = Pick<
  WorkspaceDelegationStore,
  'allocate' | 'byId' | 'byCoordinatorRequest' | 'claim' | 'compareAndSet'
>;

type DelegationEffects = Pick<WorkspaceDelegationBridges, 'prepare' | 'start' | 'link'>;

/** 直接车道在进入共享建链流程前已经解析出的来源与谓词。 */
interface DirectLane {
  readonly source: DelegationDirectSource;
  readonly authorize: DelegationDirectAuthorizer;
  readonly recheck: () => Promise<DelegationDirectSource | null>;
}

interface LaunchState {
  readonly record: WorkspaceDelegation;
  readonly plan: DelegationPlan;
  readonly prepared: DelegationPrepared | null;
  readonly started: DelegationStarted | null;
}

type LaunchGuard = (step: 'prepare' | 'start' | 'instruction', state: LaunchState) => Promise<Result<void, DomainError>>;

/**
 * 建链用例（提案车道 / 真人确认）：校验 → 只读规划 → 分配 / 复用记录 → 领取 → 准备 → 启动 → 关联 → 落定。
 *
 * 同一 `(coordinatorSessionId, requestKey)` 的重试：
 * - 先按记录里冻结的 plan 复算指纹，内容不同直接 conflict；
 * - `prepared` 直接返回，`uncertain` / `cancelled` 不领取、不重放；
 * - `failed` 只在确认没有不明副作用时重置为 `pending` 再安全重试。
 */
export async function delegateWorkspaceUseCase(
  deps: Pick<Deps, 'projects' | 'tasks' | 'access' | 'now'>,
  store: DelegationStore,
  bridges: WorkspaceDelegationBridges,
  command: DelegateWorkspaceCommand
): Promise<Result<DelegationRun, DomainError>> {
  return runWorkspaceDelegation(deps, store, bridges, bridges, command, 'proposal', null);
}

/**
 * 直接执行车道：普通任务 / 无任务会话在本项目内直接建一条独立 worktree 会话。
 *
 * 与提案确认共享完全相同的严格准备 / 启动 / 关联状态机；区别只有三处：
 * - 来源由 `resolveDirectSource` 从会话的不可变项目绑定解析，不要求登记为主会话；
 * - 授权在共享的项目 / Worker 检查之外，还必须通过显式注入的 `authorize`，并在每个尚未执行的
 *   副作用步骤前重新调用；
 * - 幂等域按 `mode='direct'` 隔离：同会话同键的提案确认不会领走这条记录。
 */
export async function delegateWorkspaceDirectUseCase(
  deps: Pick<Deps, 'projects' | 'tasks' | 'access' | 'now'>,
  store: DelegationStore,
  bridges: WorkspaceDelegationDirectBridges,
  authorize: DelegationDirectAuthorizer,
  command: DirectDelegateWorkspaceCommand
): Promise<Result<DelegationRun, DomainError>> {
  const source = await bridges.resolveDirectSource(command.sourceSessionId);
  if (!source) return err(notFound('直接执行的来源会话不存在或不可用'));
  const { sourceSessionId, ...rest } = command;
  const normalized: DelegateWorkspaceCommand = { ...rest, coordinatorSessionId: sourceSessionId };
  return runWorkspaceDelegation(deps, store, bridges, bridges, normalized, 'direct', {
    source,
    authorize,
    recheck: () => bridges.resolveDirectSource(sourceSessionId)
  });
}

/**
 * 只读提案：与建链共享完全相同的请求校验、来源核实、权限检查和指纹。
 *
 * 它只会在没有同键记录时分配一条 `pending`，然后立即返回；
 * **永不** claim / prepare / start / link。后续真人确认仍走 `delegateWorkspaceUseCase`，
 * 只要请求键与指纹完全相同，就会领取这条 pending 并继续建链。
 * 同键重放只读既有记录，不重新规划、不修改任何状态。
 */
export async function proposeWorkspaceDelegationUseCase(
  deps: Pick<Deps, 'projects' | 'tasks' | 'access' | 'now'>,
  store: DelegationStore,
  bridges: WorkspaceDelegationProposalBridges,
  command: DelegateWorkspaceCommand
): Promise<Result<DelegationProposal, DomainError>> {
  const result = await runWorkspaceDelegation(deps, store, bridges, null, command, 'proposal', null);
  if (!result.ok) return result;
  return ok({ record: result.value.record, allocation: result.value.allocation });
}

async function runWorkspaceDelegation(
  deps: Pick<Deps, 'projects' | 'tasks' | 'access' | 'now'>,
  store: DelegationStore,
  bridges: Pick<WorkspaceDelegationBridges, 'resolveCoordinator' | 'plan'>,
  effects: DelegationEffects | null,
  command: DelegateWorkspaceCommand,
  mode: DelegationMode,
  direct: DirectLane | null
): Promise<Result<DelegationRun, DomainError>> {
  const actor = command.actor;
  if (!actor) return err(forbidden('派工必须由真人登录会话发起'));
  const principal = principalOfSubject(actor);
  // token / bot / system 都没有普通人类 provenance；fail-closed，不能当主会话主人。
  if (!principal || principal.via) return err(forbidden('派工必须由真人登录会话发起'));

  const requestKey = command.requestKey;
  if (typeof requestKey !== 'string' || requestKey.trim() === '' || requestKey.length > REQUEST_KEY_MAX) {
    return err(invalid(`请求键必须是 trim 后非空、不超过 ${REQUEST_KEY_MAX} 字符的字符串`));
  }
  const requestedBaseBranch = command.baseBranch.trim();
  if (requestedBaseBranch === '' || !BRANCH_NAME_PATTERN.test(requestedBaseBranch)) {
    return err(invalid('基线分支必须是合法的分支名'));
  }

  // 来源核实：提案车道只认登记簿；直接车道只认服务端绑定的不可变项目来源。
  let binding: DelegationDirectSource;
  if (direct) {
    if (direct.source.sessionId !== command.coordinatorSessionId) {
      return err(invalid('直接执行的来源会话与请求不一致'));
    }
    binding = direct.source;
  } else {
    const coordinator = await bridges.resolveCoordinator(command.coordinatorSessionId);
    if (!coordinator || coordinator.sessionId !== command.coordinatorSessionId) {
      return err(notFound('主会话不存在'));
    }
    binding = {
      sessionId: coordinator.sessionId,
      projectId: coordinator.projectId,
      taskId: null,
      accountId: coordinator.accountId
    };
  }
  if (binding.accountId !== principal.user.id) return err(forbidden('不能替别人的主会话派工'));

  const task = await deps.tasks.byId(command.taskId);
  if (!task) return err(notFound('任务不存在'));
  const project = await deps.projects.byId(task.projectId);
  if (!project) return err(notFound('项目不存在'));
  // 回收站里的项目明确拒绝；不要在已删除项目上建新链。
  if (project.deletedAt !== null) return err(notFound('项目不存在'));
  if (binding.projectId !== project.id) return err(invalid('派工任务必须与来源会话在同一个项目'));
  // 任务会话的来源绑定和任务项目冲突时拒绝；无任务会话的绑定已经在 resolveDirectSource 校验过。
  if (direct && direct.source.taskId !== null) {
    const sourceTask = await deps.tasks.byId(direct.source.taskId);
    if (!sourceTask) return err(forbidden('来源会话的任务不存在'));
    if (sourceTask.projectId !== project.id) {
      return err(conflict('来源会话的任务项目与目标项目冲突'));
    }
  }

  // 两条车道都保留域内项目校验；直接车道额外依赖注入谓词做当前来源 / 目标 / grant 复核。
  // 先过项目权限；失败时还没有任何 worktree / 记录 / 会话副作用。
  const canCreate = await authorizeProject(deps.access, actor, project, 'session.create');
  if (!canCreate.ok) return canCreate;
  const canSpawn = await authorizeProject(deps.access, actor, project, 'agent.spawn');
  if (!canSpawn.ok) return canSpawn;

  // 仓库只认项目配置里登记过的那一条；不接受调用方传任意 URL / 路径。
  const repo = project.repos.find((candidate) => candidate.id === command.repoId);
  if (!repo || repo.url.trim() === '') return err(invalid('仓库不在项目的仓库清单里'));

  const authorizeDirect = async (
    step: DelegationDirectStep,
    plan: DelegationPlan,
    record: WorkspaceDelegation | null,
    prepared: DelegationPrepared | null = null,
    started: DelegationStarted | null = null
  ): Promise<Result<void, DomainError>> => {
    if (!direct) return ok(undefined);
    const fresh = await direct.recheck();
    if (!fresh || !sameDirectSource(fresh, direct.source)) {
      return err(forbidden('直接执行的来源会话已漂移'));
    }
    return direct.authorize({
      step,
      actor,
      source: fresh,
      project,
      task,
      repo,
      plan,
      record,
      prepared,
      started
    });
  };

  const existing = await store.byCoordinatorRequest(command.coordinatorSessionId, requestKey, mode);

  let plan: DelegationPlan;
  let record: WorkspaceDelegation;
  let allocation: 'created' | 'reused';

  if (existing) {
    // 仓库身份按 URL 固定：项目里同 id 的仓库换了地址，旧记录不能继续写。
    if (existing.repoUrl !== repo.url) {
      return err(conflict('同一请求键对应的仓库地址已变更'));
    }
    // 复用记录里冻结的 plan，避免重试时重新规划出不同路径 / 分支；再按当前请求复算指纹。
    plan = planOf(existing);
    if (plan.baseBranch !== requestedBaseBranch) {
      return err(conflict('同一请求键对应的基线分支已变更'));
    }
    const fingerprint = requestFingerprint(mode, command, requestedBaseBranch, project, task, repo, plan);
    if (fingerprint !== existing.requestFingerprint) {
      return err(conflict('同一请求键对应了不同的派工内容'));
    }
    // 旧记录 / 配置缺失时不能猜默认 agent / model；提案确认必须失败关闭。
    if (!existing.startup) {
      return err(conflict('同一请求键对应的派工记录缺少冻结的启动配置，不能确认'));
    }
    if (startupKey(existing.startup) !== startupKey(startupOf(command))) {
      return err(conflict('同一请求键对应的启动配置已变更'));
    }
    // 重放也要先过当前授权；已完成的记录返回前不允许绕过来源 / 权限漂移。
    const allowed = await authorizeDirect('create', plan, existing);
    if (!allowed.ok) return allowed;
    record = existing;
    allocation = 'reused';
  } else {
    try {
      plan = await bridges.plan({
        actor,
        coordinator: binding,
        project,
        task,
        repo,
        mode,
        requestKey
      });
    } catch (error) {
      return err(unavailable(`无法规划派工：${messageOf(error)}`));
    }
    if (plan.workerId === '' || plan.baseBranch === '' || plan.worktreePath === '' || plan.branch === '') {
      return err(invalid('派工计划缺少 Worker / 基线 / 工作树 / 分支'));
    }
    // 用户选的基线不能被规划悄悄换掉；不等就停在任何副作用之前。
    if (plan.baseBranch !== requestedBaseBranch) {
      return err(invalid('派工计划的基线分支与请求不一致'));
    }

    // 提案车道与直接车道都在分配记录与任何 Git 副作用之前过 Worker 授权；
    // 直接车道之后还要经过注入谓词的 worker.use 语义复核。
    const canUseWorker = await authorizeWorker(deps.access, actor, plan.workerId);
    if (!canUseWorker.ok) return canUseWorker;

    // 直接车道在分配记录前确认一次当前授权；被拒绝时不会留下 pending 记录。
    const allowed = await authorizeDirect('create', plan, null);
    if (!allowed.ok) return allowed;

    const executionSessionId = newSessionId();
    const fingerprint = requestFingerprint(mode, command, requestedBaseBranch, project, task, repo, plan);
    const at = deps.now();
    const input: DelegationAllocation = {
      id: newId(),
      accountId: principal.user.id,
      coordinatorSessionId: command.coordinatorSessionId,
      mode,
      requestKey,
      requestFingerprint: fingerprint,
      projectId: project.id,
      taskId: task.id,
      repoId: repo.id,
      repoUrl: repo.url,
      workerId: plan.workerId,
      baseBranch: plan.baseBranch,
      instructions: command.instructions,
      startup: startupOf(command),
      executionSessionId,
      worktreePath: plan.worktreePath,
      branch: plan.branch,
      at
    };

    let allocated;
    try {
      allocated = await store.allocate(input);
    } catch (error) {
      return err(unavailable(`派工记录分配失败：${messageOf(error)}`));
    }
    if (allocated.outcome === 'conflict') {
      return err(conflict('同一请求键已用于不同的派工内容，或预留的执行会话已被占用'));
    }
    record = allocated.record;
    allocation = allocated.outcome;
    // 并发双击时可能刚好由另一请求分配成功；以库里那条为准，使用它预留的身份。
    // 同时再核对仓库 / 基线没有被另一个并发请求换成别的内容。
    if (record.repoUrl !== repo.url) {
      return err(conflict('同一请求键对应的仓库地址已变更'));
    }
    if (record.baseBranch !== requestedBaseBranch) {
      return err(conflict('同一请求键对应的基线分支已变更'));
    }
    if (!record.startup) {
      return err(conflict('同一请求键对应的派工记录缺少冻结的启动配置，不能确认'));
    }
    if (startupKey(record.startup) !== startupKey(startupOf(command))) {
      return err(conflict('同一请求键对应的启动配置已变更'));
    }
    plan = planOf(record);
  }

  // 对复用的记录也要做一次 Worker 授权；没有 Worker 就不允许再次触碰。
  const canUseWorker = await authorizeWorker(deps.access, actor, record.workerId);
  if (!canUseWorker.ok) return canUseWorker;

  if (!effects) {
    // 纯提案：只允许分配 pending / 读取既有记录；绝不领取或调用任何副作用桥。
    // 同键重放不会重新规划，也不会修改记录。
    return ok({ record, allocation, claimed: false });
  }

  const request: DelegationRequest = { actor, coordinator: binding, project, task, repo, mode };
  const guard: LaunchGuard | null = direct
    ? async (step, state) => authorizeDirect(step, state.plan, state.record, state.prepared, state.started)
    : null;

  return launchWorkspaceDelegation(deps, store, effects, request, record, plan, allocation, guard);
}

/**
 * 共享的严格准备 / 启动 / 关联流程。两条车道都在这里产生副作用，区别只在外层来源解析与
 * 每步授权：提案车道由 bridge 自己复核注册表 / 项目 / Worker / 会话权限，直接车道由
 * `guard` 在每个尚未执行的步骤前调用注入谓词。
 */
async function launchWorkspaceDelegation(
  deps: Pick<Deps, 'projects' | 'tasks' | 'access' | 'now'>,
  store: DelegationStore,
  effects: DelegationEffects,
  request: DelegationRequest,
  initial: WorkspaceDelegation,
  plan: DelegationPlan,
  allocation: 'created' | 'reused',
  guard: LaunchGuard | null
): Promise<Result<DelegationRun, DomainError>> {
  let record = initial;

  if (record.state === 'prepared' || record.state === 'uncertain' || record.state === 'cancelled') {
    return ok({ record, allocation, claimed: false });
  }

  if (record.state === 'failed') {
    // fatal 失败没有不明副作用，允许同一记录安全重试；CAS 失败说明已被并发改过。
    let reset;
    try {
      reset = await store.compareAndSet(record.id, {
        expect: { state: 'failed', claimToken: null },
        state: 'pending',
        at: deps.now()
      });
    } catch (error) {
      return err(unavailable(`派工记录重置失败：${messageOf(error)}`));
    }
    if (!reset.ok || !reset.record) {
      if (reset.record && reset.record.state !== 'preparing' && reset.record.state !== 'pending') {
        return ok({ record: reset.record, allocation, claimed: false });
      }
      return err(conflict('派工状态已被并发修改，请刷新后重试'));
    }
    record = reset.record;
  }

  const claimToken = newId();
  let claimed: DelegationClaimResult;
  try {
    claimed = await store.claim(
      record.id,
      newDelegationClaim(`delegation:${request.coordinator.sessionId}`, claimToken, deps.now())
    );
  } catch (error) {
    return err(unavailable(`派工领取失败：${messageOf(error)}`));
  }
  if (claimed.outcome === 'missing') return err(notFound('派工记录不存在'));
  if (claimed.outcome !== 'claimed' || !claimed.record) {
    // busy / expired / not-claimable：不接管、不重放；把当前记录交回调用方对账。
    return ok({ record: claimed.record ?? record, allocation, claimed: false });
  }
  record = claimed.record;

  // 准备前重新授权。拒绝发生在 worktree 之前：确定没有新副作用，按 fatal 落定。
  if (guard) {
    const allowed = await guard('prepare', { record, plan, prepared: null, started: null });
    if (!allowed.ok) {
      const persisted = await persistFailure(
        store,
        record,
        claimToken,
        'fatal',
        `准备前授权已失效：${allowed.error.message}`,
        allocation,
        null,
        deps.now
      );
      return persisted.ok ? allowed : persisted;
    }
  }

  let prepared: DelegationPrepared;
  try {
    const outcome = await effects.prepare({ ...request, record, plan });
    if (!outcome.ok) {
      return persistFailure(store, record, claimToken, outcome.kind, outcome.message, allocation, null, deps.now);
    }
    prepared = outcome.value;
  } catch (error) {
    // 准备阶段抛错可能已经留下 worktree，必须按 uncertain 停下。
    return persistFailure(store, record, claimToken, 'uncertain', messageOf(error), allocation, null, deps.now);
  }
  if (
    typeof prepared.workspaceId !== 'string' ||
    prepared.workspaceId.trim() === '' ||
    typeof prepared.baseSha !== 'string' ||
    !BASE_SHA_PATTERN.test(prepared.baseSha)
  ) {
    // 工作空间 / 基线不完整时不能启动执行会话；worktree 可能已存在，按 uncertain 停下。
    return persistFailure(
      store,
      record,
      claimToken,
      'uncertain',
      '准备结果缺少有效的 workspaceId / 小写 40 位 baseSha',
      allocation,
      typeof prepared.baseSha === 'string' ? prepared.baseSha : null,
      deps.now
    );
  }

  // 启动前重新授权。worktree 已经存在：拒绝时按 uncertain 停下，不能自动重放。
  if (guard) {
    const allowed = await guard('start', { record, plan, prepared, started: null });
    if (!allowed.ok) {
      const persisted = await persistFailure(
        store,
        record,
        claimToken,
        'uncertain',
        `启动前授权已失效：${allowed.error.message}`,
        allocation,
        prepared.baseSha,
        deps.now
      );
      return persisted.ok ? allowed : persisted;
    }
  }

  const startInput: DelegationStartInput = { ...request, record, plan, prepared };
  let started: DelegationStarted;
  try {
    const outcome = await effects.start(startInput);
    if (!outcome.ok) {
      // 桥显式说 fatal = 确定没有创建执行会话；仍按明确失败处理。抛错则按 uncertain。
      return persistFailure(store, record, claimToken, outcome.kind, outcome.message, allocation, prepared.baseSha, deps.now);
    }
    started = outcome.value;
  } catch (error) {
    return persistFailure(store, record, claimToken, 'uncertain', messageOf(error), allocation, prepared.baseSha, deps.now);
  }

  // 执行会话必须是预留的那一个，并且真的落在目标任务 / 刚准备好的工作空间上。
  if (
    started.sessionId !== record.executionSessionId ||
    started.taskId !== record.taskId ||
    started.workspaceId !== prepared.workspaceId
  ) {
    return persistFailure(store, record, claimToken, 'uncertain', '执行会话的身份 / 任务 / 工作空间与预留不一致', allocation, prepared.baseSha, deps.now);
  }

  // 关联 / 说明送达前重新授权。执行会话已经存在：拒绝时按 uncertain 停下。
  if (guard) {
    const allowed = await guard('instruction', { record, plan, prepared, started });
    if (!allowed.ok) {
      const persisted = await persistFailure(
        store,
        record,
        claimToken,
        'uncertain',
        `关联 / 说明送达前授权已失效：${allowed.error.message}`,
        allocation,
        prepared.baseSha,
        deps.now
      );
      return persisted.ok ? allowed : persisted;
    }
  }

  try {
    const outcome = await effects.link({ ...startInput, started });
    if (!outcome.ok) {
      // 执行会话已经存在：即使 link 自称 fatal，也不能自动重放准备 / 启动。
      return persistFailure(store, record, claimToken, 'uncertain', outcome.message, allocation, prepared.baseSha, deps.now);
    }
    if (outcome.value.sessionId !== record.executionSessionId) {
      return persistFailure(store, record, claimToken, 'uncertain', '关联结果指向了别的执行会话', allocation, prepared.baseSha, deps.now);
    }
  } catch (error) {
    return persistFailure(store, record, claimToken, 'uncertain', messageOf(error), allocation, prepared.baseSha, deps.now);
  }

  let settled;
  try {
    settled = await store.compareAndSet(record.id, {
      expect: { state: 'preparing', claimToken },
      state: 'prepared',
      at: deps.now(),
      baseSha: prepared.baseSha
    });
  } catch (error) {
    return persistFailure(store, record, claimToken, 'uncertain', `执行会话已建立但派工记录落定失败：${messageOf(error)}`, allocation, prepared.baseSha, deps.now);
  }
  if (!settled.ok || !settled.record) {
    return persistFailure(store, record, claimToken, 'uncertain', '执行会话已建立但派工记录已被并发修改，需要人工核对', allocation, prepared.baseSha, deps.now);
  }
  return ok({ record: settled.record, allocation, claimed: true });
}

function sameDirectSource(left: DelegationDirectSource, right: DelegationDirectSource): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.projectId === right.projectId &&
    left.taskId === right.taskId &&
    left.accountId === right.accountId
  );
}

function planOf(record: WorkspaceDelegation): DelegationPlan {
  return {
    workerId: record.workerId,
    baseBranch: record.baseBranch,
    worktreePath: record.worktreePath,
    branch: record.branch
  };
}

/** 启动配置在分配时冻结；options 按 key 排序复制，避免调用方后续改动影响记录。 */
function startupOf(command: DelegateWorkspaceCommand): DelegationStartupConfig {
  const options: Record<string, string | boolean> = {};
  for (const key of Object.keys(command.options ?? {}).sort()) {
    options[key] = command.options![key]!;
  }
  return {
    agentId: command.agentId,
    model: command.model ?? null,
    profileId: command.profileId ?? null,
    options
  };
}

function startupKey(config: DelegationStartupConfig): string {
  return JSON.stringify([
    config.agentId,
    config.model,
    config.profileId,
    Object.entries(config.options).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  ]);
}

/**
 * 请求指纹只覆盖「这次请求要做什么」+ 冻结的 plan，不包含分配时才生成的执行会话 id / 记录 id / 时间。
 * 同一请求键重试必须得到同一个指纹。
 *
 * 提案车道沿用原前缀，避免旧 pending 提案确认时指纹突变；直接车道用独立前缀，
 * 即使库层没有按 mode 隔离也不会和提案互相覆盖。
 */
function requestFingerprint(
  mode: DelegationMode,
  command: DelegateWorkspaceCommand,
  requestedBaseBranch: string,
  project: Project,
  task: Task,
  repo: ProjectRepo,
  plan: DelegationPlan
): string {
  const options = Object.entries(command.options ?? {}).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  );
  return JSON.stringify([
    mode === 'direct' ? 'workspace-delegation/direct/v1' : 'workspace-delegation/v1',
    command.coordinatorSessionId,
    project.id,
    task.id,
    repo.id,
    repo.url,
    repo.defaultBranch,
    command.agentId,
    command.model ?? null,
    command.profileId ?? null,
    requestedBaseBranch,
    options,
    command.instructions,
    plan.workerId,
    plan.baseBranch,
    plan.worktreePath,
    plan.branch
  ]);
}

/**
 * 把本次领取的结果落成 failed / uncertain。CAS 失败时读一次当前记录：
 * 已经是终态就直接交回；仍在 preparing 才报「记录未能落定」。
 */
async function persistFailure(
  store: DelegationStore,
  record: WorkspaceDelegation,
  claimToken: string,
  kind: DelegationFailureKind,
  message: string,
  allocation: 'created' | 'reused',
  baseSha: string | null,
  now: () => number
): Promise<Result<DelegationRun, DomainError>> {
  const at = now();
  const failureMessage = message.trim() === '' ? (kind === 'fatal' ? '派工失败' : '派工结果不明') : message;
  let saved: WorkspaceDelegation | null = null;
  try {
    const cas = await store.compareAndSet(record.id, {
      expect: { state: 'preparing', claimToken },
      state: kind === 'fatal' ? 'failed' : 'uncertain',
      at,
      ...(baseSha !== null ? { baseSha } : {}),
      failure: { kind, message: failureMessage, at }
    });
    if (cas.ok && cas.record) saved = cas.record;
  } catch {
    // 下面统一按未落定处理。
  }
  if (saved) return ok({ record: saved, allocation, claimed: true });

  let current: WorkspaceDelegation | null = null;
  try {
    current = await store.byId(record.id);
  } catch {
    // 读不到就保持原来的「未落定」判断。
  }
  if (current && current.state !== 'preparing') {
    return ok({ record: current, allocation, claimed: true });
  }
  return err(unavailable(`派工${kind === 'fatal' ? '失败' : '结果不明'}，且记录未能落定；请人工核对：${failureMessage}`));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
