import type { ProviderModelSpec } from '../provider-models.ts';
import { call, post } from './http.ts';

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
export interface HubModelsHiddenDto { readonly slug: string; readonly name: string; readonly reason: string }
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

/**
 * 会话里能选哪些 hub 模型：按任务查（派生对话框）或按项目查（会话内，后端会顺着项目找到团队）。
 * 兼容老写法 `models(taskId)`：传字符串等同于 `{ taskId }`。
 */
export interface HubModelsQuery {
  readonly taskId?: string;
  readonly projectId?: string;
}
function hubModelsPath(explain: boolean, input?: string | HubModelsQuery): string {
  const query = typeof input === 'string' ? { taskId: input } : (input ?? {});
  const params = new URLSearchParams();
  if (explain) params.set('explain', '1');
  if (query.taskId !== undefined && query.taskId !== '') params.set('taskId', query.taskId);
  if (query.projectId !== undefined && query.projectId !== '') params.set('projectId', query.projectId);
  const text = params.toString();
  return `/api/providers/models${text === '' ? '' : `?${text}`}`;
}
export const providersApi = {
  list: () => call<{ providers: ProviderDto[]; workerRouting: Record<string, 'direct' | 'hub'> }>('/api/providers'),
  models: (input?: string | HubModelsQuery) => call<HubModelsDto[]>(hubModelsPath(false, input)),
  modelsExplained: (input?: string | HubModelsQuery) =>
    call<{ providers: HubModelsDto[]; hidden: HubModelsHiddenDto[] }>(hubModelsPath(true, input)),
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
