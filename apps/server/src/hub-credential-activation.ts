import { lstat, open, realpath, statfs } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Context } from 'hono';
import { asProjectId, type ProjectRepository } from '@agent-hub/domain';
import { createHubCredentialBroker, installHubCredentialBindingLifecycle, type HubCredentialBrokerOptions } from './hub-credential-broker.ts';
import { createProjectGitSnapshotReader } from './project-git-fetch.ts';
import { createProjectGitHttpsProbe } from './project-git-https-probe.ts';
import { parseAllowedOrigins } from './project-git-https-policy.ts';

const TMPFS_MAGIC = 0x01021994;
const MAX_SCRATCH_BYTES = 128 * 1024 * 1024;

const list = (value: string | null) => (value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);

function httpsOrigin(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && value === url.origin ? url.origin : null;
  } catch { return null; }
}

/** This listener is loopback-only. Its dedicated TLS proxy must strip and replace forwarding headers. */
export function managedCredentialAdminTransport(c: Context, origin: string): boolean {
  const host = new URL(origin).host;
  const callerOrigin = c.req.header('origin');
  if (c.req.header('host')?.toLowerCase() !== host) return false;
  if (new URL(c.req.url).protocol !== 'https:' && c.req.header('x-forwarded-proto') !== 'https') return false;
  return c.req.method === 'GET' || c.req.method === 'HEAD' ? callerOrigin === undefined || callerOrigin === origin : callerOrigin === origin;
}

async function isPrivateDirectory(path: string, uid: number): Promise<boolean> {
  if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) return false;
  const info = await lstat(path);
  return info.isDirectory() && info.uid === uid && (info.mode & 0o077) === 0;
}

async function keyAt(path: string, uid: number): Promise<Buffer> {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await fd.stat();
    if (!info.isFile() || info.uid !== uid || (info.mode & 0o077) !== 0 || info.size > 64) throw new Error('invalid key file');
    const base64 = (await fd.readFile('utf8')).trim();
    if (!/^[A-Za-z0-9+/]{43}=$/.test(base64)) throw new Error('invalid key size');
    const key = Buffer.from(base64, 'base64');
    if (key.length !== 32 || key.toString('base64') !== base64) throw new Error('invalid key encoding');
    return key;
  } finally { await fd.close(); }
}

export async function setupHubCredentialBroker(input: {
  readEnv(name: string): string | null;
  spawnWorker: string;
  host: string;
  dataDir: string;
  db: DatabaseSync;
  projects: Pick<ProjectRepository, 'byId'>;
  warn(message: string): void;
  audit?: HubCredentialBrokerOptions['audit'];
}) {
  const mode = input.readEnv('HUB_CREDENTIAL_BROKER');
  if (mode === '0') return null;
  const off = (reason: string) => {
    input.warn(`[hub] Hub 托管凭证保持关闭：${reason}`);
    return null;
  };
  if (mode !== null && mode !== '1') return off('HUB_CREDENTIAL_BROKER 仅支持 0 或 1');
  const uid = process.getuid?.();
  if (uid === undefined || uid === 0 || input.spawnWorker !== '0' || !['127.0.0.1', '::1'].includes(input.host)) {
    return off('需要专用非 root Hub 用户、回环监听且不启动内嵌 Worker');
  }
  const adminOrigin = httpsOrigin(input.readEnv('HUB_CREDENTIAL_ADMIN_ORIGIN'));
  const allowedOrigins = list(input.readEnv('HUB_CREDENTIAL_GIT_ORIGINS'));
  const projects = new Set(list(input.readEnv('HUB_CREDENTIAL_PROJECTS')));
  const scratchRoot = input.readEnv('HUB_CREDENTIAL_SCRATCH_ROOT');
  if (!adminOrigin || allowedOrigins.length === 0 || projects.size === 0 || !scratchRoot) {
    return off('需要 HTTPS 管理入口、项目与 Git origin 白名单，以及独立暂存挂载');
  }
  try {
    parseAllowedOrigins(allowedOrigins, 'Hub credential');
    if (!await isPrivateDirectory(input.dataDir, uid) || !await isPrivateDirectory(scratchRoot, uid)
      || scratchRoot === input.dataDir || scratchRoot.startsWith(`${input.dataDir}${sep}`)
      || input.dataDir.startsWith(`${scratchRoot}${sep}`)) return off('数据与暂存须是互不包含的真实私有目录');
    const [scratch, parent, fs] = await Promise.all([lstat(scratchRoot), lstat(dirname(scratchRoot)), statfs(scratchRoot)]);
    if (scratch.dev === parent.dev || fs.type !== TMPFS_MAGIC || fs.blocks * fs.bsize <= 0 || fs.blocks * fs.bsize > MAX_SCRATCH_BYTES) {
      return off('暂存必须是独立 tmpfs 挂载，总配额不大于 128 MiB');
    }
    const key = await keyAt(join(input.dataDir, 'hub-credential.key'), uid);
    const reader = createProjectGitSnapshotReader({ allowedOrigins, scratchRoot });
    const probe = createProjectGitHttpsProbe({ allowedOrigins });
    try {
      const broker = createHubCredentialBroker({
        db: input.db, key, allowedOrigins,
        allows: (projectId) => projects.has(projectId),
        async resolveTarget(projectId, repoId) {
          const project = await input.projects.byId(asProjectId(projectId));
          const matches = project?.repos.filter((row) => row.id === repoId);
          const repo = matches?.length === 1 ? matches[0] : undefined;
          return project?.teamId && project.deletedAt == null && repo
            ? { teamId: project.teamId, repoUrl: repo.url, branch: repo.defaultBranch } : null;
        },
        check: (request) => probe.check(request), read: (request) => reader.read(request),
        ...(input.audit ? { audit: input.audit } : {})
      });
      installHubCredentialBindingLifecycle(input.db);
      return { broker, adminOrigin, allowsProject: (id: string) => projects.has(id) };
    } catch {
      await Promise.allSettled([reader.close(), probe.close()]);
      return off('凭证存储或主密钥不可用');
    } finally { key.fill(0); }
  } catch { return off('隔离配置不符合要求，或独立主密钥不可用'); }
}
