import { durationBetween, type ObserveList, type ObserveListItem, type ObserveListQuery, type ObserveNode, type ObserveReader, type ObserveTrace } from '@agent-hub/observe';
import {
  authorizeProject,
  dayStart,
  principalOfSubject,
  TASK_STATUS_LABEL,
  type AccessPolicy,
  type AgentTaskRequest,
  type AgentTaskStore,
  type ConnectorBinding,
  type ConnectorStore,
  type Delivery,
  type DeliveryQueue,
  type Subject,
  type ProjectId,
  type Session,
  type SessionId,
  type TaskDispatch,
  type TaskDispatchStore,
  type TaskId,
  type TriggerRun
} from '@agent-hub/domain';
import type { Deps } from '@agent-hub/domain';

/** 送达行比运行写成 delivered 略晚才插入，窗口多留一分钟。这不是外键。 */
const DELIVERY_SLACK_MS = 60_000;
/** 时间窗里先取这么多条再筛，避免一次读光。多出来的记 truncated。 */
const SCAN = 500;
const QUOTA_CAP = 20;

const TRIGGER_LABEL: Record<TriggerRun['state'], string> = {
  waiting: '等待中', delivered: '已交给回合', done: '回合结束', failed: '回合失败', timeout: '超时', skipped: '跳过'
};
const SESSION_LABEL: Record<Session['status'], string> = {
  running: '运行中', stopped: '已停止', done: '完成', interrupted: '中断', failed: '失败'
};
const DISPATCH_LABEL: Record<TaskDispatch['state'], string> = {
  queued: '排队', running: '运行中', done: '完成', failed: '失败', cancelled: '已取消'
};
const DELIVERY_LABEL: Record<Delivery['state'], string> = {
  queued: '排队', sending: '发送中', delivered: '已送达', undelivered: '未送达', cancelled: '已撤回', held: '挂起'
};

export interface ConnectorObserveDeps {
  readonly now: () => number;
  readonly projects: Deps['projects'];
  readonly sessions: Deps['sessions'];
  readonly tasks: Deps['tasks'];
  readonly deliveries: DeliveryQueue;
  readonly store: ConnectorStore;
  readonly requests: AgentTaskStore;
  readonly dispatches: TaskDispatchStore;
  readonly policy?: AccessPolicy;
}

