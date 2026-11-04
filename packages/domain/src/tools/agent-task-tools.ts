import { dayStart } from '../connector.ts';
import { forbidden, invalid, notFound, type DomainError } from '../errors.ts';
import { newId, asTaskId, type ProjectId, type SessionId } from '../ids.ts';
import type { AgentTaskRequest, AgentTaskStore } from '../ports/agent-task-store.ts';
import type { ToolContext, ToolDescriptor, ToolProvider } from '../ports/tool-provider.ts';
import { err, ok, type Result } from '../result.ts';
import { createTaskUseCase, setTaskStatusUseCase } from '../use-cases/tasks.ts';
import type { Deps } from '../use-cases/deps.ts';

/** 「总管」档配额（ADR 0032 Q6）：只算连接器 / 触发唤醒的回合；人发起的回合默认不算（countHuman 可改）。 */
export const ROUTER_CAPS = { perWake: 3, perDay: 20 } as const;

export const AGENT_TASK_TOOLS: readonly ToolDescriptor[] = [
  {
    name: 'project.list', version: 1, scope: 'task:read',
    description: 'List the projects you may work in: your default project plus projects the user associated with you. Other projects are invisible to you.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'project.get', version: 1, scope: 'task:read',
    description: 'Get one associated project (name, git repo, markdown description). project = id or name; default = your default project.',
    inputSchema: { type: 'object', properties: { project: { type: 'string' } }, additionalProperties: false }
  },
  {
    name: 'task.list', version: 1, scope: 'task:read',
    description: 'List tasks in your associated projects (newest first), with status and sessions. Filter by project and/or status. mine=true lists only tasks you created with task.create (incl. ones waiting for human approval).',
    inputSchema: { type: 'object', properties: { project: { type: 'string' }, status: { type: 'string' }, mine: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false }
  },
  {
    name: 'task.create', version: 1, scope: 'task:create', perMinute: 10,
    description: 'Create a new task (title + goal) in your default project, or in another associated project. A human or task agent then works on it. If the task comes from an external item, pass source {connector, externalId}: the same item is never created twice. When woken by a trigger you may create at most 3 per wake and 20 per day; extra ones wait for human approval.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200 }, goal: { type: 'string', maxLength: 8000 }, project: { type: 'string' },
        source: { type: 'object', properties: { connector: { type: 'string' }, externalId: { type: 'string' } }, required: ['connector', 'externalId'] }
      },
      required: ['title'], additionalProperties: false
    }
  },
  {
    name: 'task.cancel', version: 1, scope: 'task:create',
    description: 'Cancel a task you created with task.create that nobody started yet (still todo), or one still waiting for approval. id = request id or task id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }
  }
];

