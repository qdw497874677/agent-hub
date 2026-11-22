import type { DatabaseSync } from 'node:sqlite';
import type {
  DelegationPublishStore,
  PublishAttempt,
  PublishAttemptCasInput,
  PublishAttemptInsert,
  PublishAttemptState,
  PublishedPullRequest,
  PublishRemoteFacts
} from '@agent-hub/domain';

/**
 * 持久发布尝试（docs/design/workspace-delegation.md，B2「人工确认发布」）。
 *
 * - 幂等键 = `(delegation_id, approval_key)` 的精确字节；同键重放只读已有记录。
 * - 同一派工下，只要有一条尝试处于 `publishing` / `uncertain` / `published`，
 *   就不允许**别的批准键**开始发布：否则 GitHub 没有幂等键，重试会多开 PR。
 *   这条 guard 落在单条 SQL 语句里，不靠先读后写，也不做 busy 重试（重试可能重放副作用）。
 * - 所有状态写入都是带状态 / claim token 条件的 UPDATE。
 * - `remote` / `pull_request` 以 JSON 落库；领取出错时保留已核验的远端事实，便于对账。
 */
export function createSqliteDelegationPublishAttempts(db: DatabaseSync): DelegationPublishStore {
  db.exec(`CREATE TABLE IF NOT EXISTS delegation_publish_attempt (
    delegation_id TEXT NOT NULL,
    approval_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    head_sha TEXT NOT NULL,
    state TEXT NOT NULL,
    claim_owner TEXT,
    claim_token TEXT,
    claim_at INTEGER,
    claim_expires_at INTEGER,
    failure_kind TEXT,
    failure_message TEXT,
    failure_at INTEGER,
    remote_json TEXT,
    pull_request_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (delegation_id, approval_key))`);
  db.exec('CREATE INDEX IF NOT EXISTS delegation_publish_attempt_delegation ON delegation_publish_attempt(delegation_id, updated_at)');

  type Row = {
    delegation_id: string;
    approval_key: string;
    fingerprint: string;
    head_sha: string;
    state: string;
    claim_owner: string | null;
    claim_token: string | null;
    claim_at: number | null;
    claim_expires_at: number | null;
    failure_kind: string | null;
    failure_message: string | null;
    failure_at: number | null;
    remote_json: string | null;
    pull_request_json: string | null;
    created_at: number;
    updated_at: number;
  };

  const jsonOf = <T>(raw: string | null): T | null => (raw === null ? null : (JSON.parse(raw) as T));

  const to = (row: Row): PublishAttempt => ({
    delegationId: row.delegation_id,
    approvalKey: row.approval_key,
    fingerprint: row.fingerprint,
    headSha: row.head_sha,
    state: row.state as PublishAttemptState,
    claim:
      row.claim_owner !== null && row.claim_token !== null && row.claim_at !== null && row.claim_expires_at !== null
        ? { owner: row.claim_owner, token: row.claim_token, at: row.claim_at, expiresAt: row.claim_expires_at }
        : null,
    failure:
      row.failure_kind !== null && row.failure_message !== null && row.failure_at !== null
        ? { kind: row.failure_kind as 'fatal' | 'uncertain', message: row.failure_message, at: row.failure_at }
        : null,
    remote: jsonOf<PublishRemoteFacts>(row.remote_json),
    pullRequest: jsonOf<PublishedPullRequest>(row.pull_request_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });

  const byKeyStmt = db.prepare('SELECT * FROM delegation_publish_attempt WHERE delegation_id = ? AND approval_key = ?');
  const latestStmt = db.prepare(`SELECT * FROM delegation_publish_attempt
    WHERE delegation_id = ?
    ORDER BY updated_at DESC, created_at DESC, approval_key DESC
    LIMIT 1`);
  // 同一个派工下挡住新发布的那条尝试；同键不算挡住自己。
  const blockerStmt = db.prepare(`SELECT * FROM delegation_publish_attempt
    WHERE delegation_id = ? AND approval_key <> ?
      AND state IN ('publishing', 'uncertain', 'published')
    ORDER BY CASE state WHEN 'publishing' THEN 0 WHEN 'uncertain' THEN 1 ELSE 2 END,
      updated_at DESC, created_at DESC, approval_key DESC
    LIMIT 1`);

  const read = (delegationId: string, approvalKey: string): PublishAttempt | null => {
    const row = byKeyStmt.get(delegationId, approvalKey) as Row | undefined;
    return row ? to(row) : null;
  };

  const blocker = (delegationId: string, approvalKey: string): PublishAttempt | null => {
    const row = blockerStmt.get(delegationId, approvalKey) as Row | undefined;
    return row ? to(row) : null;
  };

  // 一条语句完成「同键没建过 + 同派工没有别的活跃发布」才插入；并发点击由 SQLite 串行化。
  const insertIfFree = db.prepare(`INSERT INTO delegation_publish_attempt (
      delegation_id, approval_key, fingerprint, head_sha, state,
      claim_owner, claim_token, claim_at, claim_expires_at,
      failure_kind, failure_message, failure_at, remote_json, pull_request_json,
      created_at, updated_at)
    SELECT ?, ?, ?, ?, 'publishing', ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM delegation_publish_attempt WHERE delegation_id = ? AND approval_key = ?)
      AND NOT EXISTS (
        SELECT 1 FROM delegation_publish_attempt
        WHERE delegation_id = ? AND state IN ('publishing', 'uncertain', 'published'))`);

  return {
    async byKey(delegationId, approvalKey) {
      return read(delegationId, approvalKey);
    },
    async latest(delegationId) {
      const row = latestStmt.get(delegationId) as Row | undefined;
      return row ? to(row) : null;
    },
    async insert(input: PublishAttemptInsert) {
      const result = insertIfFree.run(
        input.delegationId,
        input.approvalKey,
        input.fingerprint,
        input.headSha,
        input.claim.owner,
        input.claim.token,
        input.claim.at,
        input.claim.expiresAt,
        input.at,
        input.at,
        input.delegationId,
        input.approvalKey,
        input.delegationId
      );
      const inserted = read(input.delegationId, input.approvalKey);
      if (Number(result.changes) > 0) {
        if (!inserted) throw new Error(`发布尝试未能落库：${input.delegationId}/${input.approvalKey}`);
        return { outcome: 'created', attempt: inserted };
      }
      if (inserted) return { outcome: 'exists', attempt: inserted };
      const blocking = blocker(input.delegationId, input.approvalKey);
      if (blocking) return { outcome: 'blocked', attempt: blocking };
      throw new Error(`发布尝试未能落库：${input.delegationId}/${input.approvalKey}`);
    },
    async compareAndSet(input: PublishAttemptCasInput) {
      const sets = ['state = ?', 'updated_at = ?'];
      const values: (string | number | null)[] = [input.state, input.at];
      // 省略 = 不改；null = 清空；对象 = 写入。settle() 明确传 null，因此离开 publishing 必清 claim。
      if (input.claim !== undefined) {
        if (input.claim === null) {
          sets.push('claim_owner = NULL', 'claim_token = NULL', 'claim_at = NULL', 'claim_expires_at = NULL');
        } else {
          sets.push('claim_owner = ?', 'claim_token = ?', 'claim_at = ?', 'claim_expires_at = ?');
          values.push(input.claim.owner, input.claim.token, input.claim.at, input.claim.expiresAt);
        }
      }
      if (input.failure !== undefined) {
        if (input.failure === null) {
          sets.push('failure_kind = NULL', 'failure_message = NULL', 'failure_at = NULL');
        } else {
          sets.push('failure_kind = ?', 'failure_message = ?', 'failure_at = ?');
          values.push(input.failure.kind, input.failure.message, input.failure.at);
        }
      }
      if (input.remote !== undefined) {
        sets.push('remote_json = ?');
        values.push(input.remote === null ? null : JSON.stringify(input.remote));
      }
      if (input.pullRequest !== undefined) {
        sets.push('pull_request_json = ?');
        values.push(input.pullRequest === null ? null : JSON.stringify(input.pullRequest));
      }

      const where = ['delegation_id = ?', 'approval_key = ?', 'state = ?'];
      values.push(input.delegationId, input.approvalKey, input.expect.state);
      if (input.expect.claimToken === null) {
        where.push('claim_token IS NULL');
      } else if (typeof input.expect.claimToken === 'string') {
        where.push('claim_token = ?');
        values.push(input.expect.claimToken);
      }
      // 只挡「进入 publishing」：同键的 published / failed / uncertain 落定不受别的键影响。
      if (input.state === 'publishing') {
        where.push(`NOT EXISTS (
          SELECT 1 FROM delegation_publish_attempt AS b
          WHERE b.delegation_id = ? AND b.approval_key <> ?
            AND b.state IN ('publishing', 'uncertain', 'published'))`);
        values.push(input.delegationId, input.approvalKey);
      }

      const result = db.prepare(`UPDATE delegation_publish_attempt SET ${sets.join(', ')} WHERE ${where.join(' AND ')}`).run(...values);
      if (Number(result.changes) > 0) {
        const attempt = read(input.delegationId, input.approvalKey);
        if (!attempt) throw new Error(`发布尝试更新后消失：${input.delegationId}/${input.approvalKey}`);
        return { ok: true, attempt };
      }
      if (input.state === 'publishing') {
        const blocking = blocker(input.delegationId, input.approvalKey);
        if (blocking) return { ok: false, attempt: blocking };
      }
      return { ok: false, attempt: read(input.delegationId, input.approvalKey) };
    }
  };
}
