import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { asTaskId, newId } from '@agent-hub/domain';
import type { AuditLog, Deps, JournalEntry, Principal, UserId, UserRepository } from '@agent-hub/domain';

/** 会话里「谁做了什么」：审计 + 读出时把作者名刷新成账号当前的名字。 */
export interface SessionActivityOptions {
  readonly audit: AuditLog;
  readonly users: Pick<UserRepository, 'byId'>;
}

export type SessionAction = 'session.start' | 'session.fork' | 'session.interrupt' | 'session.continue';

export function ipOf(c: Context): string | null {
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null;
  }
}

/** 经令牌的操作在审计里注明「via 令牌」（ADR 0015）。 */
export const viaSuffix = (actor: Principal, detail: string): string =>
  actor.via ? `${detail}${detail ? ' · ' : ''}via 令牌「${actor.via.name}」` : detail;

/** 记一条会话操作审计（带 IP、团队）。没登录态（共享 token、单测）就不记——不知道是谁。 */
export async function recordSessionAction(
  deps: Pick<Deps, 'sessions' | 'tasks' | 'projects' | 'now'>,
  options: SessionActivityOptions | undefined,
  c: Context,
  actor: Principal | null,
  action: SessionAction,
  sessionId: string,
  detail: string
): Promise<void> {
  if (!options || !actor) return;
  let teamId: string | null = actor.user.teamId ?? null;
  try {
    const session = await deps.sessions.byId(sessionId as never);
    const task = session ? await deps.tasks.byId(asTaskId(session.taskId)) : null;
    const project = task ? await deps.projects.byId(task.projectId) : null;
    if (project) teamId = project.teamId ?? teamId;
  } catch {
    // 查不到就用操作人自己的团队
  }
  await options.audit
    .append({
      id: newId(),
      actorId: actor.user.id,
      actorEmail: actor.user.email,
      action,
      target: sessionId,
      detail: viaSuffix(actor, detail),
      at: deps.now(),
      ip: ipOf(c),
      teamId
    })
    .catch(() => undefined);
}

/** 名字缓存（一次请求内）：删掉的用户被就地匿名化，所以按 id 现查就自动显示匿名名。 */
function nameResolver(users: Pick<UserRepository, 'byId'>) {
  const cache = new Map<string, Promise<string | null>>();
  return (id: string): Promise<string | null> => {
    let hit = cache.get(id);
    if (!hit) {
      hit = users.byId(id as UserId).then((u) => u?.displayName ?? null, () => null);
      cache.set(id, hit);
    }
    return hit;
  };
}

/** 把 prompt 事件上的作者名换成账号现在的名字（改过名、被删除匿名化都跟着变）。 */
export async function refreshAuthors(
  options: SessionActivityOptions | undefined,
  entries: readonly JournalEntry[]
): Promise<JournalEntry[]> {
  if (!options) return [...entries];
  const nameOf = nameResolver(options.users);
  return Promise.all(
    entries.map(async (entry) => {
      const event = entry.event;
      if (event.kind !== 'prompt' || !event.author) return entry;
      const name = await nameOf(event.author.id);
      return name && name !== event.author.name ? { ...entry, event: { ...event, author: { ...event.author, name } } } : entry;
    })
  );
}

export async function refreshPreviewAuthors(
  options: SessionActivityOptions | undefined,
  previews: Record<string, readonly JournalEntry[]>
): Promise<Record<string, JournalEntry[]>> {
  const out: Record<string, JournalEntry[]> = {};
  for (const [id, entries] of Object.entries(previews)) out[id] = await refreshAuthors(options, entries);
  return out;
}

export interface SessionActivityItem {
  readonly action: SessionAction;
  readonly actor: { readonly id: string; readonly name: string };
  readonly detail: string;
  readonly at: number;
}

/** 这条会话的操作记录，新的在前；名字按账号现查。IP 只进审计后台，这里不给。 */
export async function sessionActivity(options: SessionActivityOptions, sessionId: string): Promise<SessionActivityItem[]> {
  const entries = await options.audit.query({ target: sessionId, action: 'session.', limit: 50 });
  const nameOf = nameResolver(options.users);
  return Promise.all(
    entries.map(async (e) => ({
      action: e.action as SessionAction,
      actor: { id: e.actorId, name: (await nameOf(e.actorId)) ?? e.actorEmail },
      detail: e.detail,
      at: e.at
    }))
  );
}