export interface AgentTaskToolDeps extends Pick<Deps, 'now' | 'tasks' | 'projects' | 'sessions' | 'workLog'> {
  readonly requests: AgentTaskStore;
  /** 会话属于哪个 bot（定义它的项目 + @id）；不是 bot 会话是 null。 */
  readonly agentOf: (sessionId: SessionId) => Promise<{ projectId: string; name: string } | null>;
  /** bot 关联的项目（不含默认项目）。 */
  readonly associations: (projectId: string, name: string) => Promise<readonly string[]>;
  /** 这条会话当前是不是被触发唤醒的那一轮：是就给运行 id 和时区。 */
  readonly wakeOf: (sessionId: SessionId) => Promise<{ runId: string; timeZone: string } | null>;
  readonly countHuman?: boolean;
  readonly defaultTimeZone?: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export function createAgentTaskToolProvider(deps: AgentTaskToolDeps): ToolProvider {
  /** 能看见的项目：bot = 默认 + 关联；普通会话 = 本任务所在项目。第一个是默认。 */
  const scope = async (ctx: ToolContext) => {
    const session = await deps.sessions.byId(ctx.grant.sessionId);
    const agent = await deps.agentOf(ctx.grant.sessionId);
    if (agent) return { session, agent, ids: [agent.projectId, ...(await deps.associations(agent.projectId, agent.name)).filter((p) => p !== agent.projectId)] };
    const task = await deps.tasks.byId(ctx.grant.taskId);
    return { session, agent, ids: task ? [task.projectId as string] : [] };
  };
  const pick = async (ids: readonly string[], raw: unknown): Promise<Result<string, DomainError>> => {
    const want = str(raw);
    if (!want) return ids[0] ? ok(ids[0]) : err(notFound('没有可用的项目'));
    for (const id of ids) {
      const p = await deps.projects.byId(id as ProjectId);
      if (p && (p.id === want || p.name === want)) return ok(p.id);
    }
    return err(forbidden(`项目「${want}」没有关联给你（看不见也不能写），请让用户在 Bot 页关联`));
  };
  const reqView = (r: AgentTaskRequest) => ({ id: r.id, taskId: r.taskId, projectId: r.projectId, title: r.title, approval: r.approval, source: r.originConnector ? { connector: r.originConnector, externalId: r.originExternalId } : null, createdAt: r.createdAt });

  return {
    id: 'agent-task',
    tools: () => AGENT_TASK_TOOLS,
    async call(name, input, ctx): Promise<Result<unknown, DomainError>> {
      const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
      const { session, agent, ids } = await scope(ctx);
      switch (name) {
        case 'project.list': {
          const out = [];
          for (const id of ids) {
            const p = await deps.projects.byId(id as ProjectId);
            if (p) out.push({ id: p.id, name: p.name, repo: p.repo, default: id === ids[0] });
          }
          return ok({ projects: out });
        }
        case 'project.get': {
          const id = await pick(ids, args.project);
          if (!id.ok) return id;
          const p = await deps.projects.byId(id.value as ProjectId);
          return p ? ok({ id: p.id, name: p.name, repo: p.repo, description: p.description, default: p.id === ids[0] }) : err(notFound('项目不存在'));
        }
        case 'task.list': {
          const limit = typeof args.limit === 'number' ? Math.min(100, Math.max(1, Math.floor(args.limit))) : 30;
          if (args.mine === true) {
            const sessionIds = [ctx.grant.sessionId as string];
            return ok({ tasks: (await deps.requests.bySession(sessionIds, limit)).map(reqView) });
          }
          const which = str(args.project) ? await pick(ids, args.project) : null;
          if (which && !which.ok) return which;
          const out = [];
          for (const id of which ? [which.value] : ids) {
            for (const t of await deps.tasks.listByProject(id as ProjectId)) {
              if (str(args.status) && t.status !== str(args.status)) continue;
              const sessions = (await deps.sessions.listByTask(t.id)).map((s) => ({ id: s.id, agentId: s.agentId, status: s.status }));
              out.push({ id: t.id, projectId: id, title: t.title, status: t.status, summary: t.summary, updatedAt: t.updatedAt, sessions });
            }
          }
          out.sort((a, b) => b.updatedAt - a.updatedAt);
          return ok({ tasks: out.slice(0, limit) });
        }
        case 'task.create': {
          const title = str(args.title);
          if (!title) return err(invalid('title 必填'));
          const project = await pick(ids, args.project);
          if (!project.ok) return project;
          const src = args.source && typeof args.source === 'object' ? (args.source as Record<string, unknown>) : null;
          const connector = src ? str(src.connector) : '';
          const externalId = src ? str(src.externalId) : '';
          if (src && (!connector || !externalId)) return err(invalid('source 要有 connector 和 externalId'));
          const owner = session?.createdBy ?? null;
          if (!owner) return err(forbidden('这条会话没有主人，不能建任务'));
          const wake = await deps.wakeOf(ctx.grant.sessionId);
          const counted = wake !== null || deps.countHuman === true;
          const tz = wake?.timeZone ?? deps.defaultTimeZone ?? 'UTC';
          const wakeKey = wake?.runId ?? (counted ? `session:${ctx.grant.sessionId}` : null);
          let approval: AgentTaskRequest['approval'] = 'none';
          let reason = '';
          if (counted) {
            if (wakeKey && (await deps.requests.countWake(wakeKey)) >= ROUTER_CAPS.perWake) { approval = 'pending'; reason = `这次唤醒已建 ${ROUTER_CAPS.perWake} 个`; }
            else if ((await deps.requests.countSince(owner, dayStart(deps.now(), tz))) >= ROUTER_CAPS.perDay) { approval = 'pending'; reason = `今天已建 ${ROUTER_CAPS.perDay} 个`; }
          }
          const now = deps.now();
          const draft: AgentTaskRequest = {
            id: newId(), taskId: null, accountId: owner, agent: agent ? `${agent.projectId}/${agent.name}` : null, sessionId: ctx.grant.sessionId,
            projectId: project.value, title, goal: str(args.goal), originConnector: connector || null, originExternalId: externalId || null,
            wakeKey, counted: counted && approval === 'none', approval, createdAt: now, updatedAt: now
          };
          const saved = await deps.requests.insert(draft);
          if (saved.id !== draft.id) return ok({ ...reqView(saved), deduplicated: true, message: '这个来源的任务已经建过了，没有重复建' });
          if (approval === 'pending') return ok({ ...reqView(saved), message: `超出配额（${reason}），已交给人批准；批准后才会建任务` });
          const task = await createTaskUseCase(deps, { projectId: project.value, title, goal: draft.goal, ownerId: owner });
          if (!task.ok) { await deps.requests.save({ ...saved, approval: 'cancelled', counted: false, updatedAt: deps.now() }); return task; }
          await deps.requests.save({ ...saved, taskId: task.value.id, updatedAt: deps.now() });
          return ok({ ...reqView({ ...saved, taskId: task.value.id }), status: task.value.status });
        }
        case 'task.cancel': {
          const id = str(args.id);
          const mine = await deps.requests.bySession([ctx.grant.sessionId], 500);
          const r = mine.find((x) => x.id === id || x.taskId === id);
          if (!r) return err(notFound('没有你建的这个任务'));
          if (r.approval === 'pending') { await deps.requests.save({ ...r, approval: 'cancelled', updatedAt: deps.now() }); return ok({ cancelled: true }); }
          if (!r.taskId) return err(invalid('这条已经不在了'));
          const task = await deps.tasks.byId(asTaskId(r.taskId));
          if (!task || task.status !== 'todo') return err(invalid('任务已经开始了，不能取消，请让人处理'));
          const changed = await setTaskStatusUseCase(deps, task.id, 'abandoned', 'system', '创建它的 bot 取消了');
          if (!changed.ok) return changed;
          await deps.requests.save({ ...r, approval: 'cancelled', updatedAt: deps.now() });
          return ok({ cancelled: true });
        }
        default:
          return err(notFound(`没有这个工具：${name}`));
      }
    }
  };
}

/** 人批 / 拒超额的那条（收件箱里点）。批准才真正建任务。 */
export async function decideAgentTask(
  deps: Pick<Deps, 'now' | 'tasks' | 'projects'> & { readonly requests: AgentTaskStore },
  accountId: string, id: string, approve: boolean
): Promise<Result<AgentTaskRequest, DomainError>> {
  const r = await deps.requests.byId(id);
  if (!r || r.accountId !== accountId) return err(notFound('没有这条待批准的任务'));
  if (r.approval !== 'pending') return err(invalid('这条已经处理过了'));
  if (!approve) { const next = { ...r, approval: 'rejected' as const, updatedAt: deps.now() }; await deps.requests.save(next); return ok(next); }
  const task = await createTaskUseCase(deps, { projectId: r.projectId, title: r.title, goal: r.goal, ownerId: r.accountId });
  if (!task.ok) return task;
  const next = { ...r, approval: 'approved' as const, taskId: task.value.id, updatedAt: deps.now() };
  await deps.requests.save(next);
  return ok(next);
}
