import type { ProjectId, SessionId } from '../ids.ts';
import type { SessionLink } from '../session-link.ts';

/** 会话连接关系（无向）。关系是项目级资源，跨 owner 允许；发消息仍走会话双方权限。 */
export interface SessionLinkRepository {
  listByProject(projectId: ProjectId): Promise<SessionLink[]>;
  /** 与这条会话相连的所有边。 */
  forSession(sessionId: SessionId): Promise<SessionLink[]>;
  areLinked(one: SessionId, other: SessionId): Promise<boolean>;
  /** 幂等：已经连过就保留原记录。 */
  save(link: SessionLink): Promise<void>;
  remove(projectId: ProjectId, one: SessionId, other: SessionId): Promise<void>;
  removeByProject(projectId: ProjectId): Promise<void>;
}
