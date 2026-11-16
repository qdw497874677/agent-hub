import type { DatabaseSync } from 'node:sqlite';
import type { AssetSet, AssetSetItem, AssetSetRepository } from '@agent-hub/domain';
import { upsertSql } from './upsert.ts';

/**
 * 资产组合（团队级）：组合本身存这里，项目默认引用 / 会话显式选择存在各自的 asset_set_ids 列。
 * 引用不复制资产，解析时仍走可见性 + 已安装两道关。
 */
export const ASSET_SET_SCHEMA = `
CREATE TABLE IF NOT EXISTS asset_sets (
  id         TEXT PRIMARY KEY,
  team_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  doc        TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (team_id, name)
);
CREATE INDEX IF NOT EXISTS asset_sets_team ON asset_sets(team_id, updated_at);
`;

type Row = Record<string, unknown>;

interface AssetSetDoc {
  readonly description: string | null;
  readonly items: readonly AssetSetItem[];
  readonly createdBy: string | null;
}

const parseItems = (value: unknown): readonly AssetSetItem[] => {
  if (!Array.isArray(value)) return [];
  const items: AssetSetItem[] = [];
  for (const raw of value) {
    const assetId = typeof raw === 'object' && raw !== null && typeof (raw as { assetId?: unknown }).assetId === 'string'
      ? (raw as { assetId: string }).assetId.trim()
      : '';
    if (assetId !== '') items.push({ assetId });
  }
  return items;
};

const parseDoc = (value: unknown): AssetSetDoc => {
  if (typeof value !== 'string' || value === '') return { description: null, items: [], createdBy: null };
  try {
    const doc = JSON.parse(value) as Record<string, unknown>;
    return {
      description: typeof doc['description'] === 'string' ? doc['description'] : null,
      items: parseItems(doc['items']),
      createdBy: typeof doc['createdBy'] === 'string' ? doc['createdBy'] : null
    };
  } catch {
    return { description: null, items: [], createdBy: null };
  }
};

const toAssetSet = (row: Row): AssetSet => {
  const doc = parseDoc(row['doc']);
  return {
    id: String(row['id']),
    teamId: String(row['team_id']),
    name: String(row['name']),
    description: doc.description,
    items: doc.items,
    createdBy: doc.createdBy,
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at'])
  };
};

export function createSqliteAssetSets(db: DatabaseSync): AssetSetRepository {
  db.exec(ASSET_SET_SCHEMA);
  const get = db.prepare('SELECT * FROM asset_sets WHERE id = ?');
  const byTeam = db.prepare('SELECT * FROM asset_sets WHERE team_id = ? ORDER BY updated_at DESC, rowid DESC');
  const del = db.prepare('DELETE FROM asset_sets WHERE id = ?');
  const put = db.prepare(
    upsertSql('asset_sets', ['id', 'team_id', 'name', 'doc', 'created_at', 'updated_at'])
  );
  return {
    byId: async (id) => {
      const row = get.get(id) as Row | undefined;
      return row ? toAssetSet(row) : null;
    },
    listByTeam: async (teamId) => (byTeam.all(teamId) as Row[]).map(toAssetSet),
    save: async (set) => {
      const doc: AssetSetDoc = { description: set.description, items: set.items, createdBy: set.createdBy };
      put.run(set.id, set.teamId, set.name, JSON.stringify(doc), set.createdAt, set.updatedAt);
    },
    remove: async (id) => {
      del.run(id);
    }
  };
}
