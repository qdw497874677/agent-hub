import {
  authorizeSession,
  projectReader,
  type AccessPolicy,
  type DeliveryState,
  type Deps,
  type Project,
  type ProjectId,
  type PromptActor,
  type Session,
  type SessionId,
  type Subject
} from '@agent-hub/domain';
import type { ObserveLink, ObserveList, ObserveListItem, ObserveListQuery, ObserveNode, ObserveReader, ObserveTrace } from '@agent-hub/observe';

/**
 * Agent 回合（一次 prompt 送达）的只读视图（ADR 0033）。
 *
 * 这里只认送达行 + 精确的 ended 记录（ADR 0031 的 deliveryId 回执）：
 * - 当前状态来自送达行（queued / sending / delivered …），不是回合结果；
 * - 结果只来自 journal 里 deliveryId 对得上的那条 ended，迟到 / 别的送达的 ended 不算；
 * - 老数据没有 exact ended 就写「未记录」，不从会话状态、当前模型或时间窗推历史。
 * 原始提示词、错误正文、工具参数一律不进响应。
 */

/** 时间窗里先取这么多条再筛，避免一次读光。多出来的记 truncated。 */
export const AGENT_SCAN = 500;

/** 存储里的一行送达记录。字段够用就好，payload / lastError 不进来。 */
export interface AgentTurnRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly projectId: string;
  /** 对应 journal 里 prompt 事件的 seq；交接简报（held）为 0。 */
  readonly seq: number;
  /** 存储原始列；读侧先验成 DeliveryState 再打标签。 */
  readonly state: string;
  readonly attempt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** 精确回合结束：journal 里 deliveryId 对得上的那条 ended。 */
export interface AgentTurnEnd {
  readonly seq: number;
  readonly at: number;
  readonly outcome: 'done' | 'stopped' | 'interrupted' | 'failed';
  /** 运行时自己都不知道结果（例如中途重启）：不能当成成功/失败。 */
  readonly unknownOutcome: boolean;
}

type Awaitable<T> = T | Promise<T>;

/** 注入的只读存储。同步 / 异步都行；排序、时间过滤、截断在上限内由存储负责。 */
export interface AgentTurnRecords {
  list(input: {
    readonly projectIds: readonly string[];
    readonly since: number;
    readonly limit: number;
  }): Awaitable<readonly AgentTurnRecord[]>;
  byId(id: string): Awaitable<AgentTurnRecord | null>;
  /** 只返回 deliveryId 精确对得上、且在 afterSeq 之后的第一条 ended。 */
  ended(sessionId: string, deliveryId: string, afterSeq: number): Awaitable<AgentTurnEnd | null>;
  /** 精确读取对应 prompt 的受限类别；缺失 / 损坏一律 null。 */
  promptActor(sessionId: string, seq: number): Awaitable<PromptActor | null>;
  /** 只读精确标记的日期和序号，不读正文到投影。 */
  firstOutput(sessionId: string, deliveryId: string, afterSeq: number, beforeSeq: number | null): Awaitable<{ seq: number; at: number } | null>;
}

export interface AgentObserveDeps {
  readonly projects: Pick<Deps['projects'], 'list' | 'byId'>;
  readonly sessions: Pick<Deps['sessions'], 'byId'>;
  readonly tasks: Pick<Deps['tasks'], 'byId'>;
  readonly records: AgentTurnRecords;
  readonly policy?: AccessPolicy;
}

const DELIVERY_LABEL: Record<DeliveryState, string> = {
  queued: '排队',
  sending: '发送中',
  delivered: '已送达',
  undelivered: '未送达',
  cancelled: '已撤回',
  held: '挂起'
};

const OUTCOME_LABEL: Record<AgentTurnEnd['outcome'], string> = {
  done: '完成',
  stopped: '已停止',
  interrupted: '中断',
  failed: '失败'
};

