import { accessSync, constants, existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, sep } from 'node:path';
import type {
  AcquisitionResolution,
  AcquisitionStrategy,
  BinaryLocate,
  ComponentJobResult
} from '@agent-hub/domain';
import { formatRootCommand, readAcquisition } from '@agent-hub/domain';

/**
 * Worker 侧执行目录项声明的有序获取策略。只认识那四种类型，不写死某个组件。
 * 探测 / 安装都走注入的 exists / isExecutable / run / env：测试用隔离 HOME 和假路径，不碰真实缓存。
 */

export type CommandRunner = (
  file: string,
  args: readonly string[],
  options: { cwd: string; env: Record<string, string> }
) => Promise<string>;

export interface AcquireHooks {
  readonly env: Record<string, string>;
  readonly run: CommandRunner;
  readonly log?: (line: string) => void;
  /** 测试注入的额外候选绝对路径。 */
  readonly paths?: readonly string[];
  /** 默认 true：也扫策略里声明的 paths。测试应关掉，以免碰到机器上真的二进制。 */
  readonly includeListedPaths?: boolean;
  readonly exists?: (path: string) => boolean;
  readonly isExecutable?: (path: string) => boolean;
  readonly platform?: NodeJS.Platform;
  readonly browsersRoot?: string;
}

export interface AcquireSuccess {
  readonly ok: true;
  readonly acquisition: AcquisitionResolution;
  readonly missingDeps?: string[];
  readonly message: string;
}

export interface AcquireFailure {
  readonly ok: false;
  readonly missingDeps: string[];
  readonly message: string;
}

export type AcquireOutcome = AcquireSuccess | AcquireFailure;

function defaultExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function defaultExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    if (process.platform !== 'win32') return false;
    try {
      return existsSync(path);
    } catch {
      return false;
    }
  }
}

function defaultRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function defaultIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function containedBy(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * 候选二进制里的平台标记（例如 chrome-linux/、chrome-mac-arm64/、chrome-win64/、*.exe）。
 * 没有标记 = 各平台通用；同一路径声明了多个平台 = 保守地不采用。
 */
export function binarySupportsPlatform(relative: string, platform: NodeJS.Platform = process.platform): boolean {
  const segments = relative.toLowerCase().split('/');
  const has = (pattern: RegExp) => segments.some((segment) => pattern.test(segment));
  const platforms = new Set<NodeJS.Platform>();
  if (has(/(^|[-_.])(mac|macos|osx|darwin)([-_.]|$)/)) platforms.add('darwin');
  if (has(/(^|[-_.])linux(\d+)?([-_.]|$)/)) platforms.add('linux');
  if (has(/(^|[-_.])win(32|64)?([-_.]|$)/) || segments.some((segment) => segment.endsWith('.exe'))) platforms.add('win32');
  return platforms.size === 0 || (platforms.size === 1 && platforms.has(platform));
}

export { readAcquisition };

export function locateRoot(locate: BinaryLocate, hooks: Pick<AcquireHooks, 'env' | 'browsersRoot'>): string | null {
  if (hooks.browsersRoot) return hooks.browsersRoot;
  if (locate.envRoot) {
    const explicit = hooks.env[locate.envRoot];
    if (explicit && explicit !== '0') return isAbsolute(explicit) ? explicit : null;
  }
  if (locate.homeSubdir) {
    const home = hooks.env['HOME'] ?? hooks.env['USERPROFILE'];
    if (home && isAbsolute(home)) return join(home, locate.homeSubdir);
  }
  return null;
}

function startsWithAny(value: string, prefixes: readonly string[] | undefined): boolean {
  if (!prefixes?.length) return false;
  const lower = value.toLowerCase();
  return prefixes.some((prefix) => lower.startsWith(prefix.toLowerCase()));
}

/** 记录下来的路径是否真的落在 locate 的布局里：版本目录前缀 + 声明的二进制相对路径 + 当前平台。 */
function matchesLocate(
  root: string,
  locate: BinaryLocate,
  path: string,
  platform: NodeJS.Platform = process.platform
): string | null {
  const rootReal = defaultRealpath(root);
  const pathReal = defaultRealpath(path);
  if (!rootReal || !pathReal || !containedBy(rootReal, pathReal)) return null;
  const relative = pathReal.slice(rootReal.length).split(sep).filter(Boolean);
  if (relative.length < 2) return null;
  const directory = relative[0]!;
  const binary = relative.slice(1).join('/');
  if (!startsWithAny(directory, locate.directoryPrefixes) || startsWithAny(directory, locate.excludeDirectoryPrefixes)) return null;
  if (!locate.binaries.includes(binary) || !binarySupportsPlatform(binary, platform)) return null;
  if (!defaultIsFile(pathReal) || !defaultExecutable(pathReal)) return null;
  return pathReal;
}

export function findLocatedBinary(root: string, locate: BinaryLocate, exists: (path: string) => boolean = defaultExists): string | null {
  if (!exists(root)) return null;
  const platform = process.platform;
  let entries: string[] = [];
  try {
    entries = readdirSync(root)
      .filter((entry) => startsWithAny(entry, locate.directoryPrefixes) && !startsWithAny(entry, locate.excludeDirectoryPrefixes))
      .sort();
  } catch {
    return null;
  }
  const binaries = locate.binaries.filter((relative) => binarySupportsPlatform(relative, platform));
  for (const entry of entries.reverse()) {
    for (const rel of binaries) {
      const path = join(root, entry, rel);
      if (!exists(path)) continue;
      // 只认 realpath 后仍在 locate 根目录里、且是常规可执行文件的路径（防符号链接逃逸）。
      const canonical = matchesLocate(root, locate, path, platform);
      if (canonical) return canonical;
    }
  }
  return null;
}

export function listSystemBinaryCandidates(
  strategy: Extract<AcquisitionStrategy, { type: 'detect-system-binary' }>,
  hooks: Pick<AcquireHooks, 'env' | 'paths' | 'includeListedPaths' | 'exists' | 'isExecutable' | 'platform'>
): string[] {
  const exists = hooks.exists ?? defaultExists;
  const isExecutable = hooks.isExecutable ?? defaultExecutable;
  const platform = hooks.platform ?? process.platform;
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (path: string) => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    if (!binarySupportsPlatform(path, platform)) return;
    if (exists(path) && defaultIsFile(path) && isExecutable(path)) out.push(path);
  };
  for (const path of hooks.paths ?? []) add(path);
  if (hooks.includeListedPaths !== false) {
    for (const path of strategy.paths ?? []) {
      // 保留旧的 Windows / 非 Windows 绝对路径分流：不要把另一套平台的写死路径当成本机候选。
      const windowsPath = path.includes('\\') || /^[A-Za-z]:/.test(path);
      if (platform === 'win32' ? !windowsPath : windowsPath) continue;
      add(path);
    }
  }
  const pathEnv = hooks.env['PATH'] ?? hooks.env['Path'] ?? '';
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const name of strategy.names ?? []) add(join(dir, name));
  }
  return out;
}

