import { spawn } from 'node:child_process';
import { basename, delimiter, dirname } from 'node:path';
import type { ComponentAction, ComponentJobResult, ComponentJobSpec, HarnessInstaller, InstallRun, RuntimeAction, RuntimeJobState, RuntimeProvision } from '@agent-hub/domain';
import { installBundle, installComponent, uninstallComponent } from './components.ts';
import type { RuntimeStore } from './runtime-store.ts';

/** hub 下发的一个任务（帧已过 schema 校验：agentId / version 是固定形状）。 */
export interface RuntimeJobCommand {
  readonly jobId: string;
  readonly agentId: string;
  readonly action: RuntimeAction | ComponentAction;
  readonly version: string | null;
  /** switch 的目标来源（install / uninstall 没有）。 */
  readonly source?: 'machine' | 'hub';
  readonly component?: ComponentJobSpec;
  readonly components?: readonly ComponentJobSpec[];
}

export interface RuntimeJobReport {
  readonly jobId: string;
  readonly state: RuntimeJobState;
  readonly message: string;
  readonly lines: string[];
  readonly version?: string | null;
  readonly component?: ComponentJobResult;
}

export interface RuntimeManager {
  /** 每个 agent 的来源与可否安装：随 agent 清单一起报给 hub。 */
  provisions(): ReadonlyMap<string, RuntimeProvision>;
  run(command: RuntimeJobCommand, report: (status: RuntimeJobReport) => void): Promise<void>;
}

export interface RuntimeManagerOptions {
  readonly store: RuntimeStore;
  readonly installers: readonly HarnessInstaller[];
  /** 每个 agent 在启动时是否已经由机器自己提供（X_COMMAND / PATH / 常见位置）。 */
  readonly machineProvided: ReadonlyMap<string, boolean>;
  /** 机器自带那份的版本（启动时探测一次）；null = 探测失败。 */
  readonly machineVersions?: ReadonlyMap<string, string | null>;
  /** 装好 / 卸掉之后：重新探测并报 agent 清单。 */
  readonly onChange?: () => void | Promise<void>;
  readonly timeoutMs?: number;
  /** 给安装命令的环境（白名单过滤前）；默认 process.env。 */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** 跑 `<shim> --version`；测试可换。返回输出，失败抛错。 */
  readonly version?: (file: string, env: Record<string, string>) => Promise<string>;
  /** hub 管理的组件（ADR 0021 P2）：根目录与 npm-cli.js。不给 = 不接组件任务。 */
  readonly components?: { readonly root: string; readonly npm: string | null };
}

/**
 * 安装命令只拿到最小的环境：PATH、HOME、语言、代理、npm 源。
 * Worker 进程里的 HUB_TOKEN 之类绝不能漏给第三方安装脚本（npm 包、官方脚本都会跑代码）。
 */
const ENV_ALLOW = /^(PATH|HOME|USER|LOGNAME|LANG|LC_[A-Z]+|TMPDIR|TZ|(HTTPS?|NO|ALL)_PROXY|(https?|no|all)_proxy|NPM_CONFIG_REGISTRY|npm_config_registry|NODE_EXTRA_CA_CERTS|SSL_CERT_(FILE|DIR))$/;

export function installEnv(source: Readonly<Record<string, string | undefined>>, node: string = process.execPath): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) if (value !== undefined && ENV_ALLOW.test(key)) env[key] = value;
  // npm 的 `#!/usr/bin/env node` 要找到和 Worker 同一个 node
  env['PATH'] = [dirname(node), ...(env['PATH'] ?? '/usr/bin:/bin').split(delimiter).filter(Boolean)].join(delimiter);
  env['SHELL'] = '/bin/sh';
  return env;
}

const MAX_LINE = 2000;

export function runCommand(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env: Record<string, string>; signal: AbortSignal; onLine: (line: string) => void }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'], signal: options.signal, killSignal: 'SIGKILL' });
    let last = '';
    let output = '';
    const feed = (stream: NodeJS.ReadableStream) => {
      let buffer = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        buffer += chunk;
        if (output.length < 64_000) output += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim() === '') continue;
          last = line.slice(0, MAX_LINE);
          options.onLine(last);
        }
        if (buffer.length > MAX_LINE) {
          options.onLine(buffer.slice(0, MAX_LINE));
          buffer = '';
        }
      });
      stream.on('end', () => {
        if (buffer.trim() !== '') options.onLine((last = buffer.slice(0, MAX_LINE)));
      });
    };
    feed(child.stdout);
    feed(child.stderr);
    child.on('error', (error) => reject(options.signal.aborted ? new Error('超时，已中止') : error));
    child.on('close', (code) => {
      if (options.signal.aborted) reject(new Error('超时，已中止'));
      else if (code === 0) resolve(output);
      else reject(new Error(`${basename(command)} 退出码 ${code}${last ? `：${last.slice(0, 200)}` : ''}`));
    });
  });
}

