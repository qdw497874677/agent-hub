import type {
  AgentProfileDto,
  AgentProfileInput,
  AttachmentInputDto,
  AttentionDto,
  CanvasDto,
  ContinueElsewhereRequest,
  CreateTaskRequest,
  CreateTeamWorkspaceRequest,
  CreateWorkspaceRequest,
  DeriveSessionRequest,
  DirectoryListingDto,
  ForkSessionRequest,
  HomeDto,
  JournalEntryDto,
  LayoutDto,
  ProjectDto,
  ProjectFilesDto,
  PromptAckDto,
  RemoveWorkspaceRequest,
  SaveLayoutRequest,
  SearchResponseDto,
  SessionDto,
  SessionEnvironmentDto,
  TaskDto,
  TeamWorkspaceViewDto,
  WorkerInfoDto,
  WorkLogEntryDto,
  WorkspaceChangesDto,
  WorkspaceDto,
  WorkspaceViewDto
} from '@agent-hub/contract';
import type { WorkspaceGroupView } from '../../surfaces/workbench/workspace-group.ts';
import type { CatalogComponentDto } from './assets.ts';
import { call, post } from './http.ts';
import type { AgentMessageDto, SessionPeerDto } from './messages.ts';
import type { ProjectReposCheckDto, ProjectReposPatch, ProjectWorktreePatch } from './projects.ts';
import type {
  ProvenanceDto,
  SessionActivityDto,
  SessionAssetsDto,
  SessionLinkDto
} from './sessions.ts';
import type { CleanupPolicyDto, CleanupRecordsDto } from './workspaces.ts';

