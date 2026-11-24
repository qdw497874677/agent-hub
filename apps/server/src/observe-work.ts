import { authorizeProject, authorizeSession, type AccessPolicy, type Deps, type Project, type ProjectId, type SessionId, type Subject, type TaskId } from '@agent-hub/domain';
import type { ObserveList, ObserveListItem, ObserveListQuery, ObserveReader, ObserveTrace } from '@agent-hub/observe';
import { humanOf } from './http-helpers.ts';

export type WorkObserveKind = 'dispatch' | 'delegation';
export interface WorkObserveRecord {
  readonly id: string;
  readonly accountId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly sessionId: string | null;
  readonly state: string;
  readonly createdAt: number;
  readonly notified: boolean | null;
}
type Awaitable<T> = T | Promise<T>;
export interface WorkObserveRecords {
  list(kind: WorkObserveKind, input: { readonly accountId: string; readonly projectIds: readonly string[]; readonly since: number; readonly limit: number }): Awaitable<readonly WorkObserveRecord[]>;
  byId(kind: WorkObserveKind, id: string, accountId: string): Awaitable<WorkObserveRecord | null>;
}
export interface WorkObserveDeps {
  readonly records: WorkObserveRecords;
  readonly projects: Pick<Deps['projects'], 'list' | 'byId'>;
  readonly tasks: Pick<Deps['tasks'], 'byId'>;
  readonly sessions: Pick<Deps['sessions'], 'byId'>;
  readonly policy?: AccessPolicy;
}
export const WORK_OBSERVE_SCAN = 500;
const labels: Record<WorkObserveKind, Readonly<Record<string, string>>> = {
  dispatch: { queued: '排队', running: '调度中', done: '已完成', failed: '失败', cancelled: '已取消' },
  delegation: { pending: '待准备', preparing: '准备中', prepared: '已准备', failed: '准备失败', uncertain: '结果不确定', cancelled: '已取消' }
};
const actorOf = (subject: unknown): { subject: Subject; accountId: string } | null => {
  if (!subject || typeof subject !== 'object' || !('user' in subject)) return null;
  const id = (subject as { user?: { id?: unknown } }).user?.id;
  return typeof id === 'string' && id.length > 0 ? { subject: subject as Subject, accountId: id } : null;
};
const valid = (kind: WorkObserveKind, row: WorkObserveRecord | null | undefined): row is WorkObserveRecord => !!row &&
  [row.id, row.accountId, row.projectId, row.taskId].every((v) => typeof v === 'string' && v.length > 0) &&
  (row.sessionId === null || (typeof row.sessionId === 'string' && row.sessionId.length > 0)) &&
  typeof row.state === 'string' && Object.hasOwn(labels[kind], row.state) &&
  Number.isSafeInteger(row.createdAt) && row.createdAt >= 0 && row.createdAt <= 8_640_000_000_000_000 &&
  (kind === 'dispatch' ? typeof row.notified === 'boolean' : row.notified === null);

