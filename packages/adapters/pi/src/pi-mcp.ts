import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Pi 的 MCP 走它自己的 `~/.pi/agent/mcp.json`（只支持 stdio 和 Streamable HTTP，不支持 SSE）。
 * 我们在里面放一条 agent-hub：URL 和令牌都写成环境变量引用，真值由 worker 在 spawn 时通过 env 给。
 * 这样文件里永远没有令牌，用户自己开的 pi（没有这两个变量）只会跳过这一条，不会出错。
 */
export const PI_MCP_ENTRY = {
  url: '${AGENT_HUB_TOOL_URL}',
  headers: { Authorization: 'Bearer ${AGENT_HUB_TOOL_TOKEN}' },
  // direct：工具像内置工具一样直接声明给模型（只有 4 个，不必走 codemode / tool_search）
  exposure: 'direct',
  description: 'agent-hub：读取当前任务、读写任务工作日志（写交接）、更新任务状态'
} as const;

export function piMcpPath(home = homedir()): string {
  return join(home, '.pi', 'agent', 'mcp.json');
}

/** 合并进已有配置；已经一样就不写。返回是否改了文件。 */
export async function ensurePiMcpConfig(path = piMcpPath()): Promise<boolean> {
  let config: { mcpServers?: Record<string, unknown> } & Record<string, unknown> = {};
  try {
    config = JSON.parse(await readFile(path, 'utf8')) as typeof config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false; // 坏文件不动，宁可没工具
  }
  const servers = { ...(config.mcpServers ?? {}) };
  if (JSON.stringify(servers['agent-hub']) === JSON.stringify(PI_MCP_ENTRY)) return false;
  servers['agent-hub'] = PI_MCP_ENTRY;
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
  return true;
}

/** spawn 时追加的环境变量；没工具就不加。 */
export function piToolEnv(tools: { url: string; token: string } | undefined): Record<string, string> {
  return tools ? { AGENT_HUB_TOOL_URL: tools.url, AGENT_HUB_TOOL_TOKEN: tools.token } : {};
}
