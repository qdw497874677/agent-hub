import { authorizeSession, HANDOFF_BUS_ORIGIN, projectReader, type AccessPolicy, type Deps, type Project, type ProjectId, type Session, type SessionId, type Subject } from '@agent-hub/domain';
import type { ObserveList, ObserveListItem, ObserveListQuery, ObserveNode, ObserveReader, ObserveTrace } from '@agent-hub/observe';

export interface MessageObserveRecord {
  readonly id: string;
  readonly projectId: string;
  readonly fromSessionId: string;
  readonly targetSessionId: string;
  readonly replyTo: string | null;
  readonly state: string;
  readonly createdAt: number;
  readonly deliveredAt: number | null;
  readonly readAt: number | null;
  readonly handoffOrigin: string | null;
}
type Awaitable<T> = T | Promise<T>;
export interface MessageObserveRecords {
  list(input: { readonly projectIds: readonly string[]; readonly since: number; readonly limit: number }): Awaitable<readonly MessageObserveRecord[]>;
  byId(id: string): Awaitable<MessageObserveRecord | null>;
}
export interface MessageObserveDeps {
  readonly projects: Pick<Deps['projects'], 'list' | 'byId'>;
  readonly tasks: Pick<Deps['tasks'], 'byId'>;
  readonly sessions: Pick<Deps['sessions'], 'byId'>;
  readonly records: MessageObserveRecords;
  readonly policy?: AccessPolicy;
}
export const MESSAGE_OBSERVE_SCAN = 500;
const labels: Readonly<Record<string, string>> = { queued: '排队', awaiting_approval: '等待审批', held: '挂起', delivered: '已投递', answered: '已回复', done: '消息流程已结束', failed: '失败', denied: '已拒绝' };
const timestamp = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 8_640_000_000_000_000;
const valid = (r: MessageObserveRecord | null | undefined): r is MessageObserveRecord => !!r &&
  [r.id, r.projectId, r.fromSessionId, r.targetSessionId].every((v) => typeof v === 'string' && v.length > 0) &&
  !r.fromSessionId.startsWith('external:') && !r.targetSessionId.startsWith('external:') &&
  (r.replyTo === null || (typeof r.replyTo === 'string' && r.replyTo.length > 0)) &&
  typeof r.state === 'string' && Object.hasOwn(labels, r.state) && timestamp(r.createdAt) &&
  (r.deliveredAt === null || timestamp(r.deliveredAt)) && (r.readAt === null || timestamp(r.readAt));
const asSubject = (value: unknown): Subject | null => {
  if (!value || typeof value !== 'object') return null;
  if ('system' in value && (value as { system?: boolean }).system === true) return value as Subject;
  if ('user' in value && (value as { user?: { id?: string } }).user?.id) return value as Subject;
  return null;
};

export function createMessageObserveReader(deps: MessageObserveDeps): ObserveReader {
  const endpoint = async (id: string, project: Project, subject: Subject): Promise<boolean> => {
    const session: Session | null = await deps.sessions.byId(id as SessionId);
    if (!session || session.id !== id) return false;
    if (session.taskId != null) {
      const task = await deps.tasks.byId(session.taskId);
      if (!task || task.id !== session.taskId || task.projectId !== project.id || (session.originProjectId != null && session.originProjectId !== project.id)) return false;
    } else if (session.originProjectId !== project.id) return false;
    return (await authorizeSession(deps.policy, subject, project, session, 'session.read')).ok;
  };
  const access = async (row: MessageObserveRecord, subject: Subject): Promise<Project | null> => {
    if (!valid(row)) return null;
    const project = await deps.projects.byId(row.projectId as ProjectId);
    if (!project || project.id !== row.projectId || project.deletedAt != null) return null;
    const [from, target] = await Promise.all([endpoint(row.fromSessionId, project, subject), endpoint(row.targetSessionId, project, subject)]);
    return from && target ? project : null;
  };
  const node = (row: MessageObserveRecord): ObserveNode => ({
    id: `message:${row.id}`, name: '会话消息', kind: 'message', state: row.state, stateLabel: labels[row.state]!,
    startedAt: null, endedAt: null, durationMs: null, durationLabel: null, parentId: null, links: [],
    attrs: [
      { key: '发送会话', value: row.fromSessionId }, { key: '目标会话', value: row.targetSessionId },
      { key: '创建时间', value: new Date(row.createdAt).toISOString() },
      ...(row.deliveredAt === null ? [] : [{ key: '消息记录的投递时间', value: new Date(row.deliveredAt).toISOString() }]),
      ...(row.readAt === null ? [] : [{ key: '消息记录的读取时间', value: new Date(row.readAt).toISOString() }]),
      ...(row.handoffOrigin === HANDOFF_BUS_ORIGIN ? [{ key: '来源', value: '项目交接' }] : [])
    ]
  });
  return {
    id: 'message',
    async list(query: ObserveListQuery, subject: unknown): Promise<ObserveList> {
      const actor = asSubject(subject);
      if (!actor || (query.source && query.source !== 'message')) return { items: [], truncated: false };
      const canRead = await projectReader(deps.policy, actor);
      const projects = query.projectId ? [await deps.projects.byId(query.projectId as ProjectId)] : await deps.projects.list();
      const scope = new Set(projects.filter((p): p is Project => !!p && p.deletedAt == null && canRead(p)).map((p) => p.id));
      if (!scope.size) return { items: [], truncated: false, scanLimit: MESSAGE_OBSERVE_SCAN };
      const rows = await deps.records.list({ projectIds: [...scope], since: query.since, limit: MESSAGE_OBSERVE_SCAN + 1 });
      const items: ObserveListItem[] = [];
      const limit = Math.max(1, query.limit);
      for (const row of rows.slice(0, MESSAGE_OBSERVE_SCAN)) {
        if (!valid(row) || !scope.has(row.projectId as ProjectId) || row.createdAt < query.since || !(await access(row, actor))) continue;
        const gap = row.state === 'failed' ? '失败' : row.state === 'denied' ? '已拒绝' : row.state === 'held' ? '挂起' : null;
        if (query.needsLook && !gap) continue;
        items.push({ id: `message:${row.id}`, source: 'message', title: '会话消息', projectId: row.projectId, at: row.createdAt, nativeState: row.state, nativeStateLabel: labels[row.state]!, gap });
        if (items.length > limit) break;
      }
      return { items: items.slice(0, limit), truncated: rows.length > MESSAGE_OBSERVE_SCAN || items.length > limit, scanLimit: MESSAGE_OBSERVE_SCAN };
    },
    async get(id: string, subject: unknown): Promise<ObserveTrace | null> {
      const actor = asSubject(subject);
      if (!actor) return null;
      const row = await deps.records.byId(id);
      if (!valid(row) || row.id !== id) return null;
      const project = await access(row, actor);
      if (!project) return null;
      const root = node(row);
      const nodes: ObserveNode[] = [root];
      if (row.replyTo && row.replyTo !== row.id) {
        const related = await deps.records.byId(row.replyTo);
        if (valid(related) && related.id === row.replyTo && related.projectId === row.projectId && await access(related, actor)) {
          nodes[0] = { ...root, links: [{ to: `message:${related.id}`, label: '回复此消息' }] };
          nodes.push(node(related));
        }
      }
      return { id: `message:${row.id}`, source: 'message', headId: root.id, title: '会话消息', projectId: project.id, externalUrl: null, nodes };
    }
  };
}
