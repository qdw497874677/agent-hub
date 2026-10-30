import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { HarnessInstaller } from '@agent-hub/domain';

/** hub 装 Pi 时默认的版本：在这个版本上跑过端到端（ADR 0010）。 */
export const PI_RECOMMENDED_VERSION = '1.4.0';
export const PI_PACKAGE = '@earendil-works/pi-coding-agent';

/**
 * Pi 是 npm 包：用 Worker 自己那个 node 的 npm `--prefix` 装进暂存目录，入口是 JS 脚本，由 shim 交给同一个 node 跑。
 * 不碰全局 npm、不改用户的 PATH。
 */
export function piInstaller(options: { node?: string; platform?: NodeJS.Platform } = {}): HarnessInstaller {
  const node = options.node ?? process.execPath;
  const npm = findNpm(node);
  const platform = options.platform ?? process.platform;
  return {
    agentId: 'pi',
    command: 'pi',
    recommendedVersion: PI_RECOMMENDED_VERSION,
    async blocker() {
      if (platform !== 'linux' && platform !== 'darwin') return `暂不支持在 ${platform} 上在线安装`;
      if (!npm) return '这台机器的 Node 旁边没有 npm，没法在线安装';
      return null;
    },
    async install(version, run) {
      await run.run(node, [npm as string, 'install', '--prefix', run.dir, '--no-audit', '--no-fund', '--omit=dev', `${PI_PACKAGE}@${version}`], { cwd: run.dir });
      return { path: npmBin(run.dir, PI_PACKAGE, 'pi'), kind: 'node-script' };
    }
  };
}

/** 装好的包的 bin 入口（相对暂存目录），读包自己的 package.json，不猜路径。 */
export function npmBin(dir: string, pkg: string, command: string): string {
  const manifest = JSON.parse(readFileSync(join(dir, 'node_modules', pkg, 'package.json'), 'utf8')) as { bin?: string | Record<string, string> };
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[command];
  if (!bin || bin.includes('..')) throw new Error(`${pkg} 的 package.json 里没有 ${command} 入口`);
  return join('node_modules', pkg, bin.replace(/^\.\//, ''));
}

/** 和 Worker 同一个 node 配套的 npm（npm-cli.js），找不到返回 null。PATH 里的 npm 按真实路径认。 */
export function findNpm(node: string, path: string = process.env['PATH'] ?? ''): string | null {
  const candidates = [join(dirname(node), 'npm'), join(dirname(node), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  for (const dir of path.split(':').filter(Boolean)) candidates.push(join(dir, 'npm'));
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return realpathSync(candidate);
    } catch {
      // 断链之类，看下一个
    }
  }
  return null;
}
