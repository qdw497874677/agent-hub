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
 * 让 Worker 子进程找得到和这次 node 配套的 npm，以及父进程 PATH 里的 pi。
 * 用例原先把 PATH 收成 /usr/bin，目录安装的 node / pi 会变成「未安装」，组件安装会被拒。
 */
export function e2eWorkerPath(extra = ''): string {
  // extra 放最前：用例用它挡住系统里的 gh / git，换成测试替身。
  const dirs = [extra, dirname(process.execPath), commandDir('pi'), commandDir('npm'), '/usr/local/bin', '/usr/bin', '/bin'].filter((dir): dir is string => Boolean(dir));
  return [...new Set(dirs)].join(':');
}
