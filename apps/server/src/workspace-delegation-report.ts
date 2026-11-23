import {
  can,
  conflict,
  err,
  forbidden,
  grantActive,
  invalid,
  isEmailVerified,
  notFound,
  ok,
  projectAsResource,
  sessionAsResource,
  WORKSPACE_REPORT_SCOPE,
  type AccessPolicy,
  type DelegationReportCommand,
  type DomainError,
  type GrantActor,
  type MessageBus,
  type Principal,
  type Project,
  type ProjectRepository,
  type Result,
  type Session,
  type SessionId,
  type SessionRepository,
  type TaskRepository,
  type ToolDescriptor,
  type ToolProvider,
  type WorkspaceDelegation,
  type WorkspaceDelegationStore
} from '@agent-hub/domain';

/**
 * `workspace.report`：执行会话把结果回报给它自己的协调会话。
 *
 * 只认工具授权里冻结的 actor，且接收者完全从 delegation 记录派生——
 * 输入里没有 recipient / project / wake 之类的字段。这条工具只产出一条消息，
 * 不唤醒会话、不调用 worker、也不接受任意引用。
 *
 * 校验只有一份：`canReport`（给 scope 铸造 / 实时 cap 用）和真正调用
 * 走同一个 `validateReportTarget`，但两者对状态的要求刻意不同：
 *
 * - provider 调用：必须恰好 `prepared`；
 * - `canReport`：在 `prepared` 之外，还允许仍持有**未过期 claim** 的 `preparing`。
 *
 * 原因是执行会话在工作树/会话建立期间（`preparing`）就需要拿到 scope；如果 mint 也
 * 只认 `prepared`，初始子会话永远没有回报能力，只能等 rehost。`canReport` 只读，
 * 不写记录、不发消息；终态或 claim 过期的 `preparing` 会立即失去资格。
 */
export const WORKSPACE_REPORT_TOOL_NAME = 'workspace.report';

const REQUEST_KEY_MAX = 200;
const BODY_MAX = 32_768;
const SHA_LENGTH = 40;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const INPUT_KEYS = new Set(['request_key', 'body', 'sha']);

export interface WorkspaceReportInput {
  readonly requestKey: string;
  readonly body: string;
  readonly sha?: string;
}

export type WorkspaceReportCommand = DelegationReportCommand;

export interface WorkspaceReportCapabilityInput {
  readonly sessionId: SessionId;
  readonly delegation: WorkspaceDelegation;
}

/**
 * 可选的实时能力检查（例如 main boot / 授权撤销后立刻收紧）。
 * 返回 false 或抛错都按拒绝处理；不提供则不额外检查。
 */
export type WorkspaceReportCapability = (
  input: WorkspaceReportCapabilityInput
) => Promise<boolean> | boolean;

export interface WorkspaceReportToolDeps {
  readonly sessions: Pick<SessionRepository, 'byId'>;
  readonly tasks: Pick<TaskRepository, 'byId'>;
  readonly projects: Pick<ProjectRepository, 'byId'>;
  readonly delegations: Pick<WorkspaceDelegationStore, 'byExecutionSession'>;
  readonly access: AccessPolicy;
  readonly loadActor: (userId: string) => Promise<Principal | null>;
  readonly bus: Pick<MessageBus, 'reportDelegation'>;
  /** cap/mint 判断 claim 是否过期用；省略时退回 Date.now。 */
  readonly now?: () => number;
  readonly capability?: WorkspaceReportCapability;
}

export interface WorkspaceReportToolProvider {
  readonly provider: ToolProvider;
  /**
   * 不铸造 grant，只回答「这条会话现在能不能拿到 / 保留回报能力」。
   * 传了 actor 就按运行时同样规则校验（必须 web + userId）；**不传 actor 一律拒绝**，
   * 不从 delegation 记录合成身份。
   *
   * 允许未过 claim 的 `preparing`；终态、无 claim 或 claim 过期都返回 false。
   * 只读，不写记录、不发消息。
   */
  canReport(sessionId: SessionId, actor: GrantActor | null | undefined): Promise<boolean>;
}