export const api = {
  sessionMessages: (sessionId: string) =>
    call<{ messages: AgentMessageDto[]; awaitingApproval: AgentMessageDto[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/messages`),
  sendAgentMessage: (sessionId: string, body: { kind: 'send' | 'ask'; to: string; body: string; wake?: boolean }) =>
    post<{ messageId: string; traceId: string; status: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, body),
  sessionPeers: (sessionId: string) => call<{ peers: SessionPeerDto[]; handle: string | null }>(`/api/sessions/${encodeURIComponent(sessionId)}/peers`),
  setSessionHandle: (sessionId: string, handle: string) =>
    call<{ handle: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/handle`, { method: 'PUT', body: JSON.stringify({ handle }) }),
  /** 项目的 agent 通信配置；这里只读 / 改「信任同伴」（P1f），角色表不动。 */
  messagingTrust: (projectId: string) => call<{ trustPeers?: boolean }>(`/api/projects/${encodeURIComponent(projectId)}/messaging`),
  setMessagingTrust: (projectId: string, trustPeers: boolean) =>
    call<{ trustPeers?: boolean }>(`/api/projects/${encodeURIComponent(projectId)}/messaging`, { method: 'PUT', body: JSON.stringify({ trustPeers }) }),
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
  /** 项目检查命令（issue #216 P1）：同一个 PATCH，只带 checks；空数组 = 清掉。 */
  saveProjectChecks: (projectId: string, checks: readonly string[]) =>
    call<ProjectDto>(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body: JSON.stringify({ checks }) }),
  /**
   * 项目默认资产组合（asset-hub.md「资产组合」）：同一个 PATCH，只带 assetSetIds。
   * 顺序有意义（后面的组合叠在前面之上），最多 8 个；空数组 = 不引用任何组合。
   */
  saveProjectAssetSets: (projectId: string, assetSetIds: readonly string[]) =>
    call<ProjectDto>(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body: JSON.stringify({ assetSetIds }) }),
  /** 项目仓库清单（docs/design/multi-repo.md §7）：同一个 PATCH，只带 repos。 */
  saveProjectRepos: (projectId: string, repos: ProjectReposPatch['repos'], primaryRepoId?: string | null) =>
    call<ProjectDto>(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body: JSON.stringify({ repos, primaryRepoId: primaryRepoId ?? null }) }),
  /** 克隆 / 建 worktree 时是否递归初始化子模块；只影响之后新建的 checkout。 */
  saveProjectSubmodules: (projectId: string, submodules: 'off' | 'recursive') =>
    call<ProjectDto>(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body: JSON.stringify({ submodules }) }),
  /**
   * 项目默认 Agent：新会话没点名 Agent 时用它。
   * 同一个 PATCH，只带 defaultAgent；`null` = 清掉（继续跟团队默认 / 运行时默认回落）。
   */
  saveProjectDefaultAgent: (projectId: string, defaultAgent: NonNullable<ProjectDto['defaultAgent']> | null) =>
    call<ProjectDto>(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body: JSON.stringify({ defaultAgent }) }),
  /** 保存前检查仓库能不能访问：返回每条的结论，`unavailable` 说明这次没查成。 */
  checkProjectRepos: (projectId: string, repos: ProjectReposPatch['repos'], workerId: string | null = null) =>
    post<ProjectReposCheckDto>(`/api/projects/${encodeURIComponent(projectId)}/repos/check`, {
      repos,
      ...(workerId === null ? {} : { workerId })
    }),
  /**
   * 组合工作目录（docs/design/multi-repo.md §11.5）：一个任务在项目的每个仓库里各开一个 worktree，
   * agent 在总目录里干活。建组本身就 clone / 开分支，可能要几十秒；前端按「准备中」显示。
   */
  workspaceGroup: (groupId: string) => call<WorkspaceGroupView>(`/api/workspace-groups/${encodeURIComponent(groupId)}`),
  createWorkspaceGroup: (projectId: string, body: { taskId: string; workerId?: string | null; repoIds?: readonly string[] }) =>
    post<WorkspaceGroupView>(`/api/projects/${encodeURIComponent(projectId)}/workspace-groups`, body),
  addWorkspaceGroupMember: (groupId: string, body: { repoId: string }) =>
    post<WorkspaceGroupView>(`/api/workspace-groups/${encodeURIComponent(groupId)}/members`, body),
  /** 只对 failed 的组生效：重跑没准备好的成员。 */
  retryWorkspaceGroup: (groupId: string) =>
    post<WorkspaceGroupView>(`/api/workspace-groups/${encodeURIComponent(groupId)}/retry`, {}),
  /** setup 失败后重跑同一条命令（只对 failed 生效）。 */
  retryWorkspaceSetup: (workspaceId: string) =>
    post<WorkspaceDto>(`/api/workspaces/${encodeURIComponent(workspaceId)}/setup/retry`, {}),
  // WorkspaceViewDto 的 ownerProjectId / ownerProjectName 来自契约（packages/contract/src/wire/entities.ts）：
  // 独占归属下 null = 还没分配，等于本项目 = 已经在用。
  workspaces: (projectId: string) => call<WorkspaceViewDto[]>(`/api/projects/${encodeURIComponent(projectId)}/workspaces`),
  createWorkspace: (projectId: string, input: CreateWorkspaceRequest) =>
    post<WorkspaceDto>(`/api/projects/${encodeURIComponent(projectId)}/workspaces`, input),
  teamWorkspaces: () => call<TeamWorkspaceViewDto[]>('/api/workspaces'),
  createTeamWorkspace: (input: CreateTeamWorkspaceRequest) => post<WorkspaceDto>('/api/workspaces', input),
  linkWorkspace: (projectId: string, workspaceId: string) =>
    call<WorkspaceDto>(`/api/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}`, { method: 'PUT' }),
  unlinkWorkspace: (projectId: string, workspaceId: string) =>
    call<WorkspaceDto>(`/api/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}`, { method: 'DELETE' }),
  /**
   * 独占归属：把别的项目正认领的目录转到本项目（源项目不再能看到它）。
   * 源项目还有会话在这个目录里跑时后端回 409，界面把 error.message 原样给人看。
   */
  transferWorkspace: (projectId: string, workspaceId: string) =>
    post<WorkspaceDto>(`/api/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/transfer`, {}),
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
  /** 任务级默认 Agent：盖过项目，`null` = 回到「跟随项目」。 */
  setTaskDefaultAgent: (taskId: string, defaultAgent: NonNullable<TaskDto['defaultAgent']> | null) =>
    call<TaskDto>(`/api/tasks/${encodeURIComponent(taskId)}/default-agent`, {
      method: 'PATCH',
      body: JSON.stringify({ defaultAgent })
    }),
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
   * 删除一条会话：对话记录、产物引用、连线一起没；工作目录里的文件保留。
   * 会话还在跑服务端回 409，没权限 403，已经没了 404。
   */
  deleteSession: (sessionId: string, body?: { removeWorktree?: boolean }) =>
    call<{ ok: true }>(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE', body: body ? JSON.stringify(body) : undefined }),
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
  /**
   * acked 省略 = 记下（老行为）；acked:false = 撤回收起，精确到 session+phase+since 这一条，
   * 并带上记下时返回的 ackedAt 收据。返回 houskeeping 回执：ackedAt（记下成功）或 undone（撤销是否真生效）。
   */
  ackAttention: (
    item: { sessionId: string; phase: string; since: number },
    acked = true,
    ackedAt?: number
  ) =>
    post<{ ok: true; ackedAt?: number; undone?: boolean }>('/api/attention/ack', {
      sessionId: item.sessionId,
      phase: item.phase,
      since: item.since,
      acked,
      ...(ackedAt === undefined ? {} : { ackedAt })
    }),
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
