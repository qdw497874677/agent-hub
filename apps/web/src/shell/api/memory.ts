import { call, post } from './http.ts';
import type { HubModelsDto } from './providers.ts';

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
