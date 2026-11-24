import type { DatabaseSync } from 'node:sqlite';

/** Authenticated role and, for remote workers, the immutable enrollment generation. */
export type MachineObserveBinding =
  | { readonly origin: 'local' }
  | { readonly origin: 'remote'; readonly workerId: string; readonly enrolledBy: string; readonly createdAt: number };

export interface MachineObserveRecord {
  readonly id: string;
  readonly workerId: string;
  readonly origin: 'local' | 'remote';
  readonly enrollment: { readonly enrolledBy: string; readonly createdAt: number } | null;
  readonly connectedAt: number;
  readonly disconnectedAt: number | null;
}

export interface MachineObserveAppend {
  readonly connectionId: string;
  readonly workerId: string;
  readonly origin: 'local' | 'remote';
  readonly enrollment: { readonly enrolledBy: string; readonly createdAt: number } | null;
  readonly kind: 'connected' | 'disconnected';
  readonly at: number;
}

export const MACHINE_OBSERVE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const MACHINE_OBSERVE_MAX_ROWS = 100_000;
// Wire's worker id is an unbounded non-empty string. Observe deliberately supports
// at most 512 UTF-8 bytes per identifier (including 120 four-byte characters);
// larger IDs remain valid for the handshake but are not recorded or projected.
export const MACHINE_OBSERVE_ID_MAX_BYTES = 512;
type Row = { connection_id: string; worker_id: string; origin: 'local' | 'remote'; enrolled_by: string | null; enrollment_created_at: number | null; connected_at: number; disconnected_at: number | null };
const mapRow = (r: Row): MachineObserveRecord => ({ id: r.connection_id, workerId: r.worker_id, origin: r.origin, enrollment: r.enrolled_by === null || r.enrollment_created_at === null ? null : { enrolledBy: r.enrolled_by, createdAt: r.enrollment_created_at }, connectedAt: r.connected_at, disconnectedAt: r.disconnected_at });
const timestamp = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= 8_640_000_000_000_000;
const text = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= MACHINE_OBSERVE_ID_MAX_BYTES && s.isWellFormed() && !/[\u0000-\u001f\u007f]/.test(s) && Buffer.byteLength(s, 'utf8') <= MACHINE_OBSERVE_ID_MAX_BYTES;

