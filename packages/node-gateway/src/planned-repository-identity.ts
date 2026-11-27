import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

/** Opaque physical identity; no inode or device data crosses the Worker RPC boundary. */
export async function plannedRepositoryIdentity(topLevel: string, commonDir: string, gitDir: string): Promise<string> {
  const directories = [];
  for (const path of [topLevel, commonDir, gitDir]) {
    if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) throw new Error('Non-canonical repository identity');
    const stat = await lstat(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.birthtimeNs <= 0n) throw new Error('Repository identity unavailable');
    directories.push([path, String(stat.dev), String(stat.ino), String(stat.birthtimeNs)]);
  }
  return createHash('sha256').update(JSON.stringify(directories)).digest('hex');
}
