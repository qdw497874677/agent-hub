import type { DatabaseSync } from 'node:sqlite';
import type { EnrollmentRepository, PairingCode, WorkerCredential } from '@agent-hub/domain';
import { asUserId } from '@agent-hub/domain';

/** 单台机器接入：两张表都只存令牌的 SHA-256（docs/design/worker-enrollment.md）。 */
export const ENROLLMENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS pairing_codes (
  hash       TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  worker_id  TEXT
);
CREATE TABLE IF NOT EXISTS worker_credentials (
  worker_id   TEXT PRIMARY KEY,
  token_hash  TEXT NOT NULL UNIQUE,
  enrolled_by TEXT NOT NULL,
  label       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);
`;

type Row = Record<string, unknown>;

const toPairing = (row: Row): PairingCode => ({
  hash: String(row['hash']),
  createdBy: asUserId(String(row['created_by'])),
  createdAt: Number(row['created_at']),
  expiresAt: Number(row['expires_at']),
  usedAt: row['used_at'] == null ? null : Number(row['used_at']),
  workerId: row['worker_id'] == null ? null : String(row['worker_id']),
  capabilities: row['capabilities'] == null ? null : (JSON.parse(String(row['capabilities'])) as string[])
});

const toCredential = (row: Row): WorkerCredential => ({
  workerId: String(row['worker_id']),
  tokenHash: String(row['token_hash']),
  enrolledBy: asUserId(String(row['enrolled_by'])),
  label: String(row['label']),
  createdAt: Number(row['created_at']),
  revokedAt: row['revoked_at'] == null ? null : Number(row['revoked_at']),
  capabilities: row['capabilities'] == null ? null : (JSON.parse(String(row['capabilities'])) as string[]),
  lastConnectedAt: row['last_connected_at'] == null ? null : Number(row['last_connected_at']),
  lastAddress: row['last_address'] == null ? null : String(row['last_address']),
  lastUserAgent: row['last_user_agent'] == null ? null : String(row['last_user_agent']),
  rotatedAt: row['rotated_at'] == null ? null : Number(row['rotated_at']),
  pendingHash: row['pending_hash'] == null ? null : String(row['pending_hash']),
  pendingUntil: row['pending_until'] == null ? null : Number(row['pending_until']),
  rotationFailedAt: row['rotation_failed_at'] == null ? null : Number(row['rotation_failed_at'])
});

/** ADR 0030 D3/D4 新列：只加列，老库升级不丢数据；null = 老凭据（能力按 full）。 */
const ADDED_COLUMNS: readonly [string, string][] = [
  ['capabilities', 'TEXT'],
  ['last_connected_at', 'INTEGER'],
  ['last_address', 'TEXT'],
  ['last_user_agent', 'TEXT'],
  ['rotated_at', 'INTEGER'],
  // P4：轮换中的新凭据（宽限期内新旧都认）与失败时间
  ['pending_hash', 'TEXT'],
  ['pending_until', 'INTEGER'],
  ['rotation_failed_at', 'INTEGER']
];

/** P4：配对码带能力预设（展开后的能力集）；null = 老码，按 full。 */
const PAIRING_ADDED_COLUMNS: readonly [string, string][] = [['capabilities', 'TEXT']];

function migrate(db: DatabaseSync): void {
  const have = new Set((db.prepare('PRAGMA table_info(worker_credentials)').all() as Row[]).map((r) => String(r['name'])));
  for (const [name, type] of ADDED_COLUMNS) if (!have.has(name)) db.exec(`ALTER TABLE worker_credentials ADD COLUMN ${name} ${type}`);
  const havePairing = new Set((db.prepare('PRAGMA table_info(pairing_codes)').all() as Row[]).map((r) => String(r['name'])));
  for (const [name, type] of PAIRING_ADDED_COLUMNS) if (!havePairing.has(name)) db.exec(`ALTER TABLE pairing_codes ADD COLUMN ${name} ${type}`);
}

export function createEnrollmentRepository(db: DatabaseSync): EnrollmentRepository {
  db.exec(ENROLLMENT_SCHEMA);
  migrate(db);
  const insertPairing = db.prepare(
    'INSERT INTO pairing_codes(hash, created_by, created_at, expires_at, used_at, worker_id, capabilities) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const pairingByHash = db.prepare('SELECT * FROM pairing_codes WHERE hash = ?');
  const consume = db.prepare('UPDATE pairing_codes SET used_at = ?, worker_id = ? WHERE hash = ? AND used_at IS NULL');
  // 过期一天的码顺手清掉，表不会无限长
  const sweep = db.prepare('DELETE FROM pairing_codes WHERE expires_at < ?');
  const upsertCredential = db.prepare(
    'INSERT INTO worker_credentials(worker_id, token_hash, enrolled_by, label, created_at, revoked_at, capabilities, rotated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(worker_id) DO UPDATE SET token_hash = excluded.token_hash, enrolled_by = excluded.enrolled_by, ' +
      'label = excluded.label, created_at = excluded.created_at, revoked_at = excluded.revoked_at, ' +
      'capabilities = excluded.capabilities, rotated_at = excluded.rotated_at'
  );
  const credentialByHash = db.prepare('SELECT * FROM worker_credentials WHERE token_hash = ? OR pending_hash = ? LIMIT 1');
  const credentialFor = db.prepare('SELECT * FROM worker_credentials WHERE worker_id = ?');
  const allCredentials = db.prepare('SELECT * FROM worker_credentials ORDER BY created_at ASC');
  const revoke = db.prepare('UPDATE worker_credentials SET revoked_at = ? WHERE worker_id = ? AND revoked_at IS NULL');
  const recordConnection = db.prepare(
    'UPDATE worker_credentials SET last_connected_at = ?, last_address = ?, last_user_agent = ? WHERE worker_id = ?'
  );
  const setCapabilities = db.prepare('UPDATE worker_credentials SET capabilities = ? WHERE worker_id = ?');
  const beginRotation = db.prepare('UPDATE worker_credentials SET pending_hash = ?, pending_until = ? WHERE worker_id = ?');
  const completeRotation = db.prepare(
    'UPDATE worker_credentials SET token_hash = pending_hash, pending_hash = NULL, pending_until = NULL, rotated_at = ? WHERE worker_id = ? AND pending_hash = ?'
  );
  const failRotation = db.prepare('UPDATE worker_credentials SET pending_hash = NULL, pending_until = NULL, rotation_failed_at = ? WHERE worker_id = ?');

  return {
    async savePairing(code) {
      sweep.run(code.createdAt - 24 * 60 * 60 * 1000);
      insertPairing.run(code.hash, code.createdBy, code.createdAt, code.expiresAt, code.usedAt, code.workerId, code.capabilities == null ? null : JSON.stringify(code.capabilities));
    },
    async pairingByHash(hash) {
      const row = pairingByHash.get(hash) as Row | undefined;
      return row ? toPairing(row) : null;
    },
    async consumePairing(hash, workerId, at) {
      return Number(consume.run(at, workerId, hash).changes) === 1;
    },
    async saveCredential(c) {
      upsertCredential.run(
        c.workerId,
        c.tokenHash,
        c.enrolledBy,
        c.label,
        c.createdAt,
        c.revokedAt,
        c.capabilities == null ? null : JSON.stringify(c.capabilities),
        c.rotatedAt ?? null
      );
    },
    async credentialByHash(hash) {
      const row = credentialByHash.get(hash, hash) as Row | undefined;
      return row ? toCredential(row) : null;
    },
    async credentialFor(workerId) {
      const row = credentialFor.get(workerId) as Row | undefined;
      return row ? toCredential(row) : null;
    },
    async listCredentials() {
      return (allCredentials.all() as Row[]).map(toCredential);
    },
    async revoke(workerId, at) {
      revoke.run(at, workerId);
    },
    async recordConnection(workerId, c) {
      recordConnection.run(c.at, c.address, c.userAgent, workerId);
    },
    async setCapabilities(workerId, capabilities) {
      setCapabilities.run(JSON.stringify(capabilities), workerId);
    },
    async beginRotation(workerId, pendingHash, until) {
      beginRotation.run(pendingHash, until, workerId);
    },
    async completeRotation(workerId, pendingHash, at) {
      return Number(completeRotation.run(at, workerId, pendingHash).changes) === 1;
    },
    async failRotation(workerId, at) {
      failRotation.run(at, workerId);
    }
  };
}
