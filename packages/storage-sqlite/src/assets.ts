import type { DatabaseSync } from 'node:sqlite';
import type { Asset, AssetFile, AssetKind, AssetRepository, AssetRevision, AssetSource, AssetSyncBoard, SessionAssetManifest, WorkerAssetSync } from '@agent-hub/domain';

/**
 * 资产中心（docs/design/asset-hub.md）：资产、不可变的版本、按 sha256 寻址的内容、Worker 安装关系。
 * blob 被多个版本共享；删资产时只清掉没人再引用的。
 */
export const ASSET_SCHEMA = `
CREATE TABLE IF NOT EXISTS assets (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  source      TEXT NOT NULL,
  pinned      TEXT NOT NULL,
  latest      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  -- 作用域：'' = 全局，否则是项目 id（见 migrateAssetScope）
  project_id  TEXT NOT NULL DEFAULT '',
  UNIQUE(kind, name, project_id)
);
CREATE TABLE IF NOT EXISTS asset_revisions (
  asset_id    TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  digest      TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  files       TEXT NOT NULL,
  git_commit  TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (asset_id, digest)
);
CREATE TABLE IF NOT EXISTS asset_blobs (
  sha256 TEXT PRIMARY KEY,
  data   BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS asset_installs (
  worker_id  TEXT NOT NULL,
  asset_id   TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (worker_id, asset_id)
);
CREATE TABLE IF NOT EXISTS asset_project_settings (
  project_id TEXT NOT NULL,
  asset_id   TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  enabled    INTEGER NOT NULL,
  PRIMARY KEY (project_id, asset_id)
);
CREATE TABLE IF NOT EXISTS session_assets (
  session_id TEXT PRIMARY KEY,
  manifest   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS asset_sync (
  worker_id TEXT PRIMARY KEY,
  status    TEXT NOT NULL
);
`;

type Row = Record<string, unknown>;

/**
 * 旧库的 assets 表是 UNIQUE(kind, name)、没有作用域列：重建一张（SQLite 改不了约束）。
 * 先关外键再换表，不然 DROP 会级联删掉版本和安装关系；换完再打开。
 */
