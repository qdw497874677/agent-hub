import { existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync, chmodSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { InstalledEntry } from '@agent-hub/domain';

/**
 * hub 装的运行时放在哪（ADR 0010）：只在 Worker 自己的目录里，不碰全局（/usr/local、~/.local/bin、shell rc）。
 *
 *     <root>/                      默认 ~/.agent-hub/runtimes，WORKER_RUNTIMES_DIR 可改
 *       <agent>/<version>/         一个版本一个目录
 *       <agent>/current -> <version>
 *       bin/<command>              小 sh 垫片：exec 到 current 里的入口
 *
 * 安装进 `<version>.staging-<job>`，验过再整体改名、原子切换 current；失败只删暂存目录，旧版本不受影响。
 */
export interface RuntimeStore {
  readonly root: string;
  /** 这个命令的垫片位置：不管装没装，组合根都把 runtime 指向它，装好即生效。 */
  shimPath(command: string): string;
  /** hub 装的版本；没装是 null。 */
  installed(agentId: string): string | null;
  /** 一个全新的空暂存目录。 */
  stage(agentId: string, jobId: string): string;
  discard(dir: string): void;
  /** 暂存目录转正：改名、切 current、写垫片、删别的旧版本。 */
  commit(agentId: string, version: string, staging: string, entry: InstalledEntry, command: string): void;
  /** 写出一个指向暂存目录入口的临时垫片，用来在转正前跑 `--version`。 */
  probeShim(staging: string, entry: InstalledEntry): string;
  remove(agentId: string, command: string): void;
}

export function defaultRuntimesRoot(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env['WORKER_RUNTIMES_DIR'] || join(homedir(), '.agent-hub', 'runtimes');
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const quote = (value: string): string => {
  if (value.includes("'")) throw new Error('路径里有单引号，拒绝生成垫片');
  return `'${value}'`;
};

export function createRuntimeStore(options: { readonly root: string; readonly node?: string }): RuntimeStore {
  const root = options.root;
  const node = options.node ?? process.execPath;
  const binDir = join(root, 'bin');
  const check = (...segments: string[]): void => {
    for (const segment of segments) if (!SAFE_SEGMENT.test(segment) || segment === '.' || segment === '..') throw new Error(`不合法的名字：${segment}`);
  };
  const shimBody = (target: string, entry: InstalledEntry): string =>
    `#!/bin/sh\n# agent-hub 安装的运行时（ADR 0010）；卸载请在 hub 界面上点「卸载」\nexec ${entry.kind === 'node-script' ? `${quote(node)} ` : ''}${quote(target)} "$@"\n`;
  const writeShim = (file: string, body: string): void => {
    mkdirSync(join(file, '..'), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, body);
    chmodSync(tmp, 0o755);
    renameSync(tmp, file);
  };

  return {
    root,
    shimPath: (command) => {
      check(command);
      return join(binDir, command);
    },
    installed(agentId) {
      check(agentId);
      try {
        const version = readlinkSync(join(root, agentId, 'current'));
        return SAFE_SEGMENT.test(version) && existsSync(join(root, agentId, version)) ? version : null;
      } catch {
        return null;
      }
    },
    stage(agentId, jobId) {
      check(agentId, jobId);
      const dir = join(root, agentId, `.staging-${jobId}`);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    discard(dir) {
      rmSync(dir, { recursive: true, force: true });
    },
    probeShim(staging, entry) {
      const file = join(staging, '.agent-hub-probe');
      writeShim(file, shimBody(join(staging, entry.path), entry));
      return file;
    },
    commit(agentId, version, staging, entry, command) {
      check(agentId, version, command);
      if (entry.path.split('/').some((part) => part === '..')) throw new Error('入口不能跳出安装目录');
      const dir = join(root, agentId);
      const target = join(dir, version);
      rmSync(join(staging, '.agent-hub-probe'), { force: true });
      rmSync(target, { recursive: true, force: true });
      renameSync(staging, target);
      // current 原子切换：先建临时链接再 rename 覆盖
      const tmpLink = join(dir, `.current-${process.pid}`);
      rmSync(tmpLink, { force: true });
      symlinkSync(version, tmpLink);
      renameSync(tmpLink, join(dir, 'current'));
      writeShim(join(binDir, command), shimBody(join(dir, 'current', entry.path), entry));
      writeFileSync(join(target, '.agent-hub-entry.json'), JSON.stringify(entry));
      for (const name of readdirSync(dir)) {
        if (name === version || name === 'current' || name.startsWith('.staging-')) continue;
        rmSync(join(dir, name), { recursive: true, force: true });
      }
    },
    remove(agentId, command) {
      check(agentId, command);
      rmSync(join(binDir, command), { force: true });
      rmSync(join(root, agentId), { recursive: true, force: true });
    }
  };
}

/** 读 hub 装的那份的入口（调试 / 测试用）。 */
export function readInstalledEntry(store: RuntimeStore, agentId: string): InstalledEntry | null {
  const version = store.installed(agentId);
  if (!version) return null;
  try {
    return JSON.parse(readFileSync(join(store.root, agentId, version, '.agent-hub-entry.json'), 'utf8')) as InstalledEntry;
  } catch {
    return null;
  }
}
