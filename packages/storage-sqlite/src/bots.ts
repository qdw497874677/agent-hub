import type { DatabaseSync } from 'node:sqlite';
import {
  asProjectId,
  asWorkspaceId,
  type Bot,
  type BotGrant,
  type BotRepository,
  type RoleReuse
} from '@agent-hub/domain';
import { inTransaction } from './tx.ts';
import { upsertSql } from './upsert.ts';

/** 老库里的 bot 没有团队可归时落到这里（原项目已删、或项目没有 team_id）。 */
const LEGACY_TEAM_ID = 'team_legacy';

const GRANT_SCHEMA = `
CREATE TABLE IF NOT EXISTS bot_grants (
  bot_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  workspace_id TEXT,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  PRIMARY KEY (bot_id, project_id)
);
CREATE INDEX IF NOT EXISTS bot_grants_project ON bot_grants(project_id);
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  name TEXT NOT NULL,
  doc TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(team_id, name)
);
CREATE INDEX IF NOT EXISTS bots_team ON bots(team_id);
${GRANT_SCHEMA}
`;

interface BotRow {
  id: string;
  team_id: string;
  name: string;
  doc: string;
  created_at: number;
  updated_at: number;
}

interface GrantRow {
  bot_id: string;
  project_id: string;
  workspace_id: string | null;
  created_at: number;
  created_by: string | null;
}

