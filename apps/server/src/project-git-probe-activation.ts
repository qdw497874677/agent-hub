import { lstat } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import type { SecretVault } from '@agent-hub/domain';
import { createSecretVault } from '@agent-hub/storage-sqlite';
import { createProjectGitHttpsProbe, type ProjectGitHttpsProbe } from './project-git-https-probe.ts';

/**
 * 项目 Git 隔离探测的启动开关。
 *
 * 默认永远关闭；只有同时满足下面三条才装配：
 * 1. 这个 Hub 不 spawn 本机 Worker（`HUB_SPAWN_WORKER=0`）；
 * 2. operator 显式给了 origin 与项目白名单；
 * 3. 数据目录本身属于当前用户、组/其他用户完全无权限、且不是符号链接。
 *
 * 隔离凭据是 Hub 级密钥，必须和普通项目令牌隔开：专用表由隔离路由单独持有，
 * 不交给 Deps / 资产展开 / Worker 凭据桥。这里不替运营 chmod 目录，也不改变
 * 普通 Hub 启动路径。
 */

/** 专用密钥表；不要和 `repo-git:` / clone / publish 的普通凭据混用。 */
export const PROJECT_GIT_PROBE_SECRETS_TABLE = 'project_git_probe_secrets';

export interface ProjectGitProbeActivationInput {
  readonly readEnv: (name: string) => string | null;
  readonly spawnWorker: string;
  readonly dataDir: string;
  readonly db: DatabaseSync;
  readonly secretKey: Uint8Array;
  /** 仅在「要求开启但目录不合格」时提示；默认写 stderr。 */
  readonly warn?: (message: string) => void;
}

export interface ProjectGitProbeActivation {
  readonly probe: ProjectGitHttpsProbe;
  readonly vault: SecretVault;
  readonly allows: (projectId: string, repoId: string, url: string) => boolean;
}

function splitList(value: string | null): string[] {
  return (value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
}

export async function setupProjectGitProbe(
  input: ProjectGitProbeActivationInput
): Promise<ProjectGitProbeActivation | null> {
  const origins = splitList(input.readEnv('HUB_PROJECT_GIT_PROBE_ORIGINS'));
  const projects = new Set(splitList(input.readEnv('HUB_PROJECT_GIT_PROBE_PROJECTS')));
  const requested = input.spawnWorker === '0' && origins.length > 0 && projects.size > 0;
  let dataDirPrivate = false;
  if (requested) {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (uid !== null) {
      try {
        const info = await lstat(input.dataDir);
        dataDirPrivate = info.isDirectory() && !info.isSymbolicLink() && info.uid === uid && (info.mode & 0o077) === 0;
      } catch {
        dataDirPrivate = false;
      }
    }
    if (!dataDirPrivate) {
      const warn = input.warn ?? ((message: string) => console.warn(message));
      warn(`[hub] 隔离探测要求数据目录本身属于当前用户、无组/其他权限且不是符号链接（当前 ${input.dataDir}）；已保持关闭`);
    }
  }
  if (!dataDirPrivate) return null;
  return {
    probe: createProjectGitHttpsProbe({ allowedOrigins: origins }),
    vault: createSecretVault(input.db, input.secretKey, PROJECT_GIT_PROBE_SECRETS_TABLE),
    allows: (projectId: string, _repoId: string, url: string) =>
      projects.has(projectId) && origins.includes(new URL(url).origin)
  };
}
