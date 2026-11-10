import { applyLayoutPatch, buildLineage, emptyLayout } from '../canvas.ts';
import type { CanvasLayout, LayoutPatch } from '../canvas.ts';
import { asProjectId, asSessionId } from '../ids.ts';
import { canonicalLink, type SessionLink } from '../session-link.ts';
import { err, ok, type Result } from '../result.ts';
import type { DomainError } from '../errors.ts';
import { invalid, notFound, notImplemented } from '../errors.ts';
import type { JournalEntry } from '../event.ts';
import type { CanvasProjection, Deps } from './deps.ts';

export async function loadCanvas(
  deps: Pick<Deps, 'agents' | 'artifacts' | 'layout' | 'links' | 'now' | 'projects' | 'sessions' | 'tasks' | 'workspaces'>,
  projectId: string
): Promise<Result<CanvasProjection, DomainError>> {
  const project = await deps.projects.byId(asProjectId(projectId));
  if (!project) return err(notFound('项目不存在'));

  const tasks = await deps.tasks.listByProject(project.id);
  const sessions = await deps.sessions.listByProject(project.id);
  const layout = (await deps.layout.load(project.id)) ?? emptyLayout(project.id, deps.now());
  const links = (await deps.links?.listByProject(project.id)) ?? [];

  const PREVIEW_EVENTS = 24;
  const previews: Record<string, readonly JournalEntry[]> = {};
  const openings: Record<string, string> = {};
  await Promise.all(
    sessions.map(async (session) => {
      previews[session.id] = await deps.sessions.tail(session.id, PREVIEW_EVENTS);
      const first = await deps.sessions.firstPrompt(session.id);
      if (!first || first.event.kind !== 'prompt') return;
      const text = first.event.text.replace(/\s+/g, ' ').trim();
      if (text) openings[session.id] = text;
    })
  );

  const artifacts = (
    await Promise.all(tasks.map((task) => deps.artifacts.byTask(task.id)))
  ).flat();

  const workspaces = (await deps.workspaces.byProject(project.id)).filter((workspace) => workspace.state !== 'removed');

  return ok({
    project,
    workspaces,
    tasks,
    sessions,
    artifacts,
    edges: buildLineage(tasks, sessions, links),
    layout,
    agents: deps.agents.list(),
    previews,
    openings
  });
}

/** 用户拖完或改完卡片大小：只记位置与尺寸，不碰血缘。没存过布局的项目从空布局开始。 */
export async function saveLayoutUseCase(
  deps: Pick<Deps, 'layout' | 'now'>,
  projectId: string,
  patch: LayoutPatch
): Promise<CanvasLayout> {
  const id = asProjectId(projectId);
  const current = (await deps.layout.load(id)) ?? emptyLayout(id, deps.now());
  const next = applyLayoutPatch(current, patch, deps.now());
  await deps.layout.save(next);
  return next;
}

/** 把两条会话连起来（无向，幂等）。关系是项目级资源；跨 owner 允许，消息权限另算。 */
export async function linkSessionsUseCase(
  deps: Pick<Deps, 'links' | 'now' | 'projects' | 'sessions'>,
  projectId: string,
  one: string,
  other: string,
  createdBy: string | null
): Promise<Result<SessionLink, DomainError>> {
  if (!deps.links) return err(notImplemented('会话连线'));
  const project = await deps.projects.byId(asProjectId(projectId));
  if (!project) return err(notFound('项目不存在'));
  const a = asSessionId(one);
  const b = asSessionId(other);
  if (a === b) return err(invalid('不能把会话连到自己'));
  const sessions = await deps.sessions.listByProject(project.id);
  const known = new Set(sessions.map((session) => session.id));
  if (!known.has(a) || !known.has(b)) return err(notFound('会话不在这个项目里'));
  const link = canonicalLink(project.id, a, b, createdBy, deps.now());
  await deps.links.save(link);
  return ok(link);
}

/** 断开两条会话；重复删除也成功。 */
export async function unlinkSessionsUseCase(
  deps: Pick<Deps, 'links' | 'projects'>,
  projectId: string,
  one: string,
  other: string
): Promise<Result<void, DomainError>> {
  if (!deps.links) return err(notImplemented('会话连线'));
  const project = await deps.projects.byId(asProjectId(projectId));
  if (!project) return err(notFound('项目不存在'));
  const a = asSessionId(one);
  const b = asSessionId(other);
  if (a === b) return err(invalid('不能把会话连到自己'));
  await deps.links.remove(project.id, a, b);
  return ok(undefined);
}
