import { call, post } from './http.ts';

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
    /** 只给这几个项目（不给 = 不限）。 */
    projectIds?: readonly string[] | null;
  }) =>
    post<{ token: string; info: ApiTokenDto }>('/api/tokens', input),
  revoke: (id: string) => call<{ ok: true }>(`/api/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  rotate: (id: string) => post<{ token: string; info: ApiTokenDto; replaced: ApiTokenDto }>(`/api/tokens/${encodeURIComponent(id)}/rotate`, {}),
  activity: (id: string) => call<import('@agent-hub/contract').ApiTokenActivity>(`/api/tokens/${encodeURIComponent(id)}/activity`),
  tools: (id: string) => call<import('@agent-hub/contract').ApiTokenTools>(`/api/tokens/${encodeURIComponent(id)}/tools`)
};

/** 外部接入（MCP）：只读模式。 */
export const mcpAccessApi = {
  get: () => call<import('@agent-hub/contract').McpAccessSettings>('/api/mcp/access'),
  set: (readOnly: boolean | null) =>
    call<import('@agent-hub/contract').McpAccessSettings>('/api/mcp/access', { method: 'PUT', body: JSON.stringify({ readOnly }) })
};
