import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { WorkdirSafety, WorkdirTarget, WorkdirTerminal, WorkdirTerminalState, WorkdirTerminalStore } from '@agent-hub/domain';

export function createWorkdirSafety(db: DatabaseSync): { terminals: WorkdirTerminalStore; safety: WorkdirSafety } {
  db.exec(`CREATE TABLE IF NOT EXISTS workdir_terminals (
    id TEXT PRIMARY KEY, request_id TEXT NOT NULL, owner_id TEXT NOT NULL, project_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL, worker_id TEXT NOT NULL, cwd TEXT NOT NULL, epoch TEXT,
    state TEXT NOT NULL CHECK (state IN ('pending','running','closing','ended')),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(owner_id, request_id)
  ); CREATE TABLE IF NOT EXISTS workdir_removal_fences (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, worker_id TEXT, cwd TEXT NOT NULL
  );`);
  const row = (raw: unknown): WorkdirTerminal | null => {
    if (!raw) return null;
    const r = raw as Record<string, unknown>;
    return { id: r.id as string, requestId: r.request_id as string, ownerId: r.owner_id as string,
      projectId: r.project_id as string, workspaceId: r.workspace_id as string, workerId: r.worker_id as string,
      cwd: r.cwd as string, epoch: r.epoch as string | null, state: r.state as WorkdirTerminalState,
      createdAt: r.created_at as number, updatedAt: r.updated_at as number };
  };
  const list = (sql: string, ...args: string[]) => db.prepare(sql).all(...args).map((r) => row(r)!);
  const terminals: WorkdirTerminalStore = {
    get: (id) => row(db.prepare('SELECT * FROM workdir_terminals WHERE id = ?').get(id)),
    getByRequest: (owner, request) => row(db.prepare('SELECT * FROM workdir_terminals WHERE owner_id = ? AND request_id = ?').get(owner, request)),
    listNonEnded: () => list("SELECT * FROM workdir_terminals WHERE state != 'ended'"),
    listByOwner: (id) => list('SELECT * FROM workdir_terminals WHERE owner_id = ?', id),
    listByWorkspace: (id) => list('SELECT * FROM workdir_terminals WHERE workspace_id = ?', id),
    listByProject: (id) => list('SELECT * FROM workdir_terminals WHERE project_id = ?', id),
    create(record) {
      const old = terminals.getByRequest(record.ownerId, record.requestId);
      if (old) {
        if (old.projectId !== record.projectId || old.workspaceId !== record.workspaceId || old.workerId !== record.workerId || old.cwd !== record.cwd) throw new Error('workdir terminal request target conflict');
        return old;
      }
      if (record.state !== 'pending' || record.epoch !== null || !record.id || !record.requestId || !record.ownerId || !record.projectId || !record.workspaceId || !record.workerId) throw new Error('invalid workdir terminal intent');
      normalize(record.cwd);
      db.prepare('INSERT INTO workdir_terminals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(record.id, record.requestId, record.ownerId, record.projectId, record.workspaceId, record.workerId, record.cwd, record.epoch, record.state, record.createdAt, record.updatedAt);
      return record;
    },
    transition(id, expected, expectedEpoch, next, nextEpoch, updatedAt) {
      const allowed: Record<WorkdirTerminalState, readonly WorkdirTerminalState[]> = { pending: ['running', 'closing', 'ended'], running: ['closing', 'ended'], closing: ['ended'], ended: [] };
      const binding = expected === 'pending' && expectedEpoch === null && nextEpoch !== null;
      if ((!allowed[expected].includes(next) && !(binding && next === 'pending')) || (!binding && expectedEpoch !== nextEpoch) || nextEpoch === '') throw new Error('invalid workdir terminal transition');
      const result = db.prepare('UPDATE workdir_terminals SET state = ?, updated_at = ?, epoch = ? WHERE id = ? AND state = ? AND epoch IS ?').run(next, updatedAt, nextEpoch, id, expected, expectedEpoch);
      return result.changes ? terminals.get(id) : null;
    }
  };
  let queue: Promise<void> = Promise.resolve();
  const conflicts = (a: WorkdirTarget, b: WorkdirTarget) => {
    normalize(a.cwd); normalize(b.cwd);
    // Without realpath attestation, distinct lexical paths can alias via symlinks.
    return a.workspaceId === b.workspaceId || !a.workerId || !b.workerId || a.workerId === b.workerId;
  };
  const fences = (): WorkdirTarget[] => (db.prepare('SELECT * FROM workdir_removal_fences').all() as Record<string, unknown>[]).map((r) => ({ workspaceId: r.workspace_id as string, workerId: r.worker_id as string | null, cwd: r.cwd as string }));
  const safety: WorkdirSafety = {
    hasOutstanding() {
      return db.prepare("SELECT 1 AS present WHERE EXISTS (SELECT 1 FROM workdir_terminals WHERE state != 'ended') OR EXISTS (SELECT 1 FROM workdir_removal_fences)").get() !== undefined;
    },
    async runExclusive(fn) {
      const previous = queue;
      let release!: () => void;
      queue = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try { return await fn(); } finally { release(); }
    },
    assertNoRemoval(target) {
      normalize(target.cwd);
      if (!target.workspaceId || fences().length > 0) throw new Error('workdir removal pending anywhere on hub');
    },
    assertUnoccupied(target) {
      safety.assertNoRemoval(target);
      if (terminals.listNonEnded().some((t) => conflicts(target, t))) throw new Error('workdir terminal occupied');
    },
    assertProjectUnoccupied(projectId) {
      if (!projectId || terminals.listByProject(projectId).some((t) => t.state !== 'ended')) throw new Error('project has occupied workdir terminal');
    },
    beginRemoval(target) {
      safety.assertNoRemoval(target);
      if (terminals.listNonEnded().length > 0) throw new Error('workdir terminal occupied on hub; physical removal deferred');
      const id = randomUUID();
      db.prepare('INSERT INTO workdir_removal_fences VALUES (?, ?, ?, ?)').run(id, target.workspaceId, target.workerId, normalize(target.cwd));
      return id;
    },
    finishRemoval(id) { db.prepare('DELETE FROM workdir_removal_fences WHERE id = ?').run(id); }
  };
  return { terminals, safety };
}

function normalize(path: string): string {
  if (!path || !path.startsWith('/') || path.includes('\0') || path.split('/').includes('..')) throw new Error('unknown workdir path');
  return '/' + path.split('/').filter((part) => part && part !== '.').join('/');
}
