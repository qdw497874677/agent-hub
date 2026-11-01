import { mkdir, symlink, writeFile, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PROVIDER_BASE_URL_ENV, PROVIDER_TOKEN_ENV } from '@agent-hub/domain';

/** hub 管的 Hermes 目录：每会话一个 HERMES_HOME，加一个所有会话共用的 installs/cache。 */
export function defaultHermesRoot(home = homedir()): string {
  return join(home, '.local', 'state', 'agent-hub', 'hermes');
}

export function hermesSessionKey(sessionId: string): string {
  return `ahub-${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

export interface HermesProfileSpec {
  readonly model: string;
  readonly workspaceRoot: string;
  /** 有 hub 能力层时：worker 的 stdio MCP 垫片（和 Pi 同一个），参数里只有变量引用。 */
  readonly toolShim?: { readonly command: string; readonly args: readonly string[] };
}

/**
 * 会话的 config.yaml（写成 JSON——YAML 的子集）。只有地址的变量引用，令牌永远在环境变量里（ADR 0013）。
 * - 模型：custom provider 指本机中继，`${HUB_PROVIDER_*}` 由 Hermes 读配置时展开（D6：不碰 Hermes 自己的 provider）。
 * - 记忆：默认关（D4：hub 记忆是权威，避免两套记忆打架）。
 * - MCP：hub 能力层走 stdio 垫片；§14.3 实测 session key 不会转给 MCP，所以按会话写进 profile。
 * - terminal.cwd：工作区（§14.6：Runs API 没有每轮 cwd，只能放在 profile 里；它不是沙箱）。
 */
export function hermesProfileConfig(spec: HermesProfileSpec): Record<string, unknown> {
  const config: Record<string, unknown> = {
    model: {
      provider: 'custom',
      default: spec.model,
      base_url: `\${${PROVIDER_BASE_URL_ENV}}`,
      api_key: `\${${PROVIDER_TOKEN_ENV}}`
    },
    memory: { memory_enabled: false, user_profile_enabled: false },
    terminal: { backend: 'local', cwd: spec.workspaceRoot }
  };
  if (spec.toolShim) {
    config['mcp_servers'] = {
      'agent-hub': {
        command: spec.toolShim.command,
        args: [...spec.toolShim.args],
        env: {
          AGENT_HUB_TOOL_URL: '${AGENT_HUB_TOOL_URL}',
          AGENT_HUB_TOOL_TOKEN: '${AGENT_HUB_TOOL_TOKEN}',
          AGENT_HUB_MCP: '${AGENT_HUB_MCP}'
        },
        sampling: { enabled: false }
      }
    };
  }
  return config;
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false
  );
}

/**
 * 建（或复用）会话的 HERMES_HOME。目录按 hub 会话 id 定，不删：resume 靠 Hermes 自己的 state.db 接着聊。
 * installs/ cache/ 指向共用目录（实测一个会话 5.5 MB，而完整 HERMES_HOME 约 424 MB）。
 */
export async function prepareHermesHome(root: string, sessionId: string, spec: HermesProfileSpec): Promise<string> {
  const dir = join(root, 'sessions', hermesSessionKey(sessionId));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const shared of ['installs', 'cache']) {
    const target = join(root, 'shared', shared);
    await mkdir(target, { recursive: true, mode: 0o700 });
    const link = join(dir, shared);
    if (!(await exists(link))) await symlink(target, link).catch(() => undefined);
  }
  await writeFile(join(dir, 'config.yaml'), `${JSON.stringify(hermesProfileConfig(spec), null, 2)}\n`, { mode: 0o600 });
  return dir;
}
