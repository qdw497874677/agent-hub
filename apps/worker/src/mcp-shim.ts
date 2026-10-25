import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/**
 * stdio MCP 垫片（P4）：给只会 stdio MCP 的 agent 用。agent 把它当子进程拉起，
 * 它把 list / call 原样转给 AGENT_HUB_TOOL_URL（worker 本地 relay 或 hub 的 /mcp，都是 Streamable HTTP）。
 * 令牌只从 AGENT_HUB_TOOL_TOKEN 读、只放进 Authorization 头；stdout 是协议通道，任何日志都不许写进去。
 */
const url = process.env['AGENT_HUB_TOOL_URL'] ?? '';
const token = process.env['AGENT_HUB_TOOL_TOKEN'] ?? '';
delete process.env['AGENT_HUB_TOOL_TOKEN'];
if (url === '' || token === '') {
  process.stderr.write('agent-hub 垫片：缺少 AGENT_HUB_TOOL_URL / AGENT_HUB_TOOL_TOKEN\n');
  process.exit(2);
}

const client = new Client({ name: 'agent-hub-shim', version: '1.0.0' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } })
);

const server = new Server({ name: 'agent-hub', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => client.listTools());
server.setRequestHandler(CallToolRequestSchema, async (request) =>
  client.callTool({ name: request.params.name, arguments: request.params.arguments ?? {} })
);
await server.connect(new StdioServerTransport());
