import { readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { Socket } from 'node:net';
import { redactSecrets } from './redact.ts';
import { isEqualOrDescendantPath } from './path-boundary.ts';
import { unaliasedMountPath } from './mount-alias.ts';

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
  readonly cwdVerified?: true;
  readonly ports: number[];
  readonly listeners?: { port: number; identity: string }[];
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
// Per Worker process realm: a restart invalidates all earlier observations.
const realm = randomBytes(32).toString('hex');
type ListenerEvidence = { root: string; pid: number; start: string; inode: string; port: number; boot: string; netns: string; cwd: string; mnt: string; rootDev: number; rootIno: number };
const evidence = new Map<string, ListenerEvidence>();
const MAX_EVIDENCE = 4096;

function startTime(stat: string): string | null {
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const start = stat.slice(close + 1).trim().split(/\s+/)[19];
  return start && /^\d+$/.test(start) ? start : null;
}

/** Only a unique IPv4 wildcard/127.0.0.1 listener is eligible. Any tcp6
 * listener on the same port is conservatively ambiguous (dual-stack). */
function loopbackListeners(root: string): Map<number, string> {
  const candidates = new Map<number, string[]>();
  for (const name of ['tcp', 'tcp6']) {
    let content: string;
    try { content = readFileSync(join(root, 'net', name), 'utf8'); } catch { return new Map(); }
    for (const line of content.split('\n')) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] !== '0A') continue;
      const [address, hexPort] = (fields[1] ?? '').split(':');
      const port = Number.parseInt(hexPort ?? '', 16);
      if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) continue;
      if (name === 'tcp' && address !== '00000000' && address !== '0100007F') continue;
      const list = candidates.get(port) ?? [];
      // An IPv6 listener may be dual stack; don't guess IPV6_V6ONLY from /proc.
      list.push(name === 'tcp6' ? '' : (fields[9] ?? ''));
      candidates.set(port, list);
    }
  }
  return new Map([...candidates].filter(([, values]) => values.length === 1 && /^\d+$/.test(values[0] ?? '') && values[0] !== '0').map(([port, values]) => [port, values[0]!]));
}

function socketInodes(pidDir: string): Set<string> {
  const result = new Set<string>();
  let fds: string[];
  try { fds = readdirSync(join(pidDir, 'fd')); } catch { return result; }
  for (const fd of fds) {
    try {
      const match = /^socket:\[(\d+)\]$/.exec(readlinkSync(join(pidDir, 'fd', fd)));
      if (match?.[1]) result.add(match[1]);
    } catch { /* A process may close an fd while being inspected. */ }
  }
  return result;
}

function ownersOf(root: string, inodes: ReadonlySet<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const name of pidDirs(root)) {
    for (const inode of socketInodes(join(root, name))) {
      if (inodes.has(inode)) counts.set(inode, (counts.get(inode) ?? 0) + 1);
    }
  }
  return counts;
}

function identityOf(item: ListenerEvidence): string {
  return createHash('sha256').update(JSON.stringify([realm, item.boot, item.netns, item.pid, item.start, item.inode, item.port, item.cwd, item.mnt, item.rootDev, item.rootIno])).digest('hex');
}

function sameFilesystemView(root: string, pidDir: string): { mnt: string; rootDev: number; rootIno: number } {
  const mnt = readlinkSync(join(root, 'self/ns/mnt'));
  if (readlinkSync(join(pidDir, 'ns/mnt')) !== mnt) throw new Error('different mount namespace');
  const selfRoot = statSync(join(root, 'self/root'));
  const processRoot = statSync(join(pidDir, 'root'));
  if (selfRoot.dev !== processRoot.dev || selfRoot.ino !== processRoot.ino) throw new Error('different process root');
  return { mnt, rootDev: selfRoot.dev, rootIno: selfRoot.ino };
}

/** Unlike display-only cwd handling, authority requires a live canonical directory. */
function canonicalProcessCwd(pidDir: string): string {
  const target = readlinkSync(join(pidDir, 'cwd'));
  if (!isAbsolute(target) || target.endsWith(' (deleted)')) throw new Error('invalid process cwd');
  const canonical = realpathSync(target);
  const actual = statSync(join(pidDir, 'cwd'));
  const resolved = statSync(canonical);
  if (!actual.isDirectory() || actual.dev !== resolved.dev || actual.ino !== resolved.ino) throw new Error('cwd changed or not a directory');
  return canonical;
}

