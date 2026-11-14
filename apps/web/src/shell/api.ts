import type {
  AgentDto,
  AgentProfileDto,
  AgentProfileInput,
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
  PreviewLinkDto,
  ProjectDto,
  ProjectSummaryDto,
  PromptAckDto,
  RecentSessionDto,
  RuntimeOptionDto,
  SearchHitDto,
  SearchResponseDto,
  SessionDto,
  SessionEnvironmentDto,
  SessionEventDto,
  TaskDto,
  WorkLogEntryDto,
  WorkerInfoDto,
  WorkspaceDto,
  WorkspaceViewDto,
  CreateWorkspaceRequest,
  RemoveWorkspaceRequest,
  WorkspaceChangesDto,
  TeamWorkspaceViewDto,
  CreateTeamWorkspaceRequest,
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
  CredentialStatusDto,
  SettingsDto,
  AssetsOverviewDto,
  ProjectAssetsDto,
  AssetRevisionDto,
  AssetDiffDto,
  GitScanDto,
  SecretsOverviewDto,
  TeamDto,
  InviteDto,
  InvitePreviewDto,
  GroupLimitsDto,
  GroupDto,
  GroupAuthorDto,
  GroupPostDto,
  GroupThreadDto,
  GroupDeliveryDto,
  GroupViewDto,
  GroupInputDto,
  GroupUnreadDto,
  BotColorDto,
  MessagingRoleDto,
  BotRecordDto,
  DeliveryDto,
  AttentionPhase,
  AttentionItemDto,
  AttentionDto,
  TriggerRunDto,
  BindingDto,
  BotTriggerDto,
  BotTriggerSourceDto,
  BotTriggersDto,
  ConnectorNoticeDto,
  L1LevelDto,
  SessionContextDto,
  ProjectContextDto
} from '@agent-hub/contract';
import type { ProviderModelSpec } from './provider-models.ts';
import type { WorkspaceGroupView } from '../surfaces/workbench/workspace-group.ts';

export type { TeamDto, InviteDto, InvitePreviewDto, AgentProfileDto, AgentProfileInput };
export type { TeamWorkspaceViewDto, CreateTeamWorkspaceRequest, WorkspaceChangesDto, SaveLayoutRequest, WorkerInfoDto, WorkspaceDto, WorkspaceViewDto, AccountDto, AuthState, CreateWorkspaceRequest, LoginDeviceDto };
export type { WorkspaceGroupView, WorkspaceGroupMemberView } from '../surfaces/workbench/workspace-group.ts';

/**
 * 派生会话的请求体：直接用契约里的形状（`workspaceMode` 由后端线落在 deriveSessionRequest 上）。
 */

/** 项目级 worktree 配置（PATCH /api/projects/:id）。形状取契约里 ProjectDto.worktree，只有一份真源。 */
export interface ProjectWorktreePatch {
  worktree: NonNullable<ProjectDto['worktree']>;
}

/**
 * 项目仓库清单（PATCH /api/projects/:id 的 repos，docs/design/multi-repo.md §11.2）。
 * 有 id 就带上：后端按 id 保留老仓库的身份，组合工作空间的成员才不会指丢。
 */
export interface ProjectReposPatch {
  repos: readonly { id?: string; name?: string; url: string; defaultBranch?: string | null }[];
}

/**
 * 保存前的仓库检查（POST /api/projects/:id/repos/check）：在 Worker 上试 clone / 试分支，
 * 免得等到派生任务才报「Remote branch main not found」。`unavailable` 非空 = 这台机器没查成。
 */
export interface ProjectReposCheckDto {
  workerId: string | null;
  workerLabel: string | null;
  unavailable: string | null;
  results: {
    name: string;
    url: string;
    branch: string | null;
    ok: boolean;
    defaultBranch: string | null;
    message: string | null;
  }[];
}

/** 组件目录里的一个版本（ADR 0021 §8）：制品由 hub 解析钉死，scripts 是审核时要看的安装脚本原文。 */
export interface CatalogComponentDto {
  id: string;
  runtime: 'pi' | 'opencode';
  source?: 'npm' | 'git';
  gitUrl?: string;
  commit?: string;
  approvals?: { by: string; at: number; note: string | null }[];
  requiredApprovals?: number;
  packageName: string;
  version: string;
  resolved: string;
  integrity: string;
  provides: { capability: string; mode?: string }[];
  scripts: Record<string, string>;
  dependencyCount: number;
  status: 'pending' | 'approved' | 'rejected';
  submittedBy: string;
  submittedAt: number;
  reviewedBy: string | null;
  reviewedAt: number | null;
  reviewNote: string | null;
}

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

/** agent 间通信（ADR 0018）里的一条消息。 */
export interface AgentMessageDto {
  readonly messageId: string;
  readonly traceId: string;
  readonly kind: 'send' | 'ask' | 'reply';
  readonly from: string;
  readonly to: string;
  readonly targetSessionId: string | null;
  readonly status: 'queued' | 'awaiting_approval' | 'delivered' | 'answered' | 'done' | 'failed' | 'denied';
  readonly depth: number;
  readonly replyTo: string | null;
  readonly body: string;
  readonly reply: string | null;
  readonly replySource: 'tool' | 'last_turn' | null;
  readonly failure: string | null;
  readonly failureDetail: string | null;
  readonly createdAt: number;
}

