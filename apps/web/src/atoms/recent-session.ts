import type { RecentSessionDto } from '@agent-hub/contract';

/** 首页一行「最近的会话」。 */
export type HomeSessionRow = RecentSessionDto;

export function homeSessionRows(sessions: readonly RecentSessionDto[]): readonly HomeSessionRow[] {
  return sessions;
}

/**
 * 这一行显示什么：会话自己的标题优先，其次用短 ID 如实指认。
 *
 * 同一个任务下可以有很多条会话，任务名不能当会话名用；否则几条会话在首页上
 * 看起来一模一样。任务名只作为次级信息出现在搜索和行内元数据里。
 */
export function homeSessionTitle(session: HomeSessionRow): string {
  const named = session.sessionTitle?.trim();
  if (named) return named;
  return `会话 ${session.sessionId.slice(0, 6)}`;
}

/** 搜索按这句匹配：会话名、任务名、项目名都算，但结果仍然只是最近的会话。 */
export function homeSessionSearch(session: HomeSessionRow): string {
  return `${homeSessionTitle(session)} ${session.taskTitle?.trim() ?? ''} ${session.projectName}`;
}
