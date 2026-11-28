import type { DeliveryDto, PreviewLinkDto, SessionDto } from '@agent-hub/contract';
import { call, post, RequestFailed, sq } from './http.ts';
import type { PreviewDiagnostic, PreviewWorkflow, PreviewWorkflowTarget } from './preview-types.ts';

export type { PreviewDiagnostic, PreviewWorkflow, PreviewWorkflowTarget } from './preview-types.ts';

export type { DeliveryDto, JournalEntryDto, PreviewLinkDto, SessionDto, SessionEventDto } from '@agent-hub/contract';

/** A live runtime observation, not evidence of model availability. */
export type SessionStartupDto =
  | { readonly state: 'untracked' | 'offline' | 'upgrade_required' | 'starting' | 'ready' }
  | { readonly state: 'failed'; readonly reason: 'runtime' | 'configuration' | 'timed_out' };

export const sessionStartupApi = {
  get: (sessionId: string) => call<SessionStartupDto>(`${sq(sessionId)}/startup`, { cache: 'no-store' })
};

/** 会话详情里的「谁做了什么」。 */
export interface SessionActivityDto {
  readonly action: 'session.start' | 'session.fork' | 'session.interrupt' | 'session.continue';
  readonly actor: { readonly id: string; readonly name: string };
  readonly detail: string;
  readonly at: number;
}

/**
 * 会话级的开关（和 `api` 里那些会话动作同一套写请求写法，单独放一处便于按会话成组）。
 * `pin` = 常驻：Worker 不按空闲回收这条会话，也不占保活上限；权限与「说话」同一档。
 */
export const sessionsApi = {
  pin: (sessionId: string, pinned: boolean) => post<SessionDto>(`${sq(sessionId)}/pin`, { pinned })
};

/**
 * 会话能用的 MCP 服务器：会话资产快照里的 MCP 条目 ∩ 机器上已装的版本。
 * `note` 有值表示拿不到清单的原因（机器不在线 / 还没落到机器上 / 机器上没有版本），
 * 这时 `servers` 可能是空的，但 `disabled` 仍照常返回。
 */
export interface SessionMcpServerDto {
  readonly name: string;
  readonly transport: 'stdio' | 'http';
  readonly assetId: string;
  readonly assetName: string;
}

export interface SessionMcpViewDto {
  readonly servers: readonly SessionMcpServerDto[];
  readonly disabled: readonly string[];
  readonly note: string | null;
}

/**
 * 按会话关掉某些 MCP 服务器。只写会话上的名单，不重启进程、不改资产和机器安装：
 * 下一次启动会话进程时才按新名单下发。
 */
export const sessionMcpApi = {
  view: (sessionId: string) => call<SessionMcpViewDto>(`${sq(sessionId)}/mcp`),
  set: (sessionId: string, disabled: readonly string[]) =>
    call<SessionDto>(`${sq(sessionId)}/mcp`, { method: 'PATCH', body: JSON.stringify({ disabled }) })
};

/**
 * 项目级能力授权（docs/design/project-session-mcp.md §25-35）。
 *
 * 这是**会话归属人**在网页上逐项开的权限，默认全关；工具侧不能自助开启。
 * 接口只认登录会话，所以这里和别的会话动作一样走 cookie + CSRF。
 */
export type ProjectToolScope =
  | 'project:read'
  | 'task:write'
  | 'asset:write'
  | 'worktree:open'
  | 'message:send'
  | 'candidate:import'
  | 'repo:read';

export const PROJECT_TOOL_SCOPES: readonly ProjectToolScope[] = [
  'project:read',
  'task:write',
  'worktree:open',
  'message:send',
  'candidate:import',
  'asset:write',
  'repo:read'
];

/**
 * 仓库读取按服务端可用性单独展示；各能力互相独立，默认全关。
 * 服务端仍认全部 scope；后续新增能力时在这里显式加入，避免开关先于工具出现。
 */
export const PROJECT_TOOL_GRANT_SCOPES = [
  'project:read',
  'task:write',
  'worktree:open',
  'message:send',
  'candidate:import',
  'asset:write',
  'repo:read'
] as const satisfies readonly ProjectToolScope[];

export interface ProjectToolGrantView {
  /** 这条会话服务端绑定的项目；接口没给时是 null（不影响展示已有的 scopes）。 */
  readonly projectId: string | null;
  /** 当前**有效**的授权项；空数组就是默认全关。 */
  readonly scopes: readonly ProjectToolScope[];
  /** 仅 GET 明确表示当前项目支持时才开放仓库读取开关。 */
  readonly repositoryReadAvailable?: boolean;
}