export function createSqliteMachineObserve(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS machine_observe_connections (
    connection_id TEXT PRIMARY KEY, worker_id TEXT NOT NULL,
    origin TEXT NOT NULL CHECK(origin IN ('local','remote')),
    enrolled_by TEXT, enrollment_created_at INTEGER,
    connected_at INTEGER NOT NULL, disconnected_at INTEGER,
    CHECK((origin = 'local' AND enrolled_by IS NULL AND enrollment_created_at IS NULL)
       OR (origin = 'remote' AND enrolled_by IS NOT NULL AND enrollment_created_at IS NOT NULL))
  );
  CREATE INDEX IF NOT EXISTS machine_observe_time ON machine_observe_connections(connected_at DESC, connection_id DESC);`);
  const insert = db.prepare('INSERT OR IGNORE INTO machine_observe_connections VALUES (?, ?, ?, ?, ?, ?, NULL)');
  const close = db.prepare(`UPDATE machine_observe_connections SET disconnected_at = ?
    WHERE connection_id = ? AND worker_id = ? AND origin = ? AND enrolled_by IS ? AND enrollment_created_at IS ?
      AND disconnected_at IS NULL AND connected_at <= ?`);
  const expired = db.prepare('DELETE FROM machine_observe_connections WHERE connection_id IN (SELECT connection_id FROM machine_observe_connections WHERE connected_at < ? ORDER BY connected_at ASC, connection_id ASC LIMIT 256)');
  const count = db.prepare('SELECT count(*) AS n FROM machine_observe_connections');
  const trim = db.prepare('DELETE FROM machine_observe_connections WHERE connection_id IN (SELECT connection_id FROM machine_observe_connections ORDER BY connected_at ASC, connection_id ASC LIMIT ?)');
  const byId = db.prepare('SELECT * FROM machine_observe_connections WHERE connection_id = ?');
  const list = db.prepare(`SELECT m.* FROM machine_observe_connections m INDEXED BY machine_observe_time
    WHERE m.connected_at >= ?
      AND length(CAST(m.connection_id AS BLOB)) BETWEEN 1 AND 512
      AND length(CAST(m.worker_id AS BLOB)) BETWEEN 1 AND 512
      AND (m.enrolled_by IS NULL OR length(CAST(m.enrolled_by AS BLOB)) BETWEEN 1 AND 512)
      AND EXISTS (SELECT 1 FROM json_each(?) b WHERE
      (json_extract(b.value, '$.origin') = 'local' AND m.origin = 'local') OR
      (json_extract(b.value, '$.origin') = 'remote' AND m.origin = 'remote'
       AND m.worker_id = json_extract(b.value, '$.workerId')
       AND m.enrolled_by = json_extract(b.value, '$.enrolledBy')
       AND m.enrollment_created_at = json_extract(b.value, '$.createdAt')))
    ORDER BY m.connected_at DESC, m.connection_id DESC LIMIT ?`);
  return {
    append(input: MachineObserveAppend): void {
      if (!input || !text(input.connectionId) || !text(input.workerId) || !timestamp(input.at) ||
        (input.kind !== 'connected' && input.kind !== 'disconnected') ||
        !((input.origin === 'local' && input.enrollment === null) || (input.origin === 'remote' && input.enrollment !== null && text(input.enrollment?.enrolledBy) && timestamp(input.enrollment?.createdAt)))) return;
      const owner = input.enrollment?.enrolledBy ?? null;
      const generation = input.enrollment?.createdAt ?? null;
      if (input.kind === 'connected') insert.run(input.connectionId, input.workerId, input.origin, owner, generation, input.at);
      else close.run(input.at, input.connectionId, input.workerId, input.origin, owner, generation, input.at);
      // Event time is supplied by the authenticated lifecycle, never guessed during startup.
      expired.run(input.at - MACHINE_OBSERVE_RETENTION_MS);
      const excess = Number((count.get() as { n: number }).n) - MACHINE_OBSERVE_MAX_ROWS;
      if (excess > 0) trim.run(Math.min(excess, 256));
    },
    list(input: { readonly bindings: readonly MachineObserveBinding[]; readonly since: number; readonly limit: number }): readonly MachineObserveRecord[] {
      if (!input || !Array.isArray(input.bindings) || input.bindings.length === 0) return [];
      const bindings: MachineObserveBinding[] = [];
      for (const b of input.bindings) {
        if (!b || typeof b !== 'object') continue;
        if (b.origin === 'local') bindings.push({ origin: 'local' });
        else if (b.origin === 'remote' && text(b.workerId) && text(b.enrolledBy) && timestamp(b.createdAt)) bindings.push({ origin: 'remote', workerId: b.workerId, enrolledBy: b.enrolledBy, createdAt: b.createdAt });
      }
      if (!bindings.length) return [];
      const since = timestamp(input.since) ? input.since : 0;
      const limit = Math.max(1, Math.min(501, Number.isFinite(input.limit) ? Math.trunc(input.limit) : 501));
      return (list.all(since, JSON.stringify(bindings), limit) as Row[]).filter((r) => text(r.connection_id) && text(r.worker_id) && (r.enrolled_by === null || text(r.enrolled_by))).map(mapRow);
    },
    byId(id: string): MachineObserveRecord | null {
      if (!text(id)) return null;
      const row = byId.get(id) as Row | undefined;
      return row && text(row.connection_id) && text(row.worker_id) && (row.enrolled_by === null || text(row.enrolled_by)) ? mapRow(row) : null;
    }
  };
}
