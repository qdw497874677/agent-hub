import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { aggregateName, parseShimMcp, splitAggregateName, type ShimMcpEntry } from './mcp-shim-config.ts';

/**
 * stdio MCP 垫片（P4）：给只会 stdio MCP 的 agent 用（Pi 一直用它）。agent 把它当子进程拉起，
 * 它把 list / call 原样转给 AGENT_HUB_TOOL_URL（worker 本地 relay，Streamable HTTP）。
 *
 * 聚合：AGENT_HUB_MCP 里是 hub 下发的 MCP 资产——http 的连 worker 本机中转（hub 代连远端），
 * stdio 的由垫片拉起（env 里是已展开的密钥，只进那个子进程）。它们的工具以「资产名__工具名」出现在同一个服务器里。
 * 某个资产连不上只跳过它（stderr 报名字），hub 工具照常可用。
 *
 * 令牌只从 AGENT_HUB_TOOL_TOKEN 读、只放进 Authorization 头；stdout 是协议通道，任何日志都不许写进去。
 */
const url = process.env['AGENT_HUB_TOOL_URL'] ?? '';
const token = process.env['AGENT_HUB_TOOL_TOKEN'] ?? '';
const assets = parseShimMcp(process.env['AGENT_HUB_MCP']);
delete process.env['AGENT_HUB_TOOL_TOKEN'];
delete process.env['AGENT_HUB_MCP'];
if (url === '' || token === '') {
  process.stderr.write('agent-hub 垫片：缺少 AGENT_HUB_TOOL_URL / AGENT_HUB_TOOL_TOKEN\n');
  process.exit(2);
}

const connectHttp = async (target: string, name: string): Promise<Client> => {
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(target), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    })
  );
  return client;
};

/** stdio 资产的子进程只拿到最小环境 + 它自己的 env（不继承令牌和别的资产的密钥）。 */
const baseEnv = (): Record<string, string> => {
  const keep = [
    'PATH',
    'HOME',
    'USER',
    'LANG',
    'LC_ALL',
    'TMPDIR',
    'SHELL',
    'TERM',
    'NODE_EXTRA_CA_CERTS',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
    'https_proxy',
    'http_proxy',
    'no_proxy'
  ];
  return Object.fromEntries(keep.flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : [])));
};

const connectAsset = async (entry: ShimMcpEntry): Promise<Client> => {
  if (entry.transport === 'http') return connectHttp(entry.url, entry.name);
  const client = new Client({ name: entry.name, version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: entry.command,
      args: [...entry.args],
      env: { ...baseEnv(), ...entry.env },
      stderr: 'ignore'
    })
  );
  return client;
};

const hub = await connectHttp(url, 'agent-hub-shim');
const extra = new Map<string, Client>();
await Promise.all(
  assets.map(async (entry) => {
    try {
      extra.set(entry.name, await connectAsset(entry));
    } catch (error) {
      process.stderr.write(`agent-hub 垫片：MCP「${entry.name}」连不上，跳过（${(error as Error).message.slice(0, 160)}）\n`);
    }
  })
);

const server = new Server({ name: 'agent-hub', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools: Tool[] = [...(await hub.listTools()).tools];
  for (const [name, client] of extra) {
    try {
      for (const tool of (await client.listTools()).tools) tools.push({ ...tool, name: aggregateName(name, tool.name) });
    } catch {
      // 某个资产暂时不可用：只是这次少它的工具
    }
  }
  return { tools };
});
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const split = splitAggregateName(request.params.name, [...extra.keys()]);
  const client = split ? extra.get(split.server) : undefined;
  return (client ?? hub).callTool({
    name: split && client ? split.tool : request.params.name,
    arguments: request.params.arguments ?? {}
  });
});
await server.connect(new StdioServerTransport());
