import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { PROCESS_CMD_MAX, scanProcesses, verifyListenerIdentity } from './process-scan.ts';

/**
 * 进程 / 端口清单：临时目录冒充 /proc。
 * 覆盖：根内进程被收、根外跳过、LISTEN inode → fd 的端口映射、命令行脱敏与截断。
 */

const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';

/** /proc/net/tcp 一行：本地地址、远端地址、状态（0A = LISTEN）、inode。 */
function procLine(local: string, state: string, inode: number): string {
  return `   0: ${local} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0`;
}

interface FakeProc {
  readonly root: string;
  close(): void;
}

function fakeProc(tcp: readonly string[] = []): FakeProc {
  const root = mkdtempSync(join(tmpdir(), 'ah-process-scan-'));
  mkdirSync(join(root, 'net'), { recursive: true });
  writeFileSync(join(root, 'net', 'tcp'), [HEADER, ...tcp, ''].join('\n'));
  writeFileSync(join(root, 'net', 'tcp6'), `${HEADER}\n`);
  return { root, close: () => rmSync(root, { recursive: true, force: true }) };
}

interface FakeProcess {
  readonly pid: number;
  readonly ppid: number;
  readonly cwd: string;
  /** argv；写成 cmdline 时 NUL 分隔。 */
  readonly argv?: readonly string[];
  /** fd 里的 socket:[inode] 目标。 */
  readonly sockets?: readonly number[];
}

function addProcess(root: string, process: FakeProcess): void {
  const dir = join(root, String(process.pid));
  mkdirSync(dir, { recursive: true });
  symlinkSync(process.cwd, join(dir, 'cwd'));
  writeFileSync(join(dir, 'stat'), `${process.pid} (node) S ${process.ppid} ${process.pid} ${process.pid} 0 -1 4194560 0 0 0 0 0 0 0 20 0 1 0 0 0 0 0 0 0 0 0 0 0 0 0\n`);
  writeFileSync(join(dir, 'cmdline'), `${(process.argv ?? []).join('\0')}\0`);
  mkdirSync(join(dir, 'fd'), { recursive: true });
  (process.sockets ?? []).forEach((inode, index) => {
    symlinkSync(`socket:[${inode}]`, join(dir, 'fd', String(index + 3)));
  });
}

