import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessInstaller } from '@agent-hub/domain';

/** hub 装 Grok CLI 时默认的版本（ADR 0010）。 */
export const GROK_RECOMMENDED_VERSION = '1.0.70';
export const GROK_INSTALL_SCRIPT = 'https://x.ai/cli/install.sh';

const which = (dirs: readonly string[], name: string): string | null => {
  for (const dir of dirs) if (existsSync(join(dir, name))) return join(dir, name);
  return null;
};

/**
 * Grok：跑官方安装脚本，但把 HOME 指到暂存目录里的临时家目录——脚本改不到用户的 ~/.grok、shell rc，
 * 也碰不到已有的登录。装完只把二进制拷出来，临时家目录整个删掉。绝不替用户登录。
 */
export function grokInstaller(options: { platform?: NodeJS.Platform; path?: string; script?: string } = {}): HarnessInstaller {
  const platform = options.platform ?? process.platform;
  const dirs = (options.path ?? process.env['PATH'] ?? '/usr/bin:/bin').split(':').filter(Boolean);
  const script = options.script ?? GROK_INSTALL_SCRIPT;
  return {
    agentId: 'grok',
    command: 'grok',
    recommendedVersion: GROK_RECOMMENDED_VERSION,
    async blocker() {
      if (platform !== 'linux' && platform !== 'darwin') return `暂不支持在 ${platform} 上在线安装`;
      if (!which(dirs, 'bash')) return '这台机器没有 bash，跑不了官方安装脚本';
      if (!which(dirs, 'curl') && !which(dirs, 'wget')) return '这台机器没有 curl 或 wget，下载不了';
      return null;
    },
    async install(version, run) {
      const bash = which(dirs, 'bash');
      const curl = which(dirs, 'curl');
      const wget = which(dirs, 'wget');
      if (!bash || (!curl && !wget)) throw new Error('缺 bash 或 curl/wget');
      const home = join(run.dir, 'home');
      const binDir = join(home, '.grok', 'bin');
      mkdirSync(binDir, { recursive: true });
      const file = join(run.dir, 'install.sh');
      if (curl) await run.run(curl, ['-fsSL', '--retry', '2', '-o', file, script]);
      else await run.run(wget as string, ['-q', '-O', file, script]);
      await run.run(bash, [file, version], {
        cwd: run.dir,
        env: { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), GROK_BIN_DIR: binDir, PATH: `${binDir}:/usr/bin:/bin` }
      });
      const downloads = join(home, '.grok', 'downloads');
      const binary = existsSync(downloads) ? readdirSync(downloads).find((name) => name.startsWith('grok-')) : undefined;
      const source = binary ? join(downloads, binary) : existsSync(join(binDir, 'grok')) ? join(binDir, 'grok') : null;
      if (!source) throw new Error('安装脚本跑完了，但没找到 grok 二进制');
      cpSync(source, join(run.dir, 'grok'), { dereference: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(file, { force: true });
      return { path: 'grok', kind: 'binary' };
    }
  };
}
