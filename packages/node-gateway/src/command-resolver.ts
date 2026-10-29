import { accessSync, constants, readdirSync, readlinkSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

/**
 * harness 命令（pi / opencode / grok……）在这台机器上的实际位置。
 *
 * systemd 起的 Worker 不读登录 shell 的配置，PATH 很短：用 npm / nvm / 自带安装脚本装的 CLI
 * 常常就「找不到」。安装脚本已经把登录 shell 里看得到的目录写进了 worker.env；这里是运行时的兜底：
 * PATH 里没有，就按固定的一串常见位置找一遍。只看文件系统，不开登录 shell（探测要便宜、没副作用）。
 */
export type CommandResolution =
  /** 用户用 X_COMMAND 点名的，原样用。 */
  | { readonly source: 'explicit'; readonly command: string }
  | { readonly source: 'path'; readonly command: string }
  /** PATH 里没有、在常见位置找到的；dir 要补进子进程的 PATH（脚本的 `#!/usr/bin/env node` 也要找得到 node）。 */
  | { readonly source: 'fallback'; readonly command: string; readonly dir: string }
  | { readonly source: 'missing'; readonly command: string };

export interface ResolveOptions {
  /** X_COMMAND 的值；给了就不找。 */
  readonly explicit?: string | undefined;
  readonly path?: string | undefined;
  readonly home: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** 测试替身；默认看文件可执行。 */
  readonly isExecutable?: (file: string) => boolean;
  readonly listDir?: (dir: string) => readonly string[];
  readonly readLink?: (file: string) => string | null;
}

const executable = (file: string): boolean => {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};
const list = (dir: string): readonly string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};
const link = (file: string): string | null => {
  try {
    return readlinkSync(file);
  } catch {
    return null;
  }
};

/** 按版本号从新到旧排（v22.3.0 排在 v22.10.0 后面）。 */
function newestFirst(names: readonly string[]): string[] {
  const key = (name: string) => (name.match(/\d+/g) ?? []).map(Number);
  return [...names].sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
    return 0;
  });
}

/** PATH 之外会去找的目录，按顺序。 */
export function fallbackDirs(options: Pick<ResolveOptions, 'home' | 'env' | 'listDir' | 'readLink'>): string[] {
  const { home } = options;
  const env = options.env ?? {};
  const ls = options.listDir ?? list;
  const readLink = options.readLink ?? link;
  const dirs: string[] = [];
  if (env['NPM_CONFIG_PREFIX']) dirs.push(join(env['NPM_CONFIG_PREFIX'], 'bin'));
  dirs.push(join(home, '.npm-global', 'bin'));
  // nvm：当前版本（NVM_BIN / current 链接 / alias default），没有就取装着的最新版
  const nvm = env['NVM_DIR'] ?? join(home, '.nvm');
  if (env['NVM_BIN']) dirs.push(env['NVM_BIN']);
  const current = readLink(join(nvm, 'current'));
  if (current) dirs.push(join(isAbsolute(current) ? current : join(nvm, current), 'bin'));
  dirs.push(...newestFirst(ls(join(nvm, 'versions', 'node'))).map((version) => join(nvm, 'versions', 'node', version, 'bin')));
  dirs.push(join(home, '.local', 'bin'));
  // pi 官方安装脚本自带一份 node，装在这里
  dirs.push(...newestFirst(ls(join(home, '.local', 'share', 'pi-node'))).map((node) => join(home, '.local', 'share', 'pi-node', node, 'bin')));
  dirs.push(join(home, '.bun', 'bin'), join(home, '.volta', 'bin'), '/usr/local/bin');
  return [...new Set(dirs)];
}

export function resolveCommand(name: string, options: ResolveOptions): CommandResolution {
  const explicit = options.explicit?.trim();
  if (explicit) return { source: 'explicit', command: explicit };
  const isExecutable = options.isExecutable ?? executable;
  if (name.includes('/')) return { source: isExecutable(name) ? 'path' : 'missing', command: name };
  for (const dir of (options.path ?? '').split(delimiter).filter(Boolean)) {
    if (isExecutable(join(dir, name))) return { source: 'path', command: name };
  }
  for (const dir of fallbackDirs(options)) {
    const file = join(dir, name);
    if (isExecutable(file)) return { source: 'fallback', command: file, dir };
  }
  return { source: 'missing', command: name };
}

/** 没找到时给人看的提示（就绪状态里和「未安装」一起显示）。 */
export function missingCommandHint(name: string, envVar: string): string {
  return `PATH 里找不到 ${name}，可设 ${envVar} 指定路径`;
}
