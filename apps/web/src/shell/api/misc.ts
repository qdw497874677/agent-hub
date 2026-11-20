import type {
  BindingDto,
  ConnectorNoticeDto,
  ProjectContextDto,
  SessionContextDto,
  TriggerRunDto
} from '@agent-hub/contract';
import { call, post } from './http.ts';

export type {
  AgentDto,
  ArtifactDto,
  AttachmentInputDto,
  AttentionDto,
  AttentionItemDto,
  AttentionPhase,
  BindingDto,
  CapabilityDto,
  ConnectorNoticeDto,
  DirectoryListingDto,
  HomeDto,
  L1LevelDto,
  OptionValueDto,
  ProjectContextDto,
  PromptAckDto,
  RecentSessionDto,
  RuntimeOptionDto,
  SearchHitDto,
  SessionContextDto,
  StoredAttachmentDto,
  TriggerRunDto
} from '@agent-hub/contract';

const put = (body: unknown): RequestInit => ({ method: 'PUT', body: JSON.stringify(body) });
export const contextApi = {
  session: (id: string) => call<SessionContextDto>(`/api/sessions/${encodeURIComponent(id)}/context`),
  compact: (id: string) => call<{ requested: true }>(`/api/sessions/${encodeURIComponent(id)}/context/compact`, { method: 'POST', body: '{}' }),
  project: (id: string) => call<ProjectContextDto>(`/api/projects/${encodeURIComponent(id)}/context`),
  setProject: (id: string, input: { strategy: string; enabled: string[] }) => call<ProjectContextDto>(`/api/projects/${encodeURIComponent(id)}/context`, put(input)),
  setRole: (id: string, role: string, strategy: string | null) =>
    call<ProjectContextDto>(`/api/projects/${encodeURIComponent(id)}/context/roles/${encodeURIComponent(role)}`, put({ strategy }))
};

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
