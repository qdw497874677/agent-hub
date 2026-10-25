import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, homedir, hostname, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPiRuntime, discoverPiModels } from '@agent-hub/adapter-pi';
import { ACP_AGENT_DEFAULTS, acpDescriptor, createAcpRuntime, discoverAcpModels, type AcpAgentConfig } from '@agent-hub/adapter-acp';
import { createGrokRuntime, discoverGrokModels } from '@agent-hub/adapter-grok';
import { connectWorkerLink, createWorkerFiles, readBuildInfo, runSelfUpdate } from '@agent-hub/node-gateway';
import type { UpdateReport } from '@agent-hub/node-gateway';
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
// 本机口令只属于这个进程：读完就从环境里抹掉，免得被它拉起的 agent（和 agent 跑的命令）继承走。
const localSecret = env['HUB_LOCAL_SECRET'] ?? '';
delete env['HUB_LOCAL_SECRET'];
const origin = env['WORKER_ORIGIN'] === 'remote' ? 'remote' : 'local';
const label = env['WORKER_LABEL'] ?? (origin === 'local' ? '本机' : hostname());
const workerId = env['WORKER_ID'] ?? stableWorkerId();

/**
 * Worker 的身份要稳定：会话的落点存的就是它。每次启动换一个随机 id 的话，
 * 重启一次 Worker，它名下所有会话都「找不到原来那台」了。
 * 所以第一次启动时生成一个，存在 `$WORKER_STATE_DIR/worker-id`（默认 ~/.config/agent-hub/）。
 */
