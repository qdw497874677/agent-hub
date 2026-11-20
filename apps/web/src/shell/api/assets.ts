import type {
  AssetDiffDto,
  AssetRevisionDto,
  AssetsOverviewDto,
  AssetSetDto,
  AssetSetInputDto,
  GitBatchImportResult,
  GitBatchItem,
  GitScanDto,
  ProjectAssetPlanDto,
  ProjectAssetsDto,
  SecretsOverviewDto
} from '@agent-hub/contract';
import type {
  AssetReviewSettingsDto,
  AssetScopeDto,
  AssetSubmissionDto,
  InstallRequestDto,
  MarketAssetDto,
  NotificationDto,
  ReviewQueueItemDto,
  SubmissionDetailDto
} from '../market/types.ts';
import { call, post } from './http.ts';

export type {
  AssetDiffDto,
  AssetRevisionDto,
  AssetsOverviewDto,
  AssetSetDto,
  AssetSetInputDto,
  GitBatchImportResult,
  GitBatchItem,
  GitScanDto,
  ProjectAssetsDto,
  SecretsOverviewDto
} from '@agent-hub/contract';
export type * from '../market/types.ts';

/** 资产中心（docs/design/asset-hub.md）：技能与指令，按机器安装。文件内容一律 base64。 */
export type AssetUploadFile = { readonly path: string; readonly data: string };

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

const assetPath = (id: string) => `/api/admin/assets/${encodeURIComponent(id)}`;
export const assetsApi = {
  overview: () => call<AssetsOverviewDto>('/api/admin/assets'),
  upload: (input: { kind: 'skill' | 'instruction' | 'mcp'; name?: string; projectId?: string | null; files: AssetUploadFile[] }) =>
    post<{ id: string }>('/api/admin/assets/upload', input),
  scanGit: (url: string, ref: string, credential?: string) =>
    post<GitScanDto>('/api/admin/assets/git/scan', {
      url,
      ref: ref || null,
      ...(credential && credential.trim() !== '' ? { credential: credential.trim() } : {})
    }),
  importGit: (input: {
    url: string;
    ref: string;
    kind: 'skill' | 'instruction' | 'mcp';
    path: string;
    policy?: 'track' | 'locked';
    /** 私有仓库令牌：只随这一次请求发，不会被读回来。 */
    credential?: string;
    projectId?: string | null;
  }) =>
    post<{ id: string }>('/api/admin/assets/git/import', { ...input, ref: input.ref || null }),
  /**
   * 批量导入（1..20 条）。HTTP 200 只代表请求受理了：逐条成败在数组里，
   * 顺序和提交的 items 一致。每项可以单独带令牌，一般同一个仓库用同一个。
   */
  importGitBatch: (items: readonly GitBatchItem[]) => post<GitBatchImportResult[]>('/api/assets/git/batch', { items }),
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
  /**
   * 派生前预览：这台机器上这个项目实际会下发哪些资产。
   * `workerId` 必填——下发什么取决于机器上装了 / 认哪些资产。
   */
  projectPlan: (projectId: string, workerId: string) =>
    call<ProjectAssetPlanDto>(
      `/api/projects/${encodeURIComponent(projectId)}/assets?workerId=${encodeURIComponent(workerId)}`
    ),
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

/**
 * 资产组合（asset-hub.md「资产组合」）：把常用的技能 / 指令 / MCP 打包，项目里按顺序引用，
 * 派生会话时整组带或整组不带。列表按团队返回；名字 1–60 字，说明 ≤300，项数上限见 contract。
 * 被项目引用时删除会 409，`detail.message` 是后端给的原话（直接显示）。
 */
const assetSetPath = (id: string) => `/api/asset-sets/${encodeURIComponent(id)}`;
export const assetSetsApi = {
  list: () => call<{ sets: AssetSetDto[] }>('/api/asset-sets').then((result) => result.sets),
  create: (input: AssetSetInputDto) => post<AssetSetDto>('/api/asset-sets', input),
  update: (id: string, input: AssetSetInputDto) =>
    call<AssetSetDto>(assetSetPath(id), { method: 'PATCH', body: JSON.stringify(input) }),
  remove: (id: string) => call<{ ok: true }>(assetSetPath(id), { method: 'DELETE' })
};

// ---------- 资产市场 / 审核 / 通知（ADR 0016） ----------
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
  settings: () => call<{ team: (ReviewSettingsView & { teamId: string; noReviewEditable: boolean }) | null; hub: ReviewSettingsView | null }>('/api/assets/settings'),
  saveSettings: (target: 'team' | 'hub', reviewers: string[], twoReviewers: { global: boolean; mcpStdio: boolean }, teamNoReview?: boolean) =>
    call<AssetReviewSettingsDto>('/api/assets/settings', { method: 'PUT', body: JSON.stringify({ target, reviewers, twoReviewers, teamNoReview }) }),
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
  toTeam: (id: string) => post<{ submissionId: string; published: boolean }>(`/api/assets/items/${enc(id)}/to-team`, {}),
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

/* ── 内置资产（Hub 随代码带的清单，一键启用到项目） ── */
export type BuiltinAssetDto = import('@agent-hub/contract').BuiltinAssetView;
export type BrowserStatusDto = import('@agent-hub/contract').BrowserStatusDto;
export const builtinApi = {
  list: (projectId: string) => call<BuiltinAssetDto[]>(`/api/assets/builtin?projectId=${encodeURIComponent(projectId)}`),
  enable: (builtinId: string, projectId: string, secrets?: Record<string, string>) =>
    post<{ assetId: string; created: boolean }>(`/api/assets/builtin/${encodeURIComponent(builtinId)}/enable`, { projectId, ...(secrets ? { secrets } : {}) }),
  update: (assetId: string) => post<{ assetId: string; version: string }>(`/api/assets/${encodeURIComponent(assetId)}/builtin-update`, {}),
  browser: () => call<{ canInstall: boolean; workers: BrowserStatusDto[] }>('/api/builtin/browser'),
  installBrowser: (workerId: string) => post<{ job: unknown }>(`/api/workers/${encodeURIComponent(workerId)}/builtin-browser`, {})
};
