import type { ProjectId, SessionId, TaskId } from './ids.ts';

/**
 * 持久工作空间派工（docs/design/workspace-delegation.md，阶段 A1「建链」）。
 *
 * 这里只固定**记录与存储契约**，不含 Git / worktree / Runtime 副作用：
 * - 幂等身份是 `(coordinatorSessionId, requestKey)` 这一对精确字节，不做 trim / 大小写归一；
 *   同键同指纹复用同一条记录，同键不同指纹是 conflict，不能覆盖。
 * - 记录在产生任何外部副作用**之前**落库，并预分配执行会话 id、worktree 路径与分支，
 *   崩溃后据此对账；同键重试只能复用这条记录，不能再造一个执行会话。
 * - `pending` 的领取有租期（`expiresAt`）；租期到点**不会**自动把 `preparing` 改回可领取，
 *   只报告 `expired`，由人/显式对账决定继续还是标 `uncertain`。
 * - `failed` 是明确失败（没有不明副作用，可用同一记录重试）；`uncertain` 是步骤不明
 *   （可能已有副作用，不能自动接管、不能自动重放）。两者必须分开。
 * - 当前车道里 `uncertain` 只能取消；**不能**经通用 CAS 回到 `pending`。将来若要重排，
 *   必须是先拿到外部对账证据的专用入口，避免把「已发生过副作用」的派工静默重放。
 *
 * 不承诺 exactly-once：外部副作用（worktree、进程、Git）没有事务，这里保证的是
 * 「同键不会静默再开一个执行身份」以及「不确定状态停下来可查」。
 */

export type DelegationState = 'pending' | 'preparing' | 'prepared' | 'failed' | 'uncertain' | 'cancelled';

/**
 * 派工车道。提案车道由主会话登记簿核实；直接车道由普通任务 / 无任务会话发起，授权来自
 * 显式注入的当前授权谓词（见 `use-cases/workspace-delegation.ts`）。
 *
 * 车道进幂等域：同一个来源会话用同一个请求键分别走提案和直接车道时，是两条互不覆盖的记录。
 * 这样真人确认提案时不可能领走一条直接执行的记录，反之亦然。
 */
export type DelegationMode = 'proposal' | 'direct';

/** 一次准备尝试的领取凭据；`token` 用来拒绝过期持有人的写入。 */
export interface DelegationClaim {
  readonly owner: string;
  readonly token: string;
  readonly at: number;
  readonly expiresAt: number;
}

export type DelegationFailureKind = 'fatal' | 'uncertain';

export interface DelegationFailure {
  /** fatal = 明确失败，可安全重试同一记录；uncertain = 结果不明，必须人工对账。 */
  readonly kind: DelegationFailureKind;
  readonly message: string;
  readonly at: number;
}

/** 启动选项只允许普通标量，避免把凭据 / 嵌套对象写进派工记录。 */
export type DelegationStartupOption = string | boolean;

/**
 * 派工提案被批准时看到的**准确启动配置**，在分配记录时一次性冻结。
 *
 * 这里是持久契约，不通过 CAS 修改：同键重试 / 重新分配都必须复用原配置，
 * 不能在执行前悄悄换 agent / model / profile / options。
 */
export interface DelegationStartupConfig {
  readonly agentId: string;
  readonly model: string | null;
  readonly profileId: string | null;
  readonly options: Readonly<Record<string, DelegationStartupOption>>;
}

/**
 * 一条派工记录。`executionSessionId` / `worktreePath` / `branch` 在分配时写入，
 * 之后不再变化（重试同一键也复用），作为重启后的确定性对账元数据。
 * `executionSessionId` 全表唯一：派工执行会话的身份不能被两条派工共用。
 */