function stableWorkerId(): string {
  const file = join(env['WORKER_STATE_DIR'] ?? join(homedir(), '.config', 'agent-hub'), `worker-id${origin === 'local' ? '' : '.remote'}`);
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing !== '') return existing;
  } catch {
    // 第一次启动
  }
  const fresh = `${origin}-${randomUUID().slice(0, 8)}`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${fresh}\n`);
  } catch {
    // 写不了就用一次性的：能跑，只是重启后会换身份
  }
  return fresh;
}

/** 目录选择器的起点：`WORKER_ROOTS=/srv/code:/data`，默认 $HOME。 */
const roots = (env['WORKER_ROOTS'] ?? homedir())
  .split(':')
  .map((root) => root.trim())
  .filter((root) => root !== '')
  .map((root) => resolve(root));

/**
 * WORKER_ROOTS 是边界，不只是起点：hub 只能经这台 Worker 摸到 roots 里面的文件、
 * 只能在 roots 里开会话。远程 Worker 一律设防；hub 自己拉起的本机 Worker
 * 和 hub 同机，只有显式配了 WORKER_ROOTS 才设防。
 */
const files = createWorkerFiles({ roots, enforced: origin === 'remote' || env['WORKER_ROOTS'] !== undefined });

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
if (files.enforced) log(`允许访问的目录（WORKER_ROOTS）：${roots.join(':')}`);

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
        args: Array.isArray(candidate.args) ? candidate.args.filter((arg) => typeof arg === 'string') : [],
        ...(Array.isArray(candidate.listModelsArgs)
          ? { listModelsArgs: candidate.listModelsArgs.filter((arg) => typeof arg === 'string') }
          : {})
      });
    }
    return agents.length > 0 ? agents : ACP_AGENT_DEFAULTS;
  } catch {
    log('ACP_AGENTS 不是合法 JSON，回退到默认的 OpenCode');
    return ACP_AGENT_DEFAULTS;
  }
}

// OPENCODE_COMMAND 是给单机安装留的后门：PATH 里那版 opencode 不对时改一条环境变量就够。
const acpConfigs = acpAgents().map((config) =>
  config.id === 'opencode' && env['OPENCODE_COMMAND'] ? { ...config, command: env['OPENCODE_COMMAND'] } : config
);
// ACP 只在开了会话之后才报模型；启动时先问一次，派生对话框才有得选。
const acpModels = await Promise.all(acpConfigs.map((config) => discoverAcpModels(config)));

// 先接住 adapter 的回调，等 link 就绪后转给它——adapter 在构造时就要拿到这个函数。
let notifyAgentSessionRef: (sessionId: string, ref: string) => void = () => undefined;
let notifyOptions: (sessionId: string, options: readonly RuntimeOption[]) => void = () => undefined;

/**
 * stdio MCP 垫片：和 worker 同一个 node、同样的启动参数（.ts 直接跑），
 * 给 stdio-shim 模式、以及不会 HTTP MCP 的 ACP agent 用。
 */
const toolShim = {
  command: process.execPath,
  args: [...process.execArgv, join(dirname(fileURLToPath(import.meta.url)), 'mcp-shim.ts')]
};

const runtimes: AgentRuntime[] = [
  createPiRuntime({
    ...(env['PI_COMMAND'] ? { command: env['PI_COMMAND'] } : {}),
    ...(env['PI_SESSION_DIR'] ? { sessionDir: env['PI_SESSION_DIR'] } : {}),
    models: piModels,
    defaultModel: discovered.defaultModel,
    onAgentSessionRef: (sessionId, ref) => notifyAgentSessionRef(sessionId, ref),
    onOptions: (sessionId, reported) => notifyOptions(sessionId, reported)
  }),
  ...acpConfigs.map((config, index) =>
    createAcpRuntime(config, {
      descriptor: acpDescriptor(config, [], acpModels[index] ?? []),
      toolShim,
      onAgentSessionRef: (sessionId, ref) => notifyAgentSessionRef(sessionId, ref),
      onOptions: (sessionId, reported) => notifyOptions(sessionId, reported)
    })
  ),
  createGrokRuntime({
    command: grokCommand,
    models: grokCatalog.models,
    defaultModel: grokCatalog.defaultModel,
    toolShim,
    onAgentSessionRef: (sessionId, ref) => notifyAgentSessionRef(sessionId, ref),
    onOptions: (sessionId, reported) => notifyOptions(sessionId, reported)
  })
];

log(`Grok 认得 ${grokCatalog.models.length} 个模型（默认 ${grokCatalog.defaultModel || 'Grok 自己的默认'}）`);
acpConfigs.forEach((config, index) => log(`${config.label} 认得 ${acpModels[index]?.length ?? 0} 个模型`));
log(`Pi 认得 ${piModels.length} 个模型（默认 ${discovered.defaultModel || 'Pi 自己的默认'}）`);

/** 代码所在的仓库：远程更新就在这里 git fetch / npm ci。 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const build = readBuildInfo(repoRoot);
log(`版本 ${build.version}（${build.commit ? build.commit.slice(0, 7) : '非 git 仓库'}，协议 v${build.protocol}）`);

/** 更新成功后用这个退出码退出：systemd（Restart=always）或拉起它的 hub 会把新代码跑起来。 */
const RESTART_EXIT_CODE = 75;

async function onUpdate(commit: string, report: (status: UpdateReport) => void): Promise<void> {
  if (origin === 'local') {
    // 本机 Worker 和 hub 是同一份代码：在这里 git/npm 会把 hub 自己的依赖也换掉。
    // 版本一致就回「无需更新」（演练），不一致只可能是 hub 换了代码却没重启。
    if (commit === build.commit) report({ state: 'succeeded', message: `已是目标版本 ${commit.slice(0, 7)}，无需更新`, logTail: '' });
    else report({ state: 'refused', message: '本机 Worker 与 hub 共用代码：请在 hub 上 git pull 后重启 hub', logTail: '' });
    return;
  }
  const changed = await runSelfUpdate({
    repoDir: repoRoot,
    commit,
    report: (status) => {
      log(`更新：${status.message}`);
      report(status);
    }
  });
  if (changed) {
    // 给最后一帧进度一点时间发出去，再退出重启
    setTimeout(() => void link.close().finally(() => process.exit(RESTART_EXIT_CODE)), 500);
  }
}

const link = connectWorkerLink({
  url: hubUrl,
  token,
  ...(localSecret ? { localSecret } : {}),
  workerId,
  label,
  origin,
  runtimes,
  host: { hostname: hostname(), platform: platform(), arch: arch() },
  files,
  build,
  onUpdate,
  onLog: log,
  // 断线会自己重连；走到这里只有两种情况：token 被拒、被管理员断开、或者自己 close() 了。
  onClose: () => {
    log('连接关闭，退出');
    process.exit(0);
  }
});

/**
 * 由 server 拉起的本机 Worker 跟着 server 走：server 没了它也退出。
 * 否则它会一直重连，下一代 server 起来时又拉起一个——界面上就是两台「本机」。
 * 独立部署的 Worker（systemd、远程机器）不设这个变量，断了就重连。
 */
const parentPid = Number(env['HUB_PARENT_PID'] ?? 0);
if (parentPid > 0) {
  setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      log('server 进程已退出，跟着退出');
      void link.close().finally(() => process.exit(0));
    }
  }, 2_000).unref();
}

notifyAgentSessionRef = (sessionId, ref) => link.notifyAgentSessionRef(sessionId, ref);
notifyOptions = (sessionId, reported) => link.notifyOptions(sessionId, reported);

log(`已装 agent：${runtimes.map((runtime) => runtime.descriptor.label).join('、')}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void link.close().finally(() => process.exit(0));
  });
}
