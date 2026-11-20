import type {
  AccountDto,
  AdminOverviewDto,
  AdminUserDto,
  AdminWorkerDto,
  AdminWorkersDto,
  AuditEntryDto,
  AuthState,
  CredentialStatusDto,
  EnrollInfoDto,
  InviteDto,
  InvitePreviewDto,
  LoginDeviceDto,
  PairingDto,
  SettingsDto,
  TeamDto
} from '@agent-hub/contract';
import { call, post } from './http.ts';
import type { WorkerPreset } from './workers.ts';

export type {
  AccountDto,
  AdminOverviewDto,
  AdminUserDto,
  AdminWorkerDto,
  AuditEntryDto,
  AuthState,
  CredentialStatusDto,
  EnrollInfoDto,
  InviteDto,
  InvitePreviewDto,
  LoginDeviceDto,
  PairingDto,
  SettingsDto,
  TeamDto
} from '@agent-hub/contract';

export const authApi = {
  state: () => call<AuthState>('/api/auth/state'),
  login: (email: string, password: string) => post<{ user: AccountDto }>('/api/auth/login', { email, password }),
  register: (email: string, password: string, displayName?: string) =>
    post<{ user: AccountDto } | { checkEmail: true }>('/api/auth/register', { email, password, displayName }),
  logout: () => post<{ ok: true }>('/api/auth/logout', {}),
  verifyEmail: (token: string) => post<{ user: AccountDto }>('/api/auth/verify-email', { token }),
  resendVerification: () => post<{ alreadyVerified: boolean }>('/api/auth/resend-verification', {}),
  forgotPassword: (email: string) => post<void>('/api/auth/password/forgot', { email }),
  resetPassword: (token: string, password: string) => post<{ user: AccountDto }>('/api/auth/password/reset', { token, password }),
  logins: () => call<LoginDeviceDto[]>('/api/auth/logins'),
  revokeLogin: (id: string) => call<{ current: boolean }>(`/api/auth/logins/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  revokeOtherLogins: () => post<{ ok: true }>('/api/auth/logins/revoke-others', {}),
  changePassword: (oldPassword: string, newPassword: string) => post<{ ok: true }>('/api/auth/password/change', { oldPassword, newPassword }),
  updateProfile: (displayName: string) =>
    call<{ user: AccountDto }>('/api/auth/profile', { method: 'PATCH', body: JSON.stringify({ displayName }) }),
  previewInvite: (token: string) => post<InvitePreviewDto>('/api/auth/invite/preview', { token }),
  acceptInvite: (token: string, password: string, displayName?: string) =>
    post<{ user: AccountDto }>('/api/auth/invite/accept', { token, password, displayName })
};

/** 审计过滤：空串 / undefined 不发。 */
export interface AuditFilterInput {
  readonly action?: string;
  readonly actor?: string;
  readonly ip?: string;
  readonly since?: number;
  readonly until?: number;
  readonly teamId?: string;
}
export function auditQuery(filter: AuditFilterInput): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value !== undefined && value !== '') params.set(key, String(value));
  const text = params.toString();
  return text ? `?${text}` : '';
}

/** 团队（ADR 0011）：成员都能看，团队 owner / hub 管理员能邀请、改角色、删人。 */
/** 内置四个角色 + 团队自定义（custom:<id>，ADR 0017）。 */
export type RoleKey = 'owner' | 'admin' | 'member' | 'viewer' | `custom:${string}`;
export type PermissionScope = 'own' | 'team';
export interface RoleViewDto {
  readonly key: RoleKey;
  readonly id?: string;
  readonly name: string;
  readonly builtin: boolean;
  readonly permissions: Record<string, PermissionScope>;
  readonly members: number;
}
export interface AccessCatalogDto {
  readonly catalog: Record<string, readonly string[]>;
  readonly all: readonly string[];
  readonly grantable: readonly string[];
  readonly neverGrantable: readonly string[];
}
export interface AccessGrantDto {
  readonly id: string;
  readonly teamId: string;
  readonly userId: string;
  readonly permission: string;
  readonly resourceKind: string;
  readonly resourceId: string;
  readonly reason: string;
  readonly createdAt: number;
  readonly expiresAt: number | null;
  readonly revokedAt: number | null;
}
export const accessApi = {
  catalog: () => call<AccessCatalogDto>('/api/access/catalog'),
  roles: () => call<RoleViewDto[]>('/api/team/roles'),
  createRole: (name: string, permissions: Record<string, PermissionScope>) => post<{ id: string }>('/api/team/roles', { name, permissions }),
  updateRole: (id: string, name: string, permissions: Record<string, PermissionScope>) =>
    call<{ id: string }>(`/api/team/roles/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ name, permissions }) }),
  deleteRole: (id: string) => call<{ ok: true }>(`/api/team/roles/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  grants: () => call<AccessGrantDto[]>('/api/team/grants'),
  revokeGrant: (id: string) => call<AccessGrantDto>(`/api/team/grants/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  visits: () => call<AccessGrantDto[]>('/api/access/visits'),
  teams: () => call<{ id: string; name: string }[]>('/api/admin/teams'),
  startVisit: (teamId: string, reason: string, durationMs: number) => post<AccessGrantDto>('/api/admin/visits', { teamId, reason, durationMs }),
  endVisit: (id: string) => call<{ ok: true }>(`/api/access/visits/${encodeURIComponent(id)}`, { method: 'DELETE' })
};

