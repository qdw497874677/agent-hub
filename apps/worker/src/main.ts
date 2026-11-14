import { randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { rewriteCredentialEnv } from './credential-env.ts';
import { arch, homedir, hostname, platform } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME_ADAPTERS } from './runtimes.ts';
import { findNpm } from '@agent-hub/adapter-pi';
import { clearBootMarker, readRollbackNote, clearRollbackNote, rollbackReport, collectInventory, connectWorkerLink, createTerminalHost, hubComponentDirs, createResourceProbe, createRuntimeManager, createRuntimeStore, defaultRuntimesRoot, createHarnessRegistry, runtimeSelfCheck, SELF_CHECK_PREFIX, createWorkerAssets, missingCommandHint, resolveCommand, withMissingHint, createWorkerFiles, defaultAssetsRoot, defaultGroupsDir, readBuildInfo, runSelfUpdate, runTarballUpdate, downloadHubArtifact, downloadHubBundle, hubHttpFrom, writeBootMarker, runReleaseUpdate, commitRelease, abortRelease, trialInProgress, defaultReleasesRoot, createPreviewClient } from '@agent-hub/node-gateway';
import type { UpdateReport } from '@agent-hub/node-gateway';
import type { AgentAlias, AgentRuntime, PreparedRuntime, RuntimeOption } from '@agent-hub/domain';
import { applyAgentAliases, readAgentAliases, type BuiltAliasHarness } from './agent-aliases.ts';

/**
 * worker 的组合根。单机安装时由 server 拉起（HUB_SPAWN_WORKER=1），
 * 也可以单独跑在有 agent 凭据的那台机器上——同一个入口、同一份代码。
 *
 * 它不知道任务、不知道画布、不知道权限：那些在 server 的内核里。
 */
const env = process.env;

const hubUrl = env['HUB_URL'] ?? 'ws://127.0.0.1:7878/worker';
const token = env['HUB_TOKEN'] ?? '';
// 单台机器接入换来的专属凭据（install-worker.sh 写进 worker.env）；同样不留给子进程。
const credential = env['HUB_WORKER_CREDENTIAL'] ?? '';
delete env['HUB_WORKER_CREDENTIAL'];
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

