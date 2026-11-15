import type { BotId, BotRepository, ProjectId, Session, SessionId, SessionRepository, TaskRepository } from '@agent-hub/domain';

/** 这条会话是哪个 bot 开的：项目 + @id（名字）+ bot id。 */
export interface BotOfSession {
  readonly projectId: string;
  /** @id：群成员 / 连接器 binding 仍按它解析（名字建好不能改）。 */
  readonly name: string;
  /** 新会话一定有；老会话按名字反查到了才有，反查不到就是 null。 */
  readonly botId: BotId | null;
}

export interface BotOfSessionDeps {
  readonly sessions: Pick<SessionRepository, 'byId'>;
  readonly tasks: Pick<TaskRepository, 'byId'>;
  readonly bots: Pick<BotRepository, 'byId' | 'byName'>;
  /** 历史派生记录（agent_spawns）里的角色名，兼容老会话用。 */
  readonly spawnOf: (sessionId: SessionId) => Promise<{ role: string } | null>;
  /** 群成员会话映射里的角色名，兼容老会话用。 */
  readonly memberOfSession: (sessionId: SessionId) => Promise<{ role: string } | null>;
}

/**
 * 会话 → bot 的解析（#221 步骤 4）。
 *
 * 新会话在 `sessions.bot_id` 里直接记 id，优先按 id 查：bot 名字改不了，
 * 但删掉后重建同名 bot 会拿到同一个 id（`botIdFrom` 的确定性），所以按 id
 * 不会把两条会话串到「另一个 bot」上。
 *
 * 兼容路径：`bot_id` 之前的老会话只能按名字反推——派生记录、群成员映射里
 * 存的是 @id。反查只是过渡，等老会话都过期 / 迁移后可删。
 */
export function createBotOfSession(deps: BotOfSessionDeps): (sessionId: SessionId) => Promise<BotOfSession | null> {
  const projectOf = async (session: Session): Promise<string | null> => {
    if (session.taskId !== null) {
      const task = await deps.tasks.byId(session.taskId);
      if (task) return task.projectId;
    }
    if (session.botId) return (await deps.bots.byId(session.botId))?.projectId ?? null;
    return null;
  };
  return async (sessionId) => {
    const session = await deps.sessions.byId(sessionId);
    if (!session) return null;
    // 容器会话（群/bot 常驻）没有任务，项目从群/bot/工作空间反推（#221 步骤 7）。
    const projectId = await projectOf(session);
    if (projectId === null) return null;

    if (session.botId) {
      const bot = await deps.bots.byId(session.botId);
      // bot 已删：会话仍可能在跑，但不再代表任何 bot（bindings 删除时也清过了）。
      return bot ? { projectId, name: bot.name, botId: bot.id } : null;
    }

    // --- 兼容路径：没有 bot_id 的老会话，只能按名字推导 ---
    const role = (await deps.spawnOf(sessionId))?.role ?? (await deps.memberOfSession(sessionId))?.role ?? null;
    if (!role) return null;
    const bot = await deps.bots.byName(projectId as ProjectId, role);
    return { projectId, name: role, botId: bot?.id ?? null };
  };
}