/**
 * 读侧（worker 库存 / 会话链接）只信任内置清单能复核的获取结果：
 * 没有内置策略、策略 id/type 对不上、路径不在内置 locate 布局或系统候选里，一律丢弃。
 * 这样旧 `.component.json` 不能变成任意可执行路径。
 */
export function trustedRecordedAcquisition(
  acquisition: AcquisitionResolution,
  strategies: readonly AcquisitionStrategy[] | undefined,
  options: { env: Record<string, string>; platform?: NodeJS.Platform }
): AcquisitionResolution | null {
  if (!strategies?.length) return null;
  const strategy = strategies.find((item) => item.id === acquisition.strategy);
  if (!strategy || strategy.type !== acquisition.type) return null;
  const path = acquisition.path;
  if (!path) return { ...acquisition };
  if (path.includes('\0') || !isAbsolute(path)) return null;
  const canonical = defaultRealpath(path);
  if (!canonical || !defaultIsFile(canonical)) return null;
  if (strategy.type === 'detect-system-binary') {
    const candidates = listSystemBinaryCandidates(strategy, {
      env: options.env,
      includeListedPaths: true,
      platform: options.platform ?? process.platform
    });
    if (!candidates.some((candidate) => defaultRealpath(candidate) === canonical)) return null;
    return { ...acquisition, path: canonical };
  }
  if (strategy.type === 'user-space-install' || strategy.type === 'lighter-variant') {
    const root = locateRoot(strategy.locate, { env: options.env });
    if (!root) return null;
    const matched = matchesLocate(root, strategy.locate, canonical, options.platform ?? process.platform);
    return matched ? { ...acquisition, path: matched } : null;
  }
  return null;
}

