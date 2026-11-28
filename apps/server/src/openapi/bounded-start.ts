import { z } from '@hono/zod-openapi';
import { asTaskId, authorizeProject, can, deriveSessionUseCase, err, forbidden, invalid, notFound, resolveDefaultAgent } from '@agent-hub/domain';
import type { Subject } from '@agent-hub/domain';
import type { V1Context } from './context.ts';

/** Parse the original JSON, not the legacy schema's stripped output. */
export const boundedStartRequest = z.object({
  placement: z.literal('bounded_v1'),
  taskId: z.string().trim().min(1),
  workerId: z.string().trim().min(1),
  workspaceId: z.string().trim().min(1),
  agentId: z.string().trim().min(1),
  model: z.string().optional()
}).strict();

export async function boundedStart(rt: Pick<V1Context, 'deps' | 'providers'>, actor: Subject | null, raw: unknown) {
  const parsed = boundedStartRequest.safeParse(raw);
  if (!parsed.success) return err(invalid('有界启动参数不合法'));
  if (!can(actor, 'session.create')) return err(forbidden('令牌没有 sessions:write'));
  const input = parsed.data;
  const task = await rt.deps.tasks.byId(asTaskId(input.taskId));
  if (!task) return err(notFound('任务不存在'));
  const project = await rt.deps.projects.byId(task.projectId);
  const allowed = await authorizeProject(rt.deps.access, actor, project, 'session.create');
  if (!allowed.ok) return allowed;
  const model = input.model || (await resolveDefaultAgent(rt.deps, { project: allowed.value, task, explicit: { runtime: input.agentId } })).effective.model;
  if (!model.trim()) return err(invalid('没有可解析的默认模型'));
  const checked = await rt.providers?.checkModel(actor, model, input.taskId);
  if (checked && !checked.ok) return checked;
  return deriveSessionUseCase(rt.deps, {
    taskId: input.taskId, workerId: input.workerId, workspaceId: input.workspaceId,
    agentId: input.agentId, model, actor, boundedPlacement: true,
    ...(checked?.ok && checked.value ? { hubProtocol: checked.value } : {})
  });
}