const asSubject = (subject: unknown): Subject | null => {
  if (!subject || typeof subject !== 'object') return null;
  if ('system' in subject && (subject as { system?: boolean }).system === true) return subject as Subject;
  if ('user' in subject && (subject as { user?: { id?: string } }).user?.id) return subject as Subject;
  return null;
};

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max)}…` : value);

const firstLine = (value: string | null) => {
  const line = (value ?? '').split('\n')[0] ?? '';
  return line ? clip(line, 80) : null;
};

/** 业务上要看的。回写未记录和送达无外键不算，否则几乎每行都中。 */
export function connectorGap(run: TriggerRun, requests: readonly AgentTaskRequest[], dispatches: readonly TaskDispatch[]): string | null {
  if (run.state === 'failed' || run.state === 'timeout') return run.reason ?? TRIGGER_LABEL[run.state];
  if (run.state === 'skipped' && (run.reason?.startsWith('疑似注入') || run.reason?.startsWith('轮询失败'))) return run.reason;
  if (dispatches.some((item) => item.state === 'failed')) return '调度失败';
  if (requests.some((item) => item.approval === 'pending')) return '待批准';
  return null;
}

export function createConnectorObserveReader(deps: ConnectorObserveDeps): ObserveReader {
  const canRead = async (projectId: string, subject: unknown) => {
    const project = await deps.projects.byId(projectId as ProjectId);
    const allowed = await authorizeProject(deps.policy, asSubject(subject), project, 'project.read');
    return allowed.ok;
  };
  const visibleBindings = async (subject: unknown, projectId: string | null) => {
    const all = await deps.store.allBindings();
    const out: ConnectorBinding[] = [];
    for (const binding of all) {
      if (projectId && binding.agentProjectId !== projectId && binding.projectId !== projectId) continue;
      if (await canRead(binding.agentProjectId, subject)) out.push(binding);
    }
    return out;
  };
  const related = async (runs: readonly TriggerRun[], subject: unknown) => {
    const requests = (await deps.requests.byWakeKeys(runs.map((run) => run.id))).filter((item) => item.wakeKey !== null);
    const visibleRequests: AgentTaskRequest[] = [];
    for (const request of requests) if (await canRead(request.projectId, subject)) visibleRequests.push(request);
    const dispatches = await deps.dispatches.byTaskIds(visibleRequests.flatMap((item) => item.taskId ? [item.taskId] : []));
    const visibleDispatches: TaskDispatch[] = [];
    for (const item of dispatches) if (await canRead(item.projectId, subject)) visibleDispatches.push(item);
    return { requests: visibleRequests, dispatches: visibleDispatches };
  };

  return {
    id: 'connector',
    async list(query: ObserveListQuery, subject: unknown): Promise<ObserveList> {
      if (query.source && query.source !== 'connector') return { truncated: false, items: [] };
      const bindings = await visibleBindings(subject, query.projectId);
      const byId = new Map(bindings.map((binding) => [binding.id, binding]));
      const scanned = await deps.store.runsSince([...byId.keys()], query.since, SCAN + 1);
      const truncatedScan = scanned.length > SCAN;
      const runs = scanned.slice(0, SCAN);
      const { requests, dispatches } = await related(runs, subject);
      const requestsOf = (runId: string) => requests.filter((item) => item.wakeKey === runId);
      const dispatchesOf = (rows: readonly AgentTaskRequest[]) => {
        const ids = new Set(rows.flatMap((item) => item.taskId ? [item.taskId] : []));
        return dispatches.filter((item) => ids.has(item.taskId));
      };
      const items: ObserveListItem[] = [];
      for (const run of runs) {
        const binding = byId.get(run.bindingId);
        if (!binding) continue;
        const mine = requestsOf(run.id);
        const gap = connectorGap(run, mine, dispatchesOf(mine));
        if (query.needsLook && gap === null) continue;
        items.push({
          id: `connector:${run.id}`,
          source: 'connector',
          title: binding.name,
          projectId: binding.agentProjectId,
          at: run.createdAt,
          nativeState: run.state,
          nativeStateLabel: TRIGGER_LABEL[run.state],
          gap
        });
      }
      const limit = Math.max(1, query.limit);
      return { truncated: truncatedScan || items.length > limit, scanLimit: SCAN, items: items.slice(0, limit) };
    },
    async get(nativeId: string, subject: unknown): Promise<ObserveTrace | null> {
      const run = await deps.store.run(nativeId);
      if (!run) return null;
      const binding = await deps.store.binding(run.bindingId);
      if (!binding || !(await canRead(binding.agentProjectId, subject))) return null;
      const { requests, dispatches } = await related([run], subject);
      const visibleRequests = requests.filter((item) => item.wakeKey === run.id);
      const taskIds = new Set(visibleRequests.flatMap((item) => item.taskId ? [item.taskId] : []));
      const nodes = await nodesFor(deps, subject, binding, run, visibleRequests, dispatches.filter((item) => taskIds.has(item.taskId)));
      const headId = `trigger:${run.id}`;
      return {
        id: `connector:${run.id}`,
        source: 'connector',
        headId,
        title: binding.name,
        projectId: binding.agentProjectId,
        externalUrl: null,
        nodes
      };
    }
  };
}

async function nodesFor(
  deps: ConnectorObserveDeps,
  subject: unknown,
  binding: ConnectorBinding,
  run: TriggerRun,
  requests: readonly AgentTaskRequest[],
  dispatches: readonly TaskDispatch[]
): Promise<ObserveNode[]> {
  const triggerId = `trigger:${run.id}`;
  const links: { to: string; label: string }[] = [];
  const nodes: ObserveNode[] = [];
  const span = durationBetween(run.createdAt, run.updatedAt);
  const actor = principalOfSubject(asSubject(subject));
  const quota = actor && actor.user.id === binding.createdBy
    ? `${await deps.requests.countSince(actor.user.id, dayStart(deps.now(), binding.timeZone))}/${QUOTA_CAP}`
    : null;
  if (run.sessionId) links.push({ to: `session:${run.sessionId}`, label: '投递到此会话' });
  for (const request of requests) links.push({ to: `request:${request.id}`, label: '由这次唤醒建下' });
  nodes.push({
    id: triggerId,
    name: binding.name,
    kind: 'trigger',
    state: run.state,
    stateLabel: TRIGGER_LABEL[run.state],
    startedAt: run.createdAt,
    endedAt: run.updatedAt,
    durationMs: span,
    durationLabel: span === null ? null : '记录跨度',
    parentId: null,
    links,
    attrs: [
      { key: '连接器', value: binding.connector },
      { key: 'externalId', value: run.externalId },
      { key: '补跑', value: run.catchup ? '是' : '否' },
      { key: 'reason', value: run.reason ?? '空' },
      { key: '连续失败', value: String(binding.consecutiveFailures) },
      { key: '定义项目', value: binding.agentProjectId },
      ...(quota ? [{ key: '今日已计入', value: `${quota} · ${binding.timeZone}` }] : [])
    ]
  });
  if (run.sessionId) nodes.push(await sessionNode(deps, run.sessionId, binding.agentProjectId));
  for (const request of requests) {
    const requestLinks = request.taskId ? [{ to: `task:${request.taskId}`, label: 'request.taskId' }] : [];
    nodes.push({
      id: `request:${request.id}`,
      name: request.title,
      kind: 'task_request',
      state: request.approval,
      stateLabel: request.approval,
      startedAt: request.createdAt,
      endedAt: null,
      durationMs: null,
      durationLabel: null,
      parentId: null,
      links: requestLinks,
      attrs: [
        { key: 'wakeKey', value: request.wakeKey ?? '' },
        { key: '来源键', value: request.originExternalId ?? '空' },
        { key: 'counted', value: request.counted ? '是' : '否' },
        { key: '项目', value: request.projectId }
      ]
    });
    if (!request.taskId) continue;
    const task = await deps.tasks.byId(request.taskId as TaskId).catch(() => null);
    if (!task) continue;
    const job = dispatches.find((item) => item.taskId === request.taskId) ?? null;
    nodes.push({
      id: `task:${task.id}`,
      name: task.title,
      kind: 'task',
      state: task.status,
      stateLabel: TASK_STATUS_LABEL[task.status],
      startedAt: null,
      endedAt: null,
      durationMs: null,
      durationLabel: null,
      parentId: null,
      links: job ? [{ to: `dispatch:${job.id}`, label: 'task_dispatch.taskId' }] : [],
      attrs: [{ key: '项目', value: task.projectId }]
    });
    if (!job) continue;
    const jobLinks = [];
    if (job.sessionId) jobLinks.push({ to: `session:${job.sessionId}`, label: 'dispatch.sessionId' });
    if (job.notifySessionId) jobLinks.push({ to: `session:${job.notifySessionId}`, label: '已尝试通知' });
    const occupied = durationBetween(job.startedAt, job.state === 'queued' ? null : job.updatedAt);
    nodes.push({
      id: `dispatch:${job.id}`,
      name: job.title,
      kind: 'dispatch',
      state: job.state,
      stateLabel: DISPATCH_LABEL[job.state],
      startedAt: job.startedAt,
      endedAt: job.state === 'queued' ? null : job.updatedAt,
      durationMs: occupied,
      durationLabel: occupied === null ? null : '调度占用',
      parentId: null,
      links: jobLinks,
      attrs: [
        { key: 'waitReason', value: job.waitReason ?? '空' },
        { key: 'human', value: job.human ? '是' : '否' },
        { key: '通知', value: job.notified ? '已尝试通知' : '等 bot 空下来再通知' },
        { key: '结果', value: firstLine(job.result) ?? '空' },
        { key: '项目', value: job.projectId }
      ]
    });
    if (job.sessionId && job.sessionId !== run.sessionId) nodes.push(await sessionNode(deps, job.sessionId, job.projectId));
  }
  nodes.push(...await deliveryNodes(deps, run));
  nodes.push({
    id: `sink:${run.id}`,
    name: '回写',
    kind: 'sink',
    state: null,
    stateLabel: null,
    startedAt: null,
    endedAt: null,
    durationMs: null,
    durationLabel: null,
    parentId: null,
    links: [],
    attrs: [{ key: '说明', value: '未记录' }]
  });
  return nodes;
}

async function sessionNode(deps: ConnectorObserveDeps, sessionId: string, projectId: string): Promise<ObserveNode> {
  const session = await deps.sessions.byId(sessionId as SessionId).catch(() => null);
  const ready = session?.status === 'running' && session.lastSeq === 0;
  return {
    id: `session:${sessionId}`,
    name: ready ? '就绪的会话' : '会话',
    kind: 'session',
    state: session?.status ?? null,
    stateLabel: session ? (ready ? '就绪' : SESSION_LABEL[session.status]) : '不在库里',
    startedAt: null,
    endedAt: null,
    durationMs: null,
    durationLabel: null,
    parentId: null,
    links: [],
    attrs: [
      { key: '会话', value: sessionId },
      { key: '项目', value: projectId }
    ]
  };
}

async function deliveryNodes(deps: ConnectorObserveDeps, run: TriggerRun): Promise<ObserveNode[]> {
  if (!run.sessionId) return [];
  let rows: Delivery[];
  try {
    rows = await deps.deliveries.recent(run.sessionId, 80);
  } catch {
    return [{
      id: `delivery:error:${run.id}`,
      name: '会话送达',
      kind: 'delivery',
      state: null,
      stateLabel: null,
      startedAt: null,
      endedAt: null,
      durationMs: null,
      durationLabel: null,
      parentId: null,
      links: [],
      attrs: [{ key: '说明', value: '读取失败' }]
    }];
  }
  const end = run.updatedAt + DELIVERY_SLACK_MS;
  return rows.filter((row) => row.createdAt >= run.createdAt && row.createdAt <= end).map((row) => {
    const terminal = row.state === 'delivered' || row.state === 'undelivered' || row.state === 'cancelled';
    const span = terminal ? durationBetween(row.createdAt, row.updatedAt) : null;
    return {
      id: `delivery:${row.id}`,
      name: '会话送达',
      kind: 'delivery',
      state: row.state,
      stateLabel: DELIVERY_LABEL[row.state],
      startedAt: row.createdAt,
      endedAt: terminal ? row.updatedAt : null,
      durationMs: span,
      durationLabel: span === null ? null : '送达用时',
      parentId: null,
      links: [],
      attrs: [
        { key: 'kind', value: row.kind },
        { key: 'attempt', value: String(row.attempt) },
        { key: '说明', value: '无外键，只是时间窗里的候选' }
      ]
    };
  });
}