/** 没有精确 ended 时，当前状态说明的是「送达」而不是「结果」。 */
function pendingNote(state: DeliveryState): string {
  switch (state) {
    case 'queued':
      return '排队中，尚无结果';
    case 'sending':
      return '发送中，等待确认';
    case 'undelivered':
      return '未送达，尚无精确结果';
    case 'cancelled':
      return '已撤回，尚无精确结果';
    case 'held':
      return '挂起，尚无精确结果';
    case 'delivered':
      // 老数据：送达了但没有精确 ended，历史结果不可知。
      return '未记录';
  }
}

const isDeliveryState = (value: unknown): value is DeliveryState => typeof value === 'string' && Object.hasOwn(DELIVERY_LABEL, value);

const isOutcome = (value: unknown): value is AgentTurnEnd['outcome'] =>
  value === 'done' || value === 'stopped' || value === 'interrupted' || value === 'failed';

const actorLabel = (value: unknown): string => {
  switch (value) {
    case 'account': return '账号';
    case 'token': return '令牌';
    case 'system': return '系统';
    case 'unknown': return '未知';
    default: return '未记录';
  }
};

/**
 * 存储可能把原始列直接递过来；标签之前先验一遍。
 * 状态不认识、关键字段不成立就丢掉这一行，不猜它是什么。
 */
type ValidTurnRecord = AgentTurnRecord & { readonly state: DeliveryState };

const validRecord = (row: AgentTurnRecord | null | undefined): row is ValidTurnRecord =>
  !!row &&
  typeof row.id === 'string' &&
  row.id !== '' &&
  typeof row.sessionId === 'string' &&
  row.sessionId !== '' &&
  typeof row.projectId === 'string' &&
  row.projectId !== '' &&
  Number.isInteger(row.seq) &&
  row.seq >= 0 &&
  isDeliveryState(row.state) &&
  Number.isInteger(row.attempt) &&
  row.attempt >= 0 &&
  Number.isFinite(row.createdAt) &&
  Number.isFinite(row.updatedAt);

/** 结束记录要么精确可信，要么当作「结果未知」；字段不成立就视为没记录。 */
const validEnd = (end: AgentTurnEnd | null | undefined, afterSeq: number): AgentTurnEnd | null => {
  if (!end || !Number.isSafeInteger(end.seq) || end.seq <= afterSeq || !Number.isSafeInteger(end.at) || end.at < 0 || end.at > 8_640_000_000_000_000 || typeof end.unknownOutcome !== 'boolean') return null;
  if (isOutcome(end.outcome)) return end;
  // 运行时给了不认识的结果：保留结束事实，但明确标成结果未知。
  return { seq: end.seq, at: end.at, outcome: 'interrupted', unknownOutcome: true };
};

const asSubject = (subject: unknown): Subject | null => {
  if (!subject || typeof subject !== 'object') return null;
  if ('system' in subject && (subject as { system?: boolean }).system === true) return subject as Subject;
  if ('user' in subject && (subject as { user?: { id?: string } }).user?.id) return subject as Subject;
  return null;
};

/**
 * 当前规范项目：任务会话以任务的项目为准；无任务容器会话只认出生时写死的 originProjectId。
 * 任务和 origin 冲突、任务 / 项目缺失、无任务又没有 origin，都失败关闭（null）。
 * 不从这里反推工作空间或组——那些来源可能已经被改过。
 */
const canonicalProject = async (deps: AgentObserveDeps, session: Session): Promise<Project | null> => {
  if (session.taskId !== null) {
    const task = await deps.tasks.byId(session.taskId);
    if (!task) return null;
    const project = await deps.projects.byId(task.projectId);
    if (!project) return null;
    if (session.originProjectId && session.originProjectId !== project.id) return null;
    return project;
  }
  if (session.originProjectId) return deps.projects.byId(session.originProjectId);
  return null;
};

