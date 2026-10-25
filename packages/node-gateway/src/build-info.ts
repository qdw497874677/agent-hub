import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@agent-hub/contract';
import type { BuildInfo } from '@agent-hub/domain';

/**
 * 读一份代码的身份：仓库根 package.json 的版本 + `git rev-parse HEAD`。
 * hub 和 Worker 用同一个函数，「过期」才比得准。不在 git 仓库里（比如解压安装）提交号就是 null。
 */
export function readBuildInfo(repoDir: string): BuildInfo {
  let version = '0.0.0';
  try {
    const pkg = JSON.parse(readFileSync(join(repoDir, 'package.json'), 'utf8')) as { version?: unknown };
    if (typeof pkg.version === 'string') version = pkg.version;
  } catch {
    // 没有 package.json：按 0.0.0
  }
  let commit: string | null = null;
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (/^[0-9a-f]{40}$/.test(head)) commit = head;
  } catch {
    // 不是 git 仓库
  }
  return { version, commit, protocol: PROTOCOL_VERSION };
}
