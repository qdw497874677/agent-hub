import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * 新机器装 Worker 用的代码包，直接从 hub 下，不必连 GitHub：
 * - `worker-<提交>.tar.gz`：`git archive` 出来的源码（只有 git 跟踪的文件，没有 .env / 数据 / node_modules）；
 * - `worker-<提交>.bundle`：同一提交的 git bundle，装出来的是正常 git 仓库，自更新 / 回滚照旧。
 * 只发 hub 自己正在跑的那个提交；第一次请求时现做，按提交缓存到 cacheDir，sha256 一起算好。
 */
export type ArtifactKind = 'tar.gz' | 'bundle';
export interface Artifact { readonly path: string; readonly sha256: string; readonly size: number }

/** bundle 里带的引用名：安装脚本和自更新都按这个名字取。 */
export const BUNDLE_REF = 'refs/agent-hub/install';

export interface InstallArtifacts {
  readonly commit: string | null;
  get(kind: ArtifactKind): Promise<Artifact | null>;
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export function createInstallArtifacts(options: { repoDir: string; commit: string | null; cacheDir: string }): InstallArtifacts {
  const { repoDir, cacheDir } = options;
  const commit = options.commit && /^[0-9a-f]{40}$/.test(options.commit) ? options.commit : null;
  const pending = new Map<ArtifactKind, Promise<Artifact | null>>();

  const build = async (kind: ArtifactKind): Promise<Artifact | null> => {
    if (!commit) return null;
    const final = join(cacheDir, `worker-${commit}.${kind}`);
    const existing = await stat(final).catch(() => null);
    if (!existing) {
      await mkdir(cacheDir, { recursive: true });
      const tmp = `${final}.tmp-${process.pid}`;
      try {
        if (kind === 'tar.gz') {
          await exec('git', ['archive', '--format=tar.gz', `--output=${tmp}`, commit], { cwd: repoDir });
        } else {
          // bundle 只能打引用：临时建一个，打完就删（不碰分支）
          await exec('git', ['update-ref', BUNDLE_REF, commit], { cwd: repoDir });
          try {
            await exec('git', ['bundle', 'create', tmp, BUNDLE_REF], { cwd: repoDir });
          } finally {
            await exec('git', ['update-ref', '-d', BUNDLE_REF], { cwd: repoDir }).catch(() => undefined);
          }
        }
        await rename(tmp, final);
      } catch (error) {
        await rm(tmp, { force: true });
        console.error(`[hub] 生成安装包 ${kind} 失败：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
        return null;
      }
    }
    const info = await stat(final);
    return { path: final, sha256: await sha256Of(final), size: info.size };
  };

  return {
    commit,
    get(kind) {
      let job = pending.get(kind);
      if (!job) {
        job = build(kind);
        pending.set(kind, job);
        // 失败的不缓存，下次再试
        void job.then((result) => { if (!result) pending.delete(kind); });
      }
      return job;
    }
  };
}
