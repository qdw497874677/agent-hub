import { readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { redactSecrets } from './redact.ts';
import { isEqualOrDescendantPath } from './path-boundary.ts';

/**
 * 只读的进程 / 端口清单（不做进程管理，不落库）。
 *
 * 和 preview-scan 一样从 `/proc` 读，读不到就当作没有，不抛错：
 * - 进程只收 cwd 落在 `roots` 之内的，避免把整机系统进程倒给 hub；
 * - 命令行是不可信内容：先按 `redact.ts` 统一打码（`--token` / `KEY=value` / URL 凭据 /
 *   Bearer / sk-… 等），再截到 200 字；
 * - 端口从 `/proc/net/tcp{,6}` 的 LISTEN（state `0A`）拿 inode，再扫 `/proc/<pid>/fd/*`
 *   里指向 `socket:[inode]` 的符号链接反查。
 */

export interface ProcessInfo {
  readonly pid: number;
  readonly ppid: number;
  readonly cmd: string;
  readonly cwd: string;
  readonly ports: number[];
}

export interface ScanProcessesOptions {
  /** 只收 cwd 在这些目录里的进程（Worker 的 WORKER_ROOTS）。 */
  readonly roots: readonly string[];
  /** `/proc` 的替身（测试注入临时目录）；默认 `/proc`。 */
  readonly procRoot?: string;
  /** 最多返回多少条；按 pid 升序取最小的这些。 */
  readonly limit?: number;
}

/** 命令行截断长度（凭据已先抹掉）。 */
export const PROCESS_CMD_MAX = 200;
const MAX_PORT = 65535;

function readLines(file: string): string[] {
  try {
    return readFileSync(file, 'utf8').split('\n');
  } catch {
    return [];
  }
}

/** `ADDR:PORT` 里取端口；LISTEN 行只在 `fields[3] === '0A'` 时才收。 */
function listenPortsByInode(root: string): Map<string, number[]> {
  const byInode = new Map<string, number[]>();
  for (const name of ['tcp', 'tcp6']) {
    for (const line of readLines(join(root, 'net', name))) {
      const fields = line.trim().split(/\s+/);
      // sl local rem state tx:rx tr:tm retrnsmt uid timeout inode
      if (fields.length < 10) continue;
      if (fields[3] !== '0A') continue;
      const local = fields[1] ?? '';
      const colon = local.lastIndexOf(':');
      if (colon <= 0) continue;
      const port = Number.parseInt(local.slice(colon + 1), 16);
      if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) continue;
      const inode = fields[9] ?? '';
      if (inode === '' || inode === '0') continue;
      const ports = byInode.get(inode) ?? [];
      ports.push(port);
      byInode.set(inode, ports);
    }
  }
  return byInode;
}

/** 从 `/proc/<pid>/fd/*` 里找出这个进程持有的 LISTEN socket 端口。 */
function portsOf(pidDir: string, byInode: ReadonlyMap<string, number[]>): number[] {
  const ports = new Set<number>();
  let fds: string[];
  try {
    fds = readdirSync(join(pidDir, 'fd'));
  } catch {
    return [];
  }
  for (const fd of fds) {
    let target: string;
    try {
      target = readlinkSync(join(pidDir, 'fd', fd));
    } catch {
      continue;
    }
    const match = /^socket:\[(\d+)\]$/.exec(target);
    if (!match) continue;
    for (const port of byInode.get(match[1] ?? '') ?? []) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

/** `/proc/<pid>/cmdline` 是 NUL 分隔的 argv；不可读 / 空（内核线程）返回空串。 */
function cmdOf(pidDir: string): string {
  let raw: string;
  try {
    raw = readFileSync(join(pidDir, 'cmdline'), 'utf8');
  } catch {
    return '';
  }
  return redactSecrets(raw.split('\0').filter((part) => part !== '').join(' ').trim()).slice(0, PROCESS_CMD_MAX);
}

/** `/proc/<pid>/stat`：`pid (comm) state ppid ...`，comm 里可能有空格 / 括号，所以从最后一个 `)` 后面数。 */
function ppidOf(stat: string): number | null {
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  // state ppid pgrp ...
  const ppid = Number.parseInt(fields[1] ?? '', 10);
  return Number.isInteger(ppid) ? ppid : null;
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** cwd 是否落在某个 root 之内（root 本身也算）。 */
function underRoot(cwd: string, roots: readonly string[]): boolean {
  return roots.some((root) => isEqualOrDescendantPath(root, cwd));
}

/** 按 pid 数字升序的 `/proc/<pid>` 名字；只留纯数字目录。 */
function pidDirs(root: string): string[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names
    .filter((name) => /^\d+$/.test(name))
    .sort((a, b) => Number(a) - Number(b));
}

/**
 * 这台机器上 cwd 落在 `roots` 里的进程，按 pid 升序，最多 `limit` 条。
 * 不抛错：单个进程读不到（权限、正在退出）就跳过。
 */
export function scanProcesses(options: ScanProcessesOptions): ProcessInfo[] {
  const root = options.procRoot ?? '/proc';
  const rawLimit = options.limit;
  const limit = rawLimit !== undefined && Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : 200;
  // 两侧都 realpath，符号链接目录下的进程不会因为写法不同被漏掉 / 误收。
  const roots = options.roots.map(realpathOr);
  if (roots.length === 0) return [];
  const byInode = listenPortsByInode(root);
  const result: ProcessInfo[] = [];

  for (const name of pidDirs(root)) {
    if (result.length >= limit) break;
    const pid = Number(name);
    const pidDir = join(root, name);
    let cwd: string;
    try {
      cwd = realpathOr(readlinkSync(join(pidDir, 'cwd')));
    } catch {
      continue;
    }
    if (!underRoot(cwd, roots)) continue;
    let stat: string;
    try {
      stat = readFileSync(join(pidDir, 'stat'), 'utf8');
    } catch {
      continue;
    }
    const ppid = ppidOf(stat);
    if (ppid === null) continue;
    result.push({ pid, ppid, cmd: cmdOf(pidDir), cwd, ports: portsOf(pidDir, byInode) });
  }
  return result;
}
