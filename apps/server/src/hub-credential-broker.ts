import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { RepoCheckProbe } from '@agent-hub/domain';
import { authHeaderFor } from './repo-auth.ts';
import { originKey, parseAllowedOrigins } from './project-git-https-policy.ts';
import type { ProjectGitSnapshotInput, ProjectGitSnapshotOutcome } from './project-git-fetch.ts';

export interface HubCredentialTarget { teamId: string; repoUrl: string; branch: string | null }
export interface HubCredentialAuditContext { actorId: string; sessionId?: string }
export interface HubCredentialAuditEvent {
  projectId: string; repoId: string; operation: 'create' | 'bind' | 'unbind' | 'rotate' | 'revoke' | 'check' | 'read';
  credentialId: string | null; version: number | null; status: 'ok' | 'branch_missing' | 'unavailable' | 'stale';
  context?: HubCredentialAuditContext;
}
export interface HubCredentialBrokerOptions {
  db: DatabaseSync;
  key: Uint8Array;
  resolveTarget(projectId: string, repoId: string): Promise<HubCredentialTarget | null>;
  allows(projectId: string, repoId: string, url: string): boolean | Promise<boolean>;
  allowedOrigins: readonly string[];
  check(input: { url: string; branch: string | null; authorization: string }): Promise<RepoCheckProbe>;
  read(input: ProjectGitSnapshotInput): Promise<ProjectGitSnapshotOutcome>;
  audit?: (event: HubCredentialAuditEvent) => void;
  now?: () => number;
}
export type Reauthorize = () => Promise<boolean>;
type Row = { id: string; team_id: string; name: string; origin: string; version: number; state: string; cipher: string };
type Binding = { credential_id: string; target: string; revision: string };
type Target = { teamId: string; url: string; branch: string | null; origin: string };
const fail = (): never => { throw new Error('Hub credential unavailable'); };
function canonical(raw: string): string | null {
  if (raw !== raw.trim() || /[\s\u0000-\u001f\u007f?#\\]/u.test(raw) || !/^https:\/\//iu.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || raw.slice(8).split('/')[0]?.includes('@')) return null;
    // URL parser normalizes dot segments; reject them instead of silently changing the target.
    if (url.pathname !== (raw.slice(8).includes('/') ? `/${raw.slice(8).split('/').slice(1).join('/')}` : '/')) return null;
    if (url.pathname === '/' || url.pathname.endsWith('/') || url.pathname.includes('//') || /%2e|%2f|%5c|%3f|%23/iu.test(raw)) return null;
    const decoded = decodeURIComponent(url.pathname);
    if (/[\u0000-\u001f\u007f\\]/u.test(decoded) || decoded.split('/').some((segment) => segment === '.' || segment === '..')) return null;
    return `${url.origin}${url.pathname}`;
  } catch { return null; }
}
function validSecret(value: string): boolean { return value.length > 0 && value.length <= 4096 && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value); }
function validName(value: string): boolean { return value.length > 0 && value.length <= 128 && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value); }

/** Install after broker tables exist. SQLite persists these triggers even when the feature is disabled.
 * A raw repository-list or legacy-column change invalidates the whole project's bindings: malformed
 * and legacy rows may be interpreted through a fallback, so per-entry SQL comparison is unsafe.
 * Project epochs also prevent an in-flight create/bind from reviving an absent binding (ABA).
 */
