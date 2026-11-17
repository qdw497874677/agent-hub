/**
 * 外部智能体接入 hub MCP 的「一次性说明」：端点、鉴权、各家客户端的粘贴片段、给 agent 看的提示词。
 *
 * 这里只做字符串拼装（DOM-free），方便测试与复制；真实端点与令牌由调用方给。
 * 约定：MCP 走 Streamable HTTP，鉴权用访问令牌（Authorization: Bearer ahp_…），
 * 写工具需要服务端开 MCP_WRITE=1，且令牌要带 projects:write / sessions:write。
 */

export type McpClientKind = 'claude' | 'cursor' | 'codex' | 'json' | 'prompt';

export interface McpGuideInput {
  /** 站点 origin，例如 https://hub.example.com（末尾斜杠会被去掉）。 */
  readonly origin: string;
  /** 明文令牌；没有时用占位符，避免把「ahp_…」当成真令牌复制出去。 */
  readonly token?: string | null;
}

export interface McpGuide {
  readonly url: string;
  readonly header: string;
  readonly token: string;
  readonly snippets: Readonly<Record<McpClientKind, string>>;
  readonly tabs: readonly { readonly id: McpClientKind; readonly label: string }[];
}

export const MCP_PLACEHOLDER = 'ahp_粘贴你的令牌';

const trimOrigin = (origin: string): string => origin.replace(/\/+$/, '');

export function mcpGuide(input: McpGuideInput): McpGuide {
  const base = trimOrigin(input.origin);
  const url = `${base}/openapi/v1/mcp`;
  const token = input.token?.trim() || MCP_PLACEHOLDER;
  const header = `Authorization: Bearer ${token}`;

  const claude = [
    `claude mcp add --transport http agent-hub '${url}' \\`,
    `  --header 'Authorization: Bearer ${token}'`
  ].join('\n');

  const cursor = JSON.stringify(
    {
      mcpServers: {
        'agent-hub': {
          url,
          headers: { Authorization: `Bearer ${token}` }
        }
      }
    },
    null,
    2
  );

  const codex = [
    '[mcp_servers.agent-hub]',
    `url = "${url}"`,
    `http_headers = { Authorization = "Bearer ${token}" }`
  ].join('\n');

  const prompt = [
    `你可以通过 Agent Hub 的 MCP 端点（${url}）查看项目、任务、会话与资产，并（在开放写工具时）把开发任务委派给它。`,
    '',
    '规则：',
    '1. 先调 list_projects / list_tasks 找到目标，再用 get_task / list_task_log 看进度；不要凭空编 id。',
    '2. 委派流程：task_create → session_start（可带 assetIds / assetSetIds 限定资产）→ session_reply 补话 → 轮询 log 或 events → session_cancel 收尾。',
    '3. 轮询：先用 get_session 记下 `turn`，再调 events(sinceTurn=turn)；运行中 3–5 秒一次，连续两次没新事件就退到 10 秒。本 turn 出现 ended 即本轮结束。',
    '4. 写工具必须带 clientRequestId（同一请求重试用同一个值），服务端 24 小时内返回同一份结果；不要每次重试都换 id。',
    '5. 资产默认按会话冻结：session_start 不传 assetIds 表示「项目生效集」；要排除某个技能，就传完整清单减掉它。',
    '6. 出错先看错误码：not_found 表示看不到（跨项目一律 404，不泄露存在性），forbidden 表示权限不够，conflict 表示状态不允许（会话还在跑、没有待发布版本等）。',
    ''
  ].join('\n');

  return {
    url,
    header,
    token,
    tabs: [
      { id: 'claude', label: 'Claude Code' },
      { id: 'cursor', label: 'Cursor' },
      { id: 'codex', label: 'Codex' },
      { id: 'json', label: '通用 JSON' },
      { id: 'prompt', label: '给 agent 的提示词' }
    ],
    snippets: { claude, cursor, codex, json: cursor, prompt }
  };
}