export const WORKSPACE_REPORT_TOOL: ToolDescriptor = {
  name: WORKSPACE_REPORT_TOOL_NAME,
  version: 1,
  scope: WORKSPACE_REPORT_SCOPE,
  perMinute: 10,
  // 回报正文可能含代码或日志，不进审计 payload。
  omitAuditPayload: true,
  description:
    'Report the outcome of this prepared delegation back to its coordinator session. The recipient and project are derived from the delegation record; they cannot be chosen. request_key is a stable idempotency key, and sha is an optional self-reported full 40-character commit SHA (not verified). This only appends a message; it does not wake or run anything.',
  inputSchema: {
    type: 'object',
    properties: {
      request_key: {
        type: 'string',
        minLength: 1,
        maxLength: REQUEST_KEY_MAX,
        description: 'Stable idempotency key chosen by you; reuse it verbatim when retrying the same report.'
      },
      body: {
        type: 'string',
        minLength: 1,
        maxLength: BODY_MAX,
        description: 'Report body for the coordinator session.'
      },
      sha: {
        type: 'string',
        minLength: SHA_LENGTH,
        maxLength: SHA_LENGTH,
        pattern: '^[a-f0-9]{40}$',
        description: 'Optional full commit SHA you produced, self-reported and not verified by the hub.'
      }
    },
    required: ['request_key', 'body'],
    additionalProperties: false
  }
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseInput(input: unknown): Result<WorkspaceReportInput, DomainError> {
  if (!isRecord(input)) return err(invalid('workspace.report 需要一个对象参数'));

  const unknown = Object.keys(input).filter((key) => !INPUT_KEYS.has(key));
  if (unknown.length > 0) {
    return err(invalid(`workspace.report 不接受这些字段：${unknown.join(', ')}`));
  }

  const requestKey = typeof input.request_key === 'string' ? input.request_key.trim() : '';
  if (requestKey.length === 0) return err(invalid('request_key 不能为空'));
  if (requestKey.length > REQUEST_KEY_MAX) return err(invalid(`request_key 不能超过 ${REQUEST_KEY_MAX} 个字符`));

  const body = typeof input.body === 'string' ? input.body : '';
  if (body.length === 0) return err(invalid('body 不能为空'));
  if (body.length > BODY_MAX) return err(invalid(`body 不能超过 ${BODY_MAX} 个字符`));

  let sha: string | undefined;
  if (input.sha !== undefined) {
    if (typeof input.sha !== 'string' || !SHA_PATTERN.test(input.sha)) {
      return err(invalid('sha 必须是完整的 40 位小写十六进制提交 SHA'));
    }
    sha = input.sha;
  }

  return ok(sha === undefined ? { requestKey, body } : { requestKey, body, sha });
}

/**
 * 严格从不可变来源取会话的 canonical project：
 * - 有 task：task.projectId；若还带 originProjectId，则两者必须一致；
 * - 无 task：只认 originProjectId，不回退到 group / 临时 workspace。
 */
async function canonicalProject(deps: WorkspaceReportToolDeps, session: Session): Promise<Project | null> {
  let project: Project | null;
  if (session.taskId !== null) {
    const task = await deps.tasks.byId(session.taskId);
    if (!task) return null;
    if (session.originProjectId != null && session.originProjectId !== task.projectId) return null;
    project = await deps.projects.byId(task.projectId);
  } else {
    if (session.originProjectId == null) return null;
    project = await deps.projects.byId(session.originProjectId);
  }
  return project && project.deletedAt === null ? project : null;
}

interface ValidatedReportTarget {
  readonly child: Session;
  readonly creator: Session;
  readonly delegation: WorkspaceDelegation;
  readonly principal: Principal;
  readonly actorId: string;
}

/**
 * 唯一的共享校验入口。`actor` 必须来自真实 grant / 调用方，缺失即拒绝；
 * 不伪造身份。`phase` 只区分状态门槛：cap/mint 允许带未过期 claim 的 `preparing`。
 */
async function validateReportTarget(
  deps: WorkspaceReportToolDeps,
  sessionId: SessionId,
  actor: GrantActor | null | undefined,
  phase: 'call' | 'cap'
): Promise<Result<ValidatedReportTarget, DomainError>> {
  if (!actor || actor.userId === null || actor.via !== 'web') {
    return err(forbidden('workspace.report 只接受 web 工具授权里的用户'));
  }
  const actorId = actor.userId;

  const child = await deps.sessions.byId(sessionId);
  if (!child) return err(notFound('执行会话不存在'));

  const delegation = await deps.delegations.byExecutionSession(child.id);
  if (!delegation) return err(notFound('这条会话没有对应的派工记录'));

  if (phase === 'call') {
    // 真正回报只在记录落定后发生。
    if (delegation.state !== 'prepared') {
      return err(conflict(`派工当前状态是 ${delegation.state}，只有 prepared 才能回报`));
    }
  } else {
    // mint / cap：允许 preparing，但 claim 必须存在且未过期；终态一律失去资格。
    const now = deps.now?.() ?? Date.now();
    const livePreparing =
      delegation.state === 'preparing' &&
      delegation.claim !== null &&
      delegation.claim.expiresAt > now;
    if (delegation.state !== 'prepared' && !livePreparing) {
      return err(conflict(`派工当前状态是 ${delegation.state}，不能回报`));
    }
  }

  // 执行会话与记录必须互相绑定，且都属于同一个已存账号。
  if (delegation.executionSessionId !== child.id) {
    return err(conflict('派工记录与当前执行会话不匹配'));
  }
  if (child.createdBy !== actorId) return err(forbidden('执行会话不属于当前用户'));
  if (delegation.accountId !== actorId) return err(forbidden('派工记录不属于当前用户'));

  const creator = await deps.sessions.byId(delegation.coordinatorSessionId);
  if (!creator) return err(notFound('协调会话不存在'));
  if (creator.id === child.id) return err(conflict('执行会话不能给自己回报'));
  if (creator.createdBy !== actorId) return err(forbidden('协调会话不属于当前用户'));

  const principal = await deps.loadActor(actorId);
  if (!principal) return err(forbidden('账号不存在'));
  if (principal.user.id !== actorId) return err(forbidden('账号与工具授权不一致'));
  if (principal.user.disabledAt !== null || principal.user.deletedAt !== null) {
    return err(forbidden('账号已停用或删除'));
  }
  if (!isEmailVerified(principal.user)) return err(forbidden('账号邮箱尚未验证'));

  // 子会话必须真的在跑这条派工的任务；协调会话可以无 task，也可以是同项目里
  // 父/兄弟任务的会话（现有 direct grant 允许这种形状）。
  if (child.taskId === null || child.taskId !== delegation.taskId) {
    return err(conflict('执行会话的任务与派工记录不一致'));
  }

  const childProject = await canonicalProject(deps, child);
  if (!childProject) return err(notFound('执行会话的项目不存在'));
  const creatorProject = await canonicalProject(deps, creator);
  if (!creatorProject) return err(notFound('协调会话的项目不存在'));
  if (childProject.id !== creatorProject.id) {
    return err(forbidden('执行会话和协调会话不在同一个项目'));
  }
  if (childProject.id !== delegation.projectId) {
    return err(conflict('派工记录的项目与执行会话不一致'));
  }

  const accessContext = await deps.access.context();
  const childReadable = can(
    principal,
    'session.read',
    sessionAsResource(child, childProject, accessContext),
    accessContext
  );
  const creatorReadable = can(
    principal,
    'session.read',
    sessionAsResource(creator, creatorProject, accessContext),
    accessContext
  );
  if (!childReadable || !creatorReadable) return err(forbidden('当前账号不能读取这两条会话'));

  // 和 bus 实际发送同一道项目级权限：cap / mint 也必须反映它，否则 scope 列表
  // 会承诺一个真正调用时必然失败的回报能力。
  if (!can(principal, 'agent.message.send', projectAsResource(childProject, accessContext), accessContext)) {
    return err(forbidden('当前账号不能在该项目发送消息'));
  }

  if (deps.capability) {
    let allowed = false;
    try {
      allowed = await deps.capability({ sessionId: child.id, delegation });
    } catch {
      return err(forbidden('当前授权不允许回报这条派工'));
    }
    if (!allowed) return err(forbidden('当前授权不允许回报这条派工'));
  }

  return ok({ child, creator, delegation, principal, actorId });
}

export function createWorkspaceReportToolProvider(deps: WorkspaceReportToolDeps): WorkspaceReportToolProvider {
  const canReport = async (
    sessionId: SessionId,
    actor: GrantActor | null | undefined
  ): Promise<boolean> => {
    if (!actor) return false;
    try {
      const validated = await validateReportTarget(deps, sessionId, actor, 'cap');
      return validated.ok;
    } catch {
      return false;
    }
  };

  const provider: ToolProvider = {
    id: 'workspace-report',
    tools: () => [WORKSPACE_REPORT_TOOL],
    async call(name, input, ctx): Promise<Result<unknown, DomainError>> {
      if (name !== WORKSPACE_REPORT_TOOL_NAME) return err(notFound(`没有工具 ${name}`));

      if (!ctx.grant.scopes.includes(WORKSPACE_REPORT_SCOPE)) {
        return err(forbidden('这个工具授权没有 delegation:report 权限'));
      }
      if (!grantActive(ctx.grant, ctx.now)) return err(forbidden('工具授权已过期或已撤销'));

      const parsed = parseInput(input);
      if (!parsed.ok) return parsed;
      const report = parsed.value;

      const validated = await validateReportTarget(deps, ctx.grant.sessionId, ctx.grant.actor, 'call');
      if (!validated.ok) return validated;
      const { child, delegation, actorId } = validated.value;

      // 接收者只从记录派生，绝不读 payload。
      const sent = await deps.bus.reportDelegation({
        fromSessionId: child.id,
        targetSessionId: delegation.coordinatorSessionId,
        actorId,
        delegationId: delegation.id,
        requestKey: report.requestKey,
        body: report.body,
        ...(report.sha === undefined ? {} : { sha: report.sha })
      });
      if (!sent.ok) return sent;

      // status 是实际投递状态，不是「已被协调方收到」的承诺；holdReason 只在被拦下时出现。
      // sha 是执行会话自报的，附上显式标记，避免被当成 hub 校验过的提交。
      return ok({
        messageId: sent.value.messageId,
        status: sent.value.status,
        ...(sent.value.holdReason == null ? {} : { holdReason: sent.value.holdReason }),
        delegationId: delegation.id,
        requestKey: report.requestKey,
        ...(report.sha === undefined ? {} : { sha: report.sha, shaVerification: 'self-reported' as const })
      });
    }
  };

  return { provider, canReport };
}
