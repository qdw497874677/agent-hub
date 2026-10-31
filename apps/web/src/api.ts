import type {
  AgentDto,
  AttachmentInputDto,
  CapabilityDto,
  ProjectFilesDto,
  StoredAttachmentDto,
  ArtifactDto,
  CanvasDto,
  ContinueElsewhereRequest,
  CreateTaskRequest,
  DeriveSessionRequest,
  ForkSessionRequest,
  JournalEntryDto,
  LayoutDto,
  SaveLayoutRequest,
  DirectoryListingDto,
  OptionValueDto,
  HomeDto,
  ProjectDto,
  ProjectSummaryDto,
  RecentSessionDto,
  RuntimeOptionDto,
  SearchHitDto,
  SearchResponseDto,
  SessionDto,
  SessionEventDto,
  TaskDto,
  WorkLogEntryDto,
  WorkerInfoDto,
  WorkspaceDto,
  WorkspaceViewDto,
  CreateWorkspaceRequest,
  RemoveWorkspaceRequest,
  WorkspaceChangesDto,
  AccountDto,
  LoginDeviceDto,
  AuthState,
  AdminOverviewDto,
  AdminUserDto,
  AdminWorkerDto,
  AdminWorkersDto,
  AuditEntryDto,
  EnrollInfoDto,
  PairingDto,
  SettingsDto,
  AssetsOverviewDto,
  ProjectAssetsDto,
  AssetRevisionDto,
  AssetDiffDto,
  GitScanDto,
  SecretsOverviewDto,
  TeamDto,
  InviteDto,
  InvitePreviewDto
} from '@agent-hub/contract';

export type { TeamDto, InviteDto, InvitePreviewDto };
export type { WorkspaceChangesDto, SaveLayoutRequest, WorkerInfoDto, WorkspaceDto, WorkspaceViewDto, AccountDto, AuthState, CreateWorkspaceRequest, LoginDeviceDto };

export interface ApiError {
  readonly code: string;
  readonly message: string;
}

export class RequestFailed extends Error {
  constructor(readonly status: number, readonly detail: ApiError) {
    super(detail.message);
  }
}

/**
 * 身份靠服务端下发的 httpOnly cookie，前端碰不到登录令牌。
 * 会改东西的请求要带 X-Hub-CSRF（双提交：值从非 httpOnly 的 hub_csrf cookie 读）。
 */
function csrfToken(): string {
  if (typeof document === 'undefined') return '';
  const match = document.cookie.match(/(?:^|;\s*)hub_csrf=([^;]*)/);
  return match ? decodeURIComponent(match[1] ?? '') : '';
}

/** 任何接口回 401 都广播出去，登录闸门据此回到登录页。 */
export const UNAUTHORIZED_EVENT = 'agent-hub:unauthorized';

