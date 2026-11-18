/**
 * 外部智能体接入 hub MCP 的「一次性说明」：端点、鉴权、各家客户端的粘贴片段、给 agent 看的提示词。
 *
 * 这里只做字符串拼装（DOM-free），方便测试与复制。
 * 约定：MCP 走 Streamable HTTP，鉴权用访问令牌（Authorization: Bearer ahp_…）。
 * 片段里**永远不放明文令牌**，一律引用环境变量 AGENT_HUB_TOKEN——
 * 配置文件常被提交进仓库、贴进聊天，明文一旦进去就等于泄露。
 */

export type McpClientKind = 'claude' | 'cursor' | 'codex' | 'prompt';

export interface McpGuideInput {
  /** 站点 origin，例如 https://hub.example.com（末尾斜杠会被去掉）。 */
  readonly origin: string;
}

export interface McpGuide {
  readonly url: string;
  readonly header: string;
  /** 放令牌的环境变量名。 */
  readonly envVar: string;
  /** 设环境变量那一行（占位符，不是真令牌）。 */
  readonly exportLine: string;
  readonly snippets: Readonly<Record<McpClientKind, string>>;
  readonly tabs: readonly { readonly id: McpClientKind; readonly label: string }[];
}

export const MCP_TOKEN_ENV = 'AGENT_HUB_TOKEN';
export const MCP_PLACEHOLDER = 'ahp_粘贴你的令牌';

const trimOrigin = (origin: string): string => origin.replace(/\/+$/, '');

/** 列表 / 新令牌里给人看的样子：只露前缀，其余打码。 */
export function maskToken(token: string): string {
  const head = token.slice(0, Math.min(8, Math.max(0, token.length - 4)));
  return `${head}${'•'.repeat(12)}`;
}

export function mcpGuide(input: McpGuideInput): McpGuide {
  const base = trimOrigin(input.origin);
  const url = `${base}/openapi/v1/mcp`;
  const envVar = MCP_TOKEN_ENV;
  const header = `Authorization: Bearer $${envVar}`;
  const exportLine = `export ${envVar}=${MCP_PLACEHOLDER}`;

  // Claude Code：.mcp.json 里的 ${VAR} 在启动时展开，配置文件里只有变量名
  const claude = JSON.stringify(
    { mcpServers: { 'agent-hub': { type: 'http', url, headers: { Authorization: `Bearer \${${envVar}}` } } } },
    null,
    2
  );

  // Cursor：~/.cursor/mcp.json 支持 ${env:VAR}
  const cursor = JSON.stringify(
    { mcpServers: { 'agent-hub': { url, headers: { Authorization: `Bearer \${env:${envVar}}` } } } },
    null,
    2
  );

  // Codex：~/.codex/config.toml 直接写环境变量名
  const codex = ['[mcp_servers.agent-hub]', `url = "${url}"`, `bearer_token_env_var = "${envVar}"`].join('\n');

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
    envVar,
    exportLine,
    tabs: [
      { id: 'claude', label: 'Claude Code' },
      { id: 'cursor', label: 'Cursor' },
      { id: 'codex', label: 'Codex' },
      { id: 'prompt', label: '给 agent 的提示词' }
    ],
    snippets: { claude, cursor, codex, prompt }
  };
}
