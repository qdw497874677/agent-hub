import { buildLineage, emptyLayout, place } from '../canvas.ts';
import type { CanvasLayout, Point } from '../canvas.ts';
import { asProjectId } from '../ids.ts';
import { err, ok, type Result } from '../result.ts';
import type { DomainError } from '../errors.ts';
import { notFound } from '../errors.ts';
import type { JournalEntry } from '../event.ts';
import type { CanvasProjection, Deps } from './deps.ts';

export async function loadCanvas(
  deps: Deps,
  projectId: string
): Promise<Result<CanvasProjection, DomainError>> {
  const project = await deps.projects.byId(asProjectId(projectId));
  if (!project) return err(notFound('项目不存在'));

  const tasks = await deps.tasks.listByProject(project.id);
  const sessions = await deps.sessions.listByProject(project.id);
  const layout = (await deps.layout.load(project.id)) ?? emptyLayout(project.id, deps.now());

  const PREVIEW_EVENTS = 24;
  const previews: Record<string, readonly JournalEntry[]> = {};
  await Promise.all(
    sessions.map(async (session) => {
      previews[session.id] = await deps.sessions.tail(session.id, PREVIEW_EVENTS);
    })
  );

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
    agents: deps.agents.list(),
    previews
  });
}

/** 用户拖完节点：只记位置，不碰血缘。没存过布局的项目从空布局开始。 */
export async function saveLayoutUseCase(
  deps: Pick<Deps, 'layout' | 'now'>,
  projectId: string,
  positions: Readonly<Record<string, Point>>
): Promise<CanvasLayout> {
  const id = asProjectId(projectId);
  let next = (await deps.layout.load(id)) ?? emptyLayout(id, deps.now());
  for (const [nodeId, point] of Object.entries(positions)) next = place(next, nodeId, point, deps.now());
  await deps.layout.save(next);
  return next;
}