export const teamApi = {
  team: () => call<TeamDto>('/api/team'),
  audit: (filter: AuditFilterInput = {}) => call<AuditEntryDto[]>(`/api/team/audit${auditQuery(filter)}`),
  invite: (email: string, role: RoleKey, allowOverLimit = false) =>
    post<InviteDto>('/api/team/invites', { email, role, allowOverLimit }),
  revokeInvite: (id: string) => call<InviteDto>(`/api/team/invites/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  setRole: (id: string, role: RoleKey) =>
    call<{ ok: true }>(`/api/team/members/${encodeURIComponent(id)}/role`, { method: 'PUT', body: JSON.stringify({ role }) }),
  remove: (id: string) =>
    call<{ transferredProjects: number }>(`/api/team/members/${encodeURIComponent(id)}`, { method: 'DELETE' })
};

/**
 * 团队级运行时默认模型：新会话没点名模型时，按运行时用这里的默认。
 * 所有成员都能读；只有 owner / admin（`team.manage`）能写，其他人 403。
 * 空串表示「这个运行时没有默认」，整份 `{}` 就是清空。
 */
export interface AgentDefaultsDto {
  readonly defaults: Record<string, string>;
}

export const agentDefaultsApi = {
  get: () => call<AgentDefaultsDto>('/api/team/agent-defaults'),
  set: (defaults: Record<string, string>) =>
    call<AgentDefaultsDto>('/api/team/agent-defaults', { method: 'PUT', body: JSON.stringify({ defaults }) })
};

export const adminApi = {
  overview: () => call<AdminOverviewDto>('/api/admin/overview'),
  users: (q: string) => call<AdminUserDto[]>(`/api/admin/users?q=${encodeURIComponent(q)}`),
  disable: (id: string) => post<AdminUserDto>(`/api/admin/users/${id}/disable`, {}),
  enable: (id: string) => post<AdminUserDto>(`/api/admin/users/${id}/enable`, {}),
  setRole: (id: string, role: RoleKey) => post<AdminUserDto>(`/api/admin/users/${id}/role`, { role }),
  setClusterAdmin: (id: string, clusterAdmin: boolean) =>
    call<{ id: string; clusterAdmin: boolean }>(`/api/admin/users/${id}/cluster-admin`, { method: 'PUT', body: JSON.stringify({ clusterAdmin }) }),
  markVerified: (id: string) => post<AdminUserDto>(`/api/admin/users/${id}/verify`, {}),
  revokeLogins: (id: string) => post<AdminUserDto>(`/api/admin/users/${id}/revoke-logins`, {}),
  workers: () => call<AdminWorkersDto>('/api/admin/workers'),
  updateWorker: (workerId: string) =>
    post<AdminWorkerDto>(`/api/admin/workers/${encodeURIComponent(workerId)}/update`, {}),
  updateOutdated: () => post<AdminWorkerDto[]>('/api/admin/workers/update-outdated', {}),
  disconnect: (workerId: string) =>
    post<AdminWorkerDto>(`/api/admin/workers/${encodeURIComponent(workerId)}/disconnect`, {}),
  settings: () => call<SettingsDto>('/api/admin/settings'),
  saveSettings: (patch: Partial<SettingsDto>) =>
    call<SettingsDto>('/api/admin/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  audit: (filter: AuditFilterInput = {}) => call<AuditEntryDto[]>(`/api/admin/audit${auditQuery(filter)}`),
  enrollInfo: () => call<EnrollInfoDto>('/api/workers/enroll-info'),
  /** 签发一次性接入码（15 分钟、用一次），连同在新机器上运行的一行命令。 */
  pairing: (preset: WorkerPreset = 'full') => post<PairingDto>('/api/workers/pairing', { preset }),
  /** 手动轮换凭据（ADR 0030 D3）：新凭据经当前连接下发，旧的宽限 5 分钟。 */
  rotateWorker: (workerId: string) => post<{ workerId: string; pendingUntil: number }>(`/api/workers/${encodeURIComponent(workerId)}/rotate`, {}),
  credentialStatus: (workerId: string) => call<CredentialStatusDto>(`/api/workers/${encodeURIComponent(workerId)}/credential`),
  /** 吊销一台机器：作废它的凭据并立刻断开，它不会再重连。 */
  revokeWorker: (workerId: string) =>
    call<{ workerId: string; revokedAt: number }>(`/api/workers/${encodeURIComponent(workerId)}`, { method: 'DELETE' })
};
