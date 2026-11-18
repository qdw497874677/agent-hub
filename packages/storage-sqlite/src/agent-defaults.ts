import type { DatabaseSync } from 'node:sqlite';
import type { AgentDefaultsStore, RuntimeModelDefaults } from '@agent-hub/domain';

/**
 * 团队级的运行时默认模型（`packages/domain/src/agent-defaults.ts`）。
 * 一个团队一行，值是 `{ runtimeId: model }` 的 JSON——模型名可读、不含密钥，所以不加密。
 */
export const AGENT_DEFAULTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_defaults (
  team_id TEXT PRIMARY KEY,
  models  TEXT NOT NULL
);
`;

export function createAgentDefaultsStore(db: DatabaseSync): AgentDefaultsStore {
  db.exec(AGENT_DEFAULTS_SCHEMA);
  return {
    async forTeam(teamId: string): Promise<RuntimeModelDefaults> {
      const row = db.prepare('SELECT models FROM agent_defaults WHERE team_id = ?').get(teamId) as { models?: unknown } | undefined;
      if (row === undefined || typeof row.models !== 'string') return {};
      try {
        const parsed: unknown = JSON.parse(row.models);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const out: Record<string, string> = {};
        for (const [runtime, model] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof model === 'string' && model !== '') out[runtime] = model;
        }
        return out;
      } catch {
        // 坏 JSON 当「没有默认」：这是一条可读配置，不值得让开会话整个失败。
        return {};
      }
    },
    async save(teamId: string, defaults: RuntimeModelDefaults): Promise<void> {
      db.prepare(
        'INSERT INTO agent_defaults (team_id, models) VALUES (?, ?) ON CONFLICT(team_id) DO UPDATE SET models = excluded.models'
      ).run(teamId, JSON.stringify(defaults));
    }
  };
}
