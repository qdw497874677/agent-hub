import type { DatabaseSync } from 'node:sqlite';
import { EMPTY_USAGE } from '@agent-hub/domain';
import type { ModelProvider, ProviderCheck, ProviderRepository, ProviderRouting, ProviderUsage } from '@agent-hub/domain';
import { createSecretVault } from './secrets.ts';

export const PROVIDER_SCHEMA = `
CREATE TABLE IF NOT EXISTS model_providers (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  owner_id TEXT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL,
  base_url TEXT NOT NULL,
  models TEXT NOT NULL,
  routing TEXT NOT NULL DEFAULT 'direct',
  enabled INTEGER NOT NULL,
  last_check TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_worker_routing (
  worker_id TEXT PRIMARY KEY,
  routing TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_usage (
  provider_id TEXT PRIMARY KEY,
  requests INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  bytes_in INTEGER NOT NULL DEFAULT 0,
  bytes_out INTEGER NOT NULL DEFAULT 0,
  sessions INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER
);
`;

type Row = Record<string, unknown>;

/** 提供商密钥放 provider_secrets（和资产密钥分表，不会出现在资产密钥列表里），名字 = 提供商 id（作 AAD）。 */
export function createSqliteProviders(db: DatabaseSync, key: Uint8Array): ProviderRepository {
  db.exec(PROVIDER_SCHEMA);
  const vault = createSecretVault(db, key, 'provider_secrets');
  const hasKey = db.prepare('SELECT 1 FROM provider_secrets WHERE name = ?');
  const toProvider = (row: Row): ModelProvider => ({
    id: row.id as string,
    scope: row.scope as ModelProvider['scope'],
    ownerId: (row.owner_id as string | null) ?? null,
    slug: row.slug as string,
    name: row.name as string,
    protocol: row.protocol as ModelProvider['protocol'],
    baseUrl: row.base_url as string,
    models: JSON.parse(row.models as string) as ModelProvider['models'],
    routing: row.routing as ProviderRouting,
    enabled: Number(row.enabled) === 1,
    hasKey: hasKey.get(row.id as string) !== undefined,
    lastCheck: row.last_check ? (JSON.parse(row.last_check as string) as ProviderCheck) : null,
    createdBy: row.created_by as string,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  });
  const all = db.prepare('SELECT * FROM model_providers ORDER BY scope, name');
  const one = db.prepare('SELECT * FROM model_providers WHERE id = ?');
  const slug = db.prepare('SELECT * FROM model_providers WHERE slug = ?');
  const upsert = db.prepare(`INSERT INTO model_providers (id, scope, owner_id, slug, name, protocol, base_url, models, routing, enabled, last_check, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET slug = excluded.slug, name = excluded.name, protocol = excluded.protocol, base_url = excluded.base_url,
      models = excluded.models, routing = excluded.routing, enabled = excluded.enabled, last_check = excluded.last_check, updated_at = excluded.updated_at`);
  const del = db.prepare('DELETE FROM model_providers WHERE id = ?');
  const check = db.prepare('UPDATE model_providers SET last_check = ? WHERE id = ?');
  const routes = db.prepare('SELECT worker_id, routing FROM provider_worker_routing');
  const setRoute = db.prepare('INSERT INTO provider_worker_routing (worker_id, routing) VALUES (?, ?) ON CONFLICT(worker_id) DO UPDATE SET routing = excluded.routing');
  const clearRoute = db.prepare('DELETE FROM provider_worker_routing WHERE worker_id = ?');
  const bump = db.prepare(`INSERT INTO provider_usage (provider_id, requests, errors, bytes_in, bytes_out, sessions, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider_id) DO UPDATE SET requests = requests + excluded.requests, errors = errors + excluded.errors,
      bytes_in = bytes_in + excluded.bytes_in, bytes_out = bytes_out + excluded.bytes_out, sessions = sessions + excluded.sessions, last_used_at = excluded.last_used_at`);
  const usage = db.prepare('SELECT * FROM provider_usage WHERE provider_id = ?');
  const delUsage = db.prepare('DELETE FROM provider_usage WHERE provider_id = ?');

  return {
    async list() {
      return (all.all() as Row[]).map(toProvider);
    },
    async byId(id) {
      const row = one.get(id) as Row | undefined;
      return row ? toProvider(row) : null;
    },
    async bySlug(value) {
      const row = slug.get(value) as Row | undefined;
      return row ? toProvider(row) : null;
    },
    async save(p) {
      upsert.run(p.id, p.scope, p.ownerId, p.slug, p.name, p.protocol, p.baseUrl, JSON.stringify(p.models), p.routing, p.enabled ? 1 : 0,
        p.lastCheck ? JSON.stringify(p.lastCheck) : null, p.createdBy, p.createdAt, p.updatedAt);
    },
    async remove(id) {
      await vault.remove(id);
      delUsage.run(id);
      return Number(del.run(id).changes) > 0;
    },
    async setKey(id, value, at) {
      await vault.put(id, value, at);
    },
    async revealKey(id) {
      return (await vault.reveal([id]))[id] ?? null;
    },
    async recordCheck(id, value) {
      check.run(JSON.stringify(value), id);
    },
    async workerRouting() {
      const out: Record<string, ProviderRouting> = {};
      for (const row of routes.all() as Row[]) out[row.worker_id as string] = row.routing as ProviderRouting;
      return out;
    },
    async setWorkerRouting(workerId, routing) {
      if (routing === null) clearRoute.run(workerId);
      else setRoute.run(workerId, routing);
    },
    async addUsage(id, d, at) {
      bump.run(id, d.requests ?? 0, d.errors ?? 0, d.bytesIn ?? 0, d.bytesOut ?? 0, d.sessions ?? 0, at);
    },
    async usage(id): Promise<ProviderUsage> {
      const row = usage.get(id) as Row | undefined;
      if (!row) return EMPTY_USAGE;
      return {
        requests: Number(row.requests), errors: Number(row.errors), bytesIn: Number(row.bytes_in), bytesOut: Number(row.bytes_out),
        sessions: Number(row.sessions), lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at)
      };
    }
  };
}
