import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createPiRuntime, discoverPiModels } from '@agent-hub/adapter-pi';
import { ACP_AGENT_DEFAULTS, createAcpRuntime, type AcpAgentConfig } from '@agent-hub/adapter-acp';
import { connectWorkerLink } from '@agent-hub/node-gateway';
import type { AgentRuntime, RuntimeOption } from '@agent-hub/domain';

/**
 * worker 的组合根。单机安装时由 server 拉起（HUB_SPAWN_WORKER=1），
 * 也可以单独跑在有 agent 凭据的那台机器上——同一个入口、同一份代码。
 *
 * 它不知道任务、不知道画布、不知道权限：那些在 server 的内核里。
 */
const env = process.env;

const hubUrl = env['HUB_URL'] ?? 'ws://127.0.0.1:7878/worker';
const token = env['HUB_TOKEN'] ?? '';
const workerId = env['WORKER_ID'] ?? `local-${randomUUID().slice(0, 8)}`;
const label = env['WORKER_LABEL'] ?? '本机';
const origin = env['WORKER_ORIGIN'] === 'remote' ? 'remote' : 'local';

/**
 * 显式覆盖：`PI_DEFAULT_MODEL=a,b`。除此之外一律问 Pi 自己（见 discoverPiModels），
 * 因为裸模型名在多个 provider 都已认证时会被 Pi 拒绝启动，平台补不全。
 */
function explicitPiModels(): string[] {
  const explicit = env['PI_DEFAULT_MODEL'];
  if (explicit === undefined || explicit === '') return [];
  return explicit
    .split(',')
    .map((model) => model.trim())
    .filter((model) => model !== '');
}

/** Pi settings 里的 defaultModel 只有 id，没有 provider——用它告诉发现流程「优先选哪个」。 */
function piPreferredModel(): string {
  try {
    const raw = readFileSync(join(homedir(), '.pi', 'agent', 'settings.json'), 'utf8');
    const settings = JSON.parse(raw) as { defaultModel?: unknown };
    return typeof settings.defaultModel === 'string' ? settings.defaultModel : '';
  } catch {
    return '';
  }
}

const explicitModels = explicitPiModels();
const discovered =
  explicitModels.length > 0
    ? { models: explicitModels, defaultModel: explicitModels[0] ?? '' }
    : await discoverPiModels(env['PI_COMMAND'] ?? 'pi', piPreferredModel());

const piModels = discovered.models;

const log = (message: string): void => {
  process.stdout.write(`[worker] ${message}\n`);
};

/**
 * ACP agent 是配置，不是代码。
 * `ACP_AGENTS='[{"id":"claude-code","label":"Claude Code","command":"claude-code-acp","args":[]}]'`
 * 就能多一个 agent——不改内核、不重新编译（README「新增第三个 agent」说的就是这条路）。
 */
function acpAgents(): readonly AcpAgentConfig[] {
  const raw = env['ACP_AGENTS'];
  if (raw === undefined || raw === '') return ACP_AGENT_DEFAULTS;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return ACP_AGENT_DEFAULTS;
    const agents: AcpAgentConfig[] = [];
    for (const entry of parsed) {
      const candidate = entry as Partial<AcpAgentConfig>;
      if (typeof candidate.id !== 'string' || typeof candidate.command !== 'string') continue;
      agents.push({
        id: candidate.id,
        label: typeof candidate.label === 'string' ? candidate.label : candidate.id,
        command: candidate.command,
        args: Array.isArray(candidate.args) ? candidate.args.filter((arg) => typeof arg === 'string') : []
      });
    }
    return agents.length > 0 ? agents : ACP_AGENT_DEFAULTS;
  } catch {
    log('ACP_AGENTS 不是合法 JSON，回退到默认的 OpenCode');
    return ACP_AGENT_DEFAULTS;
  }
}

// 先接住 adapter 的回调，等 link 就绪后转给它——adapter 在构造时就要拿到这个函数。
let notifyAgentSessionRef: (sessionId: string, ref: string) => void = () => undefined;
let notifyOptions: (sessionId: string, options: readonly RuntimeOption[]) => void = () => undefined;

const runtimes: AgentRuntime[] = [
  createPiRuntime({
    ...(env['PI_COMMAND'] ? { command: env['PI_COMMAND'] } : {}),
    ...(env['PI_SESSION_DIR'] ? { sessionDir: env['PI_SESSION_DIR'] } : {}),
    models: piModels,
    defaultModel: discovered.defaultModel,
    onAgentSessionRef: (sessionId, ref) => notifyAgentSessionRef(sessionId, ref),
    onOptions: (sessionId, reported) => notifyOptions(sessionId, reported)
  }),
  ...acpAgents().map((config) =>
    createAcpRuntime(
      // OPENCODE_COMMAND 是给单机安装留的后门：PATH 里那版 opencode 不对时改一条环境变量就够。
      config.id === 'opencode' && env['OPENCODE_COMMAND']
        ? { ...config, command: env['OPENCODE_COMMAND'] }
        : config,
      {
        onAgentSessionRef: (sessionId, ref) => notifyAgentSessionRef(sessionId, ref),
        onOptions: (sessionId, reported) => notifyOptions(sessionId, reported)
      }
    )
  )
];

log(`Pi 认得 ${piModels.length} 个模型（默认 ${discovered.defaultModel || 'Pi 自己的默认'}）`);

const link = connectWorkerLink({
  url: hubUrl,
  token,
  workerId,
  label,
  origin,
  runtimes,
  onLog: log
});

notifyAgentSessionRef = (sessionId, ref) => link.notifyAgentSessionRef(sessionId, ref);
notifyOptions = (sessionId, reported) => link.notifyOptions(sessionId, reported);

log(`已装 agent：${runtimes.map((runtime) => runtime.descriptor.label).join('、')}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void link.close().finally(() => process.exit(0));
  });
}
