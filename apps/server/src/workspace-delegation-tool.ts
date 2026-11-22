import {
  asTaskId,
  err,
  forbidden,
  invalid,
  notFound,
  ok,
  WORKSPACE_DELEGATE_SCOPE,
  type DelegateWorkspaceCommand,
  type DelegationCoordinator,
  type DelegationProposal,
  type DomainError,
  type GrantActor,
  type Principal,
  type Result,
  type Session,
  type SessionId,
  type ToolDescriptor,
  type ToolProvider,
  type ToolScope,
  type WorkspaceCoordinatorRegistry,
  type WorkspaceDelegationProposalBridges
} from '@agent-hub/domain';
import {
  createWorkspaceDelegationBridges,
  delegationView,
  type DelegationDeps
} from './workspace-delegation.ts';

/**
 * `workspace.delegate`（提案车道）。
 *
 * 只给「主会话」用：把一次跨会话派工**登记成 pending 提案**，不领取、不准备 worktree、
 * 不起执行会话、不发布。真人确认仍走 HTTP 的 confirm 路径。
 *
 * 身份只认工具授权里冻结的 actor，并且必须与这条会话的 `createdBy` 完全一致；
 * 不接受 payload 里的 actor、coordinator_session_id、model 或任意启动选项。
 */

const REQUEST_KEY_MAX = 200;
const INSTRUCTIONS_MAX = 20_000;
const INPUT_KEYS = new Set(['request_key', 'task_id', 'repo_id', 'base_branch', 'instructions', 'agent_id']);

export const WORKSPACE_DELEGATE_TOOL: ToolDescriptor = {
  name: 'workspace.delegate',
  version: 1,
  scope: WORKSPACE_DELEGATE_SCOPE,
  perMinute: 6,
  description:
    'Propose a workspace delegation from this coordinator session to a task in the same project. A human must confirm it in the workbench before any worktree or execution session is created. Reuse the same request key and content on retries. Returns {created, allocation, delegation}: a new proposal is pending, while a replay returns the existing state.',
  inputSchema: {
    type: 'object',
    properties: {
      request_key: {
        type: 'string',
        minLength: 1,
        maxLength: REQUEST_KEY_MAX,
        description: 'Stable idempotency key chosen by you; reuse it verbatim when retrying the same proposal.'
      },
      task_id: { type: 'string', minLength: 1, description: 'Target task id; it must belong to the same project as this coordinator session.' },
      repo_id: { type: 'string', minLength: 1, description: 'Project repository id (from the project repo list, not a URL or path).' },
      base_branch: { type: 'string', minLength: 1, description: 'Explicit base branch for the execution worktree.' },
      instructions: { type: 'string', minLength: 1, maxLength: INSTRUCTIONS_MAX, description: 'What the execution session should do. Keep it self-contained.' },
      agent_id: { type: 'string', minLength: 1, description: 'Agent runtime id for the execution session.' }
    },
    required: ['request_key', 'task_id', 'repo_id', 'base_branch', 'instructions', 'agent_id'],
    additionalProperties: false
  }
};

export interface WorkspaceDelegateToolDeps {
  readonly sessions: { byId(id: SessionId): Promise<Session | null> };
  /** 与 HTTP 派工共用同一套持久登记簿核实（含漂移检查）；不是注册表里的活主会话就返回 null。 */
  readonly bridgesFor: (input: {
    readonly baseBranch: string;
    readonly agentId: string;
  }) => WorkspaceDelegationProposalBridges;
  /** 领域只读提案用例；只分配 / 复用 pending，永不产生外部副作用。 */
  readonly propose: (
    command: DelegateWorkspaceCommand,
    bridges: WorkspaceDelegationProposalBridges
  ) => Promise<Result<DelegationProposal, DomainError>>;
  /** 从 store 重新读取账号：已删除 / 已停用都返回 null，不能只信授权快照。 */
  readonly loadActor: (userId: string) => Promise<Principal | null>;
}

/**
 * 签发 `workspace:delegate` 的唯一入口（给 `withToolAccess` 的 `extraScopes` 用）。
 *
 * 不是默认 scope：只有同时满足以下条件才追加：
 * - 冻结 actor 是真人 Web；
 * - 会话与 actor 都从 store 重新读，会话 `createdBy` 就是 actor，账号仍可用；
 * - 持久主会话登记簿精确指向这条会话，且登记的主人就是 actor。
 *
 * 任何一步不成立都返回空数组（不抛错），默认工具授权不受影响。
 */
