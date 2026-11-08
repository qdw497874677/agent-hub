import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/** 资产中心 MCP 端到端测试用的最小 stdio 服务器：一个 echo 工具，把入参原样加上标记返回。 */
const server = new Server({ name: 'e2e-mcp-echo', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: '把 text 原样返回，用于验证 agent-hub 的 MCP 资产注入链路。',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text']
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{ type: 'text', text: `MCP_ASSET_ECHO ${String(request.params.arguments?.text ?? '')}` }]
}));

await server.connect(new StdioServerTransport());
