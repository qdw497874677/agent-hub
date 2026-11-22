import type { DatabaseSync } from 'node:sqlite';
import type {
  DelegationAllocation,
  DelegationClaim,
  DelegationClaimResult,
  DelegationMode,
  DelegationStartupConfig,
  DelegationStartupOption,
  DelegationState,
  WorkspaceDelegation,
  WorkspaceDelegationStore
} from '@agent-hub/domain';
import { asProjectId, asSessionId, asTaskId, delegationCanTransition } from '@agent-hub/domain';

/**
 * 启动配置一次性冻结在分配记录里。选项键排序后落库，值本身保持原样；
 * 只接受 string / boolean，避免把嵌套对象或凭据细节写进派工记录。
 */
function serializeStartup(startup: DelegationStartupConfig): {
  agentId: string;
  model: string | null;
  profileId: string | null;
  optionsJson: string;
} {
  if (!startup || typeof startup !== 'object') throw new TypeError('派工启动配置缺失');
  if (typeof startup.agentId !== 'string' || startup.agentId.trim() === '') {
    throw new TypeError('派工启动配置缺少 agentId');
  }
  if (startup.model !== null && typeof startup.model !== 'string') {
    throw new TypeError('派工启动配置的 model 必须是字符串或 null');
  }
  if (startup.profileId !== null && typeof startup.profileId !== 'string') {
    throw new TypeError('派工启动配置的 profileId 必须是字符串或 null');
  }
  const options = startup.options;
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('派工启动配置的 options 必须是对象');
  }
  const entries: [string, DelegationStartupOption][] = [];
  for (const key of Object.keys(options).sort()) {
    const value = (options as Readonly<Record<string, unknown>>)[key];
    if (typeof value !== 'string' && typeof value !== 'boolean') {
      throw new TypeError(`派工启动配置选项 ${key} 只允许 string / boolean`);
    }
    entries.push([key, value]);
  }
  return {
    agentId: startup.agentId,
    model: startup.model,
    profileId: startup.profileId,
    optionsJson: JSON.stringify(Object.fromEntries(entries))
  };
}

/** 旧记录 / 部分字段 / 损坏 JSON 一律返回 null，让提案确认失败关闭，而不是猜配置。 */
function parseStartup(row: {
  startup_agent_id: string | null;
  startup_model: string | null;
  startup_profile_id: string | null;
  startup_options_json: string | null;
}): DelegationStartupConfig | null {
  if (row.startup_agent_id === null || row.startup_options_json === null) return null;
  if (row.startup_agent_id.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.startup_options_json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const options: Record<string, DelegationStartupOption> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string' && typeof value !== 'boolean') return null;
    options[key] = value;
  }
  return {
    agentId: row.startup_agent_id,
    model: row.startup_model,
    profileId: row.startup_profile_id,
    options
  };
}

/**
 * 持久工作空间派工（docs/design/workspace-delegation.md，A1）。
 * 一层记录表：幂等键 = (mode, coordinator_session_id, request_key) 的精确字节。
 * 同一来源会话、同一请求键在提案车道和直接执行车道是两条记录，提案确认不能领走直接记录。
 * 所有状态迁移都是带条件的 UPDATE，返回是否命中；没有内存状态可丢。
 */
