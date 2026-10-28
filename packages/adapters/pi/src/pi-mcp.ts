import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * Pi 的 MCP 由 pi-mcp-adapter 提供。7.x 起它**不再读** `~/.pi/agent/mcp.json`（那是 Pi 0.99+ 内置 MCP 的文件，
 * 老 Pi 上只会得到「no longer reads … mcp.json」提示、0 个服务器），只认自己的全局配置
 * `~/.pi/agent/mcp-adapter.json`（或 `$PI_CODING_AGENT_DIR/mcp-adapter.json`）。
 * Pi 0.99+ 自带 MCP，读的才是 mcp.json。所以按 Pi 版本选文件（见 piMcpPath），老 Pi 写进 mcp-adapter.json。两者都是**用户全局**来源，不经项目信任 / 项目服务器审批；
 * 项目级 hub 资产也不落进项目目录，而是由垫片聚合进这一条（见 AGENT_HUB_MCP），和全局资产走同一条受信路径。
 * 我们不碰 settings.projectServers 之类的信任设置。
 *
 * 注意：Pi 只对 `headers` 和 stdio 的 `env` 做 `${VAR}` 展开，**`url` 按字面校验**——
 * 写 `"url": "${AGENT_HUB_TOOL_URL}"` 会让整条配置被判非法，Pi 根本不加载这些工具
 * （之前的线上验证里 Pi 是自己用 curl 调的端点，不是走 MCP 工具）。
 * 所以这条写成 stdio：拉起 worker 的 MCP 垫片，URL 和令牌都写成 env 引用，真值由 worker 在 spawn 时给。
 * 文件里永远没有令牌；relay / http 两种模式是同一条配置（垫片连 worker 本机入口或 hub 都行）。
 * 用户自己开的 pi（没有这两个变量）只会让这一条解析失败、被跳过。
 */
export function piMcpEntry(shim: { readonly command: string; readonly args: readonly string[] }) {
  return {
    command: shim.command,
    args: [...shim.args],
    // AGENT_HUB_MCP：hub 下发的 MCP 资产（JSON）；垫片把它们聚合进这一个服务器，工具名加「资产名__」前缀
    env: {
      AGENT_HUB_TOOL_URL: '${AGENT_HUB_TOOL_URL}',
      AGENT_HUB_TOOL_TOKEN: '${AGENT_HUB_TOOL_TOKEN}',
      AGENT_HUB_MCP: '${AGENT_HUB_MCP}'
    },
    // direct：工具像内置工具一样直接声明给模型（只有 4 个，不必走 codemode / tool_search）
    exposure: 'direct',
    description: 'agent-hub：读取当前任务、读写任务工作日志（写交接）、更新任务状态'
  };
}

/** Pi 的 agent 目录：和 Pi / pi-mcp-adapter 一样认 PI_CODING_AGENT_DIR。 */
export function piAgentDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const configured = env['PI_CODING_AGENT_DIR']?.trim();
  if (!configured) return join(home, '.pi', 'agent');
  if (configured === '~') return home;
  if (configured.startsWith('~/')) return resolve(home, configured.slice(2));
  return resolve(configured);
}

/**
 * agent-hub 这条该写的用户全局文件：Pi 0.99+ 自带 MCP，读 `mcp.json`（装了适配器也会导入它）；
 * 更老的 Pi 只能靠 pi-mcp-adapter，7.x 只认 `mcp-adapter.json`。两者都是全局来源，不经项目审批。
 */
export function piMcpPath(env: NodeJS.ProcessEnv = process.env, home = homedir(), builtin = false): string {
  return join(piAgentDir(env, home), builtin ? 'mcp.json' : 'mcp-adapter.json');
}

/** `pi --version` 输出 → 是否自带 MCP（0.99 起有 registerMcpServer）。认不出就按老版本处理。 */
export function piHasBuiltinMcp(version: string): boolean {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 0 || minor >= 99;
}

type McpFile = { mcpServers?: Record<string, unknown> } & Record<string, unknown>;

/** 读 JSON 配置：不存在 = {}；坏文件 = null（不动它）。 */
async function readConfig(path: string): Promise<McpFile | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as McpFile) : null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? {} : null;
  }
}

async function writeConfig(path: string, config: McpFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

/** 是不是 hub 以前写进 mcp.json 的那条（stdio 垫片 + 我们的变量引用）。 */
function isOurEntry(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const env = (value as { env?: Record<string, unknown> }).env;
  return !!env && env['AGENT_HUB_TOOL_TOKEN'] === '${AGENT_HUB_TOOL_TOKEN}';
}

/**
 * 另一个文件里我们写过的 agent-hub 条目要拿掉：老 Pi 上适配器不读 mcp.json，还会提示「请合并后删除」，
 * 模型看到会自己动手改配置（线上真发生过）；新 Pi 上两边都有会重复注册。
 * 只删我们那一条；文件只剩空壳时整个删掉（本来就是我们建的），有用户自己的服务器 / 设置就原样留着。
 */
async function dropOurEntry(path: string): Promise<boolean> {
  const config = await readConfig(path);
  if (!config || !isOurEntry(config.mcpServers?.['agent-hub'])) return false;
  const { ['agent-hub']: _ours, ...rest } = config.mcpServers ?? {};
  const others = Object.keys(config).filter((key) => key !== 'mcpServers');
  if (Object.keys(rest).length === 0 && others.length === 0) await unlink(path).catch(() => undefined);
  else await writeConfig(path, { ...config, mcpServers: rest });
  return true;
}

/**
 * 把 agent-hub 合并进该写的那个全局文件（保留用户已有的服务器和设置），并从另一个文件里拿掉我们的旧条目。
 * 已经一样就不写。返回是否改了文件。
 */
export async function ensurePiMcpConfig(
  shim: { readonly command: string; readonly args: readonly string[] },
  options: { readonly dir?: string; readonly builtin?: boolean } = {}
): Promise<boolean> {
  const dir = options.dir ?? piAgentDir();
  const builtin = options.builtin ?? false;
  const path = join(dir, builtin ? 'mcp.json' : 'mcp-adapter.json');
  const dropped = await dropOurEntry(join(dir, builtin ? 'mcp-adapter.json' : 'mcp.json')).catch(() => false);
  const entry = piMcpEntry(shim);
  const config = await readConfig(path);
  if (!config) return dropped; // 坏文件不动，宁可没工具
  const servers = { ...(config.mcpServers ?? {}) };
  if (JSON.stringify(servers['agent-hub']) === JSON.stringify(entry)) return dropped;
  servers['agent-hub'] = entry;
  await writeConfig(path, { ...config, mcpServers: servers });
  return true;
}

/**
 * spawn 时追加的环境变量；没工具就不加。有工具时 AGENT_HUB_MCP 总是给（空就是 []），否则 Pi 展开不了这条配置。
 * stdio 资产的密钥已展开在里面：只进 Pi 进程环境，垫片读完就删掉，再只传给对应的 MCP 子进程。
 */
export function piToolEnv(tools: { url: string; token: string } | undefined, mcp: readonly unknown[] = []): Record<string, string> {
  return tools ? { AGENT_HUB_TOOL_URL: tools.url, AGENT_HUB_TOOL_TOKEN: tools.token, AGENT_HUB_MCP: JSON.stringify(mcp) } : {};
}
