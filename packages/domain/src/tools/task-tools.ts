import { invalid, notFound, type DomainError } from '../errors.ts';
import { err, ok, type Result } from '../result.ts';
import { type LogLink } from '../work-log.ts';
import type { TaskStatus } from '../task.ts';
import type { ToolContext, ToolDescriptor, ToolProvider } from '../ports/tool-provider.ts';
import { appendWorkLogUseCase } from '../use-cases/work-log.ts';
import { setTaskStatusUseCase } from '../use-cases/tasks.ts';
import type { Deps } from '../use-cases/deps.ts';

const AGENT_STATUSES: readonly TaskStatus[] = ['in_progress', 'blocked', 'in_review'];
const LINK_KINDS = ['session', 'artifact', 'file', 'commit', 'pr', 'url'];

export const TASK_TOOLS: readonly ToolDescriptor[] = [
  {
    name: 'task.get',
    version: 1,
    scope: 'task:read',
    description:
      'Get the agent-hub task this session belongs to: title, goal, status, current progress line, branch, sessions, the latest work-log entry written by a person or agent, and its project (name, git repo if bound, and the free-form markdown project description, which may mention repos, conventions or how to deploy). Call this first when you start working.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'task.log.list',
    version: 1,
    scope: 'task:read',
    description: 'List work-log entries of the current task, newest first. Use beforeSeq to page back.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
        beforeSeq: { type: 'integer', minimum: 1 }
      },
      additionalProperties: false
    }
  },
  {
    name: 'task.log.append',
    version: 1,
    scope: 'task:log:write',
    perMinute: 10,
    description:
      'Append a free-form markdown entry to the current task work log, signed as you (runtime, model, session). Your latest entry becomes the task\'s current-progress line and the context for the next session, so before you stop, write one that covers: done / in progress / next steps / risks / key files.',
    inputSchema: {
      type: 'object',
      properties: {
        body: { type: 'string', minLength: 1, maxLength: 32768 },
        links: {
          type: 'array',
          maxItems: 20,
          items: {
            type: 'object',
            properties: { kind: { type: 'string', enum: LINK_KINDS }, ref: { type: 'string' }, label: { type: 'string' } },
            required: ['kind', 'ref']
          }
        }
      },
      required: ['body'],
      additionalProperties: false
    }
  },
  {
    name: 'task.update_status',
    version: 1,
    scope: 'task:status:write',
    description: 'Change the current task status. Agents may only set in_progress, blocked or in_review (a human marks it done).',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string', enum: AGENT_STATUSES }, note: { type: 'string', maxLength: 500 } },
      required: ['status'],
      additionalProperties: false
    }
  }
];

const record = (input: unknown): Record<string, unknown> =>
  input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};

const intIn = (value: unknown, min: number, max: number): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : undefined;

function parseLinks(raw: unknown): Result<LogLink[], DomainError> {
  if (raw === undefined) return ok([]);
  if (!Array.isArray(raw)) return err(invalid('links 必须是数组'));
  const links: LogLink[] = [];
  for (const item of raw) {
    const link = record(item);
    if (typeof link['kind'] !== 'string' || !LINK_KINDS.includes(link['kind']) || typeof link['ref'] !== 'string') {
      return err(invalid('links 每项要有合法的 kind 和 ref'));
    }
    links.push({
      kind: link['kind'] as LogLink['kind'],
      ref: link['ref'],
      ...(typeof link['label'] === 'string' ? { label: link['label'] } : {})
    });
  }
  return ok(links);
}

/** 首批四个任务工具（§4.2）。都隐式绑定 grant.taskId。 */
export function createTaskToolProvider(deps: Pick<Deps, 'now' | 'tasks' | 'workLog' | 'sessions' | 'projects'>): ToolProvider {
  const author = async (ctx: ToolContext) => {
    const session = await deps.sessions.byId(ctx.grant.sessionId);
    return {
      kind: 'agent' as const,
      sessionId: ctx.grant.sessionId,
      agentId: session?.agentId ?? 'unknown',
      model: session?.model ?? ''
    };
  };

  return {
    id: 'task',
    tools: () => TASK_TOOLS,
    async call(name, input, ctx) {
      const args = record(input);
      const taskId = ctx.grant.taskId;
      switch (name) {
        case 'task.get': {
          const task = await deps.tasks.byId(taskId);
          if (!task) return err(notFound('任务不存在'));
          const sessions = (await deps.sessions.listByTask(taskId)).map((session) => ({
            id: session.id,
            agentId: session.agentId,
            model: session.model,
            status: session.status,
            current: session.id === ctx.grant.sessionId
          }));
          const latest = await deps.workLog.latestNote(taskId);
          const project = await deps.projects.byId(task.projectId);
          return ok({
            id: task.id,
            title: task.title,
            goal: task.goal,
            status: task.status,
            summary: task.summary,
            branch: task.branch,
            logSeq: task.logSeq,
            sessions,
            latestEntry: latest ? { seq: latest.seq, at: latest.createdAt, author: latest.author, body: latest.body } : null,
            project: project
              ? { id: project.id, name: project.name, repo: project.repo, description: project.description }
              : null
          });
        }
        case 'task.log.list': {
          const beforeSeq = intIn(args['beforeSeq'], 1, Number.MAX_SAFE_INTEGER);
          const entries = await deps.workLog.list(taskId, {
            limit: intIn(args['limit'], 1, 50) ?? 20,
            ...(beforeSeq !== undefined ? { beforeSeq } : {})
          });
          return ok({
            entries: entries.map((entry) => ({
              seq: entry.seq,
              author: entry.author,
              body: entry.body,
              links: entry.links,
              at: entry.createdAt
            }))
          });
        }
        case 'task.log.append': {
          if (typeof args['body'] !== 'string') return err(invalid('body 必须是字符串'));
          const links = parseLinks(args['links']);
          if (!links.ok) return links;
          const appended = await appendWorkLogUseCase(deps, {
            taskId,
            author: await author(ctx),
            body: args['body'],
            links: links.value,
            sessionId: ctx.grant.sessionId
          });
          if (!appended.ok) return appended;
          return ok({ seq: appended.value.entry.seq, id: appended.value.entry.id, summary: appended.value.task.summary });
        }
        case 'task.update_status': {
          const status = args['status'];
          if (typeof status !== 'string' || !AGENT_STATUSES.includes(status as TaskStatus)) {
            return err(invalid(`status 只能是 ${AGENT_STATUSES.join(' / ')}`));
          }
          const note = typeof args['note'] === 'string' ? args['note'].slice(0, 500) : undefined;
          const before = await deps.tasks.byId(taskId);
          const me = await author(ctx);
          const label = me.model ? `${me.agentId}（${me.model}）` : me.agentId;
          const changed = await setTaskStatusUseCase(deps, taskId, status as TaskStatus, 'agent', note, {
            label,
            sessionId: ctx.grant.sessionId
          });
          if (!changed.ok) return changed;
          // 没变也明确说出来：否则模型会以为没生效、反复重试
          return before?.status === changed.value.status
            ? ok({ status: changed.value.status, changed: false, message: `任务已经是 ${status}，不用再改` })
            : ok({ status: changed.value.status, changed: true });
        }
        default:
          return err(notFound(`没有这个工具：${name}`));
      }
    }
  };
}