export async function verifyBinary(hooks: AcquireHooks, executable: string, args: readonly string[]): Promise<boolean> {
  if (args.length === 0) return true;
  const dir = mkdtempSync(join(tmpdir(), 'ah-acquire-'));
  const launch = args.some((arg) => arg.startsWith('--user-data-dir')) ? [...args] : [...args, `--user-data-dir=${dir}`];
  try {
    await hooks.run(executable, launch, { cwd: dir, env: hooks.env });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    hooks.log?.(`${executable} 验证失败：${message.slice(0, 300)}`);
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function missingLibraries(hooks: AcquireHooks, binaries: readonly string[], cwd: string): Promise<string[]> {
  const platform = hooks.platform ?? process.platform;
  if (platform !== 'linux' || binaries.length === 0) return [];
  const exists = hooks.exists ?? defaultExists;
  const files = binaries.filter((path) => exists(path));
  if (!files.length) {
    hooks.log?.('提示：没有可核对的二进制，跳过系统库检查');
    return [];
  }
  const script = `for f in "$@"; do [ -f "$f" ] || continue; ldd "$f" 2>/dev/null | grep 'not found' || true; done | sort -u`;
  try {
    const output = await hooks.run('/bin/sh', ['-c', script, 'verify-binary-deps', ...files], { cwd, env: hooks.env });
    return [
      ...new Set(
        output
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.includes('not found'))
          .map((line) => line.split(/\s+/)[0] ?? '')
      )
    ]
      .filter(Boolean)
      .sort();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    hooks.log?.(`提示：ldd 核对失败（${message.slice(0, 200)}），跳过系统库检查`);
    return [];
  }
}

function rootFailureMessage(componentId: string, strategies: readonly AcquisitionStrategy[], missingDeps: readonly string[]): string {
  const root = [...strategies].reverse().find((item) => item.type === 'requires-root');
  const listed = missingDeps.slice(0, 8).join('、') || '未知';
  const command = root ? formatRootCommand(root) : 'npx playwright install-deps chromium';
  return (
    `${componentId}：声明的获取策略都未能得到可用的可执行文件（缺系统库：${listed}）。` +
    `缺的要 root 装系统包——root 下跑 ${command}（或 apt / dnf 装对应的包）；装好后重新发起安装任务。`
  );
}

export interface RunAcquisitionOptions {
  readonly hooks: AcquireHooks;
  readonly strategies: readonly AcquisitionStrategy[];
  readonly componentId: string;
  readonly capability?: string;
  readonly cwd: string;
  /** 对已装好的包执行后置命令（user-space-install / lighter-variant）。 */
  readonly install: (args: readonly string[]) => Promise<void>;
}

export async function runAcquisitionStrategies(options: RunAcquisitionOptions): Promise<AcquireOutcome> {
  const { hooks, strategies, componentId, capability, cwd, install } = options;
  if (!strategies.length) return { ok: false, missingDeps: [], message: `${componentId}：没有获取策略` };
  const missing: string[] = [];
  const resolve = (strategy: AcquisitionStrategy, path: string | undefined, message: string): AcquireSuccess => ({
    ok: true,
    acquisition: {
      strategy: strategy.id,
      type: strategy.type,
      ...(path ? { path } : {}),
      ...(capability ? { capability } : {}),
      componentId
    },
    ...(missing.length ? { missingDeps: [...new Set(missing)].sort() } : {}),
    message
  });

  for (const strategy of strategies) {
    if (strategy.type === 'detect-system-binary') {
      hooks.log?.(`策略 ${strategy.id}：探测系统二进制`);
      for (const path of listSystemBinaryCandidates(strategy, hooks)) {
        hooks.log?.(`探测 ${path}`);
        const verified = await verifyBinary(hooks, path, strategy.verify?.args ?? []);
        if (verified) {
          hooks.log?.(`使用系统二进制 ${path}（不下载）`);
          return resolve(strategy, path, `使用系统二进制 ${path}，未下载`);
        }
      }
      continue;
    }
    if (strategy.type === 'user-space-install' || strategy.type === 'lighter-variant') {
      const attempts: (readonly string[])[] = [strategy.args];
      if (strategy.type === 'lighter-variant' && strategy.fallbackArgs?.length) attempts.push(strategy.fallbackArgs);
      for (const args of attempts) {
        hooks.log?.(`$ 用户空间安装 ${args.join(' ')}（策略 ${strategy.id}，不需要 root）`);
        try {
          await install(args);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          hooks.log?.(`策略 ${strategy.id} 安装失败：${message.slice(0, 300)}`);
          continue;
        }
        const root = locateRoot(strategy.locate, hooks);
        const exists = hooks.exists ?? defaultExists;
        const path = root ? findLocatedBinary(root, strategy.locate, exists) : null;
        if (!path) {
          hooks.log?.(`策略 ${strategy.id}：安装后没找到二进制`);
          continue;
        }
        if (strategy.checkLibs) {
          const libs = await missingLibraries(hooks, [path], cwd);
          if (libs.length) {
            missing.push(...libs);
            hooks.log?.(`策略 ${strategy.id} 缺系统库：${libs.join('、')}`);
            continue;
          }
        }
        return resolve(strategy, path, `使用 ${strategy.id} ${path}`);
      }
      continue;
    }
    if (strategy.type === 'requires-root') {
      const missingDeps = [...new Set(missing)].sort();
      const message = rootFailureMessage(componentId, strategies, missingDeps);
      hooks.log?.(message);
      return { ok: false, missingDeps, message };
    }
  }
  const missingDeps = [...new Set(missing)].sort();
  return { ok: false, missingDeps, message: rootFailureMessage(componentId, strategies, missingDeps) };
}

export function acquisitionJobResult(outcome: AcquireOutcome, extra: Omit<ComponentJobResult, 'acquisition' | 'missingDeps'> = {}): ComponentJobResult {
  if (outcome.ok) {
    return {
      ...extra,
      acquisition: outcome.acquisition,
      ...(outcome.missingDeps?.length ? { missingDeps: [...outcome.missingDeps] } : {})
    };
  }
  return { ...extra, missingDeps: [...outcome.missingDeps] };
}
