import type { ApiToken } from '../api-token.ts';
import type { ProjectId } from '../ids.ts';

export interface ApiTokenRepository {
  save(token: ApiToken): Promise<void>;
  byId(id: string): Promise<ApiToken | null>;
  byHash(hash: string): Promise<ApiToken | null>;
  listByTeam(teamId: string): Promise<ApiToken[]>;
  /** 某个项目的全部 bot 令牌（BotDto 上展示「这个 bot 有没有凭据」，一次查完）。 */
  listBotsByProject(projectId: ProjectId): Promise<ApiToken[]>;
  touch(id: string, at: number): Promise<void>;
}
