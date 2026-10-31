import type { DatabaseSync } from 'node:sqlite';
import type { AccessGrant, AccessGrantRepository, CustomRole, Permission, ResourceKind, RolePermissions, TeamRoleRepository } from '@agent-hub/domain';

/**
 * ADR 0017：显式授权 + 团队自定义角色。
 * 显式授权和 #119（ADR 0016）的审核人共用一张 access_grants（主体 × 权限 × 资源）。
 * 审核人那几行由审核设置整批维护（没有 id），这里只读写带 id 的显式授权行；
 * 但 can() 认审核人行（asset.review），见 activeFor。
 */
export const ACCESS_SCHEMA = `
CREATE TABLE IF NOT EXISTS access_grants (
  subject_id    TEXT NOT NULL,
  permission    TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id   TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (subject_id, permission, resource_type, resource_id)
);
CREATE TABLE IF NOT EXISTS team_roles (
  id          TEXT PRIMARY KEY,
  team_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  permissions TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS team_roles_name ON team_roles(team_id, name);
`;

type Row = Record<string, unknown>;
const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

export function createSqliteAccess(db: DatabaseSync): { grants: AccessGrantRepository; roles: TeamRoleRepository } {
  db.exec(ACCESS_SCHEMA);
  // 在 #119 的表上补列（老库已有表，CREATE IF NOT EXISTS 不会加列）
  const have = new Set((db.prepare('PRAGMA table_info(access_grants)').all() as Row[]).map((c) => String(c['name'])));
  for (const [name, type] of [['id', 'TEXT'], ['team_id', 'TEXT'], ['reason', "TEXT NOT NULL DEFAULT ''"], ['created_by', 'TEXT'], ['expires_at', 'INTEGER'], ['revoked_at', 'INTEGER']] as const) {
    if (!have.has(name)) db.exec(`ALTER TABLE access_grants ADD COLUMN ${name} ${type}`);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS access_grants_id ON access_grants(id) WHERE id IS NOT NULL');
  db.exec('CREATE INDEX IF NOT EXISTS access_grants_by_subject ON access_grants(subject_id)');
  db.exec('CREATE INDEX IF NOT EXISTS access_grants_by_team ON access_grants(team_id)');
  const toGrant = (row: Row): AccessGrant => ({
    // 审核人行没有 id：合成一个稳定的只读 id
    id: (row.id as string | null) ?? `review:${String(row.subject_id)}:${String(row.resource_type)}:${String(row.resource_id)}`,
    teamId: (row.team_id as string | null) ?? (row.resource_type === 'team' ? String(row.resource_id) : ''),
    userId: row.subject_id as string,
    permission: row.permission as Permission,
    resourceKind: row.resource_type as ResourceKind,
    resourceId: row.resource_id as string,
    reason: (row.reason as string | null) ?? '审核人（审核设置）',
    createdBy: (row.created_by as string | null) ?? '',
    createdAt: Number(row.created_at),
    expiresAt: num(row.expires_at),
    revokedAt: num(row.revoked_at)
  });
  const toRole = (row: Row): CustomRole => ({
    id: row.id as string,
    teamId: row.team_id as string,
    name: row.name as string,
    permissions: JSON.parse(row.permissions as string) as RolePermissions,
    createdBy: row.created_by as string,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  });
  // 同一主体 × 权限 × 资源只有一行：吊销后再授权 = 覆盖那一行
  const upsertGrant = db.prepare(`INSERT INTO access_grants (id, team_id, subject_id, permission, resource_type, resource_id, reason, created_by, created_at, expires_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(subject_id, permission, resource_type, resource_id) DO UPDATE SET
    id = excluded.id, team_id = excluded.team_id, reason = excluded.reason, created_by = excluded.created_by, created_at = excluded.created_at,
    expires_at = excluded.expires_at, revoked_at = excluded.revoked_at`);
  const grantById = db.prepare('SELECT * FROM access_grants WHERE id = ?');
  const grantsFor = db.prepare('SELECT * FROM access_grants WHERE subject_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)');
  const grantsOfTeam = db.prepare(
    "SELECT * FROM access_grants WHERE team_id = ? OR (id IS NULL AND resource_type = 'team' AND resource_id = ?) ORDER BY created_at DESC LIMIT 500"
  );
  const upsertRole = db.prepare(`INSERT INTO team_roles (id, team_id, name, permissions, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, permissions = excluded.permissions, updated_at = excluded.updated_at`);
  const roleById = db.prepare('SELECT * FROM team_roles WHERE id = ?');
  const rolesOfTeam = db.prepare('SELECT * FROM team_roles WHERE team_id = ? ORDER BY created_at');
  const deleteRole = db.prepare('DELETE FROM team_roles WHERE id = ?');
  return {
    grants: {
      async save(g) {
        upsertGrant.run(g.id, g.teamId, g.userId, g.permission, g.resourceKind, g.resourceId, g.reason, g.createdBy, g.createdAt, g.expiresAt, g.revokedAt);
      },
      async byId(id) {
        const row = grantById.get(id) as Row | undefined;
        return row ? toGrant(row) : null;
      },
      async activeFor(userId, now) {
        return (grantsFor.all(userId, now) as Row[]).map(toGrant);
      },
      async listByTeam(teamId) {
        return (grantsOfTeam.all(teamId, teamId) as Row[]).map(toGrant);
      }
    },
    roles: {
      async save(r) {
        upsertRole.run(r.id, r.teamId, r.name, JSON.stringify(r.permissions), r.createdBy, r.createdAt, r.updatedAt);
      },
      async byId(id) {
        const row = roleById.get(id) as Row | undefined;
        return row ? toRole(row) : null;
      },
      async listByTeam(teamId) {
        return (rolesOfTeam.all(teamId) as Row[]).map(toRole);
      },
      async delete(id) {
        deleteRole.run(id);
      }
    }
  };
}