export function createSqliteWorkspaceDelegations(db: DatabaseSync): WorkspaceDelegationStore {
  const columns = [
    'id', 'account_id', 'coordinator_session_id', 'mode', 'request_key', 'request_fingerprint', 'project_id', 'task_id', 'repo_id', 'repo_url',
    'worker_id', 'base_branch', 'base_sha', 'instructions',
    'startup_agent_id', 'startup_model', 'startup_profile_id', 'startup_options_json',
    'execution_session_id', 'worktree_path', 'branch', 'state',
    'claim_owner', 'claim_token', 'claim_at', 'claim_expires_at', 'failure_kind', 'failure_message', 'failure_at', 'created_at', 'updated_at'
  ] as const;

  const tableDdl = (name: string, ifNotExists = false): string => `CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${name} (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    coordinator_session_id TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'proposal' CHECK (mode IN ('proposal','direct')),
    request_key TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    project_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    repo_id TEXT NOT NULL,
    repo_url TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    base_branch TEXT NOT NULL,
    base_sha TEXT,
    instructions TEXT NOT NULL,
    startup_agent_id TEXT,
    startup_model TEXT,
    startup_profile_id TEXT,
    startup_options_json TEXT,
    execution_session_id TEXT NOT NULL,
    worktree_path TEXT NOT NULL,
    branch TEXT NOT NULL,
    state TEXT NOT NULL,
    claim_owner TEXT,
    claim_token TEXT,
    claim_at INTEGER,
    claim_expires_at INTEGER,
    failure_kind TEXT,
    failure_message TEXT,
    failure_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (mode, coordinator_session_id, request_key))`;

  db.exec(tableDdl('workspace_delegation', true));
  // 只增列：旧库的 workspace_delegation 没有启动配置列，读出来是 NULL 并失败关闭。
  const present = new Set(
    (db.prepare('PRAGMA table_info(workspace_delegation)').all() as { name: string }[]).map((column) => column.name)
  );
  for (const [name, type] of [
    ['startup_agent_id', 'TEXT'],
    ['startup_model', 'TEXT'],
    ['startup_profile_id', 'TEXT'],
    ['startup_options_json', 'TEXT']
  ] as const) {
    if (!present.has(name)) db.exec(`ALTER TABLE workspace_delegation ADD COLUMN ${name} ${type}`);
  }
  if (!present.has('mode')) {
    // 旧记录一律归入提案车道；直接执行车道不会复用这些记录的幂等域。
    db.exec("ALTER TABLE workspace_delegation ADD COLUMN mode TEXT NOT NULL DEFAULT 'proposal'");
  }

  // 旧库唯一约束是 (coordinator_session_id, request_key)。SQLite 不能 DROP CONSTRAINT，
  // 只能重建表：保留全部旧行（mode='proposal'），换成含 mode 的三列唯一约束。
  const legacyPairUnique = (
    db.prepare("PRAGMA index_list('workspace_delegation')").all() as { name: string; unique: number }[]
  ).some((index) => {
    if (index.unique !== 1) return false;
    const names = (
      db.prepare(`PRAGMA index_info('${index.name.replaceAll("'", "''")}')`).all() as { name: string }[]
    ).map((column) => column.name);
    return (
      names.length === 2 &&
      names.includes('coordinator_session_id') &&
      names.includes('request_key')
    );
  });
  if (legacyPairUnique) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('DROP TABLE IF EXISTS workspace_delegation_migrated');
      db.exec(tableDdl('workspace_delegation_migrated'));
      const list = columns.join(', ');
      db.exec(
        `INSERT INTO workspace_delegation_migrated (${list}) SELECT ${list} FROM workspace_delegation`
      );
      db.exec('DROP TABLE workspace_delegation');
      db.exec('ALTER TABLE workspace_delegation_migrated RENAME TO workspace_delegation');
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  db.exec('CREATE INDEX IF NOT EXISTS workspace_delegation_state ON workspace_delegation(state)');
  db.exec('CREATE INDEX IF NOT EXISTS workspace_delegation_coordinator ON workspace_delegation(coordinator_session_id, created_at)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS workspace_delegation_execution_unique ON workspace_delegation(execution_session_id)');

  type D = {
    id: string; account_id: string; coordinator_session_id: string; mode: string; request_key: string; request_fingerprint: string;
    project_id: string; task_id: string; repo_id: string; repo_url: string; worker_id: string; base_branch: string; base_sha: string | null;
    instructions: string;
    startup_agent_id: string | null; startup_model: string | null; startup_profile_id: string | null; startup_options_json: string | null;
    execution_session_id: string; worktree_path: string; branch: string; state: string;
    claim_owner: string | null; claim_token: string | null; claim_at: number | null; claim_expires_at: number | null;
    failure_kind: string | null; failure_message: string | null; failure_at: number | null;
    created_at: number; updated_at: number;
  };

  const to = (r: D): WorkspaceDelegation => ({
    id: r.id,
    accountId: r.account_id,
    coordinatorSessionId: asSessionId(r.coordinator_session_id),
    mode: r.mode === 'direct' ? 'direct' : 'proposal',
    requestKey: r.request_key,
    requestFingerprint: r.request_fingerprint,
    projectId: asProjectId(r.project_id),
    taskId: asTaskId(r.task_id),
    repoId: r.repo_id,
    repoUrl: r.repo_url,
    workerId: r.worker_id,
    baseBranch: r.base_branch,
    baseSha: r.base_sha,
    instructions: r.instructions,
    startup: parseStartup(r),
    executionSessionId: asSessionId(r.execution_session_id),
    worktreePath: r.worktree_path,
    branch: r.branch,
    state: r.state as DelegationState,
    claim:
      r.claim_owner !== null && r.claim_token !== null && r.claim_at !== null && r.claim_expires_at !== null
        ? { owner: r.claim_owner, token: r.claim_token, at: r.claim_at, expiresAt: r.claim_expires_at }
        : null,
    failure:
      r.failure_kind !== null && r.failure_message !== null && r.failure_at !== null
        ? { kind: r.failure_kind as 'fatal' | 'uncertain', message: r.failure_message, at: r.failure_at }
        : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  });

  const byIdStmt = db.prepare('SELECT * FROM workspace_delegation WHERE id = ?');
  const byPairStmt = db.prepare('SELECT * FROM workspace_delegation WHERE mode = ? AND coordinator_session_id = ? AND request_key = ?');
  const byExecutionStmt = db.prepare('SELECT * FROM workspace_delegation WHERE execution_session_id = ?');
  const byCoordinatorStmt = db.prepare('SELECT * FROM workspace_delegation WHERE coordinator_session_id = ? ORDER BY created_at, id');
  const unsettledStmt = db.prepare("SELECT * FROM workspace_delegation WHERE state IN ('pending','preparing','uncertain') ORDER BY created_at, id");
  const insert = db.prepare(`INSERT OR IGNORE INTO workspace_delegation (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(',')})`);
  const claimPending = db.prepare(`UPDATE workspace_delegation
    SET state = 'preparing', claim_owner = ?, claim_token = ?, claim_at = ?, claim_expires_at = ?, updated_at = ?
    WHERE id = ? AND state = 'pending' AND claim_token IS NULL`);

  const read = (id: string): WorkspaceDelegation | null => {
    const row = byIdStmt.get(id) as D | undefined;
    return row ? to(row) : null;
  };

  const classifyClaim = (record: WorkspaceDelegation, now: number): DelegationClaimResult => {
    if (record.state === 'preparing' && record.claim !== null) {
      return { outcome: record.claim.expiresAt > now ? 'busy' : 'expired', record };
    }
    return { outcome: 'not-claimable', record };
  };

  return {
    async allocate(input: DelegationAllocation) {
      const mode: DelegationMode = input.mode ?? 'proposal';
      const existing = byPairStmt.get(mode, input.coordinatorSessionId, input.requestKey) as D | undefined;
      if (existing) {
        const record = to(existing);
        return { outcome: record.requestFingerprint === input.requestFingerprint ? 'reused' : 'conflict', record };
      }
      const executionOwner = byExecutionStmt.get(input.executionSessionId) as D | undefined;
      if (executionOwner) return { outcome: 'conflict', record: to(executionOwner) };
      const startup = serializeStartup(input.startup);
      insert.run(
        input.id, input.accountId, input.coordinatorSessionId, mode, input.requestKey, input.requestFingerprint, input.projectId,
        input.taskId, input.repoId, input.repoUrl, input.workerId, input.baseBranch, null, input.instructions,
        startup.agentId, startup.model, startup.profileId, startup.optionsJson,
        input.executionSessionId, input.worktreePath, input.branch, 'pending',
        null, null, null, null, null, null, null, input.at, input.at
      );
      const row = byPairStmt.get(mode, input.coordinatorSessionId, input.requestKey) as D | undefined;
      if (!row) {
        // 并发下另一个键先占了同一执行身份：唯一索引挡住 INSERT，按身份冲突报告。
        const owner = byExecutionStmt.get(input.executionSessionId) as D | undefined;
        if (owner) return { outcome: 'conflict', record: to(owner) };
        throw new Error(`派工记录未能落库：${input.id}`);
      }
      const record = to(row);
      if (record.requestFingerprint !== input.requestFingerprint) return { outcome: 'conflict', record };
      // INSERT OR IGNORE 被并发的同键写入抢先时 id 不是我们的：如实报 reused，不假装 created。
      return { outcome: record.id === input.id ? 'created' : 'reused', record };
    },
    async byId(id) {
      return read(id);
    },
    async byExecutionSession(sessionId) {
      const row = byExecutionStmt.get(sessionId) as D | undefined;
      return row ? to(row) : null;
    },
    async byCoordinatorRequest(coordinatorSessionId, requestKey, mode = 'proposal') {
      const row = byPairStmt.get(mode, coordinatorSessionId, requestKey) as D | undefined;
      return row ? to(row) : null;
    },
    async byCoordinator(coordinatorSessionId) {
      return (byCoordinatorStmt.all(coordinatorSessionId) as D[]).map(to);
    },
    async unsettled() {
      return (unsettledStmt.all() as D[]).map(to);
    },
    async claim(id: string, claim: DelegationClaim) {
      const current = read(id);
      if (!current) return { outcome: 'missing', record: null };
      if (current.state === 'pending') {
        const result = claimPending.run(claim.owner, claim.token, claim.at, claim.expiresAt, claim.at, id);
        if (Number(result.changes) > 0) {
          return { outcome: 'claimed', record: read(id) };
        }
        // 并发下另一个领取先命中：按最新记录报告 busy / expired，不接管。
        return classifyClaim(read(id)!, claim.at);
      }
      return classifyClaim(current, claim.at);
    },
    async compareAndSet(id, input) {
      if (input.state === 'preparing') {
        throw new Error('进入 preparing 只能走 claim()：否则会缺少领取凭据');
      }
      const current = read(id);
      if (!current) return { ok: false, record: null };
      const expectedFailureKind = input.state === 'failed' ? 'fatal' : input.state === 'uncertain' ? 'uncertain' : null;
      if (expectedFailureKind !== null) {
        if (input.failure?.kind !== expectedFailureKind) {
          throw new Error(`${input.state} 必须带 ${expectedFailureKind} failure`);
        }
      } else if (input.failure) {
        throw new Error(`只有 failed / uncertain 能带 failure（收到 ${input.state}）`);
      }
      if (!delegationCanTransition(current.state, input.state)) return { ok: false, record: current };

      const sets = ['state = ?', 'updated_at = ?'];
      const values: (string | number | null)[] = [input.state, input.at];
      if (input.baseSha !== undefined) {
        sets.push('base_sha = ?');
        values.push(input.baseSha);
      }
      if (input.failure) {
        sets.push('failure_kind = ?', 'failure_message = ?', 'failure_at = ?');
        values.push(input.failure.kind, input.failure.message, input.failure.at);
      } else {
        sets.push('failure_kind = NULL', 'failure_message = NULL', 'failure_at = NULL');
      }
      // 离开 preparing 一律清掉领取凭据；不支持续租，过期写入会被 token 条件挡住。
      sets.push('claim_owner = NULL', 'claim_token = NULL', 'claim_at = NULL', 'claim_expires_at = NULL');

      const where = ['id = ?', 'state = ?'];
      values.push(id, input.expect.state);
      if (input.expect.claimToken === null) {
        where.push('claim_token IS NULL');
      } else if (typeof input.expect.claimToken === 'string') {
        where.push('claim_token = ?');
        values.push(input.expect.claimToken);
      }
      const result = db.prepare(`UPDATE workspace_delegation SET ${sets.join(', ')} WHERE ${where.join(' AND ')}`).run(...values);
      const record = read(id);
      return { ok: Number(result.changes) > 0, record };
    }
  };
}