const sq = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}`;

/**
 * 会话所属的组合工作空间。`session.groupId` 后端已经返回，契约的 sessionSchema 还没补这个字段，
 * 所以在这里做一次结构化读取，等契约补上后换成直接 `session.groupId` 即可。
 */
export function sessionGroupId(session: SessionDto | null | undefined): string | null {
  const value = (session as unknown as { groupId?: unknown } | null | undefined)?.groupId;
  return typeof value === 'string' && value !== '' ? value : null;
}

/** 工作空间文件浏览（ADR 0025，只读）。 */
export interface FileEntryDto { name: string; path: string; type: 'file' | 'dir' | 'symlink'; size: number; modifiedAt: number; ignored: boolean; sensitive: boolean; git: string | null }
export interface DirectoryPageDto { path: string; entries: FileEntryDto[]; truncated: boolean; isGit: boolean }
export interface FileContentDto { path: string; size: number; modifiedAt: number; binary: boolean; truncated: boolean; data: string }
export interface ChangedFileDto { path: string; status: string; additions: number; deletions: number; oldPath?: string }
export interface FileChangesDto { base: 'session' | 'head' | 'turn' | 'branch'; commit: string | null; target?: string | null; turn?: number | null; branch?: string | null; files: ChangedFileDto[] }
export interface TurnCheckpointDto { turn: number; promptSeq: number; before: string; after: string | null; startedAt: number; endedAt: number | null; files: number | null; additions: number | null; deletions: number | null }
/** 'session' | 'head' | 'branch'（相对分支起点）| 'turn'（最近一轮）| 'turn:3'（第 3 轮）。 */
export type DiffBaseSpec = string;
const baseQuery = (base: DiffBaseSpec) => { const [b, n] = base.split(':'); return `base=${b}${n ? `&turn=${n}` : ''}`; };
export interface FileDiffDto { path: string; patch: string; truncated: boolean; binary: boolean }
export interface FilesContextDto { sessionId: string; root: string; workerId: string | null; sessionBase: string | null; otherProjectSessions?: number }
export const filesApi = {
  context: (id: string) => call<FilesContextDto>(`${sq(id)}/files/context`),
  list: (id: string, path: string) => call<DirectoryPageDto>(`${sq(id)}/files?path=${encodeURIComponent(path)}`),
  read: (id: string, path: string, confirm: boolean) => call<FileContentDto>(`${sq(id)}/files/content?path=${encodeURIComponent(path)}${confirm ? '&confirm=1' : ''}`),
  downloadUrl: (id: string, path: string, confirm: boolean) => `${sq(id)}/files/download?path=${encodeURIComponent(path)}${confirm ? '&confirm=1' : ''}`,
  find: (id: string, q: string) => call<{ files: string[] }>(`${sq(id)}/files/find?q=${encodeURIComponent(q)}`).then((r) => r.files),
  changes: (id: string, base: DiffBaseSpec) => call<FileChangesDto>(`${sq(id)}/git/changes?${baseQuery(base)}`),
  diff: (id: string, path: string, base: DiffBaseSpec) => call<FileDiffDto>(`${sq(id)}/git/diff?path=${encodeURIComponent(path)}&${baseQuery(base)}`),
  turns: (id: string) => call<{ turns: TurnCheckpointDto[] }>(`${sq(id)}/git/turns`).then((r) => r.turns),
  eventsUrl: (id: string, paths: readonly string[]) => `${sq(id)}/files/events?paths=${paths.map(encodeURIComponent).join(',')}`
};

/**
 * 预览链接（docs/design/preview.md §4）：把 worker 上的回环端口挂到 hub 的一个监听端口上。
 * 只登记端口，不碰用户代码；返回的 `hubPort` 拼上当前 location 就是可打开的链接。
 */
export const previewsApi = {
  list: (sessionId: string) =>
    call<{ links: PreviewLinkDto[] }>(`${sq(sessionId)}/previews`).then((r) => r.links),
  create: (sessionId: string, body: { port: number; label?: string }) =>
    post<{ link: PreviewLinkDto }>(`${sq(sessionId)}/previews`, body).then((r) => r.link),
  remove: (sessionId: string, linkId: string) =>
    call<{ ok: true }>(`${sq(sessionId)}/previews/${encodeURIComponent(linkId)}`, { method: 'DELETE' }),
  /**
   * 签一条公开分享链接（P3）：没登录的人拿着返回的 url 也能看。
   * `url` 里带一次性令牌，**只在这一次响应里出现**，页面关掉就找不回来——要留给人就当场复制。
   */
  share: (sessionId: string, linkId: string, hours?: number) =>
    post<{ ok: true; url: string; expiresAt: number }>(
      `${sq(sessionId)}/previews/${encodeURIComponent(linkId)}/share`,
      hours === undefined ? {} : { hours }
    ),
  /** 撤销公开分享：令牌立刻作废，链接回到「只有登录用户能看」。 */
  unshare: (sessionId: string, linkId: string) =>
    call<{ ok: true }>(`${sq(sessionId)}/previews/${encodeURIComponent(linkId)}/share`, { method: 'DELETE' })
};

export const api = {
  sessionMessages: (sessionId: string) =>
    call<{ messages: AgentMessageDto[]; awaitingApproval: AgentMessageDto[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/messages`),
  sendAgentMessage: (sessionId: string, body: { kind: 'send' | 'ask'; to: string; body: string }) =>
    post<{ messageId: string; traceId: string; status: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, body),
  decideAgentSpawn: (messageId: string, approve: boolean) => post<AgentMessageDto>(`/api/messages/${encodeURIComponent(messageId)}/decision`, { approve }),
  workers: () => call<WorkerInfoDto[]>('/api/workers'),
  probeWorker: (workerId: string) => post<{ ok: true }>(`/api/workers/${encodeURIComponent(workerId)}/probe`, {}),
  /** 「资源满了就拒绝新会话」开关（ADR 0014，默认关）。 */
  setResourcePolicy: (workerId: string, refuseWhenFull: boolean) =>
    call<{ refuseWhenFull: boolean }>(`/api/workers/${encodeURIComponent(workerId)}/resource-policy`, { method: 'PUT', body: JSON.stringify({ refuseWhenFull }) }),
  /**
   * 在这台机器上装 / 升级 / 卸载 / 切换一个 agent 运行时；只回「已下发」，进度看 workers 列表里的 runtimeJob。
   * `install` 不带 version = 推荐版本；`switch` 要指明切到哪份（只影响下次新建的会话）。
   */
  runtimeJob: (workerId: string, agentId: string, body: { action: 'install' | 'uninstall' | 'switch'; version?: string; source?: 'machine' | 'hub' }) =>
    post<{ job: unknown }>(`/api/workers/${encodeURIComponent(workerId)}/runtimes/${encodeURIComponent(agentId)}`, body),
  /** 在这台机器上装 / 卸 / 修复一个目录里的组件（ADR 0021 §8）；进度同样看 runtimeJob。 */
  componentJob: (workerId: string, componentId: string, body: { action: 'install' | 'uninstall'; version?: string }) =>
    post<{ job: unknown }>(`/api/workers/${encodeURIComponent(workerId)}/components/${encodeURIComponent(componentId)}`, body),
  components: () => call<{ components: CatalogComponentDto[] }>('/api/components').then((r) => r.components),
  bundleInstall: (workerId: string, components: { componentId: string; version: string }[]) =>
    post<{ job: unknown }>(`/api/workers/${encodeURIComponent(workerId)}/bundle-install`, { components }),
  submitComponent: (input: { id: string; packageName: string; version: string; provides: { capability: string }[]; runtime?: 'pi' | 'opencode'; git?: { url: string; commit: string } }) =>
    post<{ component: CatalogComponentDto }>('/api/components', input),
  reviewComponent: (id: string, version: string, approve: boolean, note?: string) =>
    post<{ component: CatalogComponentDto }>(`/api/components/${encodeURIComponent(id)}/${encodeURIComponent(version)}/review`, { approve, ...(note ? { note } : {}) }),
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
  /** 项目级 worktree 配置（docs/design/worktree.md §3）：PATCH 只改这一块，不碰名字和说明。 */
  saveProjectWorktree: (projectId: string, input: ProjectWorktreePatch) =>
    call<ProjectDto>(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  /** 项目默认预览端口（docs/design/preview.md §10）：同一个 PATCH，只带 previewPort。 */
  saveProjectPreviewPort: (projectId: string, previewPort: number | null) =>
    call<ProjectDto>(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body: JSON.stringify({ previewPort }) }),
  /** 项目仓库清单（docs/design/multi-repo.md §7）：同一个 PATCH，只带 repos。 */
  saveProjectRepos: (projectId: string, repos: ProjectReposPatch['repos']) =>
    call<ProjectDto>(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body: JSON.stringify({ repos }) }),
  /** 保存前检查仓库能不能访问：返回每条的结论，`unavailable` 说明这次没查成。 */
  checkProjectRepos: (projectId: string, repos: ProjectReposPatch['repos'], workerId: string | null = null) =>
    post<ProjectReposCheckDto>(`/api/projects/${encodeURIComponent(projectId)}/repos/check`, {
      repos,
      ...(workerId === null ? {} : { workerId })
    }),
  /**
   * 组合工作空间（docs/design/multi-repo.md §11.5）：一个任务在项目的每个仓库里各开一个 worktree，
   * agent 在总目录里干活。建组本身就 clone / 开分支，可能要几十秒；前端按「准备中」显示。
   */
  workspaceGroup: (groupId: string) => call<WorkspaceGroupView>(`/api/workspace-groups/${encodeURIComponent(groupId)}`),
  createWorkspaceGroup: (projectId: string, body: { taskId: string; workerId?: string | null }) =>
    post<WorkspaceGroupView>(`/api/projects/${encodeURIComponent(projectId)}/workspace-groups`, body),
  /** 只对 failed 的组生效：重跑没准备好的成员。 */
  retryWorkspaceGroup: (groupId: string) =>
    post<WorkspaceGroupView>(`/api/workspace-groups/${encodeURIComponent(groupId)}/retry`, {}),
  /** setup 失败后重跑同一条命令（只对 failed 生效）。 */
  retryWorkspaceSetup: (workspaceId: string) =>
    post<WorkspaceDto>(`/api/workspaces/${encodeURIComponent(workspaceId)}/setup/retry`, {}),
  workspaces: (projectId: string) => call<WorkspaceViewDto[]>(`/api/projects/${encodeURIComponent(projectId)}/workspaces`),
  createWorkspace: (projectId: string, input: CreateWorkspaceRequest) =>
    post<WorkspaceDto>(`/api/projects/${encodeURIComponent(projectId)}/workspaces`, input),
  teamWorkspaces: () => call<TeamWorkspaceViewDto[]>('/api/workspaces'),
  createTeamWorkspace: (input: CreateTeamWorkspaceRequest) => post<WorkspaceDto>('/api/workspaces', input),
  linkWorkspace: (projectId: string, workspaceId: string) =>
    call<WorkspaceDto>(`/api/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}`, { method: 'PUT' }),
  unlinkWorkspace: (projectId: string, workspaceId: string) =>
    call<WorkspaceDto>(`/api/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}`, { method: 'DELETE' }),
  cleanupPolicy: (projectId: string) => call<CleanupPolicyDto>(`/api/projects/${encodeURIComponent(projectId)}/cleanup`),
  saveCleanupPolicy: (projectId: string, input: Partial<CleanupPolicyDto>) =>
    call<CleanupPolicyDto>(`/api/projects/${encodeURIComponent(projectId)}/cleanup`, { method: 'PUT', body: JSON.stringify(input) }),
  sweepProject: (projectId: string) =>
    post<{ removed: string[]; kept: string[]; skipped: string[]; failed?: string[] }>(`/api/projects/${encodeURIComponent(projectId)}/cleanup/sweep`, {}),
  cleanupRecords: (projectId: string) => call<CleanupRecordsDto>(`/api/projects/${encodeURIComponent(projectId)}/cleanup/records`),
  workspaceChanges: (workspaceId: string) => call<WorkspaceChangesDto>(`/api/workspaces/${encodeURIComponent(workspaceId)}/changes`),
  removeWorkspace: (workspaceId: string, input: RemoveWorkspaceRequest) =>
    post<WorkspaceDto>(`/api/workspaces/${encodeURIComponent(workspaceId)}/remove`, input),
  canvas: (projectId: string) => call<CanvasDto>(`/api/projects/${projectId}/canvas`),
  /** 单条会话：侧聊这类不进画布的会话要单独取。 */
  session: (id: string) => call<SessionDto>(`/api/sessions/${id}`),
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
  agentProfiles: () => call<AgentProfileDto[]>('/api/agent-profiles'),
  createAgentProfile: (input: AgentProfileInput) => post<AgentProfileDto>('/api/agent-profiles', input),
  updateAgentProfile: (id: string, input: AgentProfileInput) =>
    call<AgentProfileDto>(`/api/agent-profiles/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deleteAgentProfile: (id: string) =>
    call<{ ok: true }>(`/api/agent-profiles/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  fork: (input: ForkSessionRequest) => post<SessionDto>('/api/sessions/fork', input),
  continueElsewhere: (sessionId: string, input: ContinueElsewhereRequest) =>
    post<SessionDto>(`/api/sessions/${sessionId}/continue`, input),
  /** 回答运行时的批准请求（ADR 0023）。已结束（已回答 / 超时）返回 409。 */
  respondApproval: (sessionId: string, approvalId: string, decision: 'allow' | 'deny') =>
    call<{ requested: true }>(`/api/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}`, { method: 'POST', body: JSON.stringify({ decision }) }),
  prompt: (sessionId: string, text: string, attachments: readonly AttachmentInputDto[] = [], clientMessageId?: string) =>
    post<PromptAckDto>(`/api/sessions/${sessionId}/prompt`, {
      text,
      attachments,
      ...(clientMessageId ? { clientMessageId } : {})
    }),
  projectFiles: (projectId: string, q: string, sessionId?: string) =>
    call<ProjectFilesDto>(
      `/api/projects/${projectId}/files?q=${encodeURIComponent(q)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ''}`
    ),
  renameSession: (sessionId: string, title: string) =>
    call<SessionDto>(`/api/sessions/${encodeURIComponent(sessionId)}/title`, { method: 'PUT', body: JSON.stringify({ title }) }),
  /**
   * 收起 / 移回活跃列表（docs/design/interaction-borrowing.md §1）：只改「还看不看得到」，
   * 不碰会话记录和进程。跑着的会话服务端会拒（409），菜单里先把原因写出来。
   */
  settleSession: (sessionId: string, settled: boolean) =>
    post<SessionDto>(`/api/sessions/${encodeURIComponent(sessionId)}/settle`, { settled }),
  /**
   * 删除一条会话：对话记录、产物引用、连线一起没；工作空间里的文件保留。
   * 会话还在跑服务端回 409，没权限 403，已经没了 404。
   */
  deleteSession: (sessionId: string) =>
    call<{ ok: true }>(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }),
  interrupt: (sessionId: string) => post<{ ok: true }>(`/api/sessions/${sessionId}/interrupt`, {}),
  changeOption: (sessionId: string, optionId: string, value: string | boolean) =>
    post<SessionDto>(`/api/sessions/${sessionId}/options`, { optionId, value }),
  sessionAssets: (sessionId: string) => call<SessionAssetsDto>(`/api/sessions/${sessionId}/assets`),
  /**
   * 会话环境（资产 / MCP / 启动配置）是否改过但还没生效：只读、很轻。
   * `supported: false` 表示这个部署没有环境适配器（单测 / 老部署），前端什么都不显示。
   */
  sessionEnvironment: (sessionId: string) =>
    call<SessionEnvironmentDto>(`/api/sessions/${encodeURIComponent(sessionId)}/environment`),
  activity: (sessionId: string) => call<SessionActivityDto[]>(`/api/sessions/${sessionId}/activity`),
  provenance: (sessionId: string) => call<ProvenanceDto | null>(`/api/sessions/${sessionId}/provenance`),
  attention: () => call<AttentionDto>('/api/attention'),
  ackAttention: (item: { sessionId: string; phase: string; since: number }) =>
    post<{ ok: true }>('/api/attention/ack', { sessionId: item.sessionId, phase: item.phase, since: item.since }),
  events: (sessionId: string, after = 0) =>
    call<JournalEntryDto[]>(`/api/sessions/${sessionId}/events${after > 0 ? `?after=${after}` : ''}`),
  search: (projectId: string, q: string) =>
    call<SearchResponseDto>(`/api/search?projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent(q)}`),
  saveLayout: (projectId: string, patch: SaveLayoutRequest) =>
    call<LayoutDto>(`/api/projects/${projectId}/layout`, { method: 'PUT', body: JSON.stringify(patch) }),
  createSessionLink: (projectId: string, aSessionId: string, bSessionId: string) =>
    post<SessionLinkDto>(`/api/projects/${projectId}/session-links`, { aSessionId, bSessionId }),
  deleteSessionLink: (projectId: string, aSessionId: string, bSessionId: string) =>
    call<{ ok: true }>(
      `/api/projects/${projectId}/session-links/${encodeURIComponent(aSessionId)}/${encodeURIComponent(bSessionId)}`,
      { method: 'DELETE' }
    )
};

