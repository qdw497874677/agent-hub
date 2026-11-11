import type { DatabaseSync } from 'node:sqlite';
import { asAgentId, type AgentProfile, type AgentProfileRepository } from '@agent-hub/domain';

interface ProfileRow {
  id: string;
  owner_id: string | null;
  name: string;
  agent_id: string;
  model: string;
  options: string;
  notes: string;
  created_at: number;
  updated_at: number;
}

function parseOptions(raw: string): Record<string, string | boolean> {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out: Record<string, string | boolean> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (typeof item === 'string' || typeof item === 'boolean') out[key] = item;
    }
    return out;
  } catch {
    return {};
  }
}

const toProfile = (row: ProfileRow): AgentProfile => ({
  id: row.id,
  ownerId: row.owner_id,
  name: row.name,
  agentId: asAgentId(row.agent_id),
  model: row.model,
  options: parseOptions(row.options),
  notes: row.notes,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

/** Agent 配置：owner 隔离；无账号时 owner_id = NULL。 */
export function createSqliteAgentProfiles(db: DatabaseSync): AgentProfileRepository {
  const selectByOwner = db.prepare(
    'SELECT * FROM agent_profiles WHERE owner_id IS ? ORDER BY updated_at DESC, created_at DESC'
  );
  const selectById = db.prepare('SELECT * FROM agent_profiles WHERE id = ?');
  const upsert = db.prepare(
    'INSERT INTO agent_profiles(id, owner_id, name, agent_id, model, options, notes, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET owner_id = excluded.owner_id, name = excluded.name, agent_id = excluded.agent_id, ' +
      'model = excluded.model, options = excluded.options, notes = excluded.notes, updated_at = excluded.updated_at'
  );
  const removeById = db.prepare('DELETE FROM agent_profiles WHERE id = ?');
  const removeByOwnerId = db.prepare('DELETE FROM agent_profiles WHERE owner_id IS ?');

  return {
    async listByOwner(ownerId: string | null): Promise<AgentProfile[]> {
      return (selectByOwner.all(ownerId) as unknown as ProfileRow[]).map(toProfile);
    },
    async byId(id: string): Promise<AgentProfile | null> {
      const row = selectById.get(id) as unknown as ProfileRow | undefined;
      return row ? toProfile(row) : null;
    },
    async save(profile: AgentProfile): Promise<void> {
      upsert.run(
        profile.id,
        profile.ownerId,
        profile.name,
        profile.agentId,
        profile.model,
        JSON.stringify(profile.options),
        profile.notes,
        profile.createdAt,
        profile.updatedAt
      );
    },
    async remove(id: string): Promise<void> {
      removeById.run(id);
    },
    async removeByOwner(ownerId: string | null): Promise<void> {
      removeByOwnerId.run(ownerId);
    }
  };
}
