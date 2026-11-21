import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { BUILTIN_CHROMIUM, trustedAcquisitionStrategies, type AcquisitionResolution, type ComponentJobResult, type ComponentJobSpec } from '@agent-hub/domain';
import { acquisitionJobResult, runAcquisitionStrategies, type AcquireHooks } from './acquire.ts';

/**
 * hub 管理的组件安装（ADR 0021 P2）。目录布局（inventory.ts 读同一份）：
 *   <root>/<runtime>/<id>/current → v-<uuid>（相对符号链接）
 *   <root>/<runtime>/<id>/v-<uuid>/{package.json, package-lock.json, node_modules/<pkg>, .component.json}
 * 借鉴 paseo（packages/server/src/server/plugins/managed-source/npm.ts）：
 * - 包一层只有一个依赖的 package.json，在 UUID 暂存目录里 `npm install`，成功后才改名切换；
 * - 装完对着锁文件 `node_modules/<pkg>` 那一项核对版本和 integrity（审的就是装的）；
 * - 期望当前版本（compare-and-swap）：和机器上的对不上就拒绝；
 * - 路径一律 realpath 后检查不越出组件根目录。
 * - 一律 `--ignore-scripts`（ADR 0021 决定 8，2026-10-31 改为跟 paseo 一致）：组件及其依赖的安装脚本都不执行，
 *   只把声明了的脚本列出来回报给 hub（审计 + 提示「可能用不了」）。没有例外路径，所以 root 跑的 Worker 也能装。
 */
export interface ComponentInstallOptions {
  readonly root: string;
  readonly node: string;
  /** npm-cli.js（和 Worker 同一个 node 配套）；null = 没法装。 */
  readonly npm: string | null;
  /** 真正跑命令（runtime-jobs 的 runCommand，带超时和日志）；成功时返回完整输出（核对用）。 */
  readonly run: (file: string, args: readonly string[], options: { cwd: string; env: Record<string, string> }) => Promise<string>;
  readonly env: Record<string, string>;
  readonly log: (line: string) => void;
  readonly now?: () => number;
  /**
   * 获取策略钩子：测试注入假路径 / 关掉策略里的默认系统路径，避免碰到真实二进制或用户缓存。
   * 生产不传：按目录项声明的 names/paths + PATH 探测，缓存目录按策略 locate。
   */
  readonly acquire?: Omit<AcquireHooks, 'env' | 'run' | 'log'>;
}

export interface ComponentOutcome {
  readonly ok: boolean;
  readonly refused?: boolean;
  readonly message: string;
  readonly result: ComponentJobResult;
}

const VERSION_DIR = /^v-[0-9a-f-]{36}$/;

