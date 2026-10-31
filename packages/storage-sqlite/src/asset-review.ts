import type { DatabaseSync } from 'node:sqlite';
import type {
  AssetReviewRepository,
  AssetReviewSettings,
  AssetSubmission,
  InstallRequest,
  Notification,
  NotificationRepository,
  ReviewComment
} from '@agent-hub/domain';

/**
 * 资产审核（ADR 0016）：提交、评论、安装申请、审核设置、站内通知。
 * 指定审核人存在通用的 access_grants 表里（主体 × 权限 × 资源），给 ADR 0017 的权限重构留口子；
 * 双人审核开关单独存 asset_review_settings。
 */
export const ASSET_REVIEW_SCHEMA = `
CREATE TABLE IF NOT EXISTS asset_submissions (
  id           TEXT PRIMARY KEY,
  asset_id     TEXT NOT NULL,
  digest       TEXT NOT NULL,
  previous     TEXT NOT NULL,
  submitted_by TEXT NOT NULL,
  origin       TEXT NOT NULL,
  token_id     TEXT,
  target_scope TEXT,
  status       TEXT NOT NULL,
  required     INTEGER NOT NULL,
  approvals    TEXT NOT NULL,
  decided_by   TEXT,
  reason       TEXT,
  report       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  decided_at   INTEGER
);
CREATE INDEX IF NOT EXISTS asset_submissions_asset ON asset_submissions(asset_id, created_at);
CREATE INDEX IF NOT EXISTS asset_submissions_status ON asset_submissions(status);
CREATE TABLE IF NOT EXISTS asset_review_comments (
  id            TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL,
  author_id     TEXT NOT NULL,
  path          TEXT,
  line          INTEGER,
  body          TEXT NOT NULL,
  at            INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS asset_install_requests (
  id           TEXT PRIMARY KEY,
  asset_id     TEXT NOT NULL,
  worker_id    TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  status       TEXT NOT NULL,
  decided_by   TEXT,
  reason       TEXT,
  created_at   INTEGER NOT NULL,
  decided_at   INTEGER
);
CREATE TABLE IF NOT EXISTS asset_review_settings (
  key            TEXT PRIMARY KEY,
  two_global     INTEGER NOT NULL DEFAULT 0,
  two_mcp_stdio  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS access_grants (
  subject_id    TEXT NOT NULL,
  permission    TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id   TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (subject_id, permission, resource_type, resource_id)
);
CREATE TABLE IF NOT EXISTS notifications (
  id      TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind    TEXT NOT NULL,
  title   TEXT NOT NULL,
  body    TEXT NOT NULL,
  link    TEXT NOT NULL,
  at      INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, at);
`;

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (v == null ? null : String(v));
const num = (v: unknown): number | null => (v == null ? null : Number(v));

const toSubmission = (row: Row): AssetSubmission => ({
  id: String(row['id']),
  assetId: String(row['asset_id']),
  digest: String(row['digest']),
  previous: String(row['previous']),
  submittedBy: String(row['submitted_by']),
  origin: String(row['origin']) as AssetSubmission['origin'],
  tokenId: str(row['token_id']),
  targetScope: str(row['target_scope']) as AssetSubmission['targetScope'],
  status: String(row['status']) as AssetSubmission['status'],
  required: Number(row['required']),
  approvals: JSON.parse(String(row['approvals'])) as AssetSubmission['approvals'],
  decidedBy: str(row['decided_by']),
  reason: str(row['reason']),
  report: JSON.parse(String(row['report'])) as AssetSubmission['report'],
  createdAt: Number(row['created_at']),
  decidedAt: num(row['decided_at'])
});

const toRequest = (row: Row): InstallRequest => ({
  id: String(row['id']),
  assetId: String(row['asset_id']),
  workerId: String(row['worker_id']),
  requestedBy: String(row['requested_by']),
  status: String(row['status']) as InstallRequest['status'],
  decidedBy: str(row['decided_by']),
  reason: str(row['reason']),
  createdAt: Number(row['created_at']),
  decidedAt: num(row['decided_at'])
});

const REVIEW = 'asset.review';
const resourceOf = (key: string): [string, string] => (key === 'hub' ? ['hub', 'hub'] : ['team', key]);