/** 预览通道和 `/worker` 同源：`ws(s)://host:port/worker` → `ws(s)://host:port/preview`（contract 的 PREVIEW_WS_PATH）。 */
function previewUrlFrom(workerUrl: string): string | null {
  try {
    const url = new URL(workerUrl);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;
    url.pathname = '/preview';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

/** 目录选择器的起点：`WORKER_ROOTS=/srv/code:/data`，默认 $HOME。 */
const roots = (env['WORKER_ROOTS'] ?? homedir())
  .split(':')
  .map((root) => root.trim())
  .filter((root) => root !== '')
  .map((root) => resolve(root));

/**
 * WORKER_ROOTS 是边界，不只是起点：hub 只能经这台 Worker 摸到 roots 里面的文件、
 * 只能在 roots 里开会话。远程 Worker 和 hub 自己拉起的本机 Worker 一律设防：
 * hub 上的成员不该借本机 Worker 翻遍整台机器。没配时默认只放开 $HOME。
 */
const files = createWorkerFiles({ roots, enforced: true });

/** hub 下发的技能与指令：只落在这台机器的专属目录（WORKER_ASSETS_DIR，默认 ~/.agent-hub/assets），不碰全局目录。 */
const assets = createWorkerAssets({ root: defaultAssetsRoot(env) });

/**
 * harness 命令在哪：X_COMMAND 点名的原样用，否则 PATH，再否则常见安装位置（resolveCommand）。
 * 找到的位置记进 runtime store（machine 文件），命令本身一律指向调度垫片——
 * 用户在 hub 机器页装了 / 切换了版本，下次开会话就生效，不用重启 Worker。
 * 在常见位置找到的，把那个目录补进本进程 PATH，子进程（含脚本里的 `#!/usr/bin/env node`）跟着找得到。
 * 找不到也照样写调度垫片：之后 hub 上装好就能用；就绪探测照常报「未安装」，再带一句怎么修。
 */
const runtimeStore = createRuntimeStore({ root: defaultRuntimesRoot(env) });
/** 启动时每个 agent 是不是机器自己提供的（用于上报，不再阻止 hub 安装另一份）。 */
const machineProvided = new Map<string, boolean>();
/** 启动时找到的机器自带可执行文件（绝对路径），用来探测版本。 */
const machineCommands = new Map<string, string>();

/** `resolveCommand` 的 path 分支只回命令名；调度垫片要绝对路径，这里在 PATH 里再找一次。 */
function executablePath(name: string): string | null {
  for (const dir of (env['PATH'] ?? '').split(delimiter).filter(Boolean)) {
    const file = join(dir, name);
    try {
      accessSync(file, constants.X_OK);
      return file;
    } catch {
      // 继续找
    }
  }
  return null;
}

function harnessCommand(name: string, envVar: string, agentId: string = name): { command: string; hint: string | null } {
  const found = resolveCommand(name, { explicit: env[envVar], path: env['PATH'], home: homedir(), env });
  // 垫片 / 调度目录用 **agentId** 而不是命令：自定义别名的 command 可以是绝对路径（`/opt/foo/bar`），
  // 而 runtime store 只接受安全段名。内置 agent 两者同名，行为不变。
  const target = runtimeStore.shimPath(agentId);
  if (found.source === 'missing') {
    machineProvided.set(agentId, false);
    runtimeStore.setMachine(agentId, null);
    runtimeStore.writeDispatch(agentId, agentId);
    // 机器上没有：指向调度垫片。现在装没装都行——装好后探测立刻认得，不用重启 Worker
    return { command: target, hint: runtimeStore.installed(agentId) ? null : missingCommandHint(name, envVar) };
  }
  if (found.source === 'fallback') {
    env['PATH'] = [found.dir, ...(env['PATH'] ?? '').split(delimiter).filter(Boolean)].join(delimiter);
    process.stdout.write(`[worker] PATH 里没有 ${name}，用 ${found.command}（已把 ${found.dir} 补进 PATH；可设 ${envVar} 固定）\n`);
  }
  const absolute = found.source === 'fallback' ? found.command : found.command.startsWith('/') ? found.command : (executablePath(found.command) ?? found.command);
  machineProvided.set(agentId, true);
  machineCommands.set(agentId, absolute);
  runtimeStore.setMachine(agentId, absolute);
  runtimeStore.writeDispatch(agentId, agentId);
  return { command: target, hint: null };
}
const log = (message: string): void => {
  process.stdout.write(`[worker] ${message}\n`);
};
/** ADR 0027 D10：新建 worktree 放哪（WORKER_WORKTREES_DIR），默认仓库旁 `.worktrees/`。必须在 WORKER_ROOTS 里面，否则忽略。 */
const worktreesDirEnv = env['WORKER_WORKTREES_DIR']?.trim();
const worktreesDirRaw = worktreesDirEnv ? resolve(worktreesDirEnv.startsWith('~/') ? join(homedir(), worktreesDirEnv.slice(2)) : worktreesDirEnv) : undefined;
const worktreesDir = worktreesDirRaw && roots.some((root) => worktreesDirRaw === root || worktreesDirRaw.startsWith(`${root}/`)) ? worktreesDirRaw : undefined;
log(`允许访问的目录（WORKER_ROOTS${env['WORKER_ROOTS'] === undefined ? '，未配置，默认 $HOME' : ''}）：${roots.join(':')}`);
if (worktreesDirRaw && !worktreesDir) log(`WORKER_WORKTREES_DIR=${worktreesDirRaw} 不在 WORKER_ROOTS 里，忽略；新建 worktree 仍放在仓库旁 .worktrees/`);
else log(`新建 worktree 放在：${worktreesDir ? `${worktreesDir}/<仓库名>/<目录名>（WORKER_WORKTREES_DIR）` : '仓库旁 .worktrees/<仓库名>/<目录名>（默认，可设 WORKER_WORKTREES_DIR）'}`);

/**
 * 组合工作空间（docs/design/multi-repo.md §12.5）：容器目录与成员 worktree 只允许落在这下面。
 * 默认 `<WORKER_ROOTS 第一个>/agent-hub-groups`；显式配置的必须在某个 root 里面，否则回落默认并警告。
 */
const groupsDirEnv = env['WORKER_GROUPS_DIR']?.trim();
const groupsDirRaw = groupsDirEnv ? resolve(groupsDirEnv.startsWith('~/') ? join(homedir(), groupsDirEnv.slice(2)) : groupsDirEnv) : undefined;
/** 严格在 root 里面（等于 root 不算：容器不能就是 root 本身）。 */
const underRoots = (path: string): boolean => roots.some((root) => path !== root && path.startsWith(`${root}/`));
const groupsDir = groupsDirRaw && underRoots(groupsDirRaw) ? groupsDirRaw : defaultGroupsDir(roots);
if (groupsDirRaw && groupsDir !== groupsDirRaw) log(`警告：WORKER_GROUPS_DIR=${groupsDirRaw} 不在 WORKER_ROOTS 里，回落到 ${groupsDir}`);
else log(`组合工作空间目录：${groupsDir}${groupsDirRaw ? '（WORKER_GROUPS_DIR）' : '（默认，可设 WORKER_GROUPS_DIR）'}`);

// 先接住 adapter 的回调，等 link 就绪后转给它——adapter 在构造时就要拿到这个函数。
let notifyAgentSessionRef: (sessionId: string, ref: string) => void = () => undefined;
let notifyOptions: (sessionId: string, options: readonly RuntimeOption[]) => void = () => undefined;
let notifyTurnRef: (sessionId: string, turnRef: string) => void = () => undefined;

/**
 * stdio MCP 垫片：和 worker 同一个 node、同样的启动参数（.ts 直接跑），
 * 给 Pi、以及不会 HTTP MCP 的 ACP agent 用；它连的是本机 MCP 入口，最终都经长连接到 hub。
 */
const toolShim = {
  command: process.execPath,
  args: [...process.execArgv, join(dirname(fileURLToPath(import.meta.url)), 'mcp-shim.ts')]
};

// hub 管理的组件（ADR 0021 P2）：WORKER_COMPONENTS=0 关掉（不接组件任务、也不加载）。
const componentsRoot = join(runtimeStore.root, 'components');
const componentsEnabled = env['WORKER_COMPONENTS'] !== '0';

/** 自更新标记所在目录（和 worker-id 同一处）；hub 下发的 agents.json 也放这里。 */
const stateDir = env['WORKER_STATE_DIR'] ?? join(homedir(), '.config', 'agent-hub');
/** hub 存过的自定义运行时别名（CAP-1）：文件不存在 = 从没配过，走 ACP_AGENTS。 */
const agentsFile = join(stateDir, 'agents.json');
const storedAliases = readAgentAliases(agentsFile, log);

/**
 * 统一运行时适配器（ADR 0013 D8）：组合根只遍历注册表，不认得具体 agent。
 * `aliasConfig` 非空时覆盖 ACP_AGENTS（别名来自 hub）；null = 用本机 env。
 * 热应用时重新调它：新 runtime 换进 runtimes 数组，正在跑的会话仍拿着旧的。
 */
async function buildHarness(
  aliasConfig: readonly AgentAlias[] | null
): Promise<BuiltAliasHarness & { readonly prepared: readonly PreparedRuntime[] }> {
  const prepared: PreparedRuntime[] = [];
  for (const adapter of RUNTIME_ADAPTERS) {
    prepared.push(
      ...(await adapter.prepare({
        env,
        home: homedir(),
        toolShim,
        command: harnessCommand,
        log,
        onAgentSessionRef: (sessionId, ref) => notifyAgentSessionRef(sessionId, ref),
        onOptions: (sessionId, reported) => notifyOptions(sessionId, reported),
        onTurnRef: (sessionId, turnRef) => notifyTurnRef(sessionId, turnRef),
        ...(componentsEnabled ? { components: (runtime: string) => hubComponentDirs(componentsRoot, runtime) } : {}),
        ...(aliasConfig && aliasConfig.length > 0 ? { aliases: aliasConfig } : {})
      }))
    );
  }
  return {
    prepared,
    runtimes: prepared.map((entry) => entry.runtime),
    probes: prepared.map((entry) => withMissingHint(entry.readiness, entry.hint)),
    // 启动后的模型自检（WORKER_MODEL_CHECK=0 关掉）：每个进程一次、后台跑、有超时，结果显示在控制台
    selfChecks:
      env['WORKER_MODEL_CHECK'] === '0'
        ? []
        : prepared
            // 一台机器都没装（hint 非空 = 调度垫片后面既没有 hub 版本也没有机器自带）就没什么可自检的：
            // 现在跑只会拿到垫片的 127，日志里变成「检测失败（退出码 127）」，不如老实地报未安装。
            .filter((entry) => entry.selfCheck === true && entry.hint === null)
            .map((entry) => runtimeSelfCheck(entry.runtime, { timeoutMs: Number(env['WORKER_MODEL_CHECK_TIMEOUT_MS'] ?? '') || 45_000 })),
    summaries: prepared.map((entry) => entry.summary)
  };
}

let initial: BuiltAliasHarness & { readonly prepared: readonly PreparedRuntime[] };
try {
  initial = await buildHarness(storedAliases);
} catch (error) {
  // 落盘的别名把 harness 建挂了（例如命令解析出意外）：扔掉它、用 ACP_AGENTS 起步，别让 worker 起不来
  log(`按落盘的运行时别名建 harness 失败：${error instanceof Error ? error.message : String(error)}；改用 ACP_AGENTS`);
  initial = await buildHarness(null);
}
const prepared = initial.prepared;
/** 可变数组：热应用时就地 splice，link 里的 find / map 立刻看到新内容；正在跑的会话不受影响。 */
const runtimes: AgentRuntime[] = [...initial.runtimes];
/**
 * 机器自带那份的版本：启动时各探测一次，给 hub 的机器页显示（现在一律 unknown 的那种）。
 * 探测失败 / 超时 / 版本号认不出都记 null —— 绝不能让 Worker 起不来。
 */
const machineVersions = new Map<string, string | null>();
for (const [agentId, command] of machineCommands) {
  try {
    const probe = spawnSync(command, ['--version'], { timeout: 3000, encoding: 'utf8' });
    const text = `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`;
    machineVersions.set(agentId, text.match(/\d+\.\d+\.\d+/)?.[0] ?? null);
  } catch {
    machineVersions.set(agentId, null);
  }
}
// 启动后的模型自检由 buildHarness 一起算好；换别名时 replace 会清掉旧结果
const readiness = createHarnessRegistry(initial.probes, { selfChecks: initial.selfChecks });
const probeIntervalMs = Number(env['HARNESS_PROBE_INTERVAL_MS'] ?? '') || undefined;
for (const entry of prepared) log(entry.summary);

/** 连上 hub 后稳定这么久，才算新版本健康。 */
const HEALTHY_AFTER_MS = 15_000;
let healthTimer: NodeJS.Timeout | null = null;
function markHealthySoon(): void {
  if (healthTimer) return;
  healthTimer = setTimeout(() => {
    if (clearBootMarker(stateDir)) log(`新版本 ${build.commit?.slice(0, 7) ?? ''} 启动正常，已确认更新`);
  }, HEALTHY_AFTER_MS);
  healthTimer.unref();
}

/** 代码所在的仓库：远程更新就在这里 git fetch / npm ci。 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const build = readBuildInfo(repoRoot);
log(`版本 ${build.version}（${build.commit ? build.commit.slice(0, 7) : '非 git 仓库'}，协议 v${build.protocol}）`);

/**
 * 更新方式（ADR 0030 D2）：HUB_WORKER_UPDATE_MODE=releases 用 releases/<sha> + current/previous + 试运行；
 * 默认 legacy（原地 git / 解压）。releases 要求代码是 git 检出（staging 从它克隆）。
 */
const releasesMode = env['HUB_WORKER_UPDATE_MODE'] === 'releases' && origin === 'remote' && existsSync(join(repoRoot, '.git'));
const releasesRoot = env['WORKER_RELEASES_DIR']?.trim() || defaultReleasesRoot(homedir());
const trial = releasesMode ? trialInProgress(releasesRoot, repoRoot) : null;
if (env['HUB_WORKER_UPDATE_MODE'] === 'releases') log(releasesMode ? `更新方式：releases（${releasesRoot}）${trial ? `，正在试运行 ${trial.target.slice(0, 7)}` : ''}` : '更新方式：要求 releases 但代码不是 git 检出（或是本机 Worker），仍按 legacy');

/** 被 hub 拒绝时的退出码（EX_CONFIG）：重启也没用，要重新接入。 */
const REJECTED_EXIT_CODE = 78;

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
  const hubHttp = hubHttpFrom(hubUrl);
  const progress = (status: UpdateReport): void => {
    log(`更新：${status.message}`);
    report(status);
  };
  // 没有 git（用 hub 的 tar 包装的）：整包解到新目录再换上；有 git：走 bundle / git fetch
  let changed: boolean;
  if (releasesMode) {
    // ADR 0030 D2：装到 releases/<sha>，换 current，重启后试运行；hub 观察通过才提交
    if (!build.commit) {
      report({ state: 'refused', message: '读不到当前提交号，没法用 releases 布局更新', logTail: '' });
      return;
    }
    const swapped = await runReleaseUpdate({
      root: releasesRoot,
      runningDir: repoRoot,
      runningCommit: build.commit,
      commit,
      ...(hubHttp ? { fetchBundle: (target: string) => downloadHubBundle({ hubHttp, commit: target, dir: join(stateDir, 'update-cache') }) } : {}),
      report: progress
    });
    if (swapped) setTimeout(() => void link.close().finally(() => process.exit(RESTART_EXIT_CODE)), 500);
    return;
  }
  if (!existsSync(join(repoRoot, '.git'))) {
    if (!hubHttp) {
      report({ state: 'refused', message: '解压安装的 Worker 要从 hub 下代码包，但 HUB_URL 推不出 hub 的 http 地址', logTail: '' });
      return;
    }
    changed = await runTarballUpdate({
      repoDir: repoRoot,
      commit,
      fetchTarball: (target) => downloadHubArtifact({ hubHttp, commit: target, dir: join(stateDir, 'update-cache'), kind: 'tar.gz' }),
      report: progress
    });
  } else {
    changed = await runSelfUpdate({
      repoDir: repoRoot,
      commit,
      // 先从 hub 取代码（不依赖 GitHub），拿不到再 git fetch origin
      ...(hubHttp ? { fetchBundle: (target: string) => downloadHubBundle({ hubHttp, commit: target, dir: join(stateDir, 'update-cache') }) } : {}),
      report: progress
    });
  }
  if (changed) {
    // 待验证标记：新版本健康后自己删；起不来的话 scripts/worker-boot-guard.sh 会回滚到原提交。
    if (build.commit) writeBootMarker(stateDir, build.commit, commit);
    // 给最后一帧进度一点时间发出去，再退出重启
    setTimeout(() => void link.close().finally(() => process.exit(RESTART_EXIT_CODE)), 500);
  }
}

// 只给我们认得怎么装的那几个；ACP_AGENTS 里自定义的 agent 不在线安装
const provisioner = await createRuntimeManager({
  store: runtimeStore,
  installers: prepared.flatMap((entry) => (entry.installer && machineProvided.has(entry.installer.agentId) ? [entry.installer] : [])),
  machineProvided,
  machineVersions,
  ...(componentsEnabled ? { components: { root: componentsRoot, npm: findNpm(process.execPath) } } : {})
});

// 机器资源上报（ADR 0014）：默认开，WORKER_METRICS=0 关掉；hub 不认识就不发
const metricsIntervalMs = Number(env['WORKER_METRICS_INTERVAL_MS'] ?? 0) || undefined;
const resources = env['WORKER_METRICS'] === '0' ? undefined : createResourceProbe({ roots: files.roots });

// 套件清单（ADR 0021 §7）：只读采集；WORKER_INVENTORY=0 关掉。pi 目录和 pi 自己一样认 PI_CODING_AGENT_DIR。
const piDirEnv = env['PI_CODING_AGENT_DIR']?.trim();
const piDir = piDirEnv ? resolve(piDirEnv.startsWith('~/') ? join(homedir(), piDirEnv.slice(2)) : piDirEnv) : join(homedir(), '.pi', 'agent');
const inventory =
  env['WORKER_INVENTORY'] === '0'
    ? undefined
    : () => collectInventory({ provisions: provisioner.provisions(), componentsRoot, piAgentDir: piDir, componentInstall: componentsEnabled });

/**
 * 会话终端（docs/design/terminal.md）：在这台机器上开 PTY，cwd 就是会话的工作目录（由 link 的 workspaces 决定）。
 * 没装 node-pty 时 createTerminalHost 回 null，worker 照常启动，hub 上不显示终端页签。
 * 回调经 link 回传，所以这里先建 host、link 建好之后再接上（闭包，调用时 link 已存在）。
 */
const terminalShell = (): string => {
  const configured = env['TERMINAL_SHELL']?.trim();
  if (configured) return configured;
  const fromEnv = env['SHELL']?.trim();
  return fromEnv && existsSync(fromEnv) ? fromEnv : '/bin/bash';
};
/** TERMINAL_MAX / TERMINAL_LINGER_MS：非正整数一律忽略，用宿主默认值。 */
const positiveInt = (raw: string | undefined): number | undefined => {
  const value = Number(raw ?? '');
  return Number.isInteger(value) && value > 0 ? value : undefined;
};
const terminalMax = positiveInt(env['TERMINAL_MAX']);
const terminalLingerMs = positiveInt(env['TERMINAL_LINGER_MS']);
const terminal = createTerminalHost({
  shell: terminalShell(),
  ...(terminalMax !== undefined ? { max: terminalMax } : {}),
  ...(terminalLingerMs !== undefined ? { lingerMs: terminalLingerMs } : {}),
  check: (path) => files.check(path),
  backpressure: () => link.bufferedAmount(),
  cwdOf: (sessionId) => link.workspaceOf(sessionId),
  onData: (terminalId, chunk) => link.sendTerminalData(terminalId, chunk),
  onExit: (terminalId, code, signal) => link.sendTerminalExit(terminalId, code, signal),
  // 终端输出旁路一份给预览通道：只有在 /proc 里真的 LISTEN 的端口才会被提议。
  onOutput: (sessionId, text) => link.forwardTerminalOutput(sessionId, text),
  log
});

const link = connectWorkerLink({
  ...(inventory ? { inventory } : {}),
  url: hubUrl,
  token,
  ...(localSecret ? { localSecret } : {}),
  ...(credential ? { credential } : {}),
  // 轮换（ADR 0030 D3）：新凭据写回 worker.env（tmp + fsync + rename），找不到那一行就不换
  onCredentialRotate: async (next) => rewriteCredentialEnv(env['WORKER_ENV_FILE'] ?? join(env['WORKER_STATE_DIR'] ?? join(homedir(), '.config', 'agent-hub'), 'worker.env'), next),
  workerId,
  label,
  origin,
  runtimes,
  readiness,
  /**
   * 自定义运行时别名热应用（CAP-1）：hub 保存后推一帧下来。重建失败就保持旧的、只记日志；
   * 成功则就地替换 runtimes 与就绪探测——新建会话用新别名，正在跑的会话不受影响。
   */
  onAgentConfig: (aliases) => {
    void applyAgentAliases(aliases, {
      stateFile: agentsFile,
      rebuild: buildHarness,
      replaceRuntimes: (next) => {
        runtimes.splice(0, runtimes.length, ...next);
      },
      replaceProbes: (probes, selfChecks) => readiness.replace(probes, selfChecks),
      log
    }).then((applied) => {
      // 换完之后把新清单报一次：hub 的机器页与模型选择器不能还停在旧的那套 agent 上。
      if (applied) link.reportInventory();
    });
  },
  ...(probeIntervalMs !== undefined ? { probeIntervalMs } : {}),
  host: { hostname: hostname(), platform: platform(), arch: arch() },
  files,
  ...(worktreesDir ? { worktreesDir } : {}),
  groupsDir,
  assets,
  ...(terminal ? { terminal } : {}),
  /**
   * 终端输出里认出的端口 → 预览通道（P2 端口发现）。preview 在下面才建，
   * 这个回调只在会话真的开终端后才被调用，那时 preview 已经就绪。
   */
  onTerminalOutput: (sessionId, text) => preview?.detect(sessionId, text),
  build,
  onUpdate,
  provisioner,
  ...(resources ? { resources } : {}),
  ...(metricsIntervalMs ? { metricsIntervalMs } : {}),
  onAccepted: markHealthySoon,
  ...(trial
    ? {
        trialUpdate: () => (trialInProgress(releasesRoot, repoRoot) ? { id: trial.id, inventory: inventory !== undefined } : null),
        onUpdateCommit: (id: string) => {
          if (commitRelease(releasesRoot, id)) log(`试运行通过：${trial.target.slice(0, 7)} 已提交`);
        },
        onUpdateAbort: (id: string, reason: string) => {
          if (!abortRelease(releasesRoot, stateDir, id, reason)) return;
          log(`试运行没通过（${reason}）：已把 current 切回 ${trial.previous.slice(0, 7)}，重启`);
          setTimeout(() => void link.close().finally(() => process.exit(RESTART_EXIT_CODE)), 200);
        }
      }
    : {}),
  pendingUpdateReport: () => {
    const note = readRollbackNote(stateDir);
    if (!note) return null;
    log(`补报：新版本 ${note.failed.slice(0, 7)} 起不来，已回退到 ${note.restored.slice(0, 7)}`);
    return { report: rollbackReport(note), done: () => clearRollbackNote(stateDir) };
  },
  onLog: log,
  // 断线会自己重连；走到这里只有两种情况：token 被拒、被管理员断开、或者自己 close() 了。
  onClose: (why) => {
    log('连接关闭，退出');
    // 被 hub 拒绝（凭据无效 / 已吊销）：用专门的退出码，systemd unit 据此不再拉起（RestartPreventExitStatus）。
    process.exit(why?.code === 4401 ? REJECTED_EXIT_CODE : 0);
  }
});

/**
 * 预览通道（docs/design/preview.md §6）：浏览器的请求经 hub 转发到这台机器的回环端口。
 * 单独一条 WS，和 `/worker` 用同一份凭据；连不上 / 断了只记日志，预览不可用不影响 agent。
 * HUB_PREVIEW=0 整条关掉。
 */
const previewUrl = previewUrlFrom(hubUrl);
const preview =
  env['HUB_PREVIEW'] === '0' || previewUrl === null
    ? null
    : createPreviewClient({
        url: previewUrl,
        credential: credential !== '' ? credential : null,
        ...(localSecret ? { localSecret } : {}),
        workerId,
        onLog: (message) => log(`[preview] ${message}`)
      });
if (env['HUB_PREVIEW'] === '0') log('预览通道已关闭（HUB_PREVIEW=0）');
else if (previewUrl === null) log(`预览通道未启动：HUB_URL=${hubUrl} 不是 ws(s):// 地址`);
else {
  try {
    preview?.start();
  } catch (error) {
    log(`预览通道启动失败（不影响 agent）：${error instanceof Error ? error.message : String(error)}`);
  }
}

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

// 自检会话不是 hub 的会话，不往上报
notifyAgentSessionRef = (sessionId, ref) => {
  if (!sessionId.startsWith(SELF_CHECK_PREFIX)) link.notifyAgentSessionRef(sessionId, ref);
};
notifyTurnRef = (sessionId, turnRef) => {
  if (!sessionId.startsWith(SELF_CHECK_PREFIX)) link.notifyTurnRef(sessionId, turnRef);
};
notifyOptions = (sessionId, reported) => {
  if (!sessionId.startsWith(SELF_CHECK_PREFIX)) link.notifyOptions(sessionId, reported);
};

log(`已装 agent：${runtimes.map((runtime) => runtime.descriptor.label).join('、')}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void preview?.stop();
    void link.close().finally(() => process.exit(0));
  });
}
