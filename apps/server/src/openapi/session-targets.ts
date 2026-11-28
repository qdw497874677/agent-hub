import { asTaskId, authorizeProject, authorizeWorker, can, err, forbidden, notFound, ok, workerReader } from '@agent-hub/domain';
import type { Deps, Subject } from '@agent-hub/domain';
import { z, type OpenAPIHono } from '@hono/zod-openapi';
import { fail } from '../http-error.ts';
import type { Env, V1Runtime } from './context.ts';
import { openapiOn } from './context.ts';
import { V1, errors, json, route } from './routes/base.ts';

type Availability = 'ready' | 'blocked' | 'unknown';
export interface SessionTargets {
  taskId: string;
  workers: { workerId: string; label: string; availability: Availability; blockers: string[]; workspaces: { workspaceId: string; label: string | null; availability: Availability; blockers: string[] }[] }[];
}

const availability = z.enum(['ready', 'blocked', 'unknown']);
export const sessionTargetsRoute = route('workers:read', {
  method: 'get', path: `${V1}/tasks/{taskId}/session-targets`, tags: ['tasks'], summary: '查询任务的会话落点',
  description: '还需要任务读取权限。只列可见的远程 Worker 和本项目已登记的单目录工作空间，不返回绝对路径，不准备目录。',
  request: { params: z.object({ taskId: z.string().min(1).max(512) }) },
  responses: { ...errors, 200: json(z.object({ taskId: z.string(), workers: z.array(z.object({
    workerId: z.string(), label: z.string(), availability, blockers: z.array(z.string()),
    workspaces: z.array(z.object({ workspaceId: z.string(), label: z.string().nullable(), availability, blockers: z.array(z.string()) }))
  })) })) }
}, { module: 'tasks', need: 'task.read', alsoNeeds: ['worker.read'], readOnly: true, expose: 'list_session_targets' });

export function installSessionTargets(app: OpenAPIHono<Env>, rt: V1Runtime): void {
  openapiOn(app)(sessionTargetsRoute, async (c) => {
    const result = await listSessionTargets(rt.deps, rt.principal(c), c.req.param('taskId') ?? '');
    if (!result.ok) return fail(c, result.error);
    return c.json(result.value, 200);
  });
}

// Only use a saved display name, not a hostname, root or directory basename.
const displayLabel = (value: string | null): string | null =>
  value && value.length <= 120 && !/[/\\\p{Cc}\p{Cf}]/u.test(value) ? value : null;

/** Read-only discovery; this deliberately never returns paths or path-derived labels. */
export async function listSessionTargets(deps: Deps, actor: Subject | null, taskId: string) {
  if (!can(actor, 'task.read')) return err(forbidden('令牌没有任务读取权限'));
  if (!can(actor, 'worker.read')) return err(forbidden('令牌没有 workers:read'));
  const task = await deps.tasks.byId(asTaskId(taskId));
  if (!task) return err(notFound('任务不存在'));
  const project = await deps.projects.byId(task.projectId);
  const allowed = await authorizeProject(deps.access, actor, project, 'task.read');
  if (!allowed.ok) return allowed;
  const readable = await workerReader(deps.access, actor);
  const workspaces = await deps.workspaces.byProject(task.projectId);
  const result: SessionTargets = { taskId, workers: [] };
  for (const worker of await deps.gateway.status()) {
    if (worker.origin !== 'remote' || !(await readable(worker.workerId))) continue;
    const usable = await authorizeWorker(deps.access, actor, worker.workerId);
    const blockers: string[] = [];
    if (task.archivedAt != null) blockers.push('task_archived');
    if (!usable.ok) blockers.push('worker_not_permitted');
    if (worker.state !== 'online') blockers.push('worker_offline');
    if (worker.resources?.refusing) blockers.push('worker_refusing');
    const targets: SessionTargets['workers'][number]['workspaces'] = [];
    for (const workspace of workspaces) {
      if (workspace.workerId !== worker.workerId || workspace.groupId ||
          (workspace.kind === 'temporary' && workspace.ownerTaskId !== task.id)) continue;
      const reasons: string[] = [];
      if (workspace.state !== 'ready') reasons.push('workspace_not_ready');
      if (workspace.setup && workspace.setup.state !== 'none' && workspace.setup.state !== 'ready') reasons.push('workspace_setup_not_ready');
      targets.push({ workspaceId: workspace.id, label: displayLabel(workspace.label), availability: blockers.length || reasons.length ? 'blocked' : 'ready', blockers: [...blockers, ...reasons] });
    }
    result.workers.push({ workerId: worker.workerId, label: displayLabel(worker.label) ?? 'Worker', availability: blockers.length ? 'blocked' : 'ready', blockers, workspaces: targets });
  }
  return ok(result);
}