export interface WorkspaceDelegateScopeDeps {
  /** 与 HTTP 派工 / 工具 provider 共用同一套会话读取。 */
  readonly sessions: { byId(id: SessionId): Promise<Session | null> };
  /** 持久主会话登记簿的 resolveCoordinator（含漂移检查）；不是活主会话就返回 null。 */
  readonly resolveCoordinator: (sessionId: SessionId) => Promise<DelegationCoordinator | null>;
  /** 从 store 读取当前账号；已删除 / 已停用返回 null。 */
  readonly loadActor: (userId: string) => Promise<Principal | null>;
}

export type WorkspaceDelegateScopeResolver = (input: {
  readonly session: Pick<Session, 'id' | 'taskId' | 'workerId'>;
  readonly actor?: GrantActor;
}) => Promise<readonly ToolScope[]>;

export function createWorkspaceDelegateScopeResolver(
  deps: WorkspaceDelegateScopeDeps
): WorkspaceDelegateScopeResolver {
  return async ({ session, actor }) => {
    if (!actor || actor.via !== 'web' || actor.userId === null) return [];
    const actorId = actor.userId;
    try {
      const current = await deps.sessions.byId(session.id);
      if (!current || !current.createdBy || current.createdBy !== actorId) return [];

      const principal = await deps.loadActor(actorId);
      if (!principal || principal.user.id !== actorId) return [];

      const coordinator = await deps.resolveCoordinator(session.id);
      if (
        !coordinator ||
        coordinator.sessionId !== session.id ||
        coordinator.accountId !== actorId
      ) {
        return [];
      }
      return [WORKSPACE_DELEGATE_SCOPE];
    } catch {
      // 登记簿 / 账号读取失败时宁可不给这项能力，也不退化成普通工具。
      return [];
    }
  };
}

/**
 * Hub 侧的一条龙装配：与 HTTP 派工共用 `createWorkspaceDelegationBridges` 的
 * `resolveCoordinator`（登记簿 + 漂移检查），parent 只把结果交给 `withToolAccess` 的
 * `extraScopes` 即可。
 *
 * `resolveCoordinator` 不读取 plan 的启动上下文，这里传空占位仅用于构造 bridge。
 */
export function createWorkspaceDelegateScopeResolverFromDelegation(deps: {
  readonly delegationDeps: DelegationDeps;
  readonly coordinators: WorkspaceCoordinatorRegistry;
  readonly loadActor: (userId: string) => Promise<Principal | null>;
}): WorkspaceDelegateScopeResolver {
  const bridges = createWorkspaceDelegationBridges(
    deps.delegationDeps,
    deps.coordinators,
    { baseBranch: '', agentId: '' }
  );
  return createWorkspaceDelegateScopeResolver({
    sessions: deps.delegationDeps.sessions,
    resolveCoordinator: (sessionId) => bridges.resolveCoordinator(sessionId),
    loadActor: deps.loadActor
  });
}

interface DelegateInput {
  readonly requestKey: string;
  readonly taskId: string;
  readonly repoId: string;
  readonly baseBranch: string;
  readonly instructions: string;
  readonly agentId: string;
}