export interface WorkspaceDelegation {
  readonly id: string;
  readonly accountId: string;
  /** 提案车道 = 已核实的主会话；直接车道 = 发起派工的普通会话。幂等域也按它划分。 */
  readonly coordinatorSessionId: SessionId;
  /**
   * 车道；与来源会话、请求键一起构成幂等身份。
   * 旧记录 / 旧调用方省略时视为 `proposal`；`direct` 记录由存储显式持久化。
   */
  readonly mode?: DelegationMode;
  /** 主会话给出的稳定请求键（双击、重连都用同一个）。 */
  readonly requestKey: string;
  /** 请求内容的指纹；同键不同指纹即 conflict。 */
  readonly requestFingerprint: string;
  readonly projectId: ProjectId;
  /** 执行会话必须归属的目标任务。 */
  readonly taskId: TaskId;
  readonly repoId: string;
  readonly repoUrl: string;
  readonly workerId: string;
  readonly baseBranch: string;
  /** 解析后的基线提交；准备阶段确认远端后写入。 */
  readonly baseSha: string | null;
  readonly instructions: string;
  /**
   * 提案被批准时的启动配置；分配后不再变化。
   * `null` = 旧记录 / 配置缺失：提案确认必须失败关闭，不能猜默认 agent / model。
   */
  readonly startup: DelegationStartupConfig | null;
  /** 产生副作用前预留的执行会话身份。 */
  readonly executionSessionId: SessionId;
  /** 产生副作用前预留的独立工作树路径。 */
  readonly worktreePath: string;
  /** 产生副作用前预留的功能分支名。 */
  readonly branch: string;
  readonly state: DelegationState;
  /** 只有 `preparing` 有值；离开时清空。 */
  readonly claim: DelegationClaim | null;
  /** `failed` / `uncertain` 时必填。 */
  readonly failure: DelegationFailure | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface DelegationAllocation {
  readonly id: string;
  readonly accountId: string;
  readonly coordinatorSessionId: SessionId;
  /** 省略按提案车道处理，兼容旧调用方；新调用方必须显式给车道。 */
  readonly mode?: DelegationMode;
  readonly requestKey: string;
  readonly requestFingerprint: string;
  readonly projectId: ProjectId;
  readonly taskId: TaskId;
  readonly repoId: string;
  readonly repoUrl: string;
  readonly workerId: string;
  readonly baseBranch: string;
  readonly instructions: string;
  /** 新分配的派工必须冻结完整启动配置。 */
  readonly startup: DelegationStartupConfig;
  readonly executionSessionId: SessionId;
  readonly worktreePath: string;
  readonly branch: string;
  readonly at: number;
}

export type DelegationAllocationOutcome = 'created' | 'reused' | 'conflict';

export interface DelegationAllocationResult {
  readonly outcome: DelegationAllocationOutcome;
  /**
   * 三种结果都带记录：reused / conflict 返回库里已有的那条。
   * conflict 也用于执行会话身份撞车（返回占用该身份的那条记录）。
   */
  readonly record: WorkspaceDelegation;
}

export type DelegationClaimOutcome = 'claimed' | 'busy' | 'expired' | 'not-claimable' | 'missing';

export interface DelegationClaimResult {
  readonly outcome: DelegationClaimOutcome;
  readonly record: WorkspaceDelegation | null;
}

/**
 * CAS 的预期条件。`claimToken`：
 * - 省略 = 不校验；
 * - `null` = 必须没有 claim（`failed` 重排、`uncertain` 取消时用）；
 * - 字符串 = 必须是这次尝试。
 */
export interface DelegationCasExpect {
  readonly state: DelegationState;
  readonly claimToken?: string | null;
}

export interface DelegationCasInput {
  readonly expect: DelegationCasExpect;
  readonly state: DelegationState;
  readonly at: number;
  /** 只在解析出基线后写入；省略表示不改。 */
  readonly baseSha?: string | null;
  /** 目标为 `failed` / `uncertain` 时必填，其它目标忽略。 */
  readonly failure?: DelegationFailure | null;
}

export interface DelegationCasResult {
  readonly ok: boolean;
  /** 失败时返回当前记录，便于调用方判断是否被并发改过。 */
  readonly record: WorkspaceDelegation | null;
}

export interface WorkspaceDelegationStore {
  /**
   * 在副作用前分配记录。同 `(mode, coordinatorSessionId, requestKey)` 已存在时：
   * 指纹相同 -> `reused`（返回已有记录，且不改写已冻结的 `startup`），指纹不同 -> `conflict`（绝不覆盖）。
   * `executionSessionId` 全表唯一；被别的键占用时同样 `conflict`。
   */
  allocate(input: DelegationAllocation): Promise<DelegationAllocationResult>;
  byId(id: string): Promise<WorkspaceDelegation | null>;
  /** 供权限闸门用：该会话是不是某条派工预留的执行会话（唯一）。 */
  byExecutionSession(sessionId: SessionId): Promise<WorkspaceDelegation | null>;
  /**
   * 按车道 + 来源会话 + 请求键取记录。`mode` 省略时按提案车道，兼容旧调用方；
   * 直接车道必须显式传 `'direct'`，否则会读到提案车道的同键记录。
   */
  byCoordinatorRequest(
    coordinatorSessionId: SessionId,
    requestKey: string,
    mode?: DelegationMode
  ): Promise<WorkspaceDelegation | null>;
  byCoordinator(coordinatorSessionId: SessionId): Promise<WorkspaceDelegation[]>;
  /** 重启后需要对账的非终态：pending / preparing / uncertain。 */
  unsettled(): Promise<WorkspaceDelegation[]>;
  /**
   * 仅 `pending` 可领取；已有未过期 `preparing` 返回 `busy`，租期已过返回 `expired`
   * （不自动接管）。`preparing` 不能经 CAS 进入，先走这里。
   */
  claim(id: string, claim: DelegationClaim): Promise<DelegationClaimResult>;
  /**
   * 带预期状态 / claim token 的比较并交换。离开 `preparing` 时自动清空 claim；
   * 目标为 `failed` 必须给 `fatal`，为 `uncertain` 必须给 `uncertain`。
   * `uncertain` 只能转 `cancelled`：通用 CAS 不能把它改回 `pending`。
   */
  compareAndSet(id: string, input: DelegationCasInput): Promise<DelegationCasResult>;
}

/** 领取租期：覆盖一次 worktree + 会话准备的正常耗时，但不是「崩溃后自动继续」的承诺。 */
export const DELEGATION_CLAIM_TTL_MS = 5 * 60_000;

export function newDelegationClaim(owner: string, token: string, at: number, ttlMs: number = DELEGATION_CLAIM_TTL_MS): DelegationClaim {
  return { owner, token, at, expiresAt: at + ttlMs };
}

/** 状态迁移白名单；`preparing` 只允许从 `pending` 由 `claim` 进入。 */
export function delegationCanTransition(from: DelegationState, to: DelegationState): boolean {
  switch (from) {
    case 'pending':
      return to === 'preparing' || to === 'failed' || to === 'cancelled';
    case 'preparing':
      return to === 'prepared' || to === 'failed' || to === 'uncertain';
    case 'failed':
      return to === 'pending' || to === 'cancelled';
    case 'uncertain':
      // 不能回 pending：可能已有外部副作用，通用 CAS 不能把人重新带回重放路径。
      return to === 'cancelled';
    case 'prepared':
    case 'cancelled':
      return false;
  }
}

/** 该记录的领取是否已过租期；过租期只用于报告 `expired`，不代表可以接管。 */
export function delegationClaimExpired(record: WorkspaceDelegation, now: number): boolean {
  return record.claim !== null && record.claim.expiresAt <= now;
}
