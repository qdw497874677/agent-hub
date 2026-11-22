import type { RecentSessionDto } from '@agent-hub/contract';

/**
 * 首页一行「最近的会话」，按「可能没有任务」读。
 *
 * 主会话（项目里手动开的常驻会话）是 `taskId === null` 的会话：契约里 `taskId` 已经可空，
 * 但行上还没有会话自己的标题字段，没任务时只能落回「没有任务的会话」。
 * `title` 先当可选字段读，契约补上后把这一处删掉即可。
 */
export type HomeSessionRow = RecentSessionDto & {
  /** 人给会话起的名字；契约补上之前当可选字段读。 */
  readonly title?: string | null;
};

/** 无任务会话在首页的兜底名字：和列表视图的组名同一句。 */
export const UNASSIGNED_SESSION = '没有任务的会话';

export function homeSessionRows(sessions: readonly RecentSessionDto[]): readonly HomeSessionRow[] {
  return sessions;
}

/** 这一行显示什么：会话名 → 任务名 → 中性兜底。无任务会话没有任务名可用。 */
export function homeSessionTitle(session: HomeSessionRow): string {
  const named = session.title?.trim();
  if (named) return named;
  return session.taskTitle?.trim() || UNASSIGNED_SESSION;
}

/** 搜索框按这句匹配：标题之外也算上项目名，和以前「任务名 + 项目名」一致。 */
export function homeSessionSearch(session: HomeSessionRow): string {
  return `${homeSessionTitle(session)} ${session.projectName}`;
}