export const streamUrl = (): string => '/api/stream';

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const method = init?.method ?? 'GET';
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      ...(method === 'GET' ? {} : { 'x-hub-csrf': csrfToken() }),
      ...(init?.headers ?? {})
    }
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: ApiError } | null;
    if (response.status === 401 && !path.startsWith('/api/auth/') && typeof window !== 'undefined') {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
    throw new RequestFailed(response.status, body?.error ?? { code: 'http', message: response.statusText });
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

const post = <T>(path: string, body: unknown): Promise<T> =>
  call<T>(path, { method: 'POST', body: JSON.stringify(body) });

/** 会话详情里的「谁做了什么」。 */
export interface SessionActivityDto {
  readonly action: 'session.start' | 'session.fork' | 'session.interrupt' | 'session.continue';
  readonly actor: { readonly id: string; readonly name: string };
  readonly detail: string;
  readonly at: number;
}

export const api = {
  workers: () => call<WorkerInfoDto[]>('/api/workers'),
  probeWorker: (workerId: string) => post<{ ok: true }>(`/api/workers/${encodeURIComponent(workerId)}/probe`, {}),
  /** 「资源满了就拒绝新会话」开关（ADR 0014，默认关）。 */
  setResourcePolicy: (workerId: string, refuseWhenFull: boolean) =>
    call<{ refuseWhenFull: boolean }>(`/api/workers/${encodeURIComponent(workerId)}/resource-policy`, { method: 'PUT', body: JSON.stringify({ refuseWhenFull }) }),
  /** 在这台机器上装 / 升级 / 卸载一个 agent 运行时；只回「已下发」，进度看 workers 列表里的 runtimeJob。 */
  runtimeJob: (workerId: string, agentId: string, body: { action: 'install' | 'uninstall'; version?: string }) =>
    post<{ job: unknown }>(`/api/workers/${encodeURIComponent(workerId)}/runtimes/${encodeURIComponent(agentId)}`, body),
  home: () => call<HomeDto>('/api/home'),
  projects: () => call<ProjectDto[]>('/api/projects'),
  listDirectories: (path: string, workerId: string | null = null, project = '') =>
    call<DirectoryListingDto>(
      `/api/fs/directories?path=${encodeURIComponent(path)}${workerId ? `&workerId=${encodeURIComponent(workerId)}` : ''}${
        project ? `&project=${encodeURIComponent(project)}` : ''
      }`
    ),
  makeDirectory: (input: { workerId: string | null; parent: string; name: string }) =>
    post<{ path: string }>('/api/fs/directories', input),
  trash: () => call<{ id: string; name: string; deletedAt: number | null; createdBy: string | null }[]>('/api/projects-trash'),
  restoreProject: (projectId: string) =>
    call<{ id: string; restored: true }>(`/api/projects/${encodeURIComponent(projectId)}/restore`, { method: 'POST', body: '{}' }),
  purgeProject: (projectId: string, confirmName: string) =>
    call<{ id: string; purged: true }>(`/api/projects/${encodeURIComponent(projectId)}/purge`, { method: 'POST', body: JSON.stringify({ confirmName }) }),
  deleteProject: (projectId: string, confirmName: string) =>
    call<{ id: string; deleted: true }>(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE', body: JSON.stringify({ confirmName }) }),
  createProject: (input: {
    name: string;
    rootPath?: string;
    workerId?: string | null;
    repoUrl?: string | null;
    defaultBranch?: string | null;
    description?: string | null;
  }) => post<ProjectDto>('/api/projects', input),
  setProjectDescription: (projectId: string, description: string | null) =>
    call<ProjectDto>(`/api/projects/${encodeURIComponent(projectId)}/description`, { method: 'PUT', body: JSON.stringify({ description }) }),
  workspaces: (projectId: string) => call<WorkspaceViewDto[]>(`/api/projects/${encodeURIComponent(projectId)}/workspaces`),
  createWorkspace: (projectId: string, input: CreateWorkspaceRequest) =>
    post<WorkspaceDto>(`/api/projects/${encodeURIComponent(projectId)}/workspaces`, input),
  workspaceChanges: (workspaceId: string) => call<WorkspaceChangesDto>(`/api/workspaces/${encodeURIComponent(workspaceId)}/changes`),
  removeWorkspace: (workspaceId: string, input: RemoveWorkspaceRequest) =>
    post<WorkspaceDto>(`/api/workspaces/${encodeURIComponent(workspaceId)}/remove`, input),
  canvas: (projectId: string) => call<CanvasDto>(`/api/projects/${projectId}/canvas`),
  createTask: (input: CreateTaskRequest) => post<TaskDto>('/api/tasks', input),
  setTaskStatus: (taskId: string, status: TaskDto['status'], note?: string) =>
    call<TaskDto>(`/api/tasks/${taskId}/status`, { method: 'PATCH', body: JSON.stringify({ status, note }) }),
  setTaskSummary: (taskId: string, summary: string) =>
    call<TaskDto>(`/api/tasks/${taskId}/summary`, { method: 'PATCH', body: JSON.stringify({ summary }) }),
  taskLog: (taskId: string, beforeSeq?: number) =>
    call<{ entries: WorkLogEntryDto[]; nextBeforeSeq: number | null }>(
      `/api/tasks/${taskId}/log?limit=50${beforeSeq ? `&beforeSeq=${beforeSeq}` : ''}`
    ),
  appendTaskLog: (taskId: string, input: { body: string }) =>
    post<{ entry: WorkLogEntryDto; task: TaskDto }>(`/api/tasks/${taskId}/log`, input),
  derive: (input: DeriveSessionRequest) => post<SessionDto>('/api/sessions/derive', input),
  fork: (input: ForkSessionRequest) => post<SessionDto>('/api/sessions/fork', input),
  continueElsewhere: (sessionId: string, input: ContinueElsewhereRequest) =>
    post<SessionDto>(`/api/sessions/${sessionId}/continue`, input),
  prompt: (sessionId: string, text: string, attachments: readonly AttachmentInputDto[] = []) =>
    post<{ ok: true }>(`/api/sessions/${sessionId}/prompt`, { text, attachments }),
  projectFiles: (projectId: string, q: string, sessionId?: string) =>
    call<ProjectFilesDto>(
      `/api/projects/${projectId}/files?q=${encodeURIComponent(q)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ''}`
    ),
  interrupt: (sessionId: string) => post<{ ok: true }>(`/api/sessions/${sessionId}/interrupt`, {}),
  changeOption: (sessionId: string, optionId: string, value: string | boolean) =>
    post<SessionDto>(`/api/sessions/${sessionId}/options`, { optionId, value }),
  sessionAssets: (sessionId: string) => call<SessionAssetsDto>(`/api/sessions/${sessionId}/assets`),
  activity: (sessionId: string) => call<SessionActivityDto[]>(`/api/sessions/${sessionId}/activity`),
  events: (sessionId: string, after = 0) =>
    call<JournalEntryDto[]>(`/api/sessions/${sessionId}/events${after > 0 ? `?after=${after}` : ''}`),
  search: (projectId: string, q: string) =>
    call<SearchResponseDto>(`/api/search?projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent(q)}`),
  saveLayout: (projectId: string, patch: SaveLayoutRequest) =>
    call<LayoutDto>(`/api/projects/${projectId}/layout`, { method: 'PUT', body: JSON.stringify(patch) })
};

/** 会话启动时实际给出的资产清单（见 asset-hub.md「会话资产清单」）。 */
export interface SessionAssetsDto {
  readonly sessionId: string;
  readonly workerId: string | null;
  readonly entries: readonly { assetId: string; kind: 'skill' | 'instruction' | 'mcp'; name: string; digest: string; scope: 'global' | 'project' }[];
  readonly at: number | null;
}

export const attachmentUrl = (sessionId: string, path: string): string =>
  `/api/sessions/${sessionId}/attachment?path=${encodeURIComponent(path)}`;

export const authApi = {
  state: () => call<AuthState>('/api/auth/state'),
  login: (email: string, password: string) => post<{ user: AccountDto }>('/api/auth/login', { email, password }),
  register: (email: string, password: string, displayName?: string) =>
    post<{ user: AccountDto } | { checkEmail: true }>('/api/auth/register', { email, password, displayName }),
  tokenLogin: (token: string) => post<{ user: AccountDto }>('/api/auth/token-login', { token }),
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
export const teamApi = {
  team: () => call<TeamDto>('/api/team'),
  audit: (filter: AuditFilterInput = {}) => call<AuditEntryDto[]>(`/api/team/audit${auditQuery(filter)}`),
  invite: (email: string, role: 'owner' | 'member', allowOverLimit = false) =>
    post<InviteDto>('/api/team/invites', { email, role, allowOverLimit }),
  revokeInvite: (id: string) => call<InviteDto>(`/api/team/invites/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  setRole: (id: string, role: 'owner' | 'member') =>
    call<{ ok: true }>(`/api/team/members/${encodeURIComponent(id)}/role`, { method: 'PUT', body: JSON.stringify({ role }) }),
  remove: (id: string) =>
    call<{ transferredProjects: number }>(`/api/team/members/${encodeURIComponent(id)}`, { method: 'DELETE' })
};

export const adminApi = {
  overview: () => call<AdminOverviewDto>('/api/admin/overview'),
  users: (q: string) => call<AdminUserDto[]>(`/api/admin/users?q=${encodeURIComponent(q)}`),
  disable: (id: string) => post<AdminUserDto>(`/api/admin/users/${id}/disable`, {}),
  enable: (id: string) => post<AdminUserDto>(`/api/admin/users/${id}/enable`, {}),
  setRole: (id: string, role: 'owner' | 'member') => post<AdminUserDto>(`/api/admin/users/${id}/role`, { role }),
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
  pairing: () => post<PairingDto>('/api/workers/pairing', {}),
  /** 吊销一台机器：作废它的凭据并立刻断开，它不会再重连。 */
  revokeWorker: (workerId: string) =>
    call<{ workerId: string; revokedAt: number }>(`/api/workers/${encodeURIComponent(workerId)}`, { method: 'DELETE' })
};

/** 资产中心（docs/design/asset-hub.md）：技能与指令，按机器安装。文件内容一律 base64。 */
export type AssetUploadFile = { readonly path: string; readonly data: string };
const assetPath = (id: string) => `/api/admin/assets/${encodeURIComponent(id)}`;
export const assetsApi = {
  overview: () => call<AssetsOverviewDto>('/api/admin/assets'),
  upload: (input: { kind: 'skill' | 'instruction' | 'mcp'; name?: string; projectId?: string | null; files: AssetUploadFile[] }) =>
    post<{ id: string }>('/api/admin/assets/upload', input),
  scanGit: (url: string, ref: string) => post<GitScanDto>('/api/admin/assets/git/scan', { url, ref: ref || null }),
  importGit: (input: { url: string; ref: string; kind: 'skill' | 'instruction' | 'mcp'; path: string; projectId?: string | null }) =>
    post<{ id: string }>('/api/admin/assets/git/import', { ...input, ref: input.ref || null }),
  revisions: (id: string) => call<AssetRevisionDto[]>(`${assetPath(id)}/revisions`),
  file: (id: string, digest: string, path: string) =>
    call<{ text: string }>(`${assetPath(id)}/file?digest=${digest}&path=${encodeURIComponent(path)}`),
  diff: (id: string, from: string, to: string) => call<AssetDiffDto>(`${assetPath(id)}/diff?from=${from}&to=${to}`),
  uploadRevision: (id: string, files: AssetUploadFile[]) =>
    post<{ changed: boolean; latest: string }>(`${assetPath(id)}/revisions`, { files }),
  check: (id: string) => post<{ changed: boolean; latest: string }>(`${assetPath(id)}/check`, {}),
  pin: (id: string, digest: string) => post<{ ok: true }>(`${assetPath(id)}/pin`, { digest }),
  remove: (id: string) => call<{ ok: true }>(assetPath(id), { method: 'DELETE' }),
  install: (id: string, workerId: string, installed: boolean) =>
    call<{ ok: true }>(`${assetPath(id)}/workers/${encodeURIComponent(workerId)}`, {
      method: 'PUT',
      body: JSON.stringify({ installed })
    }),
  /** 项目级作用域：这个项目看得见的资产与开关；enabled=null 恢复默认。 */
  project: (projectId: string) => call<ProjectAssetsDto>(`/api/admin/assets/projects/${encodeURIComponent(projectId)}`),
  setProject: (projectId: string, assetId: string, enabled: boolean | null) =>
    call<{ ok: true }>(`/api/admin/assets/projects/${encodeURIComponent(projectId)}/${encodeURIComponent(assetId)}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled })
    }),
  /** MCP 密钥：只有名字进出界面，值写进去就再也读不回来。 */
  secrets: () => call<SecretsOverviewDto>('/api/admin/assets/secrets'),
  setSecret: (name: string, value: string) =>
    call<{ ok: true }>(`/api/admin/assets/secrets/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ value }) }),
  removeSecret: (name: string) => call<{ ok: true }>(`/api/admin/assets/secrets/${encodeURIComponent(name)}`, { method: 'DELETE' })
};

export type {
  SecretsOverviewDto,
  AssetsOverviewDto,
  ProjectAssetsDto,
  AssetRevisionDto,
  AssetDiffDto,
  GitScanDto,
  WorkLogEntryDto,
  AdminOverviewDto,
  AdminUserDto,
  AdminWorkerDto,
  AuditEntryDto,
  EnrollInfoDto,
  PairingDto,
  SettingsDto,
  AgentDto,
  AttachmentInputDto,
  CapabilityDto,
  StoredAttachmentDto,
  ArtifactDto,
  CanvasDto,
  JournalEntryDto,
  DirectoryListingDto,
  HomeDto,
  ProjectDto,
  ProjectSummaryDto,
  RecentSessionDto,
  OptionValueDto,
  RuntimeOptionDto,
  SearchHitDto,
  SessionDto,
  SessionEventDto,
  TaskDto
};

/** 模型提供商（ADR 0013）：密钥只写不读，界面只看得到「已配置」。 */
export type ProviderProtocolDto = 'openai-chat' | 'openai-responses' | 'anthropic';
export interface ProviderModelDto { readonly id: string; readonly name?: string; readonly contextWindow?: number; readonly maxTokens?: number }
export interface ProviderDto {
  readonly id: string;
  readonly scope: 'personal' | 'team' | 'hub';
  readonly ownerId: string | null;
  readonly slug: string;
  readonly name: string;
  readonly protocol: ProviderProtocolDto;
  readonly baseUrl: string;
  readonly models: readonly ProviderModelDto[];
  readonly routing: 'direct' | 'hub';
  readonly enabled: boolean;
  readonly hasKey: boolean;
  readonly canManage: boolean;
  readonly lastCheck: { ok: boolean; message: string; at: number; via: 'direct' | 'hub'; workerId: string } | null;
  readonly usage: { requests: number; errors: number; bytesIn: number; bytesOut: number; sessions: number; lastUsedAt: number | null };
}
export interface ProviderInputDto {
  slug: string;
  name: string;
  protocol: ProviderProtocolDto;
  baseUrl: string;
  models: ProviderModelDto[];
  routing: 'direct' | 'hub';
  enabled: boolean;
}
export interface HubModelsDto { readonly slug: string; readonly name: string; readonly protocol: ProviderProtocolDto; readonly models: readonly { id: string; label: string }[] }
const providerPath = (id: string) => `/api/providers/${encodeURIComponent(id)}`;
export const providersApi = {
  list: () => call<{ providers: ProviderDto[]; workerRouting: Record<string, 'direct' | 'hub'> }>('/api/providers'),
  models: (taskId?: string) => call<HubModelsDto[]>(`/api/providers/models${taskId ? `?taskId=${encodeURIComponent(taskId)}` : ''}`),
  create: (input: ProviderInputDto & { scope: 'personal' | 'team' | 'hub'; apiKey?: string }) => post<ProviderDto>('/api/providers', input),
  update: (id: string, input: ProviderInputDto) => call<ProviderDto>(providerPath(id), { method: 'PUT', body: JSON.stringify(input) }),
  setKey: (id: string, apiKey: string) => call<{ ok: true }>(`${providerPath(id)}/key`, { method: 'PUT', body: JSON.stringify({ apiKey }) }),
  remove: (id: string) => call<{ ok: true }>(providerPath(id), { method: 'DELETE' }),
  test: (id: string, workerId: string) =>
    post<{ ok: boolean; message: string; via: 'direct' | 'hub'; workerId: string; models: string[] }>(`${providerPath(id)}/test`, { workerId }),
  setWorkerRouting: (workerId: string, routing: 'direct' | 'hub' | null) =>
    call<{ ok: true }>(`/api/providers/routing/${encodeURIComponent(workerId)}`, { method: 'PUT', body: JSON.stringify({ routing }) })
};

/** 开放 API 访问令牌（ADR 0015）：明文只在创建时返回一次。 */
export type ApiTokenDto = import('@agent-hub/contract').ApiTokenInfo;
export type ApiScopeDto = ApiTokenDto['scopes'][number];
export const tokensApi = {
  list: () => call<ApiTokenDto[]>('/api/tokens'),
  create: (input: { name: string; kind: 'personal' | 'service'; scopes: ApiScopeDto[]; expiresAt: number | null }) =>
    post<{ token: string; info: ApiTokenDto }>('/api/tokens', input),
  revoke: (id: string) => call<{ ok: true }>(`/api/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' })
};
