import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { HarnessInstaller } from '@agent-hub/domain';

/** hub 装 OpenCode 时默认的版本（v2，ADR 0010）。 */
export const OPENCODE_RECOMMENDED_VERSION = '2.2.2';
export const OPENCODE_PACKAGE = '@opencode/cli';

/**
 * OpenCode v2：npm 包里是各平台的原生二进制。先 `--ignore-scripts` 装（不让任意依赖跑脚本），
 * 再只跑它自己的 postinstall 把对应平台的二进制放到 bin/ 下。入口是原生二进制，shim 直接 exec。
 */
export function opencodeInstaller(options: { node?: string; platform?: NodeJS.Platform } = {}): HarnessInstaller {
  const node = options.node ?? process.execPath;
  const npm = findNpm(node);
  const platform = options.platform ?? process.platform;
  return {
    agentId: 'opencode',
    command: 'opencode',
    recommendedVersion: OPENCODE_RECOMMENDED_VERSION,
    async blocker() {
      if (platform !== 'linux' && platform !== 'darwin') return `暂不支持在 ${platform} 上在线安装`;
      if (!npm) return '这台机器的 Node 旁边没有 npm，没法在线安装';
      return null;
    },
    async install(version, run) {
      if (!version.startsWith('2.')) throw new Error('只支持 OpenCode v2（2.x）');
      await run.run(node, [npm as string, 'install', '--prefix', run.dir, '--no-audit', '--no-fund', '--omit=dev', '--ignore-scripts', `${OPENCODE_PACKAGE}@${version}`], { cwd: run.dir });
      const pkgDir = join(run.dir, 'node_modules', OPENCODE_PACKAGE);
      const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { bin?: string | Record<string, string>; scripts?: Record<string, string> };
      if (manifest.scripts?.['postinstall']) {
        run.log('▸ 准备本平台的二进制');
        await run.run(node, [npm as string, 'run', 'postinstall'], { cwd: pkgDir });
      }
      const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.['opencode'];
      if (!bin || bin.includes('..')) throw new Error(`${OPENCODE_PACKAGE} 的 package.json 里没有 opencode 入口`);
      const path = join('node_modules', OPENCODE_PACKAGE, bin.replace(/^\.\//, ''));
      if (!existsSync(join(run.dir, path))) throw new Error('postinstall 之后没有找到 opencode 二进制');
      return { path, kind: 'binary' };
    }
  };
}

/** 和 Worker 同一个 node 配套的 npm（npm-cli.js），找不到返回 null。PATH 里的 npm 按真实路径认。 */
function findNpm(node: string, path: string = process.env['PATH'] ?? ''): string | null {
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
