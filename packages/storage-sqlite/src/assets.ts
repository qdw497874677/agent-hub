import type { DatabaseSync } from 'node:sqlite';
import type { Asset, AssetFile, AssetKind, AssetRepository, AssetRevision, AssetSource } from '@agent-hub/domain';

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
  UNIQUE(kind, name)
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
`;

type Row = Record<string, unknown>;

const toAsset = (row: Row): Asset => ({
  id: String(row['id']),
  kind: String(row['kind']) as AssetKind,
  name: String(row['name']),
  description: String(row['description']),
  source: JSON.parse(String(row['source'])) as AssetSource,
  pinned: String(row['pinned']),
  latest: String(row['latest']),
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
  db.exec(ASSET_SCHEMA);
  const all = db.prepare('SELECT * FROM assets ORDER BY kind, name');
  const byId = db.prepare('SELECT * FROM assets WHERE id = ?');
  const byName = db.prepare('SELECT * FROM assets WHERE kind = ? AND name = ?');
  const insertAsset = db.prepare(
    'INSERT INTO assets(id, kind, name, description, source, pinned, latest, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
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
    byName: async (kind, name) => {
      const row = byName.get(kind, name) as Row | undefined;
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
          asset.updatedAt
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
    }
  };
}