/** 后端在迁移期可能返回单条 grant、grant 列表、`{revoked:n}`，这里统一归一成「当前有效项」。 */
function normalizeProjectGrant(payload: unknown): ProjectToolGrantView {
  const grant = (payload as { grant?: unknown } | null | undefined)?.grant;
  const candidates: unknown[] = Array.isArray(grant) ? grant : grant == null ? [] : [grant];
  const now = Date.now();
  const enabled = new Set<ProjectToolScope>();
  let projectId: string | null = null;
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const record = candidate as { projectId?: unknown; scopes?: unknown; revokedAt?: unknown; expiresAt?: unknown };
    if (typeof record.revokedAt === 'number') continue;
    if (typeof record.expiresAt === 'number' && record.expiresAt <= now) continue;
    if (typeof record.projectId === 'string') projectId ??= record.projectId;
    if (!Array.isArray(record.scopes)) continue;
    for (const scope of record.scopes) {
      if (typeof scope === 'string' && (PROJECT_TOOL_SCOPES as readonly string[]).includes(scope)) {
        enabled.add(scope as ProjectToolScope);
      }
    }
  }
  const availability = (payload as { repositoryReadAvailable?: unknown } | null | undefined)?.repositoryReadAvailable;
  return { projectId, scopes: PROJECT_TOOL_SCOPES.filter((scope) => enabled.has(scope)), ...(typeof availability === 'boolean' ? { repositoryReadAvailable: availability } : {}) };
}

const projectGrantResponse = (payload: { readonly grant?: unknown }): ProjectToolGrantView =>
  normalizeProjectGrant(payload);

export const projectToolGrantApi = {
  /** 归属人查看；没有授权时后端回 `grant: null`，这里归一成空 scopes。 */
  view: (sessionId: string) =>
    call<{ grant?: unknown }>(`${sq(sessionId)}/project-tool-grant`).then(projectGrantResponse),
  /** 授予 / 替换；`scopes` 至少一项，撤权用 DELETE。 */
  set: (sessionId: string, scopes: readonly ProjectToolScope[]) =>
    call<{ grant?: unknown }>(`${sq(sessionId)}/project-tool-grant`, {
      method: 'PUT',
      body: JSON.stringify({ scopes })
    }).then(projectGrantResponse),
  /** 撤销这条会话下该账号的全部项目授权；对已经发出的旧工具令牌也立即生效。 */
  revoke: (sessionId: string) =>
    call<{ grant?: unknown }>(`${sq(sessionId)}/project-tool-grant`, { method: 'DELETE' }).then(projectGrantResponse)
};

/**
 * 会话所属的组合工作目录。`session.groupId` 后端已经返回，契约的 sessionSchema 还没补这个字段，
 * 所以在这里做一次结构化读取，等契约补上后换成直接 `session.groupId` 即可。
 */
export function sessionGroupId(session: SessionDto | null | undefined): string | null {
  const value = (session as unknown as { groupId?: unknown } | null | undefined)?.groupId;
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * 预览链接（docs/design/preview.md §4）：把 worker 上的回环端口挂到 hub 的一个监听端口上。
 * 只登记端口，不碰用户代码；返回的 `hubPort` 拼上当前 location 就是可打开的链接。
 */
export const previewsApi = {
  list: (sessionId: string) =>
    call<{ links: PreviewLinkDto[] }>(`${sq(sessionId)}/previews`).then((r) => r.links),
  listWithAddresses: (sessionId: string) =>
    call<{ links: PreviewLinkDto[]; addresses: Record<string, string | null> }>(`${sq(sessionId)}/previews`),
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

export const previewWorkflowApi = {
  get: (sessionId: string) => call<PreviewWorkflow>(`${sq(sessionId)}/preview-workflow`).catch((error: unknown) => {
    if (error instanceof RequestFailed && error.status === 404) return { available: false, targets: [] } satisfies PreviewWorkflow;
    throw error;
  }),
  register: (sessionId: string, port: number) => post<{ target: PreviewWorkflowTarget }>(`${sq(sessionId)}/preview-workflow`, { port }),
  diagnostic: (sessionId: string, linkId: string) => post<PreviewDiagnostic>(`${sq(sessionId)}/previews/${encodeURIComponent(linkId)}/diagnostic`, {})
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

export interface RewindPreviewDto { promptSeq: number; prompt: string; filesAllowed: boolean; filesBlocked: string | null; turnsAfter: number; mode?: 'native' | 'summary' | 'none'; modeReason?: string | null; agentLabel?: string }
export interface RewindDto { session: SessionDto; prompt: string; files: { turn: number; restored: number; removed: number; safety: string } | null }
/** 从某条消息重来（ADR 0027 阶段 4）。 */
export const rewindApi = {
  preview: (id: string, promptSeq: number) => call<RewindPreviewDto>(`${sq(id)}/rewind?promptSeq=${promptSeq}`),
  rewind: (id: string, promptSeq: number, files: boolean) => post<RewindDto>(`${sq(id)}/rewind`, { promptSeq, files })
};

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