function migrateAssetScope(db: DatabaseSync): void {
  const columns = db.prepare("SELECT name FROM pragma_table_info('assets')").all() as Row[];
  if (columns.length === 0 || columns.some((column) => column['name'] === 'project_id')) return;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`
CREATE TABLE assets_scoped (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  source      TEXT NOT NULL,
  pinned      TEXT NOT NULL,
  latest      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  project_id  TEXT NOT NULL DEFAULT '',
  UNIQUE(kind, name, project_id)
);
INSERT INTO assets_scoped(id, kind, name, description, source, pinned, latest, created_at, updated_at)
  SELECT id, kind, name, description, source, pinned, latest, created_at, updated_at FROM assets;
DROP TABLE assets;
ALTER TABLE assets_scoped RENAME TO assets;`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

const toAsset = (row: Row): Asset => ({
  id: String(row['id']),
  kind: String(row['kind']) as AssetKind,
  name: String(row['name']),
  description: String(row['description']),
  source: JSON.parse(String(row['source'])) as AssetSource,
  pinned: String(row['pinned']),
  latest: String(row['latest']),
  projectId: row['project_id'] ? String(row['project_id']) : null,
  createdAt: Number(row['created_at']),
  updatedAt: Number(row['updated_at'])
});

const toRevision = (row: Row): AssetRevision => ({
  assetId: String(row['asset_id']),
  digest: String(row['digest']),
  name: String(row['name']),
  description: String(row['description']),
  files: JSON.parse(String(row['files'])) as AssetFile[],
  commit: row['git_commit'] == null ? null : String(row['git_commit']),
  createdAt: Number(row['created_at'])
});

export function createAssetRepository(db: DatabaseSync): AssetRepository {
  migrateAssetScope(db);
  db.exec(ASSET_SCHEMA);
  const all = db.prepare('SELECT * FROM assets ORDER BY kind, name');
  const byId = db.prepare('SELECT * FROM assets WHERE id = ?');
  const putSessionAssets = db.prepare(
    'INSERT INTO session_assets (session_id, manifest) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET manifest = excluded.manifest'
  );
  const sessionAssetsOf = db.prepare('SELECT manifest FROM session_assets WHERE session_id = ?');
  const byName = db.prepare('SELECT * FROM assets WHERE kind = ? AND name = ? AND project_id = ?');
  const insertAsset = db.prepare(
    'INSERT INTO assets(id, kind, name, description, source, pinned, latest, created_at, updated_at, project_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const updateAsset = db.prepare('UPDATE assets SET description = ?, source = ?, pinned = ?, latest = ?, updated_at = ? WHERE id = ?');
  const insertRevision = db.prepare(
    'INSERT OR IGNORE INTO asset_revisions(asset_id, digest, name, description, files, git_commit, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const revisionsOf = db.prepare('SELECT * FROM asset_revisions WHERE asset_id = ? ORDER BY created_at DESC, rowid DESC');
  const revisionOf = db.prepare('SELECT * FROM asset_revisions WHERE asset_id = ? AND digest = ?');
  const insertBlob = db.prepare('INSERT OR IGNORE INTO asset_blobs(sha256, data) VALUES (?, ?)');
  const blobOf = db.prepare('SELECT data FROM asset_blobs WHERE sha256 = ?');
  const deleteRevisions = db.prepare('DELETE FROM asset_revisions WHERE asset_id = ?');
  const deleteInstalls = db.prepare('DELETE FROM asset_installs WHERE asset_id = ?');
  const deleteAsset = db.prepare('DELETE FROM assets WHERE id = ?');
  const referenced = db.prepare('SELECT files FROM asset_revisions');
  const allBlobs = db.prepare('SELECT sha256 FROM asset_blobs');
  const deleteBlob = db.prepare('DELETE FROM asset_blobs WHERE sha256 = ?');
  const installs = db.prepare('SELECT worker_id, asset_id FROM asset_installs ORDER BY created_at');
  const install = db.prepare('INSERT OR IGNORE INTO asset_installs(worker_id, asset_id, created_at) VALUES (?, ?, ?)');
  const uninstall = db.prepare('DELETE FROM asset_installs WHERE worker_id = ? AND asset_id = ?');
  const settingsOf = db.prepare('SELECT asset_id, enabled FROM asset_project_settings WHERE project_id = ?');
  const putSetting = db.prepare(
    'INSERT INTO asset_project_settings(project_id, asset_id, enabled) VALUES (?, ?, ?) ON CONFLICT(project_id, asset_id) DO UPDATE SET enabled = excluded.enabled'
  );
  const clearSetting = db.prepare('DELETE FROM asset_project_settings WHERE project_id = ? AND asset_id = ?');
  const deleteSettings = db.prepare('DELETE FROM asset_project_settings WHERE asset_id = ?');

  const transaction = (work: () => void): void => {
    db.exec('BEGIN IMMEDIATE');
    try {
      work();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const putRevision = (revision: AssetRevision, blobs: ReadonlyMap<string, Uint8Array>): void => {
    for (const [sha, data] of blobs) insertBlob.run(sha, data);
    insertRevision.run(
      revision.assetId,
      revision.digest,
      revision.name,
      revision.description,
      JSON.stringify(revision.files),
      revision.commit,
      revision.createdAt
    );
  };

  return {
    list: async () => (all.all() as Row[]).map(toAsset),
    get: async (id) => {
      const row = byId.get(id) as Row | undefined;
      return row ? toAsset(row) : null;
    },
    byName: async (kind, name, projectId) => {
      const row = byName.get(kind, name, projectId ?? '') as Row | undefined;
      return row ? toAsset(row) : null;
    },
    create: async (asset, revision, blobs) =>
      transaction(() => {
        insertAsset.run(
          asset.id,
          asset.kind,
          asset.name,
          asset.description,
          JSON.stringify(asset.source),
          asset.pinned,
          asset.latest,
          asset.createdAt,
          asset.updatedAt,
          asset.projectId ?? ''
        );
        putRevision(revision, blobs);
      }),
    addRevision: async (revision, blobs) => transaction(() => putRevision(revision, blobs)),
    revisions: async (assetId) => (revisionsOf.all(assetId) as Row[]).map(toRevision),
    revision: async (assetId, digest) => {
      const row = revisionOf.get(assetId, digest) as Row | undefined;
      return row ? toRevision(row) : null;
    },
    update: async (asset) => {
      updateAsset.run(asset.description, JSON.stringify(asset.source), asset.pinned, asset.latest, asset.updatedAt, asset.id);
    },
    remove: async (id) =>
      transaction(() => {
        deleteInstalls.run(id);
        deleteSettings.run(id);
        deleteRevisions.run(id);
        deleteAsset.run(id);
        const live = new Set<string>();
        for (const row of referenced.all() as Row[]) {
          for (const file of JSON.parse(String(row['files'])) as AssetFile[]) live.add(file.sha256);
        }
        for (const row of allBlobs.all() as Row[]) {
          const sha = String(row['sha256']);
          if (!live.has(sha)) deleteBlob.run(sha);
        }
      }),
    blob: async (sha) => {
      const row = blobOf.get(sha) as Row | undefined;
      return row ? new Uint8Array(row['data'] as Uint8Array) : null;
    },
    installations: async () =>
      (installs.all() as Row[]).map((row) => ({ workerId: String(row['worker_id']), assetId: String(row['asset_id']) })),
    install: async (workerId, assetId, at) => {
      install.run(workerId, assetId, at);
    },
    uninstall: async (workerId, assetId) => {
      uninstall.run(workerId, assetId);
    },
    projectSettings: async (projectId) =>
      Object.fromEntries((settingsOf.all(projectId) as Row[]).map((row) => [String(row['asset_id']), Number(row['enabled']) === 1])),
    setProjectSetting: async (projectId, assetId, enabled) => {
      if (enabled === null) clearSetting.run(projectId, assetId);
      else putSetting.run(projectId, assetId, enabled ? 1 : 0);
    },
    recordSessionAssets: async (manifest) => {
      putSessionAssets.run(manifest.sessionId, JSON.stringify(manifest));
    },
    sessionAssets: async (sessionId) => {
      const row = sessionAssetsOf.get(sessionId) as Row | undefined;
      return row ? (JSON.parse(String(row['manifest'])) as SessionAssetManifest) : null;
    }
  };
}

/**
 * 每台 Worker 最近一次同步的情况，落库以便 hub 重启后照样显示。
 * 重启前还在「同步中」的，重启后那次推送已经断了，读出来记成「待同步」（Worker 重连时会再推）。
 */
export function createAssetSyncBoard(db: DatabaseSync): AssetSyncBoard {
  db.exec(ASSET_SCHEMA);
  const read = (row: Row): WorkerAssetSync => {
    const status = JSON.parse(String(row['status'])) as WorkerAssetSync;
    return status.state === 'syncing' ? { ...status, state: 'pending' } : status;
  };
  const one = db.prepare('SELECT status FROM asset_sync WHERE worker_id = ?');
  const every = db.prepare('SELECT status FROM asset_sync ORDER BY worker_id');
  const put = db.prepare('INSERT INTO asset_sync (worker_id, status) VALUES (?, ?) ON CONFLICT(worker_id) DO UPDATE SET status = excluded.status');
  return {
    get(workerId) {
      const row = one.get(workerId) as Row | undefined;
      return row ? read(row) : null;
    },
    set(status) {
      put.run(status.workerId, JSON.stringify(status));
    },
    all: () => (every.all() as Row[]).map(read)
  };
}
