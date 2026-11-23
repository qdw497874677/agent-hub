import {
  FAILURE_CODES,
  HANDOFF_BUS_ORIGIN,
  authorizeSession,
  err,
  forbidden,
  invalid,
  notFound,
  ok,
  unavailable,
  type AgentMessage,
  type Deps,
  type DomainError,
  type FailureCode,
  type HoldReason,
  type MessagePart,
  type MessageStore,
  type Principal,
  type Project,
  type ProjectId,
  type Result,
  type Session,
  type SessionId,
  type WorkspaceDelegation,
  type WorkspaceDelegationStore
} from '@agent-hub/domain';
import { PROJECT_CANDIDATE_PART_SCHEMA } from './project-session-handoff.ts';

/**
 * 派工交接读取投影（VibeX 二期 V6，docs/design/vibex-borrowing.md §第二期）。
 *
 * 回答的问题：**项目里有哪些普通会话把这条派工的执行会话当候选来源，发过交接**。
 * 不是执行会话的收件箱，也不是会话记录 / 转录；候选只表示「消息里带了可信的候选引用」，
 * 不代表测过、验收过或 Git 上验证过。
 *
 * 为什么按候选来源查，而不是查执行会话：
 * - 真实生产者是「普通发送会话 → 普通接收会话」，候选 part 的 `sourceSessionId` 才是执行会话；
 *   生产者明确拒绝 `sourceSessionId === targetSessionId`（project-session-handoff.ts:212）。
 * - 受限执行会话没有 `message:send`，扫它的进出消息找不到生产里的候选交接。
 *
 * 可信边界：
 * - 来源只认 `AgentMessage.handoffOrigin === HANDOFF_BUS_ORIGIN`（Hub 交接用例写入）。
 *   普通发送也能自带 `data.schema` 和幂等键，所以 schema / replay key 都不能替代它；
 *   缺字段（老数据 / 伪造）= 来源未知，不展示。
 * - 查询按项目 + 执行会话预筛；进入结果前还要逐条核对：候选 part 恰好一个，
 *   `projectId` = 派工项目、`sourceSessionId` = 执行会话、`repoId` = 派工仓库、
 *   `sha` 是完整 40 位小写十六进制。
 * - 消息可见性沿用当前 `session.read`：派工归属人才能看；每条交接的发送会话必须
 *   canonical 属于同项目且现在仍可读，否则整条跳过、绝不回显内容。跳过的记录会让
 *   结果落到 `unknown`，不会说成「没有交接」。
 * - 附件只回白名单元数据：ref（repo / branch / sha）、去掉 query / fragment / 凭据的
 *   http(s) link、file 只留中性标记（不带会话 / 路径 / 成员，也不代表读文件权限）。
 *   其它 data part（例如 `verify-result/v1`）不回显，只计数。
 * - DTO 不带发送 / 接收会话 id；UI 不依赖它们，少暴露一条跨会话关联。
 *
 * 读取有上限：最多取最近 `scanLimit` 条预筛记录。取满时 `scanTruncated=true`；
 * 没有可展示的交接但存在被跳过的记录或窗口可能被截断时，state = `unknown`。
 */

/** 单条交接正文最多回显多少字符；超出置 `bodyTruncated`。 */
export const MAX_HANDOFF_BODY_CHARS = 4096;
const DEFAULT_SCAN_LIMIT = 100;
const MAX_SCAN_LIMIT = 200;
const MAX_ID_CHARS = 200;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const PART_SHA = /^[0-9a-f]{7,40}$/;

const QUERY_KEYS = new Set(['actorId', 'delegationId', 'scanLimit']);

/** 消息传输事实；不是任务状态，也不能从它推断执行成败。 */
export type HandoffTransportState =
  | 'inbox'
  | 'queued'
  | 'delivered'
  | 'held'
  | 'failed'
  | 'unknown';

export type HandoffAttachment =
  | {
      readonly kind: 'ref';
      readonly repo: string;
      readonly branch: string | null;
      readonly sha: string | null;
    }
  | { readonly kind: 'link'; readonly url: string; readonly label: string | null }
  /** 中性文件标记：不暴露 session / path / member，也不代表读文件权限。 */
  | { readonly kind: 'file' };

