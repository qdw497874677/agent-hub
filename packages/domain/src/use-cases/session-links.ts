import { asProjectId, asSessionId } from '../ids.ts';
import { canonicalLink, type SessionLink } from '../session-link.ts';
import { err, ok, type Result } from '../result.ts';
import type { DomainError } from '../errors.ts';
import { conflict, invalid, notFound, notImplemented } from '../errors.ts';
import type { Deps } from './deps.ts';
import { projectOfSessionOrigin } from './authorization.ts';

/**
 * 会话通信：连线的建立与断开。关系是项目级资源；跨 owner 允许，消息权限另算。
 * 画布只读取连线（`loadCanvas`），不负责写入。
 */

/** 把两条会话连起来（无向，幂等）。关系是项目级资源；跨 owner 允许，消息权限另算。 */
export async function linkSessionsUseCase(
  deps: Pick<Deps, 'links' | 'now' | 'projects' | 'sessions' | 'tasks' | 'workerPresence' | 'workspaces' | 'workspaceGroups'>,
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
  const first = await deps.sessions.byId(a);
  const second = await deps.sessions.byId(b);
  if (!first || !second) return err(notFound('会话不在这个项目里'));
  // #243：连线是跨会话授权，按不可变来源判项目；不能拿放置/列表归属（长期空间可转手）。
  const [firstProject, secondProject] = await Promise.all([projectOfSessionOrigin(deps, first), projectOfSessionOrigin(deps, second)]);
  if (!firstProject || firstProject.id !== project.id || !secondProject || secondProject.id !== project.id) {
    return err(notFound('会话不在这个项目里'));
  }
  if (deps.workerPresence) {
    const [firstOnline, secondOnline] = await Promise.all([
      deps.workerPresence.online(first.workerId ?? null),
      deps.workerPresence.online(second.workerId ?? null)
    ]);
    if (!firstOnline && !secondOnline) return err(conflict('两台会话所在的机器都不在线，连上之后再连'));
    if (!firstOnline) return err(conflict('当前会话所在的机器不在线，连上之后再连'));
    if (!secondOnline) return err(conflict('对方会话所在的机器不在线，连上之后再连'));
  }
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
