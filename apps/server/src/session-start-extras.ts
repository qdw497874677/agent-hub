import {
  asSessionId,
  asTaskId,
  authorizeSession,
  conflict,
  err,
  invalid,
  isHandle,
  linkSessionsUseCase,
  notFound,
  ok,
  projectOfSessionOrigin,
  type Deps,
  type DomainError,
  type MessageBus,
  type MessageStore,
  type Result,
  type Session,
  type SessionId,
  type Subject
} from '@agent-hub/domain';

/**
 * 会话通信 P1b：开会话时顺带「起短名」和「连线」（session_start / /api/sessions/derive / agent.spawn 共用）。
 * 先 check（会话还没建：短名格式与任务内唯一、要连的会话同项目且能说话），通过了才建会话；
 * 建好后 apply。apply 里个别失败（极少：并发抢了同一个短名）不回滚会话，只记日志。
 */
export interface StartExtras {
  readonly handle?: string | undefined;
  readonly linkWith?: readonly string[] | undefined;
}

export type ExtrasDeps = Pick<Deps, 'sessions' | 'tasks' | 'projects' | 'access' | 'links' | 'now' | 'workerPresence' | 'workspaces' | 'workspaceGroups' | 'bots'>;

export async function checkStartExtras(
  deps: ExtrasDeps,
  messages: Pick<MessageStore, 'sessionByHandle'> | undefined,
  taskId: string,
  extras: StartExtras,
  actor: Subject | null
): Promise<Result<readonly SessionId[], DomainError>> {
  const handle = extras.handle?.trim();
  if (handle !== undefined) {
    if (!isHandle(handle)) return err(invalid('handle 只能用小写字母开头，含 a-z 0-9 -，2–32 个字符'));
    if (messages && (await messages.sessionByHandle(taskId, handle))) return err(conflict(`同一任务里已经有会话叫 peer:${handle}`));
  }
  const ids: SessionId[] = [];
  if (!extras.linkWith || extras.linkWith.length === 0) return ok(ids);
  if (!deps.links) return err(invalid('这个 hub 没有开会话连线'));
  const task = await deps.tasks.byId(asTaskId(taskId));
  if (!task) return err(notFound('任务不存在'));
  for (const raw of new Set(extras.linkWith)) {
    const other = await deps.sessions.byId(asSessionId(raw));
    const project = other ? await projectOfSessionOrigin(deps, other) : null;
    if (!other || !project || project.id !== task.projectId) return err(notFound(`linkWith 里的会话 ${raw} 不存在或不在同一个项目里`));
    if (other.settledAt) return err(conflict(`archived: 会话 ${raw} 已收起，不能再连线`));
    if (deps.access) {
      const allowed = await authorizeSession(deps.access, actor, project, other, 'session.prompt');
      if (!allowed.ok) return allowed;
    }
    ids.push(other.id);
  }
  return ok(ids);
}

export async function applyStartExtras(
  deps: ExtrasDeps,
  bus: Pick<MessageBus, 'setHandle'> | undefined,
  session: Session,
  extras: StartExtras,
  linkIds: readonly SessionId[],
  actorId: string | null
): Promise<void> {
  const handle = extras.handle?.trim();
  if (handle && bus) {
    const saved = await bus.setHandle(session.id, handle, actorId ? `user:${actorId}` : 'hub');
    if (!saved.ok) console.warn(`[session-start] 会话 ${session.id} 设短名 ${handle} 失败：${saved.error.message}`);
  }
  const task = session.taskId ? await deps.tasks.byId(asTaskId(session.taskId)) : null;
  if (!task) return;
  for (const other of linkIds) {
    const linked = await linkSessionsUseCase(deps, task.projectId, session.id, other, actorId);
    if (!linked.ok) console.warn(`[session-start] 会话 ${session.id} 连到 ${other} 失败：${linked.error.message}`);
  }
}