export interface WorkspaceDelegationHandoffCandidate {
  readonly repoId: string;
  readonly sha: string;
}

export interface WorkspaceDelegationHandoffEntry {
  readonly messageId: string;
  readonly sentAt: number;
  /** 传输状态；`delivered` 只表示进了对方一轮，不是任务成功。 */
  readonly transport: HandoffTransportState;
  readonly failure: FailureCode | null;
  readonly holdReason: HoldReason | null;
  readonly deliveredAt: number | null;
  /** 收件箱消息被读到的时间；null = 还没读。 */
  readonly readAt: number | null;
  readonly body: string;
  readonly bodyTruncated: boolean;
  /** 只含已核对的可信候选引用，不代表验收或 Git 验证。 */
  readonly candidate: WorkspaceDelegationHandoffCandidate;
  readonly attachments: readonly HandoffAttachment[];
  /** 被隐藏的其它 data / 非法 part 数量；不回显内容。 */
  readonly hiddenPartCount: number;
}

export interface WorkspaceDelegationHandoffProjection {
  readonly delegationId: string;
  readonly projectId: ProjectId;
  readonly executionSessionId: SessionId;
  /**
   * recorded = 至少一条可展示的可信交接；
   * none     = 完整扫描后确实没有（可以回答「没有已记录的交接」）；
   * unknown  = 窗口被截断，或有记录因候选不成立 / 发送会话不可读被跳过，不能断言没有。
   */
  readonly state: 'recorded' | 'none' | 'unknown';
  /** 预筛窗口是否可能还有更早的记录。 */
  readonly scanTruncated: boolean;
  /** 新的在前；顺序稳定（sentAt 降序，同时间按 messageId 升序）。 */
  readonly handoffs: readonly WorkspaceDelegationHandoffEntry[];
}

export interface WorkspaceDelegationHandoffQuery {
  readonly actorId: string;
  readonly delegationId: string;
  /** 扫描上限，默认 100，限制在 1..200。 */
  readonly scanLimit?: number;
}

export interface WorkspaceDelegationHandoffDeps {
  readonly delegations: Pick<WorkspaceDelegationStore, 'byId'>;
  readonly projects: Pick<Deps['projects'], 'byId'>;
  readonly sessions: Pick<Deps['sessions'], 'byId'>;
  readonly tasks: Pick<Deps['tasks'], 'byId'>;
  readonly messages: Pick<MessageStore, 'byCandidateSource'>;
  readonly access: Deps['access'];
  /** 账号当前状态；返回 null 即拒绝。 */
  readonly loadActor: (accountId: string) => Promise<Principal | null>;
}

export interface WorkspaceDelegationHandoffProjectionService {
  read(
    query: WorkspaceDelegationHandoffQuery
  ): Promise<Result<WorkspaceDelegationHandoffProjection, DomainError>>;
}

const exactId = (value: unknown): value is string =>
  typeof value === 'string'
  && value !== ''
  && value === value.trim()
  && value.length <= MAX_ID_CHARS
  && !CONTROL_CHARACTERS.test(value);

const textOrNull = (value: unknown, max = 200): string | null =>
  typeof value === 'string' && value !== '' && value.length <= max && !CONTROL_CHARACTERS.test(value)
    ? value
    : null;

/** 只留 origin + path：丢掉 query / fragment / 用户名密码。 */
const safeHttpUrl = (value: unknown): string | null => {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const sanitized = `${url.origin}${url.pathname}`;
    return sanitized.length <= 2048 && !CONTROL_CHARACTERS.test(sanitized) ? sanitized : null;
  } catch {
    return null;
  }
};

const isFailureCode = (value: unknown): value is FailureCode =>
  typeof value === 'string' && (FAILURE_CODES as readonly string[]).includes(value);

const asHoldReason = (value: unknown): HoldReason | null =>
  value === 'pingpong' || value === 'privilege' ? value : null;