/** 会话连线：无向，a/b 只是规范化后的两端。 */
export interface SessionLinkDto {
  readonly projectId: string;
  readonly aSessionId: string;
  readonly bSessionId: string;
  readonly createdBy: string | null;
  readonly createdAt: number;
}

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

/**
 * 一台机器的运行时别名（ACP agent 声明，`ACP_AGENTS` 的界面版）。
 * owner 能改；admin 只能看。保存后 hub 推给在线 worker，只对之后新建的会话生效。
 * 形状先声明在 web 内的纯逻辑模块里（要和它一起被根 tsconfig 编译），等 contract 落定再换过去。
 */
export type { AgentAliasDto } from '../surfaces/workbench/agent-aliases.ts';
import type { AgentAliasDto } from '../surfaces/workbench/agent-aliases.ts';

export const workerApi = {
  agents: (workerId: string) => call<{ aliases: AgentAliasDto[] }>(`/api/workers/${encodeURIComponent(workerId)}/agents`),
  saveAgents: (workerId: string, aliases: AgentAliasDto[]) =>
    call<{ aliases: AgentAliasDto[] }>(`/api/workers/${encodeURIComponent(workerId)}/agents`, { method: 'PUT', body: JSON.stringify({ aliases }) })
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
  CredentialStatusDto,
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
  PreviewLinkDto,
  ProjectDto,
  ProjectSummaryDto,
  PromptAckDto,
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
/** 模型形状定义在不带 DOM 的纯逻辑模块里（那边的单测要能被根 tsconfig 编译），这里只做别名。 */
export type ProviderModelDto = ProviderModelSpec;
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
export interface HubModelsDto { readonly slug: string; readonly name: string; readonly protocol: ProviderProtocolDto; readonly scope?: 'personal' | 'team' | 'hub'; readonly models: readonly { id: string; label: string }[] }
/** 拉取模型：给了 workerId 就走那台机器的网络，否则 hub 直连；给了 providerId 就用服务器上已存的密钥。 */
export interface ProviderProbeInputDto {
  protocol: ProviderProtocolDto;
  baseUrl: string;
  apiKey?: string;
  providerId?: string;
  workerId?: string;
}
export interface ProviderProbeDto {
  readonly ok: boolean;
  readonly status: number;
  readonly message: string;
  readonly via: 'worker' | 'hub';
  readonly models: readonly { readonly id: string; readonly name?: string; readonly contextWindow?: number; readonly maxTokens?: number }[];
}
const providerPath = (id: string) => `/api/providers/${encodeURIComponent(id)}`;
export const providersApi = {
  list: () => call<{ providers: ProviderDto[]; workerRouting: Record<string, 'direct' | 'hub'> }>('/api/providers'),
  models: (taskId?: string) => call<HubModelsDto[]>(`/api/providers/models${taskId ? `?taskId=${encodeURIComponent(taskId)}` : ''}`),
  probe: (input: ProviderProbeInputDto) => post<ProviderProbeDto>('/api/providers/probe', input),
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
  create: (input: {
    name: string;
    kind: 'personal' | 'service' | 'bot';
    scopes: readonly ApiScopeDto[];
    /** kind = 'bot' 必填：凭据绑定的项目。 */
    projectId?: string;
    /** kind = 'bot' 可选：bot 的 @id（不给就用令牌名）。 */
    botName?: string;
    expiresAt?: number | null;
  }) =>
    post<{ token: string; info: ApiTokenDto }>('/api/tokens', input),
  revoke: (id: string) => call<{ ok: true }>(`/api/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' })
};

// ---------- 资产市场 / 审核 / 通知（ADR 0016） ----------
import type {
  MarketAssetDto,
  ReviewQueueItemDto,
  SubmissionDetailDto,
  InstallRequestDto,
  NotificationDto,
  AssetReviewSettingsDto,
  AssetSubmissionDto,
  AssetScopeDto
} from './market/types.ts';
export type * from './market/types.ts';
export type AssetKindDto = 'skill' | 'instruction' | 'mcp';
export interface MarketWorkerDto { workerId: string; label: string; state: string; local: boolean; mine: boolean; mode: 'install' | 'request' | 'none' }
export interface SubmitResultDto { assetId: string; submissionId: string; status: string }
type ReviewSettingsView = AssetReviewSettingsDto & { editable: boolean };
const enc = encodeURIComponent;
export const marketApi = {
  catalog: () => call<MarketAssetDto[]>('/api/assets/catalog'),
  mine: () => call<MarketAssetDto[]>('/api/assets/mine'),
  reviews: () => call<ReviewQueueItemDto[]>('/api/assets/reviews'),
  workers: () => call<MarketWorkerDto[]>('/api/assets/workers'),
  installRequests: () =>
    call<{ toDecide: (InstallRequestDto & { asset: string; requester: string })[]; mine: (InstallRequestDto & { asset: string })[] }>('/api/assets/install-requests'),
  decideInstall: (id: string, approve: boolean, reason?: string) => post<unknown>(`/api/assets/install-requests/${enc(id)}`, { approve, reason }),
  settings: () => call<{ team: (ReviewSettingsView & { teamId: string }) | null; hub: ReviewSettingsView | null }>('/api/assets/settings'),
  saveSettings: (target: 'team' | 'hub', reviewers: string[], twoReviewers: { global: boolean; mcpStdio: boolean }) =>
    call<AssetReviewSettingsDto>('/api/assets/settings', { method: 'PUT', body: JSON.stringify({ target, reviewers, twoReviewers }) }),
  secrets: () => call<{ personal: { name: string; updatedAt: number }[]; team: { name: string; updatedAt: number }[]; teamEditable: boolean }>('/api/assets/secrets'),
  setSecret: (layer: 'personal' | 'team', name: string, value: string) =>
    call<{ ok: true }>(`/api/assets/secrets/${layer}/${enc(name)}`, { method: 'PUT', body: JSON.stringify({ value }) }),
  removeSecret: (layer: 'personal' | 'team', name: string) => call<{ ok: true }>(`/api/assets/secrets/${layer}/${enc(name)}`, { method: 'DELETE' }),
  upload: (input: { kind: AssetKindDto; scope: AssetScopeDto; projectId?: string | null; name?: string | null; files: AssetUploadFile[] }) =>
    post<SubmitResultDto>('/api/assets/upload', input),
  git: (input: { kind: AssetKindDto; scope: AssetScopeDto; url: string; ref: string | null; path: string }) => post<SubmitResultDto>('/api/assets/git', input),
  item: (id: string) => call<{ item: MarketAssetDto; revisions: AssetRevisionDto[]; submissions: AssetSubmissionDto[] }>(`/api/assets/items/${enc(id)}`),
  revision: (id: string, files: AssetUploadFile[]) => post<{ latest: string; submissionId: string | null }>(`/api/assets/items/${enc(id)}/revisions`, { files }),
  check: (id: string) => post<{ latest: string; submissionId: string | null }>(`/api/assets/items/${enc(id)}/check`, {}),
  promote: (id: string) => post<{ submissionId: string }>(`/api/assets/items/${enc(id)}/promote`, {}),
  revoke: (id: string, reason: string) => post<{ ok: true }>(`/api/assets/items/${enc(id)}/revoke`, { reason }),
  install: (id: string, workerId: string, installed: boolean) =>
    call<{ kind: 'installed' | 'uninstalled' | 'requested' }>(`/api/assets/items/${enc(id)}/workers/${enc(workerId)}`, { method: 'PUT', body: JSON.stringify({ installed }) }),
  review: (sid: string) => call<SubmissionDetailDto>(`/api/assets/reviews/${enc(sid)}`),
  reviewDiff: (sid: string) => call<{ files: AssetDiffDto['files'] | null }>(`/api/assets/reviews/${enc(sid)}/diff`),
  reviewFile: (sid: string, path: string) => call<{ text: string }>(`/api/assets/reviews/${enc(sid)}/file?path=${enc(path)}`),
  approve: (sid: string, acknowledgeHigh: boolean) => post<unknown>(`/api/assets/reviews/${enc(sid)}/approve`, { acknowledgeHigh }),
  reject: (sid: string, reason: string, changesRequested: boolean) => post<unknown>(`/api/assets/reviews/${enc(sid)}/reject`, { reason, changesRequested }),
  withdraw: (sid: string) => post<unknown>(`/api/assets/reviews/${enc(sid)}/withdraw`, {}),
  comment: (sid: string, input: { path: string | null; line: number | null; body: string }) => post<unknown>(`/api/assets/reviews/${enc(sid)}/comments`, input),
  notifications: () => call<{ items: NotificationDto[]; unread: number }>('/api/notifications'),
  markRead: (ids: string[] | null) => post<{ ok: true }>('/api/notifications/read', { ids })
};

export interface MemoryEntryDto {
  id: string;
  scope: { kind: string } & Record<string, string>;
  kind: 'semantic' | 'episodic' | 'procedural';
  title: string;
  body: string;
  tags: string[];
  status: 'staged' | 'active' | 'proposed' | 'rejected' | 'forgotten' | 'superseded' | 'expired' | 'invalidated';
  trust: 'trusted' | 'untrusted';
  stale: boolean;
  provenance: { author: { kind: string; userId?: string; sessionId?: string }; via?: string };
  updatedAt: number;
}
export interface MemoryScopeDto { key: string; label: string; canWrite: boolean; canReview: boolean }

/** 记忆（ADR 0019）：界面只做列表、审核、忘掉、手写一条。 */
export interface DistillSettingsDto { readonly model: string | null; readonly enabled: boolean; readonly globalOff: boolean }
export const memoryApi = {
  scopes: () => call<{ scopes: MemoryScopeDto[] }>('/api/memory/scopes'),
  list: (scope: string) => call<{ entries: MemoryEntryDto[] }>(`/api/memory?scope=${encodeURIComponent(scope)}&status=active&status=proposed`),
  pending: () => call<{ entries: MemoryEntryDto[] }>('/api/memory/pending'),
  write: (input: { scope: string; kind: MemoryEntryDto['kind']; title: string; body: string }) => post<MemoryEntryDto>('/api/memory', input),
  review: (id: string, approve: boolean) => post<MemoryEntryDto>(`/api/memory/${encodeURIComponent(id)}/review`, { approve }),
  forget: (id: string, reason: string) => post<MemoryEntryDto>(`/api/memory/${encodeURIComponent(id)}/forget`, { reason }),
  distill: (projectId: string) => call<DistillSettingsDto>(`/api/projects/${encodeURIComponent(projectId)}/memory/distill`),
  setDistill: (projectId: string, input: { model?: string | null; enabled?: boolean }) =>
    call<DistillSettingsDto>(`/api/projects/${encodeURIComponent(projectId)}/memory/distill`, { method: 'PUT', body: JSON.stringify(input) }),
  distillModels: (projectId: string) => call<HubModelsDto[]>(`/api/providers/models?projectId=${encodeURIComponent(projectId)}`)
};

export type {
  GroupLimitsDto,
  GroupDto,
  GroupAuthorDto,
  GroupPostDto,
  GroupThreadDto,
  GroupDeliveryDto,
  GroupViewDto,
  GroupInputDto,
  GroupUnreadDto,
  BotColorDto,
  MessagingRoleDto,
  BotRecordDto,
  DeliveryDto,
  AttentionPhase,
  AttentionItemDto,
  AttentionDto,
  TriggerRunDto,
  BindingDto,
  BotTriggerDto,
  BotTriggerSourceDto,
  BotTriggersDto,
  ConnectorNoticeDto,
  L1LevelDto,
  SessionContextDto,
  ProjectContextDto
};

/** 一等 bot（C3c）：`/api/bots` 的增删改查；id 是稳定键，@id（name）建好不改。 */
export interface BotCreateInputDto {
  projectId: string;
  /** 就是 @id：小写字母、数字、- _；建好不改。 */
  name: string;
  agentId: string;
  model?: string;
  options?: Record<string, string | boolean>;
  displayName?: string;
  color?: BotColorDto;
  description?: string;
  reuse?: MessagingRoleDto['reuse'];
}
export type BotPatchInputDto = Omit<BotCreateInputDto, 'projectId' | 'name'>;

/**
 * 一个 bot 身上挂的触发器（`GET /api/bots/:idOrName/triggers`，只读汇总，形状见 contract）。
 * 后端还没这条路由时页面不能红：404 / 501 当成「没有触发器」，返回空表（每次新对象，别共享数组）。
 */
const emptyTriggers = (): BotTriggersDto => ({ sources: [], bindings: [] });

export const botsApi = {
  list: (projectId: string) => call<{ bots: BotRecordDto[] }>(`/api/bots?projectId=${encodeURIComponent(projectId)}`),
  create: (input: BotCreateInputDto) => post<BotRecordDto>('/api/bots', input),
  /** 只读：挂在它身上的连接器触发器；接口不在（404/501）时返回空表。 */
  triggers: async (id: string): Promise<BotTriggersDto> => {
    try {
      return await call<BotTriggersDto>(`/api/bots/${encodeURIComponent(id)}/triggers`);
    } catch (error) {
      if (error instanceof RequestFailed && (error.status === 404 || error.status === 501)) return emptyTriggers();
      throw error;
    }
  },
  /** PATCH 不接受 name（建好不改），只传要改的字段；传 {} 的 options 表示清空启动选项。 */
  update: (id: string, input: BotPatchInputDto) =>
    call<BotRecordDto>(`/api/bots/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  remove: (id: string) => call<{ ok: true }>(`/api/bots/${encodeURIComponent(id)}`, { method: 'DELETE' })
};

/** 群聊（ADR 0018 · 群组）。 */
export const groupApi = {
  list: (projectId: string) => call<{ groups: GroupDto[] }>(`/api/projects/${encodeURIComponent(projectId)}/groups`),
  create: (projectId: string, input: GroupInputDto) => post<GroupDto>(`/api/projects/${encodeURIComponent(projectId)}/groups`, input),
  view: (id: string) => call<GroupViewDto>(`/api/groups/${encodeURIComponent(id)}`),
  update: (id: string, input: GroupInputDto) => call<GroupDto>(`/api/groups/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(input) }),
  posts: (id: string) => call<{ posts: GroupPostDto[] }>(`/api/groups/${encodeURIComponent(id)}/posts?limit=200`),
  post: (id: string, body: string) => post<unknown>(`/api/groups/${encodeURIComponent(id)}/posts`, { body }),
  stop: (id: string) => post<unknown>(`/api/groups/${encodeURIComponent(id)}/stop`, {}),
  addMember: (id: string, role: string) => post<GroupDto>(`/api/groups/${encodeURIComponent(id)}/members`, { role }),
  addMembers: (id: string, roles: string[]) => post<GroupDto>(`/api/groups/${encodeURIComponent(id)}/members`, { roles }),
  removeMember: (id: string, role: string) => call<GroupDto>(`/api/groups/${encodeURIComponent(id)}/members/${encodeURIComponent(role)}`, { method: 'DELETE' }),
  chains: (id: string) => call<{ chains: { thread: GroupThreadDto; deliveries: GroupDeliveryDto[] }[] }>(`/api/groups/${encodeURIComponent(id)}/chains`),
  unread: () => call<GroupUnreadDto>('/api/groups/unread'),
  markRead: (id: string, seq?: number) => post<{ seq: number }>(`/api/groups/${encodeURIComponent(id)}/read`, seq === undefined ? {} : { seq }),
  roles: (projectId: string) => call<{ roles: MessagingRoleDto[]; limits: Record<string, number> }>(`/api/projects/${encodeURIComponent(projectId)}/messaging`)
};

const put = (body: unknown): RequestInit => ({ method: 'PUT', body: JSON.stringify(body) });
export const contextApi = {
  session: (id: string) => call<SessionContextDto>(`/api/sessions/${encodeURIComponent(id)}/context`),
  compact: (id: string) => call<{ requested: true }>(`/api/sessions/${encodeURIComponent(id)}/context/compact`, { method: 'POST', body: '{}' }),
  project: (id: string) => call<ProjectContextDto>(`/api/projects/${encodeURIComponent(id)}/context`),
  setProject: (id: string, input: { strategy: string; enabled: string[] }) => call<ProjectContextDto>(`/api/projects/${encodeURIComponent(id)}/context`, put(input)),
  setRole: (id: string, role: string, strategy: string | null) =>
    call<ProjectContextDto>(`/api/projects/${encodeURIComponent(id)}/context/roles/${encodeURIComponent(role)}`, put({ strategy }))
};

/** 提交 / 推送 / PR（ADR 0027 阶段 2）。 */
export interface PullRequestDto { id: string; taskId: string; sessionId: string | null; via: 'token' | 'gh'; repo: string; number: number; url: string; branch: string; base: string; state: 'open' | 'closed' | 'merged'; mergedAt: number | null; createdAt: number; lastSyncedAt: number }
export interface GitStateDto {
  isGit: boolean; branch: string | null; defaultBranch: string | null; hasOrigin: boolean; repo: string | null;
  files: { path: string; status: string }[]; ahead: number; upstream: string | null;
  canPush: boolean; prBlocked: string | null; prVia: 'token' | 'gh'; pullRequests: PullRequestDto[];
}
export interface GitTextDto { message: string; title: string; body: string; branch: string | null; source: 'model' | 'template' }
export interface GitRunDto { sha: string | null; committed: boolean; pushed: boolean; branch: string | null; pullRequest: PullRequestDto | null; compareUrl: string | null; notes: string[] }
export interface GitHostTokenDto { configured: boolean; last4: string | null; updatedAt: number | null }
export const gitApi = {
  state: (id: string) => call<GitStateDto>(`${sq(id)}/git/state`),
  draft: (id: string) => post<GitTextDto>(`${sq(id)}/git/draft`, {}),
  run: (id: string, body: { action: 'commit' | 'push' | 'pr'; message: string; title?: string; body?: string }) => post<GitRunDto>(`${sq(id)}/git/run`, body),
  taskPullRequests: (taskId: string) => call<{ pullRequests: PullRequestDto[] }>(`/api/tasks/${encodeURIComponent(taskId)}/pull-requests`).then((r) => r.pullRequests),
  token: () => call<GitHostTokenDto>('/api/git-host/token'),
  setToken: (token: string) => call<GitHostTokenDto>('/api/git-host/token', { method: 'PUT', body: JSON.stringify({ token }) }),
  removeToken: () => call<GitHostTokenDto>('/api/git-host/token', { method: 'DELETE' })
};

export interface RewindPreviewDto { promptSeq: number; prompt: string; filesAllowed: boolean; filesBlocked: string | null; turnsAfter: number; mode?: 'native' | 'summary' | 'none'; modeReason?: string | null; agentLabel?: string }
export interface RewindDto { session: SessionDto; prompt: string; files: { turn: number; restored: number; removed: number; safety: string } | null }
/** 从某条消息重来（ADR 0027 阶段 4）。 */
export const rewindApi = {
  preview: (id: string, promptSeq: number) => call<RewindPreviewDto>(`${sq(id)}/rewind?promptSeq=${promptSeq}`),
  rewind: (id: string, promptSeq: number, files: boolean) => post<RewindDto>(`${sq(id)}/rewind`, { promptSeq, files })
};

export interface CleanupPolicyDto {
  prMerged: boolean;
  taskEndedClean: boolean;
  idleDays: number | null;
}
export interface CleanupRecordsDto {
  items: { runId: string; workspaceId: string; path: string; branch: string | null; action: 'removed' | 'kept' | 'failed'; reason: string; sizeBytes: number | null; at: number }[];
  orphans: { path: string; workerId: string | null }[];
}

export type WorkerPreset = 'full' | 'readonly' | 'no-remote' | 'no-install';

export const deliveryApi = {
  list: (sessionId: string) => call<DeliveryDto[]>(`${sq(sessionId)}/deliveries`),
  retry: (sessionId: string, id: string) => post<{ ok: true }>(`${sq(sessionId)}/deliveries/${encodeURIComponent(id)}/retry`, {}),
  cancel: (sessionId: string, id: string) => post<{ ok: true }>(`${sq(sessionId)}/deliveries/${encodeURIComponent(id)}/cancel`, {})
};

/** 任务来历（ADR 0031 D3）。 */
export interface ProvenanceDto {
  readonly id: string;
  readonly sessionId: string;
  readonly actor: { readonly kind: 'user' | 'api_token' | 'agent' | 'system'; readonly id: string; readonly name: string };
  readonly via: string;
  readonly parent?: { readonly sessionId: string; readonly atSeq?: number } | null;
  readonly parentTitle?: string | null;
  readonly authority: { readonly role: string; readonly scope?: readonly string[] | null; readonly tokenId?: string | null };
  readonly backfilled: boolean;
  readonly createdAt: number;
}

const agentPath = (projectId: string, name: string) => `/api/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(name)}`;
export const connectorApi = {
  bindings: (projectId: string, name: string) => call<{ bindings: BindingDto[] }>(`${agentPath(projectId, name)}/bindings`),
  create: (projectId: string, name: string, input: { connector: string; kind: string; name: string; target: 'main' | 'new'; projectId: string | null; params: Record<string, unknown>; timeZone: string }) =>
    post<BindingDto>(`${agentPath(projectId, name)}/bindings`, input),
  update: (id: string, patch: { enabled?: boolean; name?: string; target?: 'main' | 'new'; params?: Record<string, unknown> }) =>
    call<BindingDto>(`/api/bindings/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  remove: (id: string) => call<{ ok: true }>(`/api/bindings/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  runs: (id: string) => call<{ runs: TriggerRunDto[] }>(`/api/bindings/${encodeURIComponent(id)}/runs`),
  projects: (projectId: string, name: string) => call<{ defaultProjectId: string; projectIds: string[] }>(`${agentPath(projectId, name)}/projects`),
  setProjects: (projectId: string, name: string, projectIds: string[]) =>
    call<{ defaultProjectId: string; projectIds: string[] }>(`${agentPath(projectId, name)}/projects`, { method: 'PUT', body: JSON.stringify({ projectIds }) }),
  notices: () => call<{ notices: ConnectorNoticeDto[] }>('/api/connectors/notices'),
  decide: (id: string, approve: boolean) => post<unknown>(`/api/agent-tasks/${encodeURIComponent(id)}/decision`, { approve }),
  dispatch: () => call<DispatchQueueDto>('/api/dispatch'),
  cancelDispatch: (id: string) => post<unknown>(`/api/dispatch/${encodeURIComponent(id)}/cancel`, {})
};

export interface DispatchItemDto {
  id: string; taskId: string; projectId: string; title: string; human: boolean; state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  workerId: string | null; sessionId: string | null; waitReason: string | null; result: string | null; notified: boolean; position: number | null;
  createdAt: number; startedAt: number | null; updatedAt: number;
}
export interface DispatchQueueDto {
  queued: DispatchItemDto[]; running: DispatchItemDto[]; recent: DispatchItemDto[];
  pending: { id: string; title: string; projectId: string; agentName: string | null; createdAt: number }[];
  caps: { global: number; perWorker: number; perProject: number; humanReserved: number } | null;
}

/** 可观测（ADR 0033）。网页只认这份契约，不认业务表。 */
export interface ObserveListItemDto {
  id: string; source: string; title: string; projectId: string | null; at: number;
  nativeState: string; nativeStateLabel: string; gap: string | null;
}
export interface ObserveNodeDto {
  id: string; name: string; kind: string; state: string | null; stateLabel: string | null;
  startedAt: number | null; endedAt: number | null; durationMs: number | null; durationLabel: string | null;
  parentId: string | null; links: { to: string; label: string }[];
  attrs: { key: string; value: string }[];
}
export interface ObserveBranchDto {
  node: ObserveNodeDto;
  children: ObserveBranchDto[];
  links: { label: string; branch: ObserveBranchDto }[];
}
export interface ObserveTreeDto {
  roots: ObserveBranchDto[];
  missingParent: ObserveNodeDto[];
  unlinked: ObserveNodeDto[];
  unrecorded: ObserveNodeDto[];
}
export interface ObserveTraceDto {
  id: string; source: string; headId: string; title: string; projectId: string | null;
  externalUrl: string | null; nodes: ObserveNodeDto[];
}
export const observeApi = {
  list: (query: { since: number; source?: string; projectId?: string; needsLook?: boolean; limit?: number }) => {
    const q = new URLSearchParams({ since: String(query.since) });
    if (query.source) q.set('source', query.source);
    if (query.projectId) q.set('projectId', query.projectId);
    if (query.needsLook) q.set('needsLook', '1');
    if (query.limit) q.set('limit', String(query.limit));
    return call<{ enabled: boolean; truncated: boolean; viewer?: 'anonymous' | 'user' | 'system'; scanLimit?: number | null; items: ObserveListItemDto[] }>(`/api/observe?${q}`);
  },
  get: (source: string, id: string) => call<{ enabled: boolean; trace: ObserveTraceDto | null; tree: ObserveTreeDto | null }>(`/api/observe/${encodeURIComponent(source)}/${encodeURIComponent(id)}`)
};
