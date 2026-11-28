import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

export interface DevelopmentPreviewReservation {
  readonly id: string;
  readonly workerId: string;
  readonly workspaceId: string;
  readonly root: string;
  /** Canonical cwd observed for this listener; never part of the browser DTO. */
  readonly cwd: string;
  readonly port: number;
  readonly hubPort: number;
  readonly listenerIdentity: string;
}

export interface DevelopmentPreviewStore {
  byService(id: string): DevelopmentPreviewReservation | null;
  byPort(hubPort: number): DevelopmentPreviewReservation | null;
  list(): readonly DevelopmentPreviewReservation[];
  reserve(reservation: Omit<DevelopmentPreviewReservation, 'hubPort'>, range: { from: number; to: number }): DevelopmentPreviewReservation | null;
}

type Row = Record<string, SQLOutputValue>;
const fromRow = (row: Row): DevelopmentPreviewReservation => ({
  id: String(row.id), workerId: String(row.worker_id), workspaceId: String(row.workspace_id),
  root: String(row.root), cwd: String(row.cwd), port: Number(row.port), hubPort: Number(row.hub_port),
  listenerIdentity: String(row.listener_identity),
});
const validPort = (port: number): boolean => Number.isInteger(port) && port >= 1 && port <= 65535;
const validString = (value: string): boolean => typeof value === 'string' && value.length > 0;

/** Reservations are permanent: a port is never recycled by this store. */
export function createDevelopmentPreviewStore(db: DatabaseSync): DevelopmentPreviewStore {
  db.exec(`CREATE TABLE IF NOT EXISTS development_preview_reservations (
    id TEXT PRIMARY KEY NOT NULL,
    worker_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    root TEXT NOT NULL,
    cwd TEXT NOT NULL,
    port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
    hub_port INTEGER NOT NULL UNIQUE CHECK (hub_port BETWEEN 1 AND 65535),
    listener_identity TEXT NOT NULL
  )`);
  const byService = (id: string): DevelopmentPreviewReservation | null => {
    const row = db.prepare('SELECT * FROM development_preview_reservations WHERE id = ?').get(id);
    return row ? fromRow(row) : null;
  };
  return {
    byService,
    byPort(hubPort) {
      const row = db.prepare('SELECT * FROM development_preview_reservations WHERE hub_port = ?').get(hubPort);
      return row ? fromRow(row) : null;
    },
    list: () => db.prepare('SELECT * FROM development_preview_reservations ORDER BY hub_port').all().map(fromRow),
    reserve(reservation, range) {
      if (!reservation || !range || !validString(reservation.id) || !validString(reservation.workerId)
        || !validString(reservation.workspaceId) || !validString(reservation.root) || !validString(reservation.cwd)
        || !validString(reservation.listenerIdentity) || !validPort(reservation.port)
        || !validPort(range.from) || !validPort(range.to) || range.from > range.to) return null;

      db.exec('SAVEPOINT development_preview_reserve');
      try {
        const existing = byService(reservation.id);
        if (existing) {
          const matches = existing.workerId === reservation.workerId && existing.workspaceId === reservation.workspaceId
            && existing.root === reservation.root && existing.cwd === reservation.cwd && existing.port === reservation.port
            && existing.listenerIdentity === reservation.listenerIdentity;
          db.exec('RELEASE development_preview_reserve');
          return matches ? existing : null;
        }
        let hubPort = range.from;
        const rows = db.prepare('SELECT hub_port FROM development_preview_reservations WHERE hub_port BETWEEN ? AND ? ORDER BY hub_port').all(range.from, range.to);
        for (const row of rows) {
          if (Number(row.hub_port) !== hubPort) break;
          hubPort++;
        }
        if (hubPort > range.to) {
          db.exec('RELEASE development_preview_reserve');
          return null;
        }
        db.prepare(`INSERT INTO development_preview_reservations
          (id, worker_id, workspace_id, root, cwd, port, hub_port, listener_identity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(reservation.id, reservation.workerId, reservation.workspaceId, reservation.root, reservation.cwd, reservation.port, hubPort, reservation.listenerIdentity);
        db.exec('RELEASE development_preview_reserve');
        return { id: reservation.id, workerId: reservation.workerId, workspaceId: reservation.workspaceId,
          root: reservation.root, cwd: reservation.cwd, port: reservation.port, hubPort, listenerIdentity: reservation.listenerIdentity };
      } catch (error) {
        db.exec('ROLLBACK TO development_preview_reserve');
        db.exec('RELEASE development_preview_reserve');
        throw error;
      }
    },
  };
}