const transportOf = (message: AgentMessage): HandoffTransportState => {
  switch (message.status) {
    case 'done':
      // wake=false：bus 只写收件箱，不唤醒；wake=true 的 done = 已经过一轮。
      return message.wake === false ? 'inbox' : 'delivered';
    case 'queued':
    case 'delivered':
    case 'held':
    case 'failed':
      return message.status;
    default:
      // awaiting_approval / answered / denied 不属于交接 send 的正常路径。
      return 'unknown';
  }
};

/**
 * 会话 → 项目：有任务以任务项目为准，不可变来源冲突时绑定不成立。
 * 与项目交接生产端（project-session-handoff.ts 的 canonicalProjectId）同一规则。
 */
async function canonicalProjectId(
  deps: WorkspaceDelegationHandoffDeps,
  session: Session,
  taskCache: Map<string, string | null>
): Promise<string | null> {
  if (session.taskId === null) return session.originProjectId ?? null;

  let projectId = taskCache.get(session.taskId);
  if (projectId === undefined) {
    const task = await deps.tasks.byId(session.taskId);
    projectId = task ? task.projectId : null;
    taskCache.set(session.taskId, projectId);
  }
  if (projectId === null) return null;
  if (session.originProjectId != null && session.originProjectId !== projectId) return null;
  return projectId;
}

const asMessagePart = (value: unknown): value is MessagePart =>
  typeof value === 'object'
  && value !== null
  && !Array.isArray(value)
  && typeof (value as { type?: unknown }).type === 'string';

/** 存储层把 parts 当数组整体透传；历史 / 伪造行里可能有 null、字符串、数字，逐个跳过。 */
function safeParts(value: unknown): { parts: MessagePart[]; dropped: number } {
  if (!Array.isArray(value)) return { parts: [], dropped: 0 };
  const parts: MessagePart[] = [];
  let dropped = 0;
  for (const item of value) {
    if (asMessagePart(item)) parts.push(item);
    else dropped += 1;
  }
  return { parts, dropped };
}

interface CandidateRead {
  readonly repoId: string;
  readonly sha: string;
}

/**
 * 候选只在完全可证时返回。多个候选 part 视为歧义，不挑一个「看起来对」的；
 * 候选只证明来源消息带了可信元数据，不证明代码可用或已验收。
 */
function confirmCandidate(
  message: AgentMessage,
  delegation: WorkspaceDelegation,
  parts: readonly MessagePart[]
): CandidateRead | null {
  if (message.projectId !== delegation.projectId) return null;
  const candidates = parts.filter(
    (part): part is Extract<MessagePart, { type: 'data' }> =>
      part.type === 'data' && part.schema === PROJECT_CANDIDATE_PART_SCHEMA
  );
  if (candidates.length !== 1) return null;
  const part = candidates[0];
  if (!part) return null;
  const data = part.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;

  const record = data as Record<string, unknown>;
  const repoId = record.repoId;
  const sha = record.sha;
  if (record.projectId !== delegation.projectId) return null;
  if (record.sourceSessionId !== delegation.executionSessionId) return null;
  if (typeof repoId !== 'string' || !exactId(repoId) || repoId !== delegation.repoId) return null;
  if (typeof sha !== 'string' || !FULL_SHA.test(sha)) return null;
  return { repoId, sha };
}

/** 附件只做元数据投影；file 不读路径，其它 data 不回显。 */
function readAttachments(parts: readonly MessagePart[]): {
  attachments: HandoffAttachment[];
  hiddenPartCount: number;
} {
  const attachments: HandoffAttachment[] = [];
  let hiddenPartCount = 0;
  for (const part of parts) {
    switch (part.type) {
      case 'ref': {
        const repo = textOrNull(part.repo);
        if (repo === null) {
          hiddenPartCount += 1;
          break;
        }
        attachments.push({
          kind: 'ref',
          repo,
          branch: textOrNull(part.branch),
          sha: typeof part.sha === 'string' && PART_SHA.test(part.sha) ? part.sha : null
        });
        break;
      }
      case 'link': {
        const url = safeHttpUrl(part.url);
        if (url === null) {
          hiddenPartCount += 1;
          break;
        }
        attachments.push({ kind: 'link', url, label: textOrNull(part.label) });
        break;
      }
      case 'file':
        // 中性标记：不检查也不暗示文件读权限。
        attachments.push({ kind: 'file' });
        break;
      default:
        // 候选 data 单独处理；其余 data（含 verify-result/v1）是发送方自述，不当证据。
        if (part.schema !== PROJECT_CANDIDATE_PART_SCHEMA) hiddenPartCount += 1;
        break;
    }
  }
  return { attachments, hiddenPartCount };
}

