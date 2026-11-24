import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessInstaller } from '@agent-hub/domain';
import { findNpm, npmBin } from '@agent-hub/node-kit';

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
      const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
      if (manifest.scripts?.['postinstall']) {
        run.log('▸ 准备本平台的二进制');
        await run.run(node, [npm as string, 'run', 'postinstall'], { cwd: pkgDir });
      }
      // 入口仍由包自己的 package.json 决定；找不到 / 越界由 npmBin 报同样的错误。
      const path = npmBin(run.dir, OPENCODE_PACKAGE, 'opencode');
      if (!existsSync(join(run.dir, path))) throw new Error('postinstall 之后没有找到 opencode 二进制');
      return { path, kind: 'binary' };
    }
  };
}