/** 输入必须精确：不认识的键（尤其是 actor / coordinatorSessionId / options）直接拒绝。 */
function parseInput(input: unknown): Result<DelegateInput, DomainError> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return err(invalid('参数必须是对象'));
  }
  const raw = input as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((key) => !INPUT_KEYS.has(key));
  if (unknown.length > 0) return err(invalid(`不支持的参数：${unknown.join(', ')}`));

  const requestKey = raw.request_key;
  if (typeof requestKey !== 'string' || requestKey.trim() === '' || requestKey.length > REQUEST_KEY_MAX) {
    return err(invalid(`request_key 必须是 trim 后非空、不超过 ${REQUEST_KEY_MAX} 字符的字符串`));
  }

  const exact = (key: 'task_id' | 'repo_id' | 'base_branch' | 'agent_id'): Result<string, DomainError> => {
    const value = raw[key];
    if (typeof value !== 'string' || value.trim() === '') return err(invalid(`${key} 必须是非空字符串`));
    // id / 分支名原样使用；夹空白说明调用方拼错了，不做静默 trim。
    if (value !== value.trim()) return err(invalid(`${key} 不能有首尾空白`));
    return ok(value);
  };

  const taskId = exact('task_id');
  if (!taskId.ok) return taskId;
  const repoId = exact('repo_id');
  if (!repoId.ok) return repoId;
  const baseBranch = exact('base_branch');
  if (!baseBranch.ok) return baseBranch;
  const agentId = exact('agent_id');
  if (!agentId.ok) return agentId;

  const instructions = raw.instructions;
  if (
    typeof instructions !== 'string' ||
    instructions.trim() === '' ||
    instructions.length > INSTRUCTIONS_MAX
  ) {
    return err(invalid(`instructions 必须是 trim 后非空、不超过 ${INSTRUCTIONS_MAX} 字符的字符串`));
  }

  return ok({
    requestKey,
    taskId: taskId.value,
    repoId: repoId.value,
    baseBranch: baseBranch.value,
    instructions,
    agentId: agentId.value
  });
}

export function createWorkspaceDelegationToolProvider(deps: WorkspaceDelegateToolDeps): ToolProvider {
  return {
    id: 'workspace-delegation',
    tools: () => [WORKSPACE_DELEGATE_TOOL],
    async call(name, input, ctx): Promise<Result<unknown, DomainError>> {
      if (name !== WORKSPACE_DELEGATE_TOOL.name) return err(notFound(`未知工具：${name}`));

      const parsed = parseInput(input);
      if (!parsed.ok) return parsed;

      // 1) 调用会话必须真实存在。
      const session = await deps.sessions.byId(ctx.grant.sessionId);
      if (!session) return err(notFound('找不到发起派工的会话'));

      // 2) 只认授权快照里冻结的人类身份；payload 里的 actor / coordinatorSessionId 一律不读。
      const actor = ctx.grant.actor;
      if (!actor || actor.userId === null || actor.via !== 'web') {
        return err(forbidden('workspace.delegate 只能由真人登录会话调用'));
      }
      const actorId = actor.userId;

      // 3) 冻结身份必须就是这条会话的归属人；没有归属人就拒绝（不猜、不回退）。
      if (!session.createdBy || session.createdBy !== actorId) {
        return err(forbidden('调用身份与会话归属人不一致'));
      }

      // 4) 账号可能已被删除 / 停用：从 store 重新加载，不看旧快照。
      const principal = await deps.loadActor(actorId);
      if (!principal || principal.user.id !== actorId) {
        return err(forbidden('调用账号已停用或不存在'));
      }

      // 5) 持久登记簿必须精确指向这条会话，且记录的主会话主人就是当前 actor。
      //    这里与 HTTP 派工共用 bridge，漂移（任务 / 工作区 / bot / 群 / 父会话 / 归属人 / Worker）一律拒绝。
      const bridges = deps.bridgesFor({ baseBranch: parsed.value.baseBranch, agentId: parsed.value.agentId });
      const coordinator = await bridges.resolveCoordinator(ctx.grant.sessionId);
      if (!coordinator || coordinator.sessionId !== ctx.grant.sessionId) {
        return err(notFound('主会话登记不存在或已漂移'));
      }
      if (coordinator.accountId !== actorId) {
        return err(forbidden('不能替别人的主会话派工'));
      }

      const command: DelegateWorkspaceCommand = {
        actor: principal,
        requestKey: parsed.value.requestKey,
        coordinatorSessionId: ctx.grant.sessionId,
        taskId: asTaskId(parsed.value.taskId),
        repoId: parsed.value.repoId,
        baseBranch: parsed.value.baseBranch,
        instructions: parsed.value.instructions,
        agentId: parsed.value.agentId
      };

      // 只分配 / 复用 pending 提案；领域用例在 propose 模式下不会 claim / prepare / start / link。
      const proposal = await deps.propose(command, bridges);
      if (!proposal.ok) return proposal;

      return ok({
        created: proposal.value.allocation === 'created',
        allocation: proposal.value.allocation,
        delegation: delegationView(proposal.value.record)
      });
    }
  };
}
