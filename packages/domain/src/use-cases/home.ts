import type { Project } from '../project.ts';
import type { SessionStatus } from '../session.ts';
import type { AgentId, ProjectId, SessionId, TaskId } from '../ids.ts';
import type { Deps } from './deps.ts';

export interface ProjectSummary extends Project {
  readonly taskCount: number;
  readonly sessionCount: number;
  readonly lastActivityAt: number | null;
}

export interface RecentSession {
  readonly sessionId: SessionId;
  readonly taskId: TaskId;
  readonly taskTitle: string;
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly agentId: AgentId;
  readonly status: SessionStatus;
  readonly lastSeq: number;
  readonly updatedAt: number;
}

export interface HomeView {
  readonly projects: readonly ProjectSummary[];
  readonly recentSessions: readonly RecentSession[];
}

/** 首页只列最近这么多条会话：多到能认出「昨天那条」，少到不用滚。 */
export const RECENT_LIMIT = 24;

/**
 * 首页：项目 + 每个项目里有多少活。它是入口，不是看板——不用卡片列表示意进度。
 * 最近会话是主角：它回答「接着干哪条」，项目列表只回答「在哪儿干」。
 */
export async function loadHome(
  deps: Pick<Deps, 'projects' | 'tasks' | 'sessions'>,
  limit: number = RECENT_LIMIT,
  /** 只要这个人能看的项目（ADR 0011）；不给 = 全部。 */
  include: (project: Project) => boolean = () => true
): Promise<HomeView> {
  const projects = (await deps.projects.list()).filter(include);
  const owners = new Map<string, { title: string; project: Project }>();

  const summaries = await Promise.all(
    projects.map(async (project): Promise<ProjectSummary> => {
      const tasks = await deps.tasks.listByProject(project.id);
      const sessions = await deps.sessions.listByProject(project.id);
      for (const task of tasks) owners.set(task.id, { title: task.title, project });
      const touched = [...tasks.map((task) => task.updatedAt), ...sessions.map((session) => session.updatedAt)];
      return {
        ...project,
        taskCount: tasks.length,
        sessionCount: sessions.length,
        lastActivityAt: touched.length === 0 ? null : Math.max(...touched)
      };
    })
  );
  summaries.sort((left, right) => (right.lastActivityAt ?? right.createdAt) - (left.lastActivityAt ?? left.createdAt));

  const recentSessions = (await deps.sessions.listAll())
    .toSorted((left, right) => right.updatedAt - left.updatedAt)
    .flatMap((session): RecentSession[] => {
      const owner = owners.get(session.taskId);
      if (!owner) return [];
      return [
        {
          sessionId: session.id,
          taskId: session.taskId,
          taskTitle: owner.title,
          projectId: owner.project.id,
          projectName: owner.project.name,
          agentId: session.agentId,
          status: session.status,
          lastSeq: session.lastSeq,
          updatedAt: session.updatedAt
        }
      ];
    })
    .slice(0, limit);

  return { projects: summaries, recentSessions };
}
