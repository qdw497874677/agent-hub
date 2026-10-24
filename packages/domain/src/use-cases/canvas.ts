import { buildLineage, emptyLayout } from '../canvas.ts';
import { err, ok, type Result } from '../result.ts';
import type { DomainError } from '../errors.ts';
import { notFound } from '../errors.ts';
import type { CanvasProjection, Deps } from './deps.ts';

export async function loadCanvas(
  deps: Deps,
  projectId: string
): Promise<Result<CanvasProjection, DomainError>> {
  const project = await deps.projects.byId(projectId as never);
  if (!project) return err(notFound('项目不存在'));

  const tasks = await deps.tasks.listByProject(project.id);
  const sessions = await deps.sessions.listByProject(project.id);
  const layout = (await deps.layout.load(project.id)) ?? emptyLayout(project.id, deps.now());

  const artifacts = (
    await Promise.all(tasks.map((task) => deps.artifacts.byTask(task.id)))
  ).flat();

  return ok({
    project,
    tasks,
    sessions,
    artifacts,
    edges: buildLineage(tasks, sessions),
    layout,
    agents: deps.agents.list()
  });
}
