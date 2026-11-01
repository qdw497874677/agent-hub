import { mkdir, symlink, writeFile, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PROVIDER_BASE_URL_ENV, PROVIDER_TOKEN_ENV } from '@agent-hub/domain';

/** hub 管的 Hermes 目录：每个 worker 一个 HERMES_HOME（所有会话共用一个网关），加共用的 installs/cache。 */
export function defaultHermesRoot(home = homedir()): string {
  return join(home, '.local', 'state', 'agent-hub', 'hermes');
}

export function hermesSessionKey(sessionId: string): string {
  return `ahub-${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

/** 每会话的小目录：只放 hub 自己的记录（进行中一轮），Hermes 的会话数据在 worker 共用的 HERMES_HOME 里。 */
export async function prepareSessionDir(root: string, sessionId: string): Promise<string> {
  const dir = join(root, 'worker', 'sessions', hermesSessionKey(sessionId));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * worker 共用的 config.yaml（写成 JSON——YAML 的子集），设计文档 §17。只有变量引用，密钥永远在环境变量里。
 * - 模型：custom provider 指 worker 内的分流器（provider-mux.ts），每轮的 model 带会话路由；
 * - 记忆：默认关（D4：hub 记忆是权威）；
 * - terminal.cwd：一个中性的空目录——Runs API 没有每轮 cwd，一个网关服务多个工作区，
 *   不能把一个会话的工作区当成大家的默认目录；每轮的工作区绝对路径写进 instructions（保守选择，§17.3）；
 * - MCP：不配。MCP 是 profile 级，session key 不会转给 MCP（§14.3），共用网关下分不清是哪个会话在调 hub 工具，
 *   宁可不给也不能串（§17.4）；要 hub 工具的会话用 `hermes-acp` 运行时（ADR 0022 补充）。
 */
export function hermesWorkerConfig(cwd: string): Record<string, unknown> {
  return {
    model: {
      provider: 'custom',
      default: 'ahub-unrouted',
      base_url: `\${${PROVIDER_BASE_URL_ENV}}`,
      api_key: `\${${PROVIDER_TOKEN_ENV}}`
    },
    memory: { memory_enabled: false, user_profile_enabled: false },
    terminal: { backend: 'local', cwd }
  };
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false
  );
}

/** 建（或复用）worker 共用的 HERMES_HOME：root/worker/home。不删：resume 靠 Hermes 自己的 state.db。 */
export async function prepareWorkerHome(root: string): Promise<{ home: string; cwd: string }> {
  const home = join(root, 'worker', 'home');
  const cwd = join(root, 'worker', 'cwd');
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  for (const shared of ['installs', 'cache']) {
    const target = join(root, 'shared', shared);
    await mkdir(target, { recursive: true, mode: 0o700 });
    const link = join(home, shared);
    if (!(await exists(link))) await symlink(target, link).catch(() => undefined);
  }
  await writeFile(join(home, 'config.yaml'), `${JSON.stringify(hermesWorkerConfig(cwd), null, 2)}\n`, { mode: 0o600 });
  return { home, cwd };
}