export function installHubCredentialBindingLifecycle(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hub_credential_project_epochs (project_id TEXT PRIMARY KEY, revision TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS hub_credential_project_insert AFTER INSERT ON projects BEGIN
      DELETE FROM hub_credential_bindings WHERE project_id = NEW.id;
      INSERT INTO hub_credential_project_epochs VALUES (NEW.id, lower(hex(randomblob(16))))
        ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision;
    END;
    CREATE TRIGGER IF NOT EXISTS hub_credential_project_update AFTER UPDATE ON projects
    WHEN OLD.id IS NOT NEW.id OR OLD.team_id IS NOT NEW.team_id OR OLD.deleted_at IS NOT NEW.deleted_at
      OR OLD.repos IS NOT NEW.repos OR OLD.repo_url IS NOT NEW.repo_url OR OLD.repo_default_branch IS NOT NEW.repo_default_branch
    BEGIN
      DELETE FROM hub_credential_bindings WHERE project_id = OLD.id OR project_id = NEW.id;
      INSERT INTO hub_credential_project_epochs VALUES (OLD.id, lower(hex(randomblob(16))))
        ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision;
      INSERT INTO hub_credential_project_epochs VALUES (NEW.id, lower(hex(randomblob(16))))
        ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision;
    END;
    CREATE TRIGGER IF NOT EXISTS hub_credential_project_delete AFTER DELETE ON projects BEGIN
      DELETE FROM hub_credential_bindings WHERE project_id = OLD.id;
      INSERT INTO hub_credential_project_epochs VALUES (OLD.id, lower(hex(randomblob(16))))
        ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision;
    END;
  `);
}

/** The key is provided by the host; never generate a replacement key for existing records. */
export function createHubCredentialBroker(options: HubCredentialBrokerOptions) {
  const { db } = options;
  if (options.key.length !== 32) throw new Error('Hub credential key must be 32 bytes');
  const key = Buffer.from(options.key);
  const origins = parseAllowedOrigins(options.allowedOrigins, 'Hub credential');
  const audit = (projectId: string, repoId: string, operation: HubCredentialAuditEvent['operation'], c: Pick<Row, 'id' | 'version'> | null, status: HubCredentialAuditEvent['status'], context?: HubCredentialAuditContext) => {
    const bounded = (value: string) => value.length <= 128 && value.length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
    const safeContext = context && bounded(context.actorId) && (context.sessionId === undefined || bounded(context.sessionId)) ? { actorId: context.actorId, ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }) } : undefined;
    try { options.audit?.({ projectId: bounded(projectId) ? projectId : '[invalid]', repoId: bounded(repoId) ? repoId : '[invalid]', operation, credentialId: c?.id ?? null, version: c?.version ?? null, status, ...(safeContext ? { context: safeContext } : {}) }); } catch { /* audit sink cannot leak upstream errors */ }
  };
  db.exec(`CREATE TABLE IF NOT EXISTS hub_credentials (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, name TEXT NOT NULL, origin TEXT NOT NULL, version INTEGER NOT NULL, state TEXT NOT NULL, cipher TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS hub_credential_bindings (project_id TEXT NOT NULL, repo_id TEXT NOT NULL, credential_id TEXT NOT NULL, target TEXT NOT NULL, revision TEXT NOT NULL, PRIMARY KEY(project_id, repo_id));
    CREATE TABLE IF NOT EXISTS hub_credential_key_check (id INTEGER PRIMARY KEY CHECK(id=1), cipher TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS hub_credential_project_epochs (project_id TEXT PRIMARY KEY, revision TEXT NOT NULL);`);
  const encrypt = (text: string, aad: string): string => {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(aad)); const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  };
  const decrypt = (text: string, aad: string): string => {
    const data = Buffer.from(text, 'base64'); if (data.length < 28) return fail();
    const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); cipher.setAAD(Buffer.from(aad)); cipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8');
  };
  const checkKey = db.prepare('SELECT cipher FROM hub_credential_key_check WHERE id=1').get() as { cipher: string } | undefined;
  if (checkKey) { try { if (decrypt(checkKey.cipher, 'key-check') !== 'hub-credential-v1') fail(); } catch { throw new Error('Hub credential key unavailable'); } }
  else {
    const count = db.prepare('SELECT count(*) AS n FROM hub_credentials').get() as { n: number };
    if (count.n) throw new Error('Hub credential key unavailable');
    db.prepare('INSERT INTO hub_credential_key_check VALUES (1, ?)').run(encrypt('hub-credential-v1', 'key-check'));
  }
  const transaction = <T>(fn: () => T): T => { db.exec('BEGIN IMMEDIATE'); try { const value = fn(); db.exec('COMMIT'); return value; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  const target = async (projectId: string, repoId: string): Promise<Target> => {
    const project = await options.resolveTarget(projectId, repoId);
    if (!project || !project.teamId) return fail();
    const url = canonical(project.repoUrl); if (!url) return fail();
    const origin = originKey(new URL(url));
    if (!origins.has(origin) || !await options.allows(projectId, repoId, url)) return fail();
    return { teamId: project.teamId, url, origin, branch: project.branch };
  };
  const authorizedTarget = async (projectId: string, repoId: string, authorize: Reauthorize): Promise<Target> => {
    if (!await authorize()) return fail();
    const result = await target(projectId, repoId);
    if (!await authorize()) return fail();
    const fresh = await target(projectId, repoId);
    if (fresh.teamId !== result.teamId || fresh.url !== result.url || fresh.branch !== result.branch) return fail();
    return fresh;
  };
  const binding = (projectId: string, repoId: string): Binding | undefined => db.prepare('SELECT credential_id, target, revision FROM hub_credential_bindings WHERE project_id=? AND repo_id=?').get(projectId, repoId) as Binding | undefined;
  const credential = (id: string): Row | undefined => db.prepare('SELECT id, team_id, name, origin, version, state, cipher FROM hub_credentials WHERE id=?').get(id) as Row | undefined;
  const stamp = (projectId: string, repoId: string) => {
    const b = binding(projectId, repoId); const c = b && credential(b.credential_id);
    const epoch = db.prepare('SELECT revision FROM hub_credential_project_epochs WHERE project_id=?').get(projectId) as { revision: string } | undefined;
    return JSON.stringify([b?.revision ?? null, c?.version ?? null, c?.state ?? null, epoch?.revision ?? null]);
  };
  const ensureStamp = (projectId: string, repoId: string, expected: string) => { if (stamp(projectId, repoId) !== expected) fail(); };
  const active = (t: Target, b: Binding | undefined): Row => {
    if (!b || b.target !== t.url) return fail(); const c = credential(b.credential_id);
    if (!c || c.state !== 'active' || c.team_id !== t.teamId || c.origin !== t.origin) return fail(); return c;
  };
  const unchanged = async (projectId: string, repoId: string, auth: Reauthorize, t: Target, b: Binding, c: Row): Promise<boolean> => {
    try {
      const next = await authorizedTarget(projectId, repoId, auth);
      const latest = binding(projectId, repoId); const latestCredential = credential(c.id);
      return next.teamId === t.teamId && next.url === t.url && next.branch === t.branch && latest?.revision === b.revision && latest.credential_id === c.id && latest.target === b.target && latestCredential?.state === 'active' && latestCredential.version === c.version && latestCredential.team_id === c.team_id && latestCredential.origin === c.origin;
    } catch { return false; }
  };
  const prepare = async (projectId: string, repoId: string, auth: Reauthorize) => {
    const t = await authorizedTarget(projectId, repoId, auth); const b = binding(projectId, repoId); const c = active(t, b);
    if (!b || !await unchanged(projectId, repoId, auth, t, b, c)) return fail();
    let secret: string; try { secret = decrypt(c.cipher, `${c.id}:${c.team_id}:${c.version}`); } catch { return fail(); }
    return { t, b, c, authorization: authHeaderFor(secret, t.url).header.replace(/^Authorization: /, '') };
  };
  const putBinding = (projectId: string, repoId: string, id: string, url: string) => db.prepare('INSERT INTO hub_credential_bindings VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, repo_id) DO UPDATE SET credential_id=excluded.credential_id, target=excluded.target, revision=excluded.revision').run(projectId, repoId, id, url, randomUUID());
  return {
    async list(projectId: string, repoId: string, auth: Reauthorize) {
      const t = await authorizedTarget(projectId, repoId, auth); const b = binding(projectId, repoId);
      let current: Row | undefined; try { current = active(t, b); } catch { /* stale binding is not usable */ }
      const rows = db.prepare("SELECT id, name, version FROM hub_credentials WHERE team_id=? AND origin=? AND state='active' ORDER BY name, id").all(t.teamId, t.origin) as Array<{ id: string; name: string; version: number }>;
      return { binding: current ? { credentialId: current.id, name: current.name, version: current.version } : null, credentials: rows };
    },
    async create(projectId: string, repoId: string, name: string, secret: string, auth: Reauthorize, context?: HubCredentialAuditContext) {
      if (!validName(name) || !validSecret(secret)) return fail();
      const expected = stamp(projectId, repoId);
      const t = await authorizedTarget(projectId, repoId, auth); const id = randomUUID();
      transaction(() => { ensureStamp(projectId, repoId, expected); db.prepare('INSERT INTO hub_credentials VALUES (?, ?, ?, ?, 1, ?, ?, ?)').run(id, t.teamId, name, t.origin, 'active', encrypt(secret, `${id}:${t.teamId}:1`), (options.now ?? Date.now)()); putBinding(projectId, repoId, id, t.url); });
      audit(projectId, repoId, 'create', { id, version: 1 }, 'ok', context);
      return { ok: true as const, version: 1 };
    },
    async bind(projectId: string, repoId: string, id: string, auth: Reauthorize, context?: HubCredentialAuditContext) {
      const expected = stamp(projectId, repoId);
      const t = await authorizedTarget(projectId, repoId, auth);
      const c = transaction(() => { ensureStamp(projectId, repoId, expected); const c = credential(id); if (!c || c.state !== 'active' || c.team_id !== t.teamId || c.origin !== t.origin) return fail(); putBinding(projectId, repoId, id, t.url); return c; }); audit(projectId, repoId, 'bind', c, 'ok', context); return { ok: true as const };
    },
    async unbind(projectId: string, repoId: string, auth: Reauthorize, context?: HubCredentialAuditContext) {
      const expected = stamp(projectId, repoId); await authorizedTarget(projectId, repoId, auth); const c = transaction(() => { ensureStamp(projectId, repoId, expected); const b = binding(projectId, repoId); const c = b ? credential(b.credential_id) ?? null : null; db.prepare('DELETE FROM hub_credential_bindings WHERE project_id=? AND repo_id=?').run(projectId, repoId); return c; }); audit(projectId, repoId, 'unbind', c, 'ok', context); return { ok: true as const };
    },
    async rotate(projectId: string, repoId: string, secret: string, credentialId: string, version: number, auth: Reauthorize, context?: HubCredentialAuditContext) {
      if (!validSecret(secret)) return fail(); const expected = stamp(projectId, repoId); const t = await authorizedTarget(projectId, repoId, auth);
      const current = active(t, binding(projectId, repoId)); if (current.id !== credentialId || current.version !== version) return fail();
      const result = transaction(() => { ensureStamp(projectId, repoId, expected); const c = active(t, binding(projectId, repoId)); const nextVersion = c.version + 1;
        db.prepare('UPDATE hub_credentials SET version=?, cipher=?, updated_at=? WHERE id=?').run(nextVersion, encrypt(secret, `${c.id}:${c.team_id}:${nextVersion}`), (options.now ?? Date.now)(), c.id);
        const { n } = db.prepare('SELECT count(*) AS n FROM hub_credential_bindings WHERE credential_id=?').get(c.id) as { n: number }; return { ok: true as const, version: nextVersion, affectedBindings: n }; }); audit(projectId, repoId, 'rotate', { id: current.id, version: result.version }, 'ok', context); return result;
    },
    async revoke(projectId: string, repoId: string, credentialId: string, version: number, auth: Reauthorize, context?: HubCredentialAuditContext) {
      const expected = stamp(projectId, repoId); const t = await authorizedTarget(projectId, repoId, auth);
      const current = active(t, binding(projectId, repoId)); if (current.id !== credentialId || current.version !== version) return fail();
      const result = transaction(() => { ensureStamp(projectId, repoId, expected); const c = active(t, binding(projectId, repoId));
        db.prepare("UPDATE hub_credentials SET state='revoked', version=version+1, cipher='', updated_at=? WHERE id=?").run((options.now ?? Date.now)(), c.id);
        const { n } = db.prepare('SELECT count(*) AS n FROM hub_credential_bindings WHERE credential_id=?').get(c.id) as { n: number }; return { ok: true as const, version: c.version + 1, affectedBindings: n }; }); audit(projectId, repoId, 'revoke', { id: current.id, version: result.version }, 'ok', context); return result;
    },
    async check(projectId: string, repoId: string, auth: Reauthorize, context?: HubCredentialAuditContext): Promise<{ status: 'ok' | 'branch_missing' | 'unavailable'; branch: string | null }> {
      const p = await prepare(projectId, repoId, auth); let result: RepoCheckProbe | null = null;
      if (!await unchanged(projectId, repoId, auth, p.t, p.b, p.c)) { audit(projectId, repoId, 'check', p.c, 'stale', context); return fail(); }
      try { result = await options.check({ url: p.t.url, branch: p.t.branch, authorization: p.authorization }); } catch { /* no upstream errors escape */ }
      if (!await unchanged(projectId, repoId, auth, p.t, p.b, p.c)) { audit(projectId, repoId, 'check', p.c, 'stale', context); return fail(); }
      const branch = p.t.branch ?? (result?.defaultBranch && result.defaultBranch.length <= 255 && !/[\u0000-\u001f\u007f]/u.test(result.defaultBranch) ? result.defaultBranch : null);
      const status = !result?.reachable || (p.t.branch === null && branch === null) ? 'unavailable' : p.t.branch === null || result.branchExists ? 'ok' : 'branch_missing';
      audit(projectId, repoId, 'check', p.c, status, context);
      return { status, branch };
    },
    async readRepo(input: { projectId: string; repoId: string; branch: string | null; path: string | null; expectedTip: string | null; reauthorize: Reauthorize; auditContext?: HubCredentialAuditContext }): Promise<ProjectGitSnapshotOutcome> {
      const unavailable = (): ProjectGitSnapshotOutcome => ({ ok: false, code: 'generic', message: '仓库读取不可用' });
      try {
        const p = await prepare(input.projectId, input.repoId, input.reauthorize);
        const authorizeUpstream = () => unchanged(input.projectId, input.repoId, input.reauthorize, p.t, p.b, p.c);
        let branch = input.branch ?? p.t.branch;
        if (branch === null) {
          let probe: RepoCheckProbe | null = null;
          if (!await authorizeUpstream()) { audit(input.projectId, input.repoId, 'read', p.c, 'stale', input.auditContext); return unavailable(); }
          try { probe = await options.check({ url: p.t.url, branch: null, authorization: p.authorization }); } catch { /* normalized below */ }
          branch = probe?.reachable ? probe.defaultBranch : null;
          if (!branch || branch.length > 255 || /[\u0000-\u001f\u007f]/u.test(branch)) { audit(input.projectId, input.repoId, 'read', p.c, 'unavailable', input.auditContext); return unavailable(); }
        }
        if (!await authorizeUpstream()) { audit(input.projectId, input.repoId, 'read', p.c, 'stale', input.auditContext); return unavailable(); }
        let result: ProjectGitSnapshotOutcome;
        try { result = await options.read({ repoUrl: p.t.url, branch, authorization: p.authorization, path: input.path, expectedTip: input.expectedTip, authorizeUpstream }); } catch { result = unavailable(); }
        if (!await authorizeUpstream()) { audit(input.projectId, input.repoId, 'read', p.c, 'stale', input.auditContext); return unavailable(); }
        audit(input.projectId, input.repoId, 'read', p.c, result.ok ? 'ok' : 'unavailable', input.auditContext);
        return result.ok ? result : { ok: false, code: result.code, message: '仓库读取不可用' };
      } catch { return unavailable(); }
    }
  };
}
export type HubCredentialBroker = ReturnType<typeof createHubCredentialBroker>;