export function createAgentObserveReader(deps: AgentObserveDeps): ObserveReader {
  /** 只把当前项目、会话都还能读的行交出去；不区分「不存在」和「不能看」。 */
  const authorizedRow = async (row: AgentTurnRecord, subject: Subject): Promise<{ session: Session; project: Project } | null> => {
    if (!validRecord(row)) return null;
    const session = await deps.sessions.byId(row.sessionId as SessionId);
    if (!session) return null;
    const project = await canonicalProject(deps, session);
    if (!project || project.id !== row.projectId) return null;
    const allowed = await authorizeSession(deps.policy, subject, project, session, 'session.read');
    return allowed.ok ? { session, project } : null;
  };

  const readableProjectIds = async (subject: Subject, explicit: string | null): Promise<string[]> => {
    const reader = await projectReader(deps.policy, subject);
    if (explicit) {
      const project = await deps.projects.byId(explicit as ProjectId);
      return project && reader(project) ? [project.id] : [];
    }
    return (await deps.projects.list()).filter(reader).map((project) => project.id);
  };

  const exactEnd = async (row: ValidTurnRecord): Promise<AgentTurnEnd | null> =>
    row.seq > 0 ? validEnd(await deps.records.ended(row.sessionId, row.id, row.seq), row.seq) : null;

  return {
    id: 'agent',
    async list(query: ObserveListQuery, subject: unknown): Promise<ObserveList> {
      if (query.source && query.source !== 'agent') return { truncated: false, items: [] };
      const actor = asSubject(subject);
      // 匿名不查项目、不查存储：不把「没登录」伪装成空数据。
      if (!actor) return { truncated: false, items: [] };
      const projectIds = await readableProjectIds(actor, query.projectId);
      if (projectIds.length === 0) return { truncated: false, scanLimit: AGENT_SCAN, items: [] };
      const scanned = await deps.records.list({ projectIds, since: query.since, limit: AGENT_SCAN + 1 });
      const truncatedScan = scanned.length > AGENT_SCAN;
      const rows = scanned.slice(0, AGENT_SCAN);
      const items: ObserveListItem[] = [];
      const limit = Math.max(1, query.limit);
      for (const row of rows) {
        // 原始列先验形状，再谈项目 / 会话 / 标签。
        if (!validRecord(row)) continue;
        if (!projectIds.includes(row.projectId)) continue;
        if (!(await authorizedRow(row, actor))) continue;
        // 必须先授权再读精确回执；送达状态和结果各自独立。
        const ended = await exactEnd(row);
        const gap = ended?.unknownOutcome ? '结果未知'
          : ended?.outcome === 'failed' ? '回合失败'
          : ended?.outcome === 'interrupted' ? '回合中断'
          : row.state === 'undelivered' ? '未送达'
          : row.state === 'delivered' && !ended ? '未记录精确结果'
          : null;
        if (query.needsLook && gap === null) continue;
        items.push({
          id: `agent:${row.id}`,
          source: 'agent',
          title: 'Agent 回合',
          projectId: row.projectId,
          at: row.createdAt,
          nativeState: row.state,
          nativeStateLabel: DELIVERY_LABEL[row.state],
          gap
        });
        if (items.length > limit) break;
      }
      return { truncated: truncatedScan || items.length > limit, scanLimit: AGENT_SCAN, items: items.slice(0, limit) };
    },
    async get(nativeId: string, subject: unknown): Promise<ObserveTrace | null> {
      const actor = asSubject(subject);
      if (!actor) return null;
      const row = await deps.records.byId(nativeId);
      if (!validRecord(row)) return null;
      const access = await authorizedRow(row, actor);
      if (!access) return null;
      // held（seq 0）不是一轮 prompt，不能拿第一条 ended 冒充它的结果。
      const ended = await exactEnd(row);
      const promptActor = row.seq > 0 ? await deps.records.promptActor(row.sessionId, row.seq) : null;
      const output = row.seq > 0 && (row.state === 'sending' || row.state === 'delivered')
        ? await deps.records.firstOutput(row.sessionId, row.id, row.seq, ended?.seq ?? null) : null;
      const firstOutput = output && Number.isSafeInteger(output.seq) && output.seq > row.seq &&
        Number.isSafeInteger(output.at) && output.at >= row.createdAt && output.at <= 8_640_000_000_000_000 &&
        (!ended || (output.seq < ended.seq && output.at <= ended.at)) ? output : null;
      return traceFor(row, access.project, ended, promptActor, firstOutput);
    }
  };
}