interface ReadContext {
  readonly delegation: WorkspaceDelegation;
  readonly project: Project;
  readonly execution: Session;
  readonly actor: Principal;
}

/** 授权前置：派工归属、项目、执行会话可读、执行会话仍是记录里的那条任务会话。 */
async function readContext(
  deps: WorkspaceDelegationHandoffDeps,
  query: WorkspaceDelegationHandoffQuery,
  actor: Principal
): Promise<Result<ReadContext, DomainError>> {
  let delegation: WorkspaceDelegation | null;
  try {
    delegation = await deps.delegations.byId(query.delegationId);
  } catch {
    return err(unavailable('派工记录暂时不可用，请稍后重试'));
  }
  // 非归属人按不存在处理，不泄露派工是否存在。
  if (!delegation) return err(notFound('派工记录不存在'));
  if (delegation.accountId !== query.actorId) return err(notFound('派工记录不存在'));
  if (!exactId(delegation.repoId)) return err(forbidden('派工记录不完整'));

  let project: Project | null;
  try {
    project = await deps.projects.byId(delegation.projectId);
  } catch {
    return err(unavailable('项目暂时不可用，请稍后重试'));
  }
  if (!project || project.deletedAt != null) return err(notFound('项目不存在'));
  if (delegation.projectId !== project.id) return err(notFound('项目不存在'));

  let execution: Session | null;
  try {
    execution = await deps.sessions.byId(delegation.executionSessionId);
  } catch {
    return err(unavailable('执行会话暂时不可用，请稍后重试'));
  }
  if (!execution) return err(notFound('执行会话不存在'));

  // 消息可见性沿用现有 session.read；权限实现抛错也按不可读处理。
  let readable: Result<Session, DomainError>;
  try {
    readable = await authorizeSession(deps.access, actor, project, execution, 'session.read');
  } catch {
    return err(unavailable('暂时无法确认执行会话的读取权限，请稍后重试'));
  }
  if (!readable.ok) return readable;

  // 记录里的执行会话必须仍是同一任务、且 canonical 归属于派工项目；
  // 漂移时失败关闭，不换一条会话去读。
  if (execution.taskId !== delegation.taskId) {
    return err(forbidden('执行会话与派工记录不一致'));
  }
  let canonical: string | null;
  try {
    canonical = await canonicalProjectId(deps, execution, new Map());
  } catch {
    return err(unavailable('暂时无法确认执行会话所属项目，请稍后重试'));
  }
  if (canonical !== project.id) return err(forbidden('执行会话与派工记录不一致'));

  return ok({ delegation, project, execution, actor });
}

