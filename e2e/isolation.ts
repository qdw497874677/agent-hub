import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * 远程 Worker 的可访问目录。用例把仓库和临时目录放在 os.tmpdir()，
 * 不能写死 /tmp：隔离运行会把 TMPDIR 指到别处，目录在边界外时建项目会失败，
 * 后面的 derive 只剩一个空 taskId，看起来像「请求体不合法」。
 */
export function e2eWorkerRoots(): string {
  const roots = new Set<string>(['/tmp', realpathSync(tmpdir())]);
  return [...roots].join(':');
}

/** 父进程 PATH 里某个命令所在目录。不启动登录 shell，也不读家目录配置。 */
function commandDir(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir !== '' && existsSync(join(dir, name))) return dir;
  }
  return null;
}

/**
 * 远程 Worker 的 PATH。
 * 默认只给这次 node、它旁边的 npm，以及系统基本目录，不把宿主机的 pi / opencode / grok 算成「机器自带」。
 * `agents: true` 才把父进程 PATH 里的 pi 加进来（组件安装要求这台机器已经有 pi）。
 * `extra` 放最前，测试替身（假 gh）不会被后面的同名命令盖住。
 */
export function e2eWorkerPath(extra = '', options: { agents?: boolean } = {}): string {
  const dirs = [
    extra,
    dirname(process.execPath),
    options.agents ? commandDir('pi') : null,
    commandDir('npm'),
    '/usr/local/bin',
    '/usr/bin',
    '/bin'
  ].filter((dir): dir is string => Boolean(dir));
  return [...new Set(dirs)].join(':');
}