function traceFor(row: ValidTurnRecord, project: Project, ended: AgentTurnEnd | null, promptActor: unknown, firstOutput: { seq: number; at: number } | null): ObserveTrace {
  const headId = `turn:${row.id}`;
  const endId = `end:${row.id}`;
  const outputId = `output:${row.id}`;
  const links: ObserveLink[] = [
    ...(firstOutput ? [{ to: outputId, label: '同一送达的首条输出' }] : []),
    ...(ended ? [{ to: endId, label: ended.unknownOutcome ? '同一送达的待确认记录' : 'deliveryId 对得上的结束' }] : [])
  ];
  const root: ObserveNode = {
    id: headId,
    name: 'Agent 回合',
    kind: 'turn',
    state: row.state,
    stateLabel: DELIVERY_LABEL[row.state],
    // createdAt 只是入队时间，不是回合开始；未知记录也不证明结束。
    startedAt: null,
    endedAt: ended && !ended.unknownOutcome ? ended.at : null,
    // 没有准确的回合开始，就不编耗时。
    durationMs: null,
    durationLabel: null,
    parentId: null,
    links,
    attrs: [
      { key: '序号', value: String(row.seq) },
      { key: '尝试', value: String(row.attempt) },
      { key: '当前状态', value: DELIVERY_LABEL[row.state] },
      { key: '发起类别', value: actorLabel(promptActor) },
      { key: '首条输出', value: firstOutput ? '已记录' : '未记录' },
      ...(!ended && row.state !== 'delivered' ? [{ key: '结果', value: pendingNote(row.state) }] : []),
      // 过了 ACL 才给会话跳转所需的字段；没权限时整条 trace 都不会返回。
      { key: '会话', value: row.sessionId },
      { key: '项目', value: project.id }
    ]
  };
  const nodes: ObserveNode[] = [root];
  if (firstOutput) nodes.push({
    id: outputId, name: '首条输出', kind: 'first_output', state: 'observed', stateLabel: '已记录',
    startedAt: null, endedAt: firstOutput.at, durationMs: null, durationLabel: null, parentId: null, links: [],
    attrs: [{ key: '输出 seq', value: String(firstOutput.seq) }, { key: '时间口径', value: 'Hub 收到输出的时间，不是模型首字耗时' }]
  });
  if (ended) {
    nodes.push({
      id: endId,
      name: '回合结果',
      kind: 'turn_end',
      state: ended.unknownOutcome ? 'unknown' : ended.outcome,
      stateLabel: ended.unknownOutcome ? '结果未知' : OUTCOME_LABEL[ended.outcome],
      startedAt: null,
      endedAt: ended.unknownOutcome ? null : ended.at,
      durationMs: null,
      durationLabel: null,
      parentId: null,
      links: [],
      attrs: [
        { key: ended.unknownOutcome ? '记录 seq' : '结束 seq', value: String(ended.seq) },
        ...(ended.unknownOutcome ? [{ key: '说明', value: '结果未知，不当作成功或失败' }] : [])
      ]
    });
  } else if (row.state === 'delivered') {
    nodes.push({
      id: `sink:${row.id}`,
      name: '回合结果',
      kind: 'sink',
      state: null,
      stateLabel: null,
      startedAt: null,
      endedAt: null,
      durationMs: null,
      durationLabel: null,
      parentId: null,
      links: [],
      attrs: [{ key: '说明', value: pendingNote(row.state) }]
    });
  }
  return {
    id: `agent:${row.id}`,
    source: 'agent',
    headId,
    title: 'Agent 回合',
    projectId: row.projectId,
    externalUrl: null,
    nodes
  };
}