/** Revalidate without a process-wide rescan; false is always fail-closed. */
export function verifyListenerIdentity(port: number, identity: string): boolean {
  const item = evidence.get(identity);
  if (!item || item.port !== port) return false;
  try {
    const view = sameFilesystemView(item.root, join(item.root, String(item.pid)));
    return readFileSync(join(item.root, 'sys/kernel/random/boot_id'), 'utf8').trim() === item.boot
      && view.mnt === item.mnt && view.rootDev === item.rootDev && view.rootIno === item.rootIno
      && readlinkSync(join(item.root, 'self/ns/net')) === item.netns
      && readlinkSync(join(item.root, String(item.pid), 'ns/net')) === item.netns
      && startTime(readFileSync(join(item.root, String(item.pid), 'stat'), 'utf8')) === item.start
      && canonicalProcessCwd(join(item.root, String(item.pid))) === item.cwd
      && unaliasedMountPath(item.cwd, item.root)
      && loopbackListeners(item.root).get(port) === item.inode
      && socketInodes(join(item.root, String(item.pid))).has(item.inode);
  } catch { return false; }
}

/** Correlate the connected client's exact reverse tuple with an accepted fd
 * held by the same process. Multi-process acceptors are intentionally refused. */
export async function verifyConnectedListener(socket: Socket, port: number, identity: string): Promise<boolean> {
  const item = evidence.get(identity);
  if (!item || item.port !== port || socket.localAddress !== '127.0.0.1' || socket.remoteAddress !== '127.0.0.1' || socket.remotePort !== port || !socket.localPort) return false;
  const local = `0100007F:${port.toString(16).toUpperCase().padStart(4, '0')}`;
  const remote = `0100007F:${socket.localPort.toString(16).toUpperCase().padStart(4, '0')}`;
  const deadline = Date.now() + 500;
  do {
    if (socket.destroyed) return false;
    let rows: string[];
    try { rows = readFileSync(join(item.root, 'net/tcp'), 'utf8').split('\n'); } catch { return false; }
    const matching = rows.map((row) => row.trim().split(/\s+/)).filter((fields) => fields[1] === local && fields[2] === remote && fields[3] === '01' && /^\d+$/.test(fields[9] ?? '') && fields[9] !== '0');
    if (matching.length > 1) return false;
    if (matching.length === 1 && socketInodes(join(item.root, String(item.pid))).has(matching[0]![9]!)) {
      return verifyListenerIdentity(port, identity);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  return false;
}

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
  const verifiedRoots = options.roots.flatMap((path) => { try { const actual = realpathSync(path); return statSync(actual).isDirectory() ? [actual] : []; } catch { return []; } });
  if (roots.length === 0) return [];
  const byInode = listenPortsByInode(root);
  const eligible = loopbackListeners(root);
  // A socket inherited or shared by multiple processes cannot be attributed
  // safely to either process, even if only one process is inside roots.
  const ownerCounts = ownersOf(root, new Set(eligible.values()));
  let boot = '';
  let netns = '';
  try {
    boot = readFileSync(join(root, 'sys/kernel/random/boot_id'), 'utf8').trim();
    netns = readlinkSync(join(root, 'self/ns/net'));
  } catch { /* No identity evidence if the Worker realm cannot be established. */ }
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
    const listeners: { port: number; identity: string }[] = [];
    const start = startTime(stat);
    let cwdVerified = false;
    try {
      const view = sameFilesystemView(root, pidDir);
      cwdVerified = canonicalProcessCwd(pidDir) === cwd && underRoot(cwd, verifiedRoots) && unaliasedMountPath(cwd, root);
      if (cwdVerified && boot && netns && start && readlinkSync(join(pidDir, 'ns/net')) === netns) {
        const sockets = socketInodes(pidDir);
        for (const [port, inode] of eligible) {
          if (!sockets.has(inode) || ownerCounts.get(inode) !== 1) continue;
          const item = { root, pid, start, inode, port, boot, netns, cwd, ...view };
          const identity = identityOf(item);
          evidence.delete(identity);
          evidence.set(identity, item);
          while (evidence.size > MAX_EVIDENCE) evidence.delete(evidence.keys().next().value!);
          listeners.push({ port, identity });
          if (listeners.length >= 256) break;
        }
      }
    } catch { /* Process exited or namespace is not visible. */ }
    result.push({ pid, ppid, cmd: cmdOf(pidDir), cwd, ports: portsOf(pidDir, byInode), listeners, ...(cwdVerified ? { cwdVerified: true as const } : {}) });
  }
  return result;
}