async function readProjection(
  deps: WorkspaceDelegationHandoffDeps,
  query: WorkspaceDelegationHandoffQuery
): Promise<Result<WorkspaceDelegationHandoffProjection, DomainError>> {
  const unknown = Object.keys(query).filter((key) => !QUERY_KEYS.has(key));
  if (unknown.length > 0) return err(invalid(`未知参数：${unknown.join(', ')}`));
  if (!exactId(query.actorId)) return err(invalid('查看人 id 不合法'));
  if (!exactId(query.delegationId)) return err(invalid('派工 id 不合法'));
  const scanLimit = query.scanLimit ?? DEFAULT_SCAN_LIMIT;
  if (!Number.isInteger(scanLimit) || scanLimit < 1 || scanLimit > MAX_SCAN_LIMIT) {
    return err(invalid(`scanLimit 必须是 1..${MAX_SCAN_LIMIT} 的整数`));
  }

  let actor: Principal | null;
  try {
    actor = await deps.loadActor(query.actorId);
  } catch {
    return err(unavailable('当前账号暂时不可用，请稍后重试'));
  }
  if (!actor || actor.user.id !== query.actorId) return err(forbidden('当前账号不可用'));

  const context = await readContext(deps, query, actor);
  if (!context.ok) return context;
  const { delegation, project, execution } = context.value;

  let rows: AgentMessage[];
  try {
    rows = await deps.messages.byCandidateSource(project.id, execution.id, scanLimit);
  } catch {
    return err(unavailable('交接记录暂时不可用，无法确认是否已交付'));
  }

  const taskCache = new Map<string, string | null>();
  const senderCache = new Map<string, Session | null>();
  const readableCache = new Map<string, boolean>();
  const handoffs: WorkspaceDelegationHandoffEntry[] = [];
  let hidden = 0;

  for (const message of rows) {
    // 来源只认 Hub 写入的标记；方向必须是普通会话发出的 send，目标非空且不是执行会话自己。
    if (
      message.handoffOrigin !== HANDOFF_BUS_ORIGIN
      || message.kind !== 'send'
      || message.projectId !== project.id
      || message.fromSessionId === execution.id
      || message.targetSessionId === null
      || message.targetSessionId === execution.id
    ) {
      continue;
    }
    if (!Number.isFinite(message.createdAt)) {
      hidden += 1;
      continue;
    }

    const { parts, dropped } = safeParts(message.parts);
    const candidate = confirmCandidate(message, delegation, parts);
    if (!candidate) {
      hidden += 1;
      continue;
    }

    let sender = senderCache.get(message.fromSessionId);
    if (sender === undefined) {
      try {
        sender = await deps.sessions.byId(message.fromSessionId);
      } catch {
        return err(unavailable('交接记录暂时不可用，无法确认是否已交付'));
      }
      senderCache.set(message.fromSessionId, sender);
    }
    if (!sender) {
      hidden += 1;
      continue;
    }

    let senderInProject: string | null;
    try {
      senderInProject = await canonicalProjectId(deps, sender, taskCache);
    } catch {
      return err(unavailable('交接记录暂时不可用，无法确认是否已交付'));
    }
    if (senderInProject !== project.id) {
      hidden += 1;
      continue;
    }

    let visible = readableCache.get(sender.id);
    if (visible === undefined) {
      let authorized: Result<Session, DomainError>;
      try {
        authorized = await authorizeSession(deps.access, actor, project, sender, 'session.read');
      } catch {
        return err(unavailable('暂时无法确认交接消息的读取权限，请稍后重试'));
      }
      visible = authorized.ok;
      readableCache.set(sender.id, visible);
    }
    if (!visible) {
      hidden += 1;
      continue;
    }

    const { attachments, hiddenPartCount } = readAttachments(parts);
    const rawBody = typeof message.body === 'string' ? message.body : '';
    const bodyTruncated = rawBody.length > MAX_HANDOFF_BODY_CHARS;
    handoffs.push({
      messageId: message.id,
      sentAt: message.createdAt,
      transport: transportOf(message),
      failure: isFailureCode(message.failure) ? message.failure : null,
      holdReason: asHoldReason(message.holdReason),
      deliveredAt: typeof message.deliveredAt === 'number' ? message.deliveredAt : null,
      readAt: typeof message.readAt === 'number' ? message.readAt : null,
      body: bodyTruncated ? rawBody.slice(0, MAX_HANDOFF_BODY_CHARS) : rawBody,
      bodyTruncated,
      candidate,
      attachments,
      hiddenPartCount: hiddenPartCount + dropped
    });
  }

  handoffs.sort(
    (left, right) =>
      right.sentAt - left.sentAt || (left.messageId < right.messageId ? -1 : left.messageId > right.messageId ? 1 : 0)
  );

  const scanTruncated = rows.length >= scanLimit;
  const state =
    handoffs.length > 0 ? 'recorded' : scanTruncated || hidden > 0 ? 'unknown' : 'none';

  return ok({
    delegationId: delegation.id,
    projectId: delegation.projectId,
    executionSessionId: delegation.executionSessionId,
    state,
    scanTruncated,
    handoffs
  });
}

export function createWorkspaceDelegationHandoffProjection(
  deps: WorkspaceDelegationHandoffDeps
): WorkspaceDelegationHandoffProjectionService {
  return {
    read: (query) => readProjection(deps, query)
  };
}