interface LegacyBotRow {
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

/** 行 → Bot：id / teamId / name / 时间戳在列上，其余从 doc 拼回。 */
const toBot = (row: BotRow): Bot => {
  const doc = parseDoc(row.doc);
  const ref = doc.ref ?? {};
  const displayName = text(doc.displayName);
  const color = text(doc.color);
  return {
    id: row.id,
    teamId: row.team_id,
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

/** 行 → BotGrant；workspace_id 可空（NULL = 跟随项目默认工作空间）。 */
const toGrant = (row: GrantRow): BotGrant => ({
  botId: row.bot_id,
  projectId: asProjectId(row.project_id),
  workspaceId: row.workspace_id === null ? null : asWorkspaceId(row.workspace_id),
  createdAt: row.created_at,
  createdBy: row.created_by
});

/**
 * 老库升级：项目级 bot（`project_id NOT NULL` + `UNIQUE(project_id, name)`）
 * → 团队级 bot（`team_id` + `UNIQUE(team_id, name)`）+ `bot_grants`。
 *
 * 幂等：`PRAGMA table_info(bots)` 里已经有 `team_id` 就直接返回；表还不存在也直接返回
 * （随后 `SCHEMA` 会建新表）。
 *
 * 老 bot 的 `team_id` 从它原来的项目上取；项目已删或团队为空时落到 `team_legacy`——
 * 宁可让它们挂在一个显式的「遗留团队」下可见可改，也不要因为缺少归属而丢数据。
 *
 * `PRAGMA foreign_keys` 在事务里不生效，所以关/开都放在 `BEGIN IMMEDIATE` 外面；
 * 事务只包 DDL/DML（否则 `DROP TABLE bots` 会被引用它的子表挡住）。
 */
export function migrateBotsToTeamScope(db: DatabaseSync): void {
  const exists =
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'bots'").get() !== undefined;
  if (!exists) return;
  const columns = db.prepare('PRAGMA table_info(bots)').all() as { name: string }[];
  if (columns.some((column) => column.name === 'team_id')) return;

  const hasProjects =
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get() !== undefined;

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    inTransaction(db, () => {
      const legacy = db
        .prepare('SELECT id, project_id, name, doc, created_at, updated_at FROM bots')
        .all() as unknown as LegacyBotRow[];
      const teamOfProject = hasProjects
        ? db.prepare('SELECT team_id FROM projects WHERE id = ?')
        : null;

      db.exec(`
        CREATE TABLE bots_new (
          id TEXT PRIMARY KEY,
          team_id TEXT NOT NULL,
          name TEXT NOT NULL,
          doc TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(team_id, name)
        );
      `);
      db.exec(GRANT_SCHEMA);
      const insertBot = db.prepare(
        'INSERT INTO bots_new(id, team_id, name, doc, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      );
      // 每行老 bot 转一条授权：原来的项目就是它一开始能干活的地方。
      const insertGrant = db.prepare(
        'INSERT OR IGNORE INTO bot_grants(bot_id, project_id, workspace_id, created_at, created_by) ' +
          'VALUES (?, ?, NULL, ?, NULL)'
      );

      for (const row of legacy) {
        const project = teamOfProject?.get(row.project_id) as { team_id?: string | null } | undefined;
        const teamId = project?.team_id ? project.team_id : LEGACY_TEAM_ID;
        insertBot.run(row.id, teamId, row.name, row.doc, row.created_at, row.updated_at);
        insertGrant.run(row.id, row.project_id, row.created_at);
      }

      db.exec('DROP TABLE bots');
      db.exec('ALTER TABLE bots_new RENAME TO bots');
      db.exec('CREATE INDEX IF NOT EXISTS bots_team ON bots(team_id)');
      db.exec('CREATE INDEX IF NOT EXISTS bot_grants_project ON bot_grants(project_id)');
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/**
 * bot 存储。bot 是团队级实体：`UNIQUE(team_id, name)` 保证团队内 @id 不重复；
 * 能进哪个项目由 `bot_grants` 决定（`listForProject` 走 join）。
 */
export function createSqliteBotRepository(db: DatabaseSync): BotRepository {
  // 老库必须先生成 team_id 再执行 SCHEMA（否则 `bots_team` 索引会因缺列建不出来）。
  migrateBotsToTeamScope(db);
  db.exec(SCHEMA);
  const selectById = db.prepare('SELECT * FROM bots WHERE id = ?');
  const selectByName = db.prepare('SELECT * FROM bots WHERE team_id = ? AND name = ?');
  const selectByTeam = db.prepare('SELECT * FROM bots WHERE team_id = ? ORDER BY created_at, name');
  const selectForProject = db.prepare(
    'SELECT b.* FROM bots b JOIN bot_grants g ON g.bot_id = b.id ' +
      'WHERE g.project_id = ? ORDER BY b.created_at, b.name'
  );
  const upsert = db.prepare(
    upsertSql('bots', ['id', 'team_id', 'name', 'doc', 'created_at', 'updated_at'], 'id')
  );
  const removeById = db.prepare('DELETE FROM bots WHERE id = ?');
  const selectGrantsOf = db.prepare(
    'SELECT * FROM bot_grants WHERE bot_id = ? ORDER BY created_at, project_id'
  );
  const selectGrantsForProject = db.prepare(
    'SELECT * FROM bot_grants WHERE project_id = ? ORDER BY created_at, bot_id'
  );
  // 只改 workspaceId：created_at / created_by 保留第一次授权的值。
  const upsertGrant = db.prepare(
    'INSERT INTO bot_grants(bot_id, project_id, workspace_id, created_at, created_by) VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT(bot_id, project_id) DO UPDATE SET workspace_id = excluded.workspace_id'
  );
  const removeGrant = db.prepare('DELETE FROM bot_grants WHERE bot_id = ? AND project_id = ?');

  return {
    async byId(id) {
      const row = selectById.get(id) as unknown as BotRow | undefined;
      return row ? toBot(row) : null;
    },
    async byName(teamId, name) {
      const row = selectByName.get(teamId, name) as unknown as BotRow | undefined;
      return row ? toBot(row) : null;
    },
    async listByTeam(teamId) {
      return (selectByTeam.all(teamId) as unknown as BotRow[]).map(toBot);
    },
    async listForProject(projectId) {
      return (selectForProject.all(projectId) as unknown as BotRow[]).map(toBot);
    },
    async save(bot: Bot): Promise<void> {
      const doc: BotDoc = {
        ref: { runtime: bot.ref.runtime, model: bot.ref.model, options: bot.ref.options },
        ...(bot.displayName !== undefined ? { displayName: bot.displayName } : {}),
        ...(bot.color !== undefined ? { color: bot.color } : {}),
        description: bot.description,
        reuse: bot.reuse
      };
      upsert.run(bot.id, bot.teamId, bot.name, JSON.stringify(doc), bot.createdAt, bot.updatedAt);
    },
    async remove(id) {
      removeById.run(id);
    },
    async grantsOf(botId) {
      return (selectGrantsOf.all(botId) as unknown as GrantRow[]).map(toGrant);
    },
    async grantsForProject(projectId) {
      return (selectGrantsForProject.all(projectId) as unknown as GrantRow[]).map(toGrant);
    },
    async grant(grant: BotGrant): Promise<void> {
      upsertGrant.run(
        grant.botId,
        grant.projectId,
        grant.workspaceId,
        grant.createdAt,
        grant.createdBy
      );
    },
    async revoke(botId, projectId) {
      removeGrant.run(botId, projectId);
    }
  };
}
