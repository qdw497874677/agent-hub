import type { DatabaseSync } from 'node:sqlite';
import type { CatalogComponent, ComponentCatalogRepository, ComponentPinStore, WorkerComponentPin } from '@agent-hub/domain';

export const COMPONENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS component_catalog (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS component_pins (
  worker_id TEXT NOT NULL,
  component_id TEXT NOT NULL,
  runtime TEXT NOT NULL,
  version TEXT NOT NULL,
  integrity TEXT NOT NULL,
  installed_by TEXT NOT NULL,
  installed_at INTEGER NOT NULL,
  PRIMARY KEY (worker_id, component_id, runtime)
);
`;

/** 运行时套件 P2（ADR 0021 §7）：组件目录 + component_pins。 */
export function createSqliteComponents(db: DatabaseSync): { catalog: ComponentCatalogRepository; pins: ComponentPinStore } {
  db.exec(COMPONENT_SCHEMA);
  const all = db.prepare('SELECT body FROM component_catalog ORDER BY id');
  const one = db.prepare('SELECT body FROM component_catalog WHERE id = ?');
  const put = db.prepare(
    'INSERT INTO component_catalog (id, body, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at'
  );
  const pinsOf = db.prepare('SELECT * FROM component_pins WHERE worker_id = ? ORDER BY component_id');
  const pinPut = db.prepare(
    'INSERT INTO component_pins (worker_id, component_id, runtime, version, integrity, installed_by, installed_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(worker_id, component_id, runtime) DO UPDATE SET version = excluded.version, integrity = excluded.integrity, installed_by = excluded.installed_by, installed_at = excluded.installed_at'
  );
  const pinDel = db.prepare('DELETE FROM component_pins WHERE worker_id = ? AND component_id = ? AND runtime = ?');
  interface PinRow { worker_id: string; component_id: string; runtime: string; version: string; integrity: string; installed_by: string; installed_at: number }
  return {
    catalog: {
      async list() {
        return (all.all() as { body: string }[]).map((row) => JSON.parse(row.body) as CatalogComponent);
      },
      async byId(id) {
        const row = one.get(id) as { body: string } | undefined;
        return row ? (JSON.parse(row.body) as CatalogComponent) : null;
      },
      async save(item) {
        put.run(item.id, JSON.stringify(item), Date.now());
      }
    },
    pins: {
      pinsFor(workerId) {
        return (pinsOf.all(workerId) as unknown as PinRow[]).map(
          (row): WorkerComponentPin => ({
            workerId: row.worker_id,
            componentId: row.component_id,
            runtime: row.runtime,
            version: row.version,
            integrity: row.integrity,
            installedBy: row.installed_by,
            installedAt: row.installed_at
          })
        );
      },
      upsert(pin) {
        pinPut.run(pin.workerId, pin.componentId, pin.runtime, pin.version, pin.integrity, pin.installedBy, pin.installedAt);
      },
      remove(workerId, componentId, runtime) {
        pinDel.run(workerId, componentId, runtime);
      }
    }
  };
}