test('scanProcesses：只收 cwd 在 roots 内的进程，按 pid 升序，命令行 / cwd / ppid 都带上', () => {
  const proc = fakeProc();
  const workspace = join(proc.root, 'workspace');
  const outside = join(proc.root, 'outside');
  mkdirSync(join(workspace, 'sub'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  addProcess(proc.root, { pid: 300, ppid: 1, cwd: workspace, argv: ['node', 'server.js'] });
  addProcess(proc.root, { pid: 100, ppid: 50, cwd: join(workspace, 'sub'), argv: ['npm', 'run', 'dev'] });
  addProcess(proc.root, { pid: 200, ppid: 1, cwd: outside, argv: ['unrelated'] });
  try {
    const processes = scanProcesses({ roots: [workspace], procRoot: proc.root });
    assert.deepEqual(processes.map((process) => process.pid), [100, 300]);
    assert.equal(processes[0]?.ppid, 50);
    assert.equal(processes[0]?.cmd, 'npm run dev');
    assert.equal(processes[0]?.cwd, realpathSync(join(workspace, 'sub')));
    assert.deepEqual(processes[0]?.ports, []);
  } finally {
    proc.close();
  }
});

test('scanProcesses：LISTEN inode 经 /proc/<pid>/fd 反查成端口，去重升序；非 LISTEN 不算', () => {
  const proc = fakeProc([
    // 0.0.0.0:3000，LISTEN，inode 4242
    procLine('00000000:0BB8', '0A', 4242),
    // 127.0.0.1:5173，LISTEN，inode 7777
    procLine('0100007F:1435', '0A', 7777),
    // ESTABLISHED 的 inode 不该变成端口
    procLine('0100007F:1F90', '01', 9999)
  ]);
  const workspace = join(proc.root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  addProcess(proc.root, { pid: 10, ppid: 1, cwd: workspace, argv: ['vite'], sockets: [7777, 4242, 9999] });
  addProcess(proc.root, { pid: 20, ppid: 1, cwd: workspace, argv: ['idle'] });
  try {
    const processes = scanProcesses({ roots: [workspace], procRoot: proc.root });
    assert.deepEqual(processes.map((process) => [process.pid, process.ports]), [[10, [3000, 5173]], [20, []]]);
  } finally {
    proc.close();
  }
});

test('scanProcesses：命令行先抹 user:token@ 凭据再截断；读不到 cwd / stat 的进程跳过；limit 按 pid 取最小', () => {
  const proc = fakeProc();
  const workspace = join(proc.root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  addProcess(proc.root, {
    pid: 7,
    ppid: 1,
    cwd: workspace,
    argv: ['git', 'clone', 'https://user:secret1234@example.com/repo.git']
  });
  addProcess(proc.root, { pid: 8, ppid: 1, cwd: workspace, argv: ['x'.repeat(PROCESS_CMD_MAX * 3)] });
  // 没有 cwd 符号链接的进程（正在退出 / 没权限）
  mkdirSync(join(proc.root, '9'), { recursive: true });
  try {
    const all = scanProcesses({ roots: [workspace], procRoot: proc.root });
    assert.deepEqual(all.map((process) => process.pid), [7, 8]);
    assert.equal(all[0]?.cmd, 'git clone https://user:***@example.com/repo.git');
    assert.equal(all[1]?.cmd.length, PROCESS_CMD_MAX);
    assert.equal(all[1]?.cmd, 'x'.repeat(PROCESS_CMD_MAX));

    const one = scanProcesses({ roots: [workspace], procRoot: proc.root, limit: 1 });
    assert.deepEqual(one.map((process) => process.pid), [7]);
  } finally {
    proc.close();
  }
});

test('scanProcesses：没有 roots / /proc 读不到时返回空数组，不抛错', () => {
  assert.deepEqual(scanProcesses({ roots: [], procRoot: join(tmpdir(), 'ah-missing-proc') }), []);
  assert.deepEqual(scanProcesses({ roots: ['/tmp'], procRoot: join(tmpdir(), 'ah-missing-proc') }), []);
});

test('real loopback listener identity expires when its socket is replaced on the same port', async () => {
  const first = createServer();
  first.listen(0, '127.0.0.1');
  await once(first, 'listening');
  const port = (first.address() as AddressInfo).port;
  const identity = scanProcesses({ roots: [process.cwd()] }).find((p) => p.pid === process.pid)?.listeners?.find((l) => l.port === port)?.identity;
  assert.ok(identity);
  assert.equal(verifyListenerIdentity(port, identity), true);
  await new Promise<void>((resolve) => first.close(() => resolve()));
  const replacement = createServer();
  replacement.listen(port, '127.0.0.1');
  await once(replacement, 'listening');
  try {
    assert.equal(verifyListenerIdentity(port, identity), false);
    const next = scanProcesses({ roots: [process.cwd()] }).find((p) => p.pid === process.pid)?.listeners?.find((l) => l.port === port)?.identity;
    assert.ok(next);
    assert.notEqual(identity, next);
    assert.equal(verifyListenerIdentity(port, next), true);
  } finally {
    await new Promise<void>((resolve) => replacement.close(() => resolve()));
  }
});

test('ambiguous shared socket, competing listener and non-loopback address are excluded without altering ports', () => {
  const proc = fakeProc([
    procLine('0100007F:1388', '0A', 100),
    procLine('0100007F:1389', '0A', 101),
    procLine('00000000:1389', '0A', 102),
    procLine('0101A8C0:138A', '0A', 103)
  ]);
  const workspace = join(proc.root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(proc.root, 'sys/kernel/random'), { recursive: true });
  writeFileSync(join(proc.root, 'sys/kernel/random/boot_id'), 'boot-id');
  mkdirSync(join(proc.root, 'self/ns'), { recursive: true });
  symlinkSync('net:[1]', join(proc.root, 'self/ns/net'));
  addProcess(proc.root, { pid: 10, ppid: 1, cwd: workspace, sockets: [100, 101, 103] });
  addProcess(proc.root, { pid: 20, ppid: 1, cwd: workspace, sockets: [100, 102] });
  for (const pid of [10, 20]) {
    mkdirSync(join(proc.root, String(pid), 'ns'));
    symlinkSync('net:[1]', join(proc.root, String(pid), 'ns/net'));
  }
  try {
    const processes = scanProcesses({ roots: [workspace], procRoot: proc.root });
    assert.deepEqual(processes.map((p) => p.ports), [[5000, 5001, 5002], [5000, 5001]]);
    assert.deepEqual(processes.map((p) => p.listeners), [[], []]);
  } finally { proc.close(); }
});

test('listener authority follows the canonical exact cwd and rejects changed, missing or deleted cwd', () => {
  const proc = fakeProc([procLine('0100007F:1388', '0A', 100)]);
  const workspace = join(proc.root, 'workspace');
  const other = join(workspace, 'other');
  mkdirSync(other, { recursive: true });
  mkdirSync(join(proc.root, 'sys/kernel/random'), { recursive: true });
  writeFileSync(join(proc.root, 'sys/kernel/random/boot_id'), 'boot-id');
  mkdirSync(join(proc.root, 'self/ns'), { recursive: true });
  symlinkSync('net:[1]', join(proc.root, 'self/ns/net'));
  symlinkSync('mnt:[1]', join(proc.root, 'self/ns/mnt'));
  symlinkSync('/', join(proc.root, 'self/root'));
  writeFileSync(join(proc.root, 'self/mountinfo'), '1 0 1:1 / / rw - ext4 /dev/root rw\n');
  addProcess(proc.root, { pid: 10, ppid: 1, cwd: workspace, sockets: [100] });
  mkdirSync(join(proc.root, '10/ns'));
  symlinkSync('net:[1]', join(proc.root, '10/ns/net'));
  symlinkSync('mnt:[1]', join(proc.root, '10/ns/mnt'));
  symlinkSync('/', join(proc.root, '10/root'));
  const cwdLink = join(proc.root, '10/cwd');
  const changeCwd = (target: string): void => { unlinkSync(cwdLink); symlinkSync(target, cwdLink); };
  try {
    const original = scanProcesses({ roots: [workspace], procRoot: proc.root })[0]?.listeners?.[0]?.identity;
    assert.ok(original);
    assert.equal(scanProcesses({ roots: [workspace], procRoot: proc.root })[0]?.cwdVerified, true);
    assert.equal(verifyListenerIdentity(5000, original), true);
    unlinkSync(join(proc.root, '10/ns/mnt'));
    symlinkSync('mnt:[2]', join(proc.root, '10/ns/mnt'));
    assert.equal(verifyListenerIdentity(5000, original), false);
    assert.equal(scanProcesses({ roots: [workspace], procRoot: proc.root })[0]?.cwdVerified, undefined);
    unlinkSync(join(proc.root, '10/ns/mnt'));
    symlinkSync('mnt:[1]', join(proc.root, '10/ns/mnt'));
    unlinkSync(join(proc.root, '10/root'));
    symlinkSync(workspace, join(proc.root, '10/root'));
    assert.equal(verifyListenerIdentity(5000, original), false);
    assert.equal(scanProcesses({ roots: [workspace], procRoot: proc.root })[0]?.cwdVerified, undefined);
    unlinkSync(join(proc.root, '10/root'));
    symlinkSync('/', join(proc.root, '10/root'));
    changeCwd(other);
    assert.equal(verifyListenerIdentity(5000, original), false);
    const changed = scanProcesses({ roots: [workspace], procRoot: proc.root })[0]?.listeners?.[0]?.identity;
    assert.ok(changed);
    assert.notEqual(changed, original);
    assert.equal(verifyListenerIdentity(5000, changed), true);
    changeCwd(`${other} (deleted)`);
    assert.equal(verifyListenerIdentity(5000, changed), false);
    assert.deepEqual(scanProcesses({ roots: [workspace], procRoot: proc.root })[0]?.listeners, []);
    changeCwd(join(workspace, 'missing'));
    assert.equal(verifyListenerIdentity(5000, changed), false);
    assert.deepEqual(scanProcesses({ roots: [workspace], procRoot: proc.root })[0]?.listeners, []);
  } finally { proc.close(); }
});

test('real process chdir invalidates listener identity while socket and pid stay unchanged', async () => {
  const originalCwd = process.cwd();
  const workspace = mkdtempSync(join(tmpdir(), 'ah-listener-cwd-'));
  const other = join(workspace, 'other');
  mkdirSync(other);
  const server = createServer();
  try {
    process.chdir(workspace);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;
    const identity = scanProcesses({ roots: [workspace] }).find((p) => p.pid === process.pid)?.listeners?.find((l) => l.port === port)?.identity;
    assert.ok(identity);
    assert.equal(verifyListenerIdentity(port, identity), true);
    process.chdir(other);
    assert.equal(verifyListenerIdentity(port, identity), false);
    const next = scanProcesses({ roots: [workspace] }).find((p) => p.pid === process.pid)?.listeners?.find((l) => l.port === port)?.identity;
    assert.ok(next);
    assert.notEqual(next, identity);
    assert.equal(verifyListenerIdentity(port, next), true);
  } finally {
    process.chdir(originalCwd);
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(workspace, { recursive: true, force: true });
  }
});
