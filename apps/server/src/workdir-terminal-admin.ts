import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Context, Hono } from 'hono';
import { asUserId, isSystem, requireOwner, type Principal, type User, type UserRepository } from '@agent-hub/domain';
import type { PrincipalOf } from './auth.ts';
import { fail } from './http-error.ts';

export interface WorkdirTerminalGrant { readonly userId: string; readonly workerId: string }
export interface WorkdirTerminalWorker { readonly id: string; readonly label: string }
export interface WorkdirTerminalReadiness {
  readonly mode: 'managed' | 'deployment' | 'unavailable';
  /** Effective deployment value; managed mode reads the persisted policy instead. */
  readonly enabled: boolean;
  /** Only workers currently validated as terminal-ready. */
  readonly workers: readonly WorkdirTerminalWorker[];
  /** Includes incompatible online mutation workers, or other blockers. */
  readonly blockedReason: string | null;
}

type Change = { action: 'set-enabled'; enabled: boolean } | { action: 'grant' | 'revoke'; userId: string; workerId: string };
export interface WorkdirTerminalAdminStore {
  isEnabled(): boolean;
  hasGrant(userId: string, workerId: string): boolean;
  listGrants(): WorkdirTerminalGrant[];
  change(change: Change, actor: User, at: number): void;
}

/** Policy, exact grants and their audit entry share one synchronous SQLite transaction. */
export function createWorkdirTerminalAdminStore(db: DatabaseSync): WorkdirTerminalAdminStore {
  db.exec(`CREATE TABLE IF NOT EXISTS workdir_terminal_policy (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1), enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
  );
  CREATE TABLE IF NOT EXISTS workdir_terminal_grants (
    user_id TEXT NOT NULL, worker_id TEXT NOT NULL, PRIMARY KEY (user_id, worker_id)
  );`);
  return {
    isEnabled: () => (db.prepare('SELECT enabled FROM workdir_terminal_policy WHERE singleton = 1').get()?.enabled ?? 0) === 1,
    hasGrant: (userId, workerId) => db.prepare('SELECT 1 FROM workdir_terminal_grants WHERE user_id = ? AND worker_id = ?').get(userId, workerId) !== undefined,
    listGrants: () => db.prepare('SELECT user_id, worker_id FROM workdir_terminal_grants ORDER BY user_id, worker_id').all().map((row) => ({ userId: String(row.user_id), workerId: String(row.worker_id) })),
    change(change, actor, at) {
      db.exec('SAVEPOINT workdir_terminal_admin');
      try {
        let action: string;
        let target: string;
        let detail: string;
        if (change.action === 'set-enabled') {
          db.prepare('INSERT INTO workdir_terminal_policy(singleton, enabled) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET enabled = excluded.enabled').run(change.enabled ? 1 : 0);
          action = 'workdir_terminal.enabled'; target = 'workdir-terminal'; detail = JSON.stringify({ enabled: change.enabled });
        } else {
          if (change.action === 'grant') db.prepare('INSERT OR IGNORE INTO workdir_terminal_grants(user_id, worker_id) VALUES (?, ?)').run(change.userId, change.workerId);
          else {
            db.prepare('DELETE FROM workdir_terminal_grants WHERE user_id = ? AND worker_id = ?').run(change.userId, change.workerId);
            db.prepare("UPDATE workdir_terminals SET state = 'closing', updated_at = ? WHERE owner_id = ? AND worker_id = ? AND state != 'ended'").run(at, change.userId, change.workerId);
          }
          action = `workdir_terminal.${change.action}`; target = change.userId; detail = JSON.stringify({ userId: change.userId, workerId: change.workerId });
        }
        db.prepare('INSERT INTO audit_log(id, actor_id, actor_email, action, target, detail, at, ip, team_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(randomUUID(), actor.id, actor.email, action, target, detail, at, null, actor.teamId);
        db.exec('RELEASE workdir_terminal_admin');
      } catch (error) {
        db.exec('ROLLBACK TO workdir_terminal_admin');
        db.exec('RELEASE workdir_terminal_admin');
        throw error;
      }
    }
  };
}

export interface WorkdirTerminalAdminOptions {
  readonly store: WorkdirTerminalAdminStore;
  readonly users: Pick<UserRepository, 'list' | 'byId'>;
  readonly now: () => number;
  /** Must authenticate the ingress, not trust forwarded headers supplied by clients. */
  readonly protectedTransport: (c: Context) => boolean;
  /** Synchronous snapshot: no async gap between this check and the SQLite mutation. */
  readonly readiness: () => WorkdirTerminalReadiness;
  /** Best-effort reconciliation trigger after a committed revoke; durable closing rows are authoritative. */
  readonly onRevoked?: () => void;
}

const usable = (user: User | null): user is User => user !== null && user.disabledAt === null && user.deletedAt === null && user.emailVerifiedAt !== null;
const validId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.trim() === id;
function parseChange(value: unknown): Change | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body).sort().join(',');
  if (body.action === 'set-enabled' && keys === 'action,enabled' && typeof body.enabled === 'boolean') return { action: body.action, enabled: body.enabled };
  if ((body.action === 'grant' || body.action === 'revoke') && keys === 'action,userId,workerId' && validId(body.userId) && validId(body.workerId)) return { action: body.action, userId: body.userId, workerId: body.workerId };
  return null;
}

