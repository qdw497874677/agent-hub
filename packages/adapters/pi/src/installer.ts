import type { HarnessInstaller } from '@agent-hub/domain';
import { findNpm, npmBin } from '@agent-hub/node-kit';

export { findNpm, npmBin } from '@agent-hub/node-kit';

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
