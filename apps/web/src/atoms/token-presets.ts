import type { ApiTokenInfo } from '@agent-hub/contract';

type ApiScopeDto = ApiTokenInfo['scopes'][number];

/**
 * 外部接入页的权限预设：大多数人只需要从这三种里挑一个，不用逐个勾 scope。
 * 「自定义」= 不套预设，自己勾。
 */
export type TokenPresetId = 'readonly' | 'delegate' | 'assets' | 'custom';

export interface TokenPreset {
  readonly id: TokenPresetId;
  readonly label: string;
  readonly hint: string;
  readonly scopes: readonly ApiScopeDto[];
}

export const TOKEN_PRESETS: readonly TokenPreset[] = [
  { id: 'readonly', label: '只读', hint: '看项目、任务、会话和资产，什么都改不了', scopes: ['projects:read', 'sessions:read', 'assets:read'] },
  {
    id: 'delegate',
    label: '委派开发',
    hint: '建任务、发起会话、补话、打断；可以用模型',
    scopes: ['projects:read', 'projects:write', 'sessions:read', 'sessions:write', 'providers:use']
  },
  { id: 'assets', label: '资产自动化', hint: '读资产、新建和更新资产（进审核）', scopes: ['assets:read', 'assets:write'] },
  { id: 'custom', label: '自定义', hint: '自己勾权限', scopes: [] }
];

/** 当前勾选正好等于哪个预设；都不是就算自定义。 */
export function presetOf(scopes: readonly ApiScopeDto[]): TokenPresetId {
  const have = [...new Set(scopes)].sort().join(' ');
  return TOKEN_PRESETS.find((preset) => preset.id !== 'custom' && [...preset.scopes].sort().join(' ') === have)?.id ?? 'custom';
}

/** 调用记录里给人看的动作名。 */
export function activityLabel(action: string): string {
  if (action === 'mcp.call') return '调用';
  if (action === 'token.create') return '创建';
  if (action === 'token.rotate') return '轮换';
  if (action === 'token.revoke') return '吊销';
  return action;
}

/** 测试连接：用刚拿到的明文调一次 tools/list，返回能看到几个工具（失败抛出人话）。 */
export async function testMcpConnection(url: string, token: string, fetcher: typeof fetch = fetch): Promise<number> {
  const response = await fetcher(url, {
    method: 'POST',
    credentials: 'omit',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  });
  if (response.status === 401) throw new Error('令牌无效或已过期');
  if (!response.ok) throw new Error(`连不上（HTTP ${response.status}）`);
  const body = (await response.json()) as { result?: { tools?: unknown[] }; error?: { message?: string } };
  if (!body.result) throw new Error(body.error?.message ?? '返回的不是工具清单');
  return body.result.tools?.length ?? 0;
}
