import type { AgentProfile } from '../agent-profile.ts';

export interface AgentProfileRepository {
  listByOwner(ownerId: string | null): Promise<AgentProfile[]>;
  byId(id: string): Promise<AgentProfile | null>;
  save(profile: AgentProfile): Promise<void>;
  remove(id: string): Promise<void>;
  removeByOwner(ownerId: string | null): Promise<void>;
}
