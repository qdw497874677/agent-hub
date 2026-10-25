import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createPiRuntime, discoverPiModels } from '@agent-hub/adapter-pi';
import { createOpenCodeRuntime } from '@agent-hub/adapter-opencode';
import { createGrokRuntime, discoverGrokModels } from '@agent-hub/adapter-grok';
import { connectWorkerLink } from '@agent-hub/node-gateway';
import type { AgentRuntime } from '@agent-hub/domain';

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

const grokCommand = env['GROK_COMMAND'] ?? 'grok';
// 没装 grok 时返回空目录，Grok 用自己的默认模型；真正启动会话时再报不可用。
const grokCatalog = await discoverGrokModels(grokCommand);

const log = (message: string): void => {
  process.stdout.write(`[worker] ${message}\n`);
};

// 先接住 adapter 的回调，等 link 就绪后转给它——adapter 在构造时就要拿到这个函数。
let notifyAgentSessionRef: (sessionId: string, ref: string) => void = () => undefined;

const runtimes: AgentRuntime[] = [
  createPiRuntime({
    ...(env['PI_COMMAND'] ? { command: env['PI_COMMAND'] } : {}),
    ...(env['PI_SESSION_DIR'] ? { sessionDir: env['PI_SESSION_DIR'] } : {}),
    models: piModels,
    defaultModel: discovered.defaultModel,
    onAgentSessionRef: (sessionId, ref) => notifyAgentSessionRef(sessionId, ref)
  }),
  createOpenCodeRuntime({
    ...(env['OPENCODE_COMMAND'] ? { command: env['OPENCODE_COMMAND'] } : {}),
    onAgentSessionRef: (sessionId, ref) => notifyAgentSessionRef(sessionId, ref)
  }),
  createGrokRuntime({
    command: grokCommand,
    models: grokCatalog.models,
    defaultModel: grokCatalog.defaultModel,
    onAgentSessionRef: (sessionId, ref) => notifyAgentSessionRef(sessionId, ref)
  })
];

log(`Grok 认得 ${grokCatalog.models.length} 个模型（默认 ${grokCatalog.defaultModel || 'Grok 自己的默认'}）`);
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

log(`已装 agent：${runtimes.map((runtime) => runtime.descriptor.label).join('、')}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void link.close().finally(() => process.exit(0));
  });
}
