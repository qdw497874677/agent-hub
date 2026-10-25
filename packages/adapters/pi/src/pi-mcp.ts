import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Pi 的 MCP 走它自己的 `~/.pi/agent/mcp.json`（只支持 stdio 和 Streamable HTTP，不支持 SSE）。
 *
 * 注意：Pi 只对 `headers` 和 stdio 的 `env` 做 `${VAR}` 展开，**`url` 按字面校验**——
 * 写 `"url": "${AGENT_HUB_TOOL_URL}"` 会让整条配置被判非法，Pi 根本不加载这些工具
 * （之前的线上验证里 Pi 是自己用 curl 调的端点，不是走 MCP 工具）。
 * 所以这条写成 stdio：拉起 worker 的 MCP 垫片，URL 和令牌都写成 env 引用，真值由 worker 在 spawn 时给。
 * 文件里永远没有令牌；http / stdio-shim 两种模式是同一条配置（垫片两种 URL 都能连）。
 * 用户自己开的 pi（没有这两个变量）只会让这一条解析失败、被跳过。
 */
export function piMcpEntry(shim: { readonly command: string; readonly args: readonly string[] }) {
  return {
    command: shim.command,
    args: [...shim.args],
    env: { AGENT_HUB_TOOL_URL: '${AGENT_HUB_TOOL_URL}', AGENT_HUB_TOOL_TOKEN: '${AGENT_HUB_TOOL_TOKEN}' },
    // direct：工具像内置工具一样直接声明给模型（只有 4 个，不必走 codemode / tool_search）
    exposure: 'direct',
    description: 'agent-hub：读取当前任务、读写任务工作日志（写交接）、更新任务状态'
  };
}

export function piMcpPath(home = homedir()): string {
  return join(home, '.pi', 'agent', 'mcp.json');
}

/** 合并进已有配置；已经一样就不写。返回是否改了文件。 */
export async function ensurePiMcpConfig(
  shim: { readonly command: string; readonly args: readonly string[] },
  path = piMcpPath()
): Promise<boolean> {
  const entry = piMcpEntry(shim);
  let config: { mcpServers?: Record<string, unknown> } & Record<string, unknown> = {};
  try {
    config = JSON.parse(await readFile(path, 'utf8')) as typeof config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false; // 坏文件不动，宁可没工具
  }
  const servers = { ...(config.mcpServers ?? {}) };
  if (JSON.stringify(servers['agent-hub']) === JSON.stringify(entry)) return false;
  servers['agent-hub'] = entry;
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
