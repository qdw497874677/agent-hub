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
 *       <agent>/machine            机器自带那份的绝对路径（一行；探测到就写）
 *       <agent>/source             用户显式选择：machine / hub（一行；没选过就没有）
 *       dispatch.mjs               调度脚本：按 source → hub current → machine 选目标
 *       bin/<command>              小 sh 垫片：exec node dispatch.mjs <agentId> "$@"
 *
 * 安装进 `<version>.staging-<job>`，验过再整体改名、原子切换 current；失败只删暂存目录，旧版本不受影响。
 */
export interface RuntimeStore {
  readonly root: string;
  /** 这个命令的垫片位置：不管装没装，组合根都把 runtime 指向它，装好即生效。 */
  shimPath(command: string): string;
  /** hub 装的版本；没装是 null。 */
  installed(agentId: string): string | null;
  /** 机器自带那份的路径；没有是 null。 */
  machinePath(agentId: string): string | null;
  setMachine(agentId: string, path: string | null): void;
  /** 用户显式选的来源；没选过是 null。 */
  preference(agentId: string): 'machine' | 'hub' | null;
  setPreference(agentId: string, source: 'machine' | 'hub' | null): void;
  /** 写调度垫片（bin/<command>）和 dispatch.mjs；幂等。 */
  writeDispatch(agentId: string, command: string): void;
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

/**
 * 调度脚本：每次 agent 启动时按 machine/source/current 现场选目标。
 * 和仓库版本一起发布的静态文件，不含任何插值——agent 目录由 argv 传进来。
 */
const DISPATCH_SCRIPT = `#!/usr/bin/env node
// agent-hub 运行时调度（ADR 0010）：按 用户选择 → hub current → 机器自带 的顺序选目标。
import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const agentId = process.argv[2] ?? '';
const args = process.argv.slice(3);
const agentDir = join(root, agentId);

const readLine = (name) => {
  try {
    return readFileSync(join(agentDir, name), 'utf8').trim();
  } catch {
    return '';
  }
};
const usable = (file) => {
  if (!file || !file.startsWith('/')) return false;
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};
const machine = readLine('machine');
const source = readLine('source');

let target = null;
let viaNode = false;
if (source === 'machine' && usable(machine)) target = machine;
if (!target) {
  const current = join(agentDir, 'current');
  try {
    const entry = JSON.parse(readFileSync(join(current, '.agent-hub-entry.json'), 'utf8'));
    if (entry && typeof entry.path === 'string') {
      const file = resolve(current, entry.path);
      if (existsSync(file)) {
        target = file;
        viaNode = entry.kind === 'node-script';
      }
    }
  } catch {
    // 没有 current 或没有入口元数据：继续看机器自带
  }
}
if (!target && usable(machine)) target = machine;
if (!target) {
  process.stderr.write('没有可用的 ' + agentId + '；请在 hub 机器页安装或恢复机器自带的版本\\n');
  process.exit(127);
}

const child = viaNode
  ? spawn(process.execPath, [target, ...args], { stdio: 'inherit' })
  : spawn(target, args, { stdio: 'inherit' });
// 调度壳只是转发层：Worker 发 SIGTERM/SIGINT 给壳时，要一并停掉真正的 agent，
// 否则会留下一个没人管的 opencode 进程。
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    child.kill(signal);
  });
}
child.on('error', (error) => {
  process.stderr.write(String(error && error.message ? error.message : error) + '\\n');
  process.exit(127);
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 127)));
`;

export function createRuntimeStore(options: { readonly root: string; readonly node?: string }): RuntimeStore {
  const root = options.root;
  const node = options.node ?? process.execPath;
  const binDir = join(root, 'bin');
  const check = (...segments: string[]): void => {
    for (const segment of segments) if (!SAFE_SEGMENT.test(segment) || segment === '.' || segment === '..') throw new Error(`不合法的名字：${segment}`);
  };
  const dispatchFile = join(root, 'dispatch.mjs');
  const ensureRoot = (): void => {
    mkdirSync(root, { recursive: true });
  };
  const writeFileAtomic = (file: string, body: string, mode?: number): void => {
    mkdirSync(join(file, '..'), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, body);
    if (mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, file);
  };
  const writeShim = (file: string, body: string): void => writeFileAtomic(file, body, 0o755);
  /** <root>/<agent>/{machine,source}：一行文本，值 null = 删掉。 */
  const writeLine = (agentId: string, name: 'machine' | 'source', value: string | null): void => {
    const file = join(root, agentId, name);
    if (value === null || value === '') rmSync(file, { force: true });
    else writeFileAtomic(file, `${value}\n`);
  };
  const readLine = (agentId: string, name: 'machine' | 'source'): string => {
    try {
      return readFileSync(join(root, agentId, name), 'utf8').trim();
    } catch {
      return '';
    }
  };
  const shimBody = (target: string, entry: InstalledEntry): string =>
    `#!/bin/sh\n# agent-hub 安装的运行时（ADR 0010）；卸载请在 hub 界面上点「卸载」\nexec ${entry.kind === 'node-script' ? `${quote(node)} ` : ''}${quote(target)} "$@"\n`;
  const dispatchBody = (agentId: string): string =>
    `#!/bin/sh\n# agent-hub 运行时调度（ADR 0010）；版本切换在 hub 机器页\nexec ${quote(node)} ${quote(dispatchFile)} ${quote(agentId)} "$@"\n`;
  const preferenceOf = (agentId: string): 'machine' | 'hub' | null => {
    const value = readLine(agentId, 'source');
    return value === 'machine' || value === 'hub' ? value : null;
  };
  const writeDispatchFiles = (agentId: string, command: string): void => {
    check(agentId, command);
    ensureRoot();
    let current: string | null = null;
    try {
      current = readFileSync(dispatchFile, 'utf8');
    } catch {
      // 第一次写
    }
    if (current !== DISPATCH_SCRIPT) writeFileAtomic(dispatchFile, DISPATCH_SCRIPT);
    writeShim(join(binDir, command), dispatchBody(agentId));
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
    machinePath(agentId) {
      check(agentId);
      const value = readLine(agentId, 'machine');
      return value === '' ? null : value;
    },
    setMachine(agentId, path) {
      check(agentId);
      writeLine(agentId, 'machine', path === null ? null : path.trim());
    },
    preference(agentId) {
      check(agentId);
      return preferenceOf(agentId);
    },
    setPreference(agentId, source) {
      check(agentId);
      writeLine(agentId, 'source', source);
    },
    writeDispatch(agentId, command) {
      writeDispatchFiles(agentId, command);
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
      writeFileSync(join(target, '.agent-hub-entry.json'), JSON.stringify(entry));
      for (const name of readdirSync(dir)) {
        if (name === version || name === 'current' || name === 'machine' || name === 'source' || name.startsWith('.staging-')) continue;
        rmSync(join(dir, name), { recursive: true, force: true });
      }
      writeDispatchFiles(agentId, command);
    },
    remove(agentId, command) {
      check(agentId, command);
      const dir = join(root, agentId);
      const wasHub = preferenceOf(agentId) === 'hub';
      let names: string[] = [];
      try {
        names = readdirSync(dir);
      } catch {
        names = [];
      }
      // 机器自带那份的路径和用户的选择留着：卸掉 hub 的版本后还能切回去；选了 hub 的选择作废。
      for (const name of names) {
        if (name === 'machine' || name === 'source') continue;
        rmSync(join(dir, name), { recursive: true, force: true });
      }
      if (wasHub) writeLine(agentId, 'source', null);
      // 调度垫片留着：hub 版本没了就回落到机器自带，用户还能再装回来
      writeDispatchFiles(agentId, command);
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
