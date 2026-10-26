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
  workerId: row['worker_id'] == null ? null : String(row['worker_id'])
});

const toCredential = (row: Row): WorkerCredential => ({
  workerId: String(row['worker_id']),
  tokenHash: String(row['token_hash']),
  enrolledBy: asUserId(String(row['enrolled_by'])),
  label: String(row['label']),
  createdAt: Number(row['created_at']),
  revokedAt: row['revoked_at'] == null ? null : Number(row['revoked_at'])
});

export function createEnrollmentRepository(db: DatabaseSync): EnrollmentRepository {
  db.exec(ENROLLMENT_SCHEMA);
  const insertPairing = db.prepare(
    'INSERT INTO pairing_codes(hash, created_by, created_at, expires_at, used_at, worker_id) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const pairingByHash = db.prepare('SELECT * FROM pairing_codes WHERE hash = ?');
  const consume = db.prepare('UPDATE pairing_codes SET used_at = ?, worker_id = ? WHERE hash = ? AND used_at IS NULL');
  // 过期一天的码顺手清掉，表不会无限长
  const sweep = db.prepare('DELETE FROM pairing_codes WHERE expires_at < ?');
  const upsertCredential = db.prepare(
    'INSERT INTO worker_credentials(worker_id, token_hash, enrolled_by, label, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(worker_id) DO UPDATE SET token_hash = excluded.token_hash, enrolled_by = excluded.enrolled_by, ' +
      'label = excluded.label, created_at = excluded.created_at, revoked_at = excluded.revoked_at'
  );
  const credentialByHash = db.prepare('SELECT * FROM worker_credentials WHERE token_hash = ?');
  const credentialFor = db.prepare('SELECT * FROM worker_credentials WHERE worker_id = ?');
  const allCredentials = db.prepare('SELECT * FROM worker_credentials ORDER BY created_at ASC');
  const revoke = db.prepare('UPDATE worker_credentials SET revoked_at = ? WHERE worker_id = ? AND revoked_at IS NULL');

  return {
    async savePairing(code) {
      sweep.run(code.createdAt - 24 * 60 * 60 * 1000);
      insertPairing.run(code.hash, code.createdBy, code.createdAt, code.expiresAt, code.usedAt, code.workerId);
    },
    async pairingByHash(hash) {
      const row = pairingByHash.get(hash) as Row | undefined;
      return row ? toPairing(row) : null;
    },
    async consumePairing(hash, workerId, at) {
      return Number(consume.run(at, workerId, hash).changes) === 1;
    },
    async saveCredential(c) {
      upsertCredential.run(c.workerId, c.tokenHash, c.enrolledBy, c.label, c.createdAt, c.revokedAt);
    },
    async credentialByHash(hash) {
      const row = credentialByHash.get(hash) as Row | undefined;
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
    }
  };
}