export function createWorkObserveReaders(deps: WorkObserveDeps): readonly ObserveReader[] {
  return (['dispatch', 'delegation'] as const).map((kind): ObserveReader => {
    const title = kind === 'dispatch' ? '任务调度' : '工作空间派工';
    const gap = (state: string): string | null => state === 'uncertain' ? '结果不确定' : state === 'failed' ? '失败' : null;
    const access = async (row: WorkObserveRecord, subject: Subject, accountId: string): Promise<Project | null> => {
      if (!valid(kind, row) || row.accountId !== accountId) return null;
      const [task, project] = await Promise.all([
        deps.tasks.byId(row.taskId as TaskId), deps.projects.byId(row.projectId as ProjectId)
      ]);
      if (!task || task.id !== row.taskId || task.projectId !== row.projectId || !project || project.id !== row.projectId) return null;
      return (await authorizeProject(deps.policy, subject, project, 'task.read')).ok ? project : null;
    };
    const trace = async (row: WorkObserveRecord, project: Project, subject: Subject): Promise<ObserveTrace> => {
      let sessionId: string | null = null;
      if (row.sessionId) {
        try {
          const session = await deps.sessions.byId(row.sessionId as SessionId);
          // Match workspace-delegation.ts executionSessionExistsFor: the owner must be
          // a cookie-authenticated human and the reserved session must be their root task session.
          const human = kind === 'delegation' ? humanOf(subject) : null;
          const delegationIdentity = kind !== 'delegation' || (human?.user.id === row.accountId &&
            session?.createdBy === row.accountId && session.botId == null &&
            session.parentSessionId == null && session.kind !== 'side');
          if (session && session.id === row.sessionId && session.taskId === row.taskId && delegationIdentity &&
              (session.originProjectId == null || session.originProjectId === project.id) &&
              (await authorizeSession(deps.policy, subject, project, session, 'session.read')).ok) sessionId = session.id;
        } catch {
          // A missing or unreadable session only hides the link, never the authorized work trace.
        }
      }
      const headId = `${kind}:${row.id}`;
      return { id: headId, source: kind, headId, title, projectId: project.id, externalUrl: null, nodes: [{
        id: headId, name: title, kind, state: row.state, stateLabel: labels[kind][row.state]!,
        startedAt: null, endedAt: null, durationMs: null, durationLabel: null, parentId: null, links: [],
        attrs: [
          { key: '项目', value: project.id },
          ...(sessionId ? [{ key: '会话', value: sessionId }] : []),
          ...(kind === 'dispatch' ? [{ key: '通知', value: row.notified ? '通知标记已置位（不代表收到或已发送）' : '通知标记未置位' }] : [{ key: '说明', value: row.state === 'uncertain' ? '结果不确定' : '准备状态不代表 Agent 已完成' }])
        ]
      }] };
    };
    return {
      id: kind,
      async list(query: ObserveListQuery, subject: unknown): Promise<ObserveList> {
        const actor = actorOf(subject);
        if (!actor || (query.source && query.source !== kind)) return { items: [], truncated: false };
        const projects = query.projectId ? [await deps.projects.byId(query.projectId as ProjectId)] : await deps.projects.list();
        const decisions = await Promise.all(projects.map((p) => authorizeProject(deps.policy, actor.subject, p, 'task.read')));
        const scope = new Set<string>(decisions.flatMap((decision) => decision.ok ? [decision.value.id] : []));
        if (scope.size === 0) return { items: [], truncated: false, scanLimit: WORK_OBSERVE_SCAN };
        const rows = await deps.records.list(kind, { accountId: actor.accountId, projectIds: [...scope], since: query.since, limit: WORK_OBSERVE_SCAN + 1 });
        const items: ObserveListItem[] = [];
        const limit = Math.max(1, query.limit);
        for (const row of rows.slice(0, WORK_OBSERVE_SCAN)) {
          if (!valid(kind, row) || !scope.has(row.projectId) || row.createdAt < query.since || !(await access(row, actor.subject, actor.accountId))) continue;
          const problem = gap(row.state);
          if (query.needsLook && !problem) continue;
          items.push({ id: `${kind}:${row.id}`, source: kind, title, projectId: row.projectId, at: row.createdAt, nativeState: row.state, nativeStateLabel: labels[kind][row.state]!, gap: problem });
          if (items.length > limit) break;
        }
        return { items: items.slice(0, limit), truncated: rows.length > WORK_OBSERVE_SCAN || items.length > limit, scanLimit: WORK_OBSERVE_SCAN };
      },
      async get(id: string, subject: unknown): Promise<ObserveTrace | null> {
        const actor = actorOf(subject);
        if (!actor) return null;
        const row = await deps.records.byId(kind, id, actor.accountId);
        if (!valid(kind, row) || row.id !== id) return null;
        const project = await access(row, actor.subject, actor.accountId);
        return project ? trace(row, project, actor.subject) : null;
      }
    };
  });
}
