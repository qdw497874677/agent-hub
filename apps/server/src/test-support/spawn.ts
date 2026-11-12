import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';

export interface SpawnHubOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** 子进程 stdout/stderr 都追加到这个文件；不再用 pipe。 */
  logFile: string;
  detached?: boolean;
  shell?: boolean;
}

const grouped = new WeakSet<ChildProcess>();

/**
 * 起一个 hub / worker / 占位子进程。
 * stdio 固定不用 pipe：pipe 句柄是 `npm test` 挂住不返回的根因，日志直接写文件。
 */
export function spawnHub(command: string, args: string[], options: SpawnHubOptions): ChildProcess {
  const fd = openSync(options.logFile, 'a');
  try {
    const child = spawn(command, args, {
      env: options.env,
      cwd: options.cwd,
      detached: options.detached,
      shell: options.shell,
      stdio: ['ignore', fd, fd]
    });
    if (options.detached) grouped.add(child);
    return child;
  } finally {
    closeSync(fd);
  }
}

/** 读子进程日志（断言失败时拼进 message）。 */
export function readHubLog(logFile: string): string {
  try {
    return readFileSync(logFile, 'utf8');
  } catch {
    return '';
  }
}

/** 让内核分配一个空闲端口：listen(0) 拿到后立刻 close，最多重试 3 次。 */
export async function reservePort(attempts = 3): Promise<number> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await new Promise<number>((resolve, reject) => {
        const server = createServer();
        server.unref();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          const port = typeof address === 'object' && address ? address.port : 0;
          server.close((error) => (error ? reject(error) : resolve(port)));
        });
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('分配不到空闲端口');
}

async function waitExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref();
  });
  const exited = once(child, 'exit').then(
    () => true,
    () => true
  );
  try {
    return await Promise.race([exited, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** SIGTERM → 等最多 3s → 还没退就 SIGKILL；detached 的子进程按进程组杀。 */
export async function stop(child: ChildProcess, graceMs = 3000): Promise<void> {
  if (!child.pid) return;
  const pid = child.pid;
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(grouped.has(child) ? -pid : pid, name);
    } catch {
      try {
        child.kill(name);
      } catch {
        // 已经退出了
      }
    }
  };

  if (child.exitCode !== null || child.signalCode !== null) return;
  signal('SIGTERM');
  if (await waitExit(child, graceMs)) return;
  signal('SIGKILL');
  await waitExit(child, graceMs);
}
