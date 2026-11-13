import type { DatabaseSync } from 'node:sqlite';
import { asProjectId, type Bot, type BotRepository, type RoleReuse } from '@agent-hub/domain';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  doc TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(project_id, name)
);
CREATE INDEX IF NOT EXISTS bots_project ON bots(project_id);
`;

interface BotRow {
  id: string;
  project_id: string;
  name: string;
  doc: string;
  created_at: number;
  updated_at: number;
}

/** doc 里只放「不是列」的字段：ref / displayName / color / description / reuse。 */
interface BotDoc {
  ref?: { runtime?: unknown; model?: unknown; options?: unknown };
  displayName?: unknown;
  color?: unknown;
  description?: unknown;
  reuse?: unknown;
}

function parseOptions(raw: unknown): Record<string, string | boolean> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' || typeof value === 'boolean') out[key] = value;
  }
  return out;
}

function parseDoc(raw: string): BotDoc {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as BotDoc) : {};
  } catch {
    return {};
  }
}

const text = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

/** 行 → Bot：id / projectId / name / 时间戳在列上，其余从 doc 拼回。 */
const toBot = (row: BotRow): Bot => {
  const doc = parseDoc(row.doc);
  const ref = doc.ref ?? {};
  const displayName = text(doc.displayName);
  const color = text(doc.color);
  return {
    id: row.id,
    projectId: asProjectId(row.project_id),
    name: row.name,
    ...(displayName ? { displayName } : {}),
    ...(color ? { color } : {}),
    description: text(doc.description),
    ref: { runtime: text(ref.runtime), model: text(ref.model), options: parseOptions(ref.options) },
    reuse: (text(doc.reuse) || 'sticky') as RoleReuse,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
};

/** 项目 bot：UNIQUE(project_id, name) 保证 @id 不重复；按 created_at 再按 name 列。 */
export function createSqliteBotRepository(db: DatabaseSync): BotRepository {
  db.exec(SCHEMA);
  const selectById = db.prepare('SELECT * FROM bots WHERE id = ?');
  const selectByName = db.prepare('SELECT * FROM bots WHERE project_id = ? AND name = ?');
  const selectByProject = db.prepare('SELECT * FROM bots WHERE project_id = ? ORDER BY created_at, name');
  const upsert = db.prepare(
    'INSERT INTO bots(id, project_id, name, doc, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, name = excluded.name, doc = excluded.doc, ' +
      'created_at = excluded.created_at, updated_at = excluded.updated_at'
  );
  const removeById = db.prepare('DELETE FROM bots WHERE id = ?');

  return {
    async byId(id) {
      const row = selectById.get(id) as unknown as BotRow | undefined;
      return row ? toBot(row) : null;
    },
    async byName(projectId, name) {
      const row = selectByName.get(projectId, name) as unknown as BotRow | undefined;
      return row ? toBot(row) : null;
    },
    async list(projectId) {
      return (selectByProject.all(projectId) as unknown as BotRow[]).map(toBot);
    },
    async save(bot: Bot): Promise<void> {
      const doc: BotDoc = {
        ref: { runtime: bot.ref.runtime, model: bot.ref.model, options: bot.ref.options },
        ...(bot.displayName !== undefined ? { displayName: bot.displayName } : {}),
        ...(bot.color !== undefined ? { color: bot.color } : {}),
        description: bot.description,
        reuse: bot.reuse
      };
      upsert.run(bot.id, bot.projectId, bot.name, JSON.stringify(doc), bot.createdAt, bot.updatedAt);
    },
    async remove(id) {
      removeById.run(id);
    }
  };
}