export function createAssetReviewRepository(db: DatabaseSync): AssetReviewRepository {
  db.exec(ASSET_REVIEW_SCHEMA);
  const putSub = db.prepare(`INSERT OR REPLACE INTO asset_submissions
    (id, asset_id, digest, previous, submitted_by, origin, token_id, target_scope, status, required, approvals, decided_by, reason, report, created_at, decided_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const getSub = db.prepare('SELECT * FROM asset_submissions WHERE id = ?');
  const allSubs = db.prepare('SELECT * FROM asset_submissions ORDER BY created_at DESC, rowid DESC');
  const putComment = db.prepare('INSERT INTO asset_review_comments (id, submission_id, author_id, path, line, body, at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const commentsOf = db.prepare('SELECT * FROM asset_review_comments WHERE submission_id = ? ORDER BY at, rowid');
  const putRequest = db.prepare(`INSERT OR REPLACE INTO asset_install_requests
    (id, asset_id, worker_id, requested_by, status, decided_by, reason, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const getRequest = db.prepare('SELECT * FROM asset_install_requests WHERE id = ?');
  const allRequests = db.prepare('SELECT * FROM asset_install_requests ORDER BY created_at DESC, rowid DESC');
  const getSettings = db.prepare('SELECT * FROM asset_review_settings WHERE key = ?');
  const putSettings = db.prepare(
    'INSERT INTO asset_review_settings (key, two_global, two_mcp_stdio) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET two_global = excluded.two_global, two_mcp_stdio = excluded.two_mcp_stdio'
  );
  const grantsOf = db.prepare('SELECT subject_id FROM access_grants WHERE permission = ? AND resource_type = ? AND resource_id = ? ORDER BY created_at, subject_id');
  const clearGrants = db.prepare('DELETE FROM access_grants WHERE permission = ? AND resource_type = ? AND resource_id = ?');
  const addGrant = db.prepare('INSERT OR IGNORE INTO access_grants (subject_id, permission, resource_type, resource_id, created_at) VALUES (?, ?, ?, ?, ?)');

  const saveSub = (s: AssetSubmission) =>
    void putSub.run(s.id, s.assetId, s.digest, s.previous, s.submittedBy, s.origin, s.tokenId, s.targetScope, s.status, s.required,
      JSON.stringify(s.approvals), s.decidedBy, s.reason, JSON.stringify(s.report), s.createdAt, s.decidedAt);
  const saveRequest = (r: InstallRequest) =>
    void putRequest.run(r.id, r.assetId, r.workerId, r.requestedBy, r.status, r.decidedBy, r.reason, r.createdAt, r.decidedAt);

  return {
    addSubmission: async (s) => saveSub(s),
    updateSubmission: async (s) => saveSub(s),
    submission: async (id) => {
      const row = getSub.get(id) as Row | undefined;
      return row ? toSubmission(row) : null;
    },
    submissions: async ({ assetId, status }) =>
      (allSubs.all() as Row[]).map(toSubmission).filter((s) => (!assetId || s.assetId === assetId) && (!status || status.includes(s.status))),
    addComment: async (c: ReviewComment) => void putComment.run(c.id, c.submissionId, c.authorId, c.path, c.line, c.body, c.at),
    comments: async (id) =>
      (commentsOf.all(id) as Row[]).map((row) => ({
        id: String(row['id']),
        submissionId: String(row['submission_id']),
        authorId: String(row['author_id']),
        path: str(row['path']),
        line: num(row['line']),
        body: String(row['body']),
        at: Number(row['at'])
      })),
    addInstallRequest: async (r) => saveRequest(r),
    updateInstallRequest: async (r) => saveRequest(r),
    installRequest: async (id) => {
      const row = getRequest.get(id) as Row | undefined;
      return row ? toRequest(row) : null;
    },
    installRequests: async ({ status, workerId, assetId }) =>
      (allRequests.all() as Row[]).map(toRequest).filter((r) => (!status || r.status === status) && (!workerId || r.workerId === workerId) && (!assetId || r.assetId === assetId)),
    settings: async (key) => {
      const row = getSettings.get(key) as Row | undefined;
      const [type, id] = resourceOf(key);
      const reviewers = (grantsOf.all(REVIEW, type, id) as Row[]).map((r) => String(r['subject_id']));
      if (!row && reviewers.length === 0) return null;
      return { reviewers, twoReviewers: { global: Number(row?.['two_global'] ?? 0) === 1, mcpStdio: Number(row?.['two_mcp_stdio'] ?? 0) === 1 } };
    },
    setSettings: async (key, settings: AssetReviewSettings) => {
      const [type, id] = resourceOf(key);
      db.exec('BEGIN IMMEDIATE');
      try {
        putSettings.run(key, settings.twoReviewers.global ? 1 : 0, settings.twoReviewers.mcpStdio ? 1 : 0);
        clearGrants.run(REVIEW, type, id);
        for (const subject of settings.reviewers) addGrant.run(subject, REVIEW, type, id, Date.now());
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  };
}

export function createNotificationRepository(db: DatabaseSync): NotificationRepository {
  db.exec(ASSET_REVIEW_SCHEMA);
  const put = db.prepare('INSERT INTO notifications (id, user_id, kind, title, body, link, at, read_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const list = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY at DESC, rowid DESC LIMIT ?');
  const unread = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL');
  const readAll = db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL');
  const readOne = db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND id = ? AND read_at IS NULL');
  return {
    add: async (n: Notification) => void put.run(n.id, n.userId, n.kind, n.title, n.body, n.link, n.at, n.readAt),
    list: async (userId, limit) =>
      (list.all(userId, limit) as Row[]).map((row) => ({
        id: String(row['id']),
        userId: String(row['user_id']),
        kind: String(row['kind']) as Notification['kind'],
        title: String(row['title']),
        body: String(row['body']),
        link: String(row['link']),
        at: Number(row['at']),
        readAt: num(row['read_at'])
      })),
    unread: async (userId) => Number((unread.get(userId) as Row)['n']),
    markRead: async (userId, ids, at) => {
      if (ids === null) readAll.run(at, userId);
      else for (const id of ids) readOne.run(at, userId, id);
    }
  };
}
