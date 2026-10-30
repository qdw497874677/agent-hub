import type { Team, TeamId } from '../account.ts';

/** 团队（租户，ADR 0011）。 */
export interface TeamRepository {
  save(team: Team): Promise<void>;
  byId(id: TeamId): Promise<Team | null>;
  list(): Promise<Team[]>;
}