/** Install after the account/CSRF middleware. Also independently checks owner and the fresh human account. */
export function installWorkdirTerminalAdmin(app: Hono, options: WorkdirTerminalAdminOptions, principalOf: PrincipalOf): void {
  const path = '/api/admin/workdir-terminal-settings';
  app.use(path, async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const principal = principalOf(c);
    if (!principal || isSystem(principal) || principal.via || !requireOwner(principal).ok || !principal.user.clusterAdmin) return fail(c, { code: 'forbidden', message: '需要网页登录的 hub 管理员' });
    const current = await options.users.byId(principal.user.id);
    if (!usable(current) || !current.clusterAdmin) return fail(c, { code: 'forbidden', message: '需要有效的 hub 管理员账号' });
    await next();
  });
  const dto = async (secure: boolean) => {
    const state = options.readiness();
    const enabled = state.mode === 'managed' ? options.store.isEnabled() : state.enabled;
    if (!secure) return { mode: 'unavailable' as const, enabled, canEnable: false, blockedReason: '需要受保护的连接', workers: [], users: [], grants: [] };
    const blockedReason = state.blockedReason ?? (state.workers.length === 0 ? '没有就绪的终端 Worker' : null);
    const users = (await options.users.list()).filter(usable).map((user) => ({ id: user.id, label: user.displayName || user.email }));
    return { mode: state.mode, enabled, canEnable: state.mode === 'managed' && blockedReason === null, blockedReason, workers: state.workers, users, grants: options.store.listGrants() };
  };
  app.get(path, async (c) => c.json(await dto(options.protectedTransport(c))));
  app.put(path, async (c) => {
    if (!options.protectedTransport(c)) return fail(c, { code: 'forbidden', message: '需要受保护的连接' });
    const change = parseChange(await c.req.json().catch(() => null));
    if (!change) return fail(c, { code: 'invalid', message: '请求体不合法' });
    const principal = principalOf(c) as Principal;
    const actor = await options.users.byId(principal.user.id);
    if (!usable(actor) || !actor.clusterAdmin) return fail(c, { code: 'forbidden', message: '需要有效的 hub 管理员账号' });
    if (change.action === 'grant') {
      const user = await options.users.byId(asUserId(change.userId));
      if (!usable(user)) return fail(c, { code: 'invalid', message: '用户不存在或不可用' });
    }
    const state = options.readiness();
    if (state.mode !== 'managed') return fail(c, { code: 'unavailable', message: '终端设置不可修改' });
    if (change.action === 'set-enabled' && change.enabled && (state.blockedReason !== null || state.workers.length === 0)) return fail(c, { code: 'conflict', message: state.blockedReason ?? '没有就绪的终端 Worker' });
    if (change.action === 'grant' && !state.workers.some((worker) => worker.id === change.workerId)) return fail(c, { code: 'invalid', message: 'Worker 不存在或尚未就绪' });
    options.store.change(change, actor, options.now());
    if (change.action === 'revoke') {
      try { options.onRevoked?.(); } catch (error) { console.error('workdir terminal revoke reconciliation failed', error); }
    }
    return c.json(await dto(true));
  });
}
