import type { ApiToken } from '../api-token.ts';

export interface ApiTokenRepository {
  save(token: ApiToken): Promise<void>;
  byId(id: string): Promise<ApiToken | null>;
  byHash(hash: string): Promise<ApiToken | null>;
  listByTeam(teamId: string): Promise<ApiToken[]>;
  touch(id: string, at: number): Promise<void>;
}
