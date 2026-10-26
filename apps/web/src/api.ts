import type {
  AgentDto,
  AttachmentInputDto,
  CapabilityDto,
  ProjectFilesDto,
  StoredAttachmentDto,
  ArtifactDto,
  CanvasDto,
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
  AccountDto,
  AuthState,
  AdminOverviewDto,
  AdminUserDto,
  AdminWorkerDto,
  AdminWorkersDto,
  AuditEntryDto,
  EnrollInfoDto,
  PairingDto,
  SettingsDto
} from '@agent-hub/contract';

export type { SaveLayoutRequest, WorkerInfoDto, WorkspaceDto, WorkspaceViewDto, AccountDto, AuthState };

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
  return (await response.json()) as T;
}

const post = <T>(path: string, body: unknown): Promise<T> =>
  call<T>(path, { method: 'POST', body: JSON.stringify(body) });

export const api = {
  workers: () => call<WorkerInfoDto[]>('/api/workers'),
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
  deleteProject: (projectId: string, confirmName: string) =>
    call<{ id: string; deleted: true }>(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE', body: JSON.stringify({ confirmName }) }),
  createProject: (input: {
    name: string;
    rootPath?: string;
    workerId?: string | null;
    repoUrl?: string | null;
    defaultBranch?: string | null;
  }) => post<ProjectDto>('/api/projects', input),
  workspaces: (projectId: string) => call<WorkspaceViewDto[]>(`/api/projects/${encodeURIComponent(projectId)}/workspaces`),
  createWorkspace: (projectId: string, input: CreateWorkspaceRequest) =>
    post<WorkspaceDto>(`/api/projects/${encodeURIComponent(projectId)}/workspaces`, input),
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
  continueElsewhere: (sessionId: string, workerId: string, directory: string | null) =>
    post<SessionDto>(`/api/sessions/${sessionId}/continue`, { workerId, directory }),
  prompt: (sessionId: string, text: string, attachments: readonly AttachmentInputDto[] = []) =>
    post<{ ok: true }>(`/api/sessions/${sessionId}/prompt`, { text, attachments }),
  projectFiles: (projectId: string, q: string, sessionId?: string) =>
    call<ProjectFilesDto>(
      `/api/projects/${projectId}/files?q=${encodeURIComponent(q)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ''}`
    ),
  interrupt: (sessionId: string) => post<{ ok: true }>(`/api/sessions/${sessionId}/interrupt`, {}),
  changeOption: (sessionId: string, optionId: string, value: string | boolean) =>
    post<SessionDto>(`/api/sessions/${sessionId}/options`, { optionId, value }),
  events: (sessionId: string, after = 0) =>
    call<JournalEntryDto[]>(`/api/sessions/${sessionId}/events${after > 0 ? `?after=${after}` : ''}`),
  search: (projectId: string, q: string) =>
    call<SearchResponseDto>(`/api/search?projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent(q)}`),
  saveLayout: (projectId: string, patch: SaveLayoutRequest) =>
    call<LayoutDto>(`/api/projects/${projectId}/layout`, { method: 'PUT', body: JSON.stringify(patch) })
};

export const attachmentUrl = (sessionId: string, path: string): string =>
  `/api/sessions/${sessionId}/attachment?path=${encodeURIComponent(path)}`;

export const authApi = {
  state: () => call<AuthState>('/api/auth/state'),
  login: (email: string, password: string) => post<{ user: AccountDto }>('/api/auth/login', { email, password }),
  register: (email: string, password: string, displayName?: string) =>
    post<{ user: AccountDto }>('/api/auth/register', { email, password, displayName }),
  tokenLogin: (token: string) => post<{ user: AccountDto }>('/api/auth/token-login', { token }),
  logout: () => post<{ ok: true }>('/api/auth/logout', {})
};

export const adminApi = {
  overview: () => call<AdminOverviewDto>('/api/admin/overview'),
  users: (q: string) => call<AdminUserDto[]>(`/api/admin/users?q=${encodeURIComponent(q)}`),
  disable: (id: string) => post<AdminUserDto>(`/api/admin/users/${id}/disable`, {}),
  enable: (id: string) => post<AdminUserDto>(`/api/admin/users/${id}/enable`, {}),
  setRole: (id: string, role: 'owner' | 'member') => post<AdminUserDto>(`/api/admin/users/${id}/role`, { role }),
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
  audit: () => call<AuditEntryDto[]>('/api/admin/audit'),
  enrollInfo: () => call<EnrollInfoDto>('/api/workers/enroll-info'),
  /** 签发一次性接入码（15 分钟、用一次），连同在新机器上运行的一行命令。 */
  pairing: () => post<PairingDto>('/api/workers/pairing', {}),
  /** 吊销一台机器：作废它的凭据并立刻断开，它不会再重连。 */
  revokeWorker: (workerId: string) =>
    call<{ workerId: string; revokedAt: number }>(`/api/workers/${encodeURIComponent(workerId)}`, { method: 'DELETE' })
};

export type {
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