export function currentVersionDir(root: string, runtime: string, id: string): string | null {
  try {
    const link = readlinkSync(join(root, runtime, id, 'current'));
    return VERSION_DIR.test(link) ? link : null;
  } catch {
    return null;
  }
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function installedVersion(root: string, runtime: string, id: string): string | null {
  const dir = currentVersionDir(root, runtime, id);
  if (!dir) return null;
  const meta = readJson(join(root, runtime, id, dir, '.component.json'));
  return typeof meta?.['version'] === 'string' ? meta['version'] : null;
}

function inside(root: string, path: string): boolean {
  const base = realpathSync(root);
  return path === base || path.startsWith(base + sep);
}

/** 这次装进来的树里，哪些包带安装脚本（审计用）：锁文件标了 hasInstallScript 的，再读它自己的 package.json。 */
function scriptsInTree(dir: string, lock: Record<string, unknown>): { package: string; script: string }[] {
  const packages = (lock['packages'] ?? {}) as Record<string, Record<string, unknown>>;
  const out: { package: string; script: string }[] = [];
  for (const [path, entry] of Object.entries(packages)) {
    if (!path.startsWith('node_modules/') || entry['hasInstallScript'] !== true) continue;
    const pkg = readJson(join(dir, path, 'package.json'));
    const name = typeof pkg?.['name'] === 'string' ? pkg['name'] : path.slice('node_modules/'.length);
    const scripts = (pkg?.['scripts'] ?? {}) as Record<string, unknown>;
    const names = ['preinstall', 'install', 'postinstall'].filter((s) => typeof scripts[s] === 'string');
    for (const script of names.length ? names : ['install']) out.push({ package: name.slice(0, 214), script });
    if (out.length >= 200) break;
  }
  return out;
}

interface Staged {
  readonly spec: ComponentJobSpec;
  readonly base: string;
  readonly staging: string;
  readonly previous: string | null;
  readonly scripts: { package: string; script: string }[];
  readonly acquisition?: AcquisitionResolution;
}

type StageResult = { ok: true; staged: Staged } | { ok: false; outcome: ComponentOutcome };

/** 装进暂存目录并核对（不切换）。失败时暂存已删。 */
async function stageComponent(options: ComponentInstallOptions, spec: ComponentJobSpec, elapsed: () => number): Promise<StageResult> {
  const base = join(options.root, spec.runtime, spec.componentId);
  const current = installedVersion(options.root, spec.runtime, spec.componentId);
  const previous = currentVersionDir(options.root, spec.runtime, spec.componentId);
  const refuse = (message: string): StageResult => ({ ok: false, outcome: { ok: false, refused: true, message, result: { durationMs: elapsed() } } });
  if (current !== spec.expectedCurrent) return refuse(`${spec.componentId}：机器上的版本（${current ?? '没装'}）和 hub 以为的（${spec.expectedCurrent ?? '没装'}）不一致，先刷新再试`);
  // 执行策略只认内置清单：wire / 旧任务里带来的自定义步骤一律拒绝，绝不执行。
  const trusted = trustedAcquisitionStrategies(spec.componentId, spec.version, spec.strategies, {
    packageName: spec.packageName,
    integrity: spec.integrity,
    source: spec.git ? 'git' : 'npm'
  });
  if (!trusted.ok) return refuse(trusted.error.message);
  const strategies = trusted.value;
  if (!options.npm) return refuse('这台机器的 Node 旁边没有 npm，没法装组件');
  if (spec.git && spec.integrity !== `git:${spec.git.commit}`) return refuse('git 来源的完整性标识不对');

  mkdirSync(base, { recursive: true });
  const staging = join(base, `.staging-${randomUUID()}`);
  let scripts: { package: string; script: string }[] = [];
  try {
    mkdirSync(staging);
    // git 来源（P4）：git+https://…#<40 位提交号>，npm 只拉这个提交
    const dependency = spec.git ? `git+${spec.git.url}#${spec.git.commit}` : spec.version;
    writeFileSync(
      join(staging, 'package.json'),
      `${JSON.stringify({ name: `agent-hub-component-${spec.componentId}`, private: true, dependencies: { [spec.packageName]: dependency } }, null, 2)}\n`
    );
    // npm 缓存和 HOME 都放进暂存目录：不读写 Worker 用户的 ~/.npmrc / 缓存，装完一起删
    const env = { ...options.env, HOME: staging, npm_config_cache: join(staging, '.npm-cache'), npm_config_userconfig: join(staging, '.npmrc'), GIT_TERMINAL_PROMPT: '0' };
    const args = [options.npm, 'install', '--no-audit', '--no-fund', '--omit=dev', '--package-lock=true', '--ignore-scripts'];
    options.log(`$ npm ${args.slice(1).join(' ')}（${spec.packageName}@${spec.git ? `${spec.git.url}#${spec.git.commit.slice(0, 12)}` : spec.version}）`);
    await options.run(options.node, args, { cwd: staging, env });

    const lock = readJson(join(staging, 'package-lock.json'));
    const entry = ((lock?.['packages'] ?? {}) as Record<string, Record<string, unknown>>)[`node_modules/${spec.packageName}`];
    if (!lock || !entry) throw new Error('锁文件里没有这个包');
    if (entry['version'] !== spec.version) throw new Error(`装上的版本 ${String(entry['version'])} 不是 ${spec.version}`);
    if (spec.git) {
      // git 依赖没有 sha512：核对锁文件钉住的就是审核时那个提交
      const resolved = typeof entry['resolved'] === 'string' ? entry['resolved'] : '';
      if (!resolved.endsWith(`#${spec.git.commit}`)) {
        rmSync(staging, { recursive: true, force: true });
        return { ok: false, outcome: { ok: false, message: `${spec.componentId}：装上的提交和审核时钉住的不一致，已丢弃，没有切换版本`, result: { integrity: resolved.slice(-60), integrityMismatch: true, durationMs: elapsed() } } };
      }
    } else {
      const integrity = typeof entry['integrity'] === 'string' ? entry['integrity'] : '';
      if (integrity !== spec.integrity) {
        rmSync(staging, { recursive: true, force: true });
        return { ok: false, outcome: { ok: false, message: `${spec.componentId}：制品哈希和审核时钉住的不一致，已丢弃，没有切换版本`, result: { integrity: integrity.slice(0, 200), integrityMismatch: true, durationMs: elapsed() } } };
      }
      if (typeof entry['resolved'] === 'string' && entry['resolved'] !== spec.resolved) options.log(`提示：下载地址是 ${entry['resolved'].slice(0, 200)}（镜像源），哈希一致`);
    }
    const pkgDir = join(staging, 'node_modules', spec.packageName);
    const pkg = readJson(join(pkgDir, 'package.json'));
    if (pkg?.['name'] !== spec.packageName || pkg?.['version'] !== spec.version) throw new Error('装出来的 package.json 对不上');
    const pkgReal = realpathSync(pkgDir);
    if (!inside(staging, pkgReal)) throw new Error('包目录越出了暂存目录');
    // 没执行的安装脚本：只是列出来（hub 记审计、提示可能用不了）
    scripts = scriptsInTree(staging, lock);
    if (scripts.length) options.log(`提示：${scripts.map((s) => `${s.package} ${s.script}`).join('、')} 声明了安装脚本，没有执行；依赖它的组件可能用不了`);
    // 目录项如果声明了获取策略：在已核对的包上按顺序执行（系统二进制 / 用户空间安装 / 轻量退路 / 要 root）。
    let acquisition: AcquisitionResolution | undefined;
    if (strategies?.length) {
      const hooks: AcquireHooks = {
        env: { ...options.env },
        run: options.run,
        log: options.log,
        ...(options.acquire ?? {})
      };
      const capability = spec.provides[0]?.capability;
      const resolved = await runAcquisitionStrategies({
        hooks,
        strategies: strategies ?? [],
        componentId: spec.componentId,
        capability,
        cwd: staging,
        install: async (args) => {
          const cli = join(pkgDir, 'cli.js');
          let cliReal: string;
          try {
            cliReal = realpathSync(cli);
          } catch {
            throw new Error('组件包里没有可用的 cli.js');
          }
          if (!statSync(cliReal).isFile()) throw new Error('cli.js 不是常规文件');
          if (!inside(pkgReal, cliReal) && cliReal !== pkgReal) throw new Error('cli.js 越出了组件包目录');
          await options.run(options.node, [cliReal, ...args], { cwd: staging, env: { ...options.env } });
        }
      });
      if (!resolved.ok) {
        rmSync(staging, { recursive: true, force: true });
        options.log(resolved.message);
        return {
          ok: false,
          outcome: {
            ok: false,
            message: resolved.message,
            result: acquisitionJobResult(resolved, { exitCode: 0, durationMs: elapsed() })
          }
        };
      }
      acquisition = resolved.acquisition;
      options.log(resolved.message);
    }
    rmSync(join(staging, '.npm-cache'), { recursive: true, force: true });
    writeFileSync(
      join(staging, '.component.json'),
      `${JSON.stringify({ id: spec.componentId, version: spec.version, packageName: spec.packageName, integrity: spec.integrity, enabled: true, provides: spec.provides, ...(acquisition ? { acquisition } : {}), ...(spec.git ? { source: `git:${spec.git.url}` } : {}), installedAt: Date.now() }, null, 2)}\n`
    );
    return { ok: true, staged: { spec, base, staging, previous, scripts, ...(acquisition ? { acquisition } : {}) } };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    const message = error instanceof Error ? error.message : String(error);
    const code = /退出码 (\d+)/.exec(message);
    return { ok: false, outcome: { ok: false, message: `安装失败（${spec.componentId}）：${message.slice(0, 300)}`, result: { ignoredScripts: true, scripts, exitCode: code ? Number(code[1]) : null, durationMs: elapsed() } } };
  }
}

/** 切换：暂存目录改名成版本目录，再原子替换 current 链接；只留新版本和上一版（决定 7）。 */
function commitStaged(staged: Staged): void {
  const { base, staging, previous } = staged;
  const dir = `v-${randomUUID()}`;
  renameSync(staging, join(base, dir));
  const tmpLink = join(base, `.current-${randomUUID()}`);
  symlinkSync(dir, tmpLink);
  renameSync(tmpLink, join(base, 'current'));
  for (const name of readdirSync(base)) {
    if (VERSION_DIR.test(name) && name !== dir && name !== previous) rmSync(join(base, name), { recursive: true, force: true });
  }
}

export async function installComponent(options: ComponentInstallOptions, spec: ComponentJobSpec): Promise<ComponentOutcome> {
  const started = (options.now ?? Date.now)();
  const elapsed = () => (options.now ?? Date.now)() - started;
  const stage = await stageComponent(options, spec, elapsed);
  if (!stage.ok) return stage.outcome;
  commitStaged(stage.staged);
  const acquisition = stage.staged.acquisition;
  const used = acquisition?.path ? `（策略 ${acquisition.strategy}：${acquisition.path}）` : acquisition ? `（策略 ${acquisition.strategy}）` : '';
  return {
    ok: true,
    message: `已安装组件 ${spec.componentId} ${spec.version}${used}`,
    result: { integrity: spec.integrity, ignoredScripts: true, scripts: stage.staged.scripts, exitCode: 0, durationMs: elapsed(), ...(acquisition ? { acquisition } : {}) }
  };
}

/**
 * 整套安装（P3）：全有或全无。先把每个组件都装进各自的暂存目录并核对，
 * 任何一个失败就删掉所有暂存、一个都不切换；全部通过才依次切换 current。
 * （切换本身是几次 rename，不会因为下载 / 校验失败而半途而废。）
 */
export async function installBundle(options: ComponentInstallOptions, specs: readonly ComponentJobSpec[]): Promise<ComponentOutcome> {
  const started = (options.now ?? Date.now)();
  const elapsed = () => (options.now ?? Date.now)() - started;
  const staged: Staged[] = [];
  for (const spec of specs) {
    const stage = await stageComponent(options, spec, elapsed);
    if (!stage.ok) {
      for (const done of staged) rmSync(done.staging, { recursive: true, force: true });
      return { ...stage.outcome, message: `${stage.outcome.message}；整套安装已取消，没有切换任何组件` };
    }
    staged.push(stage.staged);
  }
  for (const done of staged) commitStaged(done);
  const acquisition = staged.map((s) => s.acquisition).find((item) => item);
  return {
    ok: true,
    message: `已整套安装 ${specs.length} 个组件：${specs.map((s) => `${s.componentId} ${s.version}`).join('、')}`,
    result: { ignoredScripts: true, scripts: staged.flatMap((s) => s.scripts).slice(0, 200), exitCode: 0, durationMs: elapsed(), ...(acquisition ? { acquisition } : {}) }
  };
}

export function uninstallComponent(options: Pick<ComponentInstallOptions, 'root'>, spec: ComponentJobSpec): ComponentOutcome {
  const current = installedVersion(options.root, spec.runtime, spec.componentId);
  if (current !== spec.expectedCurrent) return { ok: false, refused: true, message: `机器上的版本（${current ?? '没装'}）和 hub 以为的不一致，先刷新再试`, result: {} };
  const base = join(options.root, spec.runtime, spec.componentId);
  if (existsSync(base)) rmSync(base, { recursive: true, force: true });
  return { ok: true, message: `已卸载组件 ${spec.componentId}`, result: {} };
}

/** 开会话时现查：hub 装的、启用的组件包目录（真实路径，确认在组件根目录里面）。 */
export function hubComponentDirs(root: string, runtime: string): string[] {
  const dir = join(root, runtime);
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const id of readdirSync(dir)) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) continue;
    const version = currentVersionDir(root, runtime, id);
    if (!version) continue;
    const meta = readJson(join(dir, id, version, '.component.json'));
    if (!meta || meta['enabled'] === false || typeof meta['packageName'] !== 'string') continue;
    // 机器工具（例如内置浏览器）不是 agent 插件：不交给运行时加载
    if (machineToolOnly(meta['provides'])) continue;
    try {
      const real = realpathSync(join(dir, id, 'current', 'node_modules', meta['packageName']));
      if (inside(root, real)) out.push(real);
    } catch {
      // 目录坏了：清单那边会报漂移，这里跳过
    }
  }
  return out;
}

/** 这条组件任务是否要跑获取策略（目录声明或内置清单补上的）。 */
export function installsBrowser(spec: Pick<ComponentJobSpec, 'packageName' | 'provides' | 'strategies'>): boolean {
  if (spec.strategies && spec.strategies.length > 0) return true;
  return spec.packageName === BUILTIN_CHROMIUM.packageName && spec.provides.some((p) => p.capability === BUILTIN_CHROMIUM.capability);
}

/** 只提供机器工具（mode = machine-tool）的组件不是运行时插件。 */
export function machineToolOnly(provides: unknown): boolean {
  return Array.isArray(provides) && provides.length > 0 && provides.every((p) => (p as { mode?: unknown } | null)?.mode === 'machine-tool');
}