export async function createRuntimeManager(options: RuntimeManagerOptions): Promise<RuntimeManager> {
  const { store } = options;
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const byAgent = new Map(options.installers.map((installer) => [installer.agentId, installer]));
  // 能不能装只在启动时问一次（看平台、npm、curl）：provisions() 要同步给 agent 清单用
  const blockers = new Map<string, string | null>();
  for (const installer of options.installers) blockers.set(installer.agentId, await installer.blocker().catch(() => '检查安装条件失败'));
  let busy = false;

  const provisionOf = (agentId: string): RuntimeProvision => {
    const installer = byAgent.get(agentId);
    const hubVersion = store.installed(agentId);
    const machineVersion = options.machineVersions?.get(agentId) ?? null;
    const hasMachine = store.machinePath(agentId) !== null || options.machineProvided.get(agentId) === true;
    const preference = store.preference(agentId);
    // source 是当前实际生效的那份：用户选过就按选择，否则 hub 装了报 hub，再否则机器自带。
    const source =
      preference === 'machine' && hasMachine ? 'machine' : hubVersion ? 'hub' : hasMachine ? 'machine' : 'missing';
    const version = source === 'hub' ? hubVersion : source === 'machine' ? machineVersion : null;
    const blocker = blockers.get(agentId) ?? null;
    return {
      source,
      ...(version ? { version } : {}),
      ...(hasMachine && machineVersion ? { machineVersion } : {}),
      ...(hubVersion ? { hubVersion } : {}),
      ...(preference ? { preference } : {}),
      ...(installer ? { recommended: installer.recommendedVersion } : {}),
      // 装了 hub 的版本就不再用安装条件挡着：切换 / 卸载都还能做
      ...(!hubVersion && blocker ? { blocker } : {})
    };
  };

  const checkVersion =
    options.version ??
    ((file: string, env: Record<string, string>) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      return runCommand(file, ['--version'], { env, signal: controller.signal, onLine: () => undefined }).finally(() => clearTimeout(timer));
    });

  /** 组件任务：和运行时任务共用 busy（一台机器同时只跑一个安装任务）。 */
  async function runComponent(command: RuntimeJobCommand, report: (status: RuntimeJobReport) => void): Promise<void> {
    const bundle = command.components?.length ? command.components : null;
    const spec = command.component ?? bundle?.[0];
    const components = options.components;
    if (!spec || !components) return report({ jobId: command.jobId, state: 'refused', message: '这台 Worker 不支持安装组件', lines: [] });
    busy = true;
    const lines: string[] = [];
    let flushTimer: NodeJS.Timeout | null = null;
    const send = (state: RuntimeJobState, message: string, extra: Partial<RuntimeJobReport> = {}) => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      report({ jobId: command.jobId, state, message, lines: lines.splice(0), ...extra });
    };
    const log = (line: string) => {
      lines.push(line.slice(0, MAX_LINE));
      if (lines.length >= 200) send('running', '正在安装组件');
      else flushTimer ??= setTimeout(() => send('running', '正在安装组件'), 300);
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const env = installEnv(options.env ?? process.env);
      const outcome =
        command.action === 'uninstall_component'
          ? uninstallComponent({ root: components.root }, spec)
          : await (bundle ? (o: Parameters<typeof installComponent>[0]) => installBundle(o, bundle) : (o: Parameters<typeof installComponent>[0]) => installComponent(o, spec))(
              {
                root: components.root,
                node: process.execPath,
                npm: components.npm,
                env,
                log,
                run: async (file, args, runOptions) => {
                  await runCommand(file, args, { cwd: runOptions.cwd, env: runOptions.env, signal: controller.signal, onLine: log });
                }
              }
            );
      if (outcome.ok) await options.onChange?.();
      log(outcome.message);
      send(outcome.ok ? 'succeeded' : outcome.refused ? 'refused' : 'failed', outcome.message, {
        ...(outcome.ok ? { version: command.action === 'install_component' && !bundle ? spec.version : null } : {}),
        component: outcome.result
      });
    } catch (error) {
      send('failed', `安装出错：${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`);
    } finally {
      clearTimeout(timer);
      busy = false;
    }
  }

  return {
    provisions() {
      const ids = new Set([...options.machineProvided.keys(), ...byAgent.keys()]);
      return new Map([...ids].map((id) => [id, provisionOf(id)]));
    },
    async run(command, report) {
      const refuse = (message: string) => report({ jobId: command.jobId, state: 'refused', message, lines: [] });
      if (busy) return refuse('这台机器上已经有一个安装任务在跑');
      if (command.action === 'install_component' || command.action === 'uninstall_component') return runComponent(command, report);
      if (command.action === 'switch') {
        const source = command.source;
        if (source !== 'machine' && source !== 'hub') return refuse('切换要指明 source（machine 或 hub）');
        busy = true;
        try {
          if (source === 'hub') {
            const version = store.installed(command.agentId);
            if (!version) {
              report({ jobId: command.jobId, state: 'refused', message: 'hub 还没装这个 agent 的版本', lines: [] });
              return;
            }
            store.setPreference(command.agentId, 'hub');
            await options.onChange?.();
            report({ jobId: command.jobId, state: 'succeeded', message: `已切换到 hub 安装的 v${version}`, lines: [] });
            return;
          }
          if (!store.machinePath(command.agentId)) {
            report({ jobId: command.jobId, state: 'refused', message: '这台机器上没有自带的版本', lines: [] });
            return;
          }
          store.setPreference(command.agentId, 'machine');
          await options.onChange?.();
          report({ jobId: command.jobId, state: 'succeeded', message: '已切换到机器自带的版本', lines: [] });
        } finally {
          busy = false;
        }
        return;
      }
      const installer = byAgent.get(command.agentId);
      if (!installer) return refuse('这个 agent 不支持在线安装');
      busy = true;

      let pending: string[] = [];
      let flushTimer: NodeJS.Timeout | null = null;
      const flush = (state: RuntimeJobState, message: string, version?: string | null) => {
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = null;
        const lines = pending;
        pending = [];
        report({ jobId: command.jobId, state, message, lines, ...(version !== undefined ? { version } : {}) });
      };
      let progress = '';
      const log = (line: string) => {
        pending.push(line.slice(0, MAX_LINE));
        if (pending.length >= 200) flush('running', progress);
        else flushTimer ??= setTimeout(() => flush('running', progress), 300);
      };
      const step = (message: string) => {
        progress = message;
        log(`▸ ${message}`);
      };

      const env = installEnv(options.env ?? process.env);
      let staging: string | null = null;
      try {
        if (command.action === 'uninstall') {
          const version = store.installed(command.agentId);
          if (!version) {
            flush('refused', '这台机器上没有 hub 装的那份');
            return;
          }
          step(`删除 ${command.agentId} ${version}`);
          store.remove(command.agentId, installer.command);
          if (store.preference(command.agentId) === 'hub') store.setPreference(command.agentId, null);
          await options.onChange?.();
          flush('succeeded', `已卸载 ${version}`, null);
          return;
        }
        const version = command.version ?? installer.recommendedVersion;
        const blocker = blockers.get(command.agentId);
        if (blocker) {
          flush('refused', blocker);
          return;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        timer.unref?.();
        try {
          staging = store.stage(command.agentId, command.jobId);
          step(`安装 ${command.agentId} ${version}`);
          const run: InstallRun = {
            dir: staging,
            signal: controller.signal,
            log,
            run: async (file, args, runOptions) => {
              log(`$ ${basename(file)} ${args.join(' ')}`);
              const merged: Record<string, string> = { ...env };
              for (const [key, value] of Object.entries(runOptions?.env ?? {})) {
                if (value === undefined) delete merged[key];
                else merged[key] = value;
              }
              await runCommand(file, args, { ...(runOptions?.cwd ? { cwd: runOptions.cwd } : {}), env: merged, signal: controller.signal, onLine: log });
            }
          };
          const entry = await installer.install(version, run);
          step('校验版本');
          const output = await checkVersion(store.probeShim(staging, entry), env);
          if (!output.includes(version)) throw new Error(`装好的版本不对：${output.trim().slice(0, 120) || '没有输出'}`);
          log(output.trim().slice(0, 200));
          step('切换到新版本');
          store.commit(command.agentId, version, staging, entry, installer.command);
          staging = null;
        } finally {
          clearTimeout(timer);
        }
        await options.onChange?.();
        flush('succeeded', `已安装 ${version}`, version);
      } catch (error) {
        if (staging) store.discard(staging);
        const message = error instanceof Error ? error.message : String(error);
        log(message);
        flush('failed', `安装失败：${message.slice(0, 300)}`);
      } finally {
        busy = false;
      }
    }
  };
}
