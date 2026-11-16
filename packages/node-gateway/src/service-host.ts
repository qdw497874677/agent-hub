import { readFileSync, realpathSync } from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { ServiceRestart, ServiceState } from '@agent-hub/domain';
import { scrubCredentials, setupEnv, tailOutput } from './setup-script.ts';

/**
 * 会话服务（docs/design/session-service.md §5）：Worker 侧的本地长驻进程。
 *
 * 规则都在这里落地：root 必须落在 WORKER_ROOTS 内（realpath 后比较）、`/bin/sh -lc` 起进程并
 * `detached` 成独立进程组、端口声明了就 30 秒内确认在听、`restart: 'always'` 才按 1s/5s/30s 重拉、
 * 停的时候先 SIGTERM 整组再 3 秒后 SIGKILL、日志只留尾部 8 KiB。
 *
 * 状态与日志都通过回调往上抛：worker-link 把它们转成 `service_state` / `service_log` 帧。
 */

export const SERVICE_PORT_TIMEOUT_MS = 30_000;
export const SERVICE_LOG_MAX = 8 * 1024;
/** 重拉退避：第 1 次 1s、第 2 次 5s、之后都是 30s；最多 5 次。 */
const RETRY_DELAYS = [1_000, 5_000, 30_000, 30_000, 30_000];
const RETRY_MAX = RETRY_DELAYS.length;
const PORT_POLL_MS = 200;
const STOP_GRACE_MS = 3_000;

export interface ServiceSpec {
  readonly serviceId: string;
  readonly root: string;
  readonly command: string;
  readonly port: number | null;
  readonly env: Readonly<Record<string, string>>;
  readonly restart: ServiceRestart;
}

export interface ServiceStateEvent {
  readonly serviceId: string;
  readonly state: ServiceState;
  readonly pid: number | null;
  readonly detail: string | null;
  readonly port: number | null;
}

export interface ServiceRuntimeInfo {
  readonly serviceId: string;
  readonly pid: number | null;
  readonly state: ServiceState;
  readonly port: number | null;
}

export interface ServiceHostOptions {
  /** WORKER_ROOTS：服务目录必须落在这些根之内。 */
  readonly roots: readonly string[];
  readonly onState: (event: ServiceStateEvent) => void;
  readonly onLog: (serviceId: string, chunk: string) => void;
  /** `/proc` 的位置；测试用临时目录替身，不依赖真实网络。 */
  readonly procRoot?: string;
  /** 落盘位置；默认 `<WORKER_ROOTS[0]>/../.agent-hub/services.json`。 */
  readonly statePath?: string;
  readonly log?: (message: string) => void;
}

export interface ServiceHost {
  start(spec: ServiceSpec): Promise<{ pid: number; port: number | null }>;
  stop(serviceId: string, signal?: 'TERM' | 'KILL'): Promise<{ exited: boolean }>;
  list(): readonly ServiceRuntimeInfo[];
  logs(serviceId: string, maxBytes?: number): string;
  /** Worker 重启后按 services.json 重拉 `always` 的服务，其余标 failed。 */
  revive(): Promise<void>;
  dispose(): void;
}

export class ServiceHostError extends Error {
  readonly code: 'invalid' | 'failed' | 'conflict' | 'not_found';
  constructor(code: 'invalid' | 'failed' | 'conflict' | 'not_found', message: string) {
    super(message);
    this.code = code;
  }
}

interface Entry {
  spec: ServiceSpec;
  proc: ChildProcess | null;
  state: ServiceState;
  pid: number | null;
  port: number | null;
  detail: string | null;
  log: string;
  /** 已经重拉过几次；成功 running 后清零。 */
  attempts: number;
  retry: NodeJS.Timeout | null;
  portTimer: NodeJS.Timeout | null;
  /** 用户主动停：退出时不再重拉，也不报 failed。 */
  stopping: boolean;
}

interface PersistedEntry {
  readonly serviceId: string;
  readonly root: string;
  readonly command: string;
  readonly port: number | null;
  readonly env: Readonly<Record<string, string>>;
  readonly restart: ServiceRestart;
  readonly state: ServiceState;
}

/** 在 `/proc/net/tcp{,6}` 里找有没有端口在 LISTEN（0A）。 */
function listening(port: number, procRoot: string): boolean {
  for (const file of ['tcp', 'tcp6']) {
    let text: string;
    try {
      text = readFileSync(resolve(procRoot, 'net', file), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 4 || fields[3] !== '0A') continue;
      const local = fields[1] ?? '';
      const colon = local.lastIndexOf(':');
      if (colon < 0) continue;
      if (Number.parseInt(local.slice(colon + 1), 16) === port) return true;
    }
  }
  return false;
}

const inside = (root: string, candidate: string): boolean => candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);

export function createServiceHost(options: ServiceHostOptions): ServiceHost {
  const entries = new Map<string, Entry>();
  const procRoot = options.procRoot ?? '/proc';
  const statePath = options.statePath ?? resolve(options.roots[0] ?? '.', '..', '.agent-hub', 'services.json');
  const canonicalRoots = options.roots.map((root) => {
    try {
      return realpathSync(root);
    } catch {
      return resolve(root);
    }
  });
  let disposed = false;

  function emit(entry: Entry, state: ServiceState, detail: string | null = null): void {
    entry.state = state;
    entry.detail = detail;
    options.onState({
      serviceId: entry.spec.serviceId,
      state,
      pid: entry.pid,
      detail,
      port: entry.port
    });
  }

  function persist(): void {
    const rows: PersistedEntry[] = [...entries.values()].map((entry) => ({
      serviceId: entry.spec.serviceId,
      root: entry.spec.root,
      command: entry.spec.command,
      port: entry.spec.port,
      env: entry.spec.env,
      restart: entry.spec.restart,
      state: entry.state
    }));
    try {
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, JSON.stringify({ services: rows }, null, 2));
    } catch (error) {
      options.log?.(`服务清单落盘失败（${statePath}）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** root 必须在 WORKER_ROOTS 之内；不存在 / 不是目录都按 invalid。 */
  function checkedRoot(root: string): string {
    let canonical: string;
    try {
      canonical = realpathSync(root);
    } catch {
      throw new ServiceHostError('invalid', `服务目录不存在：${root}`);
    }
    if (!canonicalRoots.some((allowed) => inside(allowed, canonical))) {
      throw new ServiceHostError('invalid', '服务目录不在 Worker 允许的根目录内');
    }
    return canonical;
  }

  function clearTimers(entry: Entry): void {
    if (entry.retry !== null) {
      clearTimeout(entry.retry);
      entry.retry = null;
    }
    if (entry.portTimer !== null) {
      clearInterval(entry.portTimer);
      entry.portTimer = null;
    }
  }

  function killGroup(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-pid, signal);
    } catch {
      // 进程组已经没了（或平台不支持）：直接对 pid 补一刀。
      try {
        process.kill(pid, signal);
      } catch {
        /* 已经退出 */
      }
    }
  }

  function launch(entry: Entry): number {
    let child: ChildProcess;
    try {
      child = spawn('/bin/sh', ['-lc', entry.spec.command], {
        cwd: entry.spec.root,
        env: setupEnv(entry.spec.env),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      throw new ServiceHostError('failed', `起不来：${error instanceof Error ? error.message : String(error)}`);
    }
    entry.proc = child;
    entry.pid = child.pid ?? null;
    entry.port = null;
    entry.detail = null;
    entry.state = 'starting';
    emit(entry, 'starting');

    const collector = (chunk: Buffer): void => {
      const text = scrubCredentials(chunk.toString('utf8'));
      entry.log = tailOutput(entry.log + text, SERVICE_LOG_MAX);
      options.onLog(entry.spec.serviceId, text);
    };
    child.stdout?.on('data', collector);
    child.stderr?.on('data', collector);

    child.on('error', (error) => {
      options.log?.(`服务 ${entry.spec.serviceId} 启动出错：${error.message}`);
    });

    child.on('exit', (code, signal) => {
      entry.proc = null;
      entry.pid = null;
      if (entry.portTimer !== null) {
        clearInterval(entry.portTimer);
        entry.portTimer = null;
      }
      const reason = signal !== null ? `信号 ${signal}` : `退出码 ${code ?? '未知'}`;
      if (entry.stopping || disposed) {
        entry.port = null;
        emit(entry, 'stopped', reason);
        persist();
        return;
      }
      entry.port = null;
      if (entry.spec.restart !== 'always') {
        emit(entry, 'failed', `${reason}（重启策略 ${entry.spec.restart}）`);
        persist();
        return;
      }
      if (entry.attempts >= RETRY_MAX) {
        emit(entry, 'failed', `${reason}，已重拉 ${entry.attempts} 次仍失败`);
        persist();
        return;
      }
      const delay = RETRY_DELAYS[entry.attempts] ?? 30_000;
      entry.attempts += 1;
      emit(entry, 'failed', `${reason}，${Math.round(delay / 1000)} 秒后第 ${entry.attempts} 次重拉`);
      entry.retry = setTimeout(() => {
        entry.retry = null;
        if (disposed || entry.stopping) return;
        try {
          launch(entry);
          persist();
        } catch (error) {
          emit(entry, 'failed', error instanceof Error ? error.message : String(error));
        }
      }, delay);
      entry.retry.unref?.();
      persist();
    });

    if (entry.spec.port !== null) {
      const port = entry.spec.port;
      const deadline = Date.now() + SERVICE_PORT_TIMEOUT_MS;
      entry.portTimer = setInterval(() => {
        if (entry.portTimer === null) return;
        if (listening(port, procRoot)) {
          clearInterval(entry.portTimer);
          entry.portTimer = null;
          entry.port = port;
          entry.attempts = 0;
          emit(entry, 'running');
          persist();
          return;
        }
        if (Date.now() > deadline) {
          clearInterval(entry.portTimer);
          entry.portTimer = null;
          emit(entry, 'failed', '30 秒内没有监听端口');
          persist();
        }
      }, PORT_POLL_MS);
      entry.portTimer.unref?.();
    } else {
      entry.attempts = 0;
      entry.port = null;
      emit(entry, 'running');
      persist();
    }

    return entry.pid ?? 0;
  }

  async function start(spec: ServiceSpec): Promise<{ pid: number; port: number | null }> {
    if (entries.has(spec.serviceId)) throw new ServiceHostError('conflict', '这条服务已经在跑');
    const root = checkedRoot(spec.root);
    const entry: Entry = {
      spec: { ...spec, root },
      proc: null,
      state: 'starting',
      pid: null,
      port: null,
      detail: null,
      log: '',
      attempts: 0,
      retry: null,
      portTimer: null,
      stopping: false
    };
    entries.set(spec.serviceId, entry);
    const pid = launch(entry);
    persist();
    return { pid, port: entry.spec.port };
  }

  async function stop(serviceId: string, signal: 'TERM' | 'KILL' = 'TERM'): Promise<{ exited: boolean }> {
    const entry = entries.get(serviceId);
    if (!entry) throw new ServiceHostError('not_found', '服务不存在');
    clearTimers(entry);
    entry.stopping = true;
    const pid = entry.pid;
    if (pid === null || entry.proc === null) {
      entry.port = null;
      emit(entry, 'stopped', entry.detail ?? '已停');
      persist();
      return { exited: true };
    }
    killGroup(pid, signal === 'KILL' ? 'SIGKILL' : 'SIGTERM');
    if (signal === 'KILL') {
      // 直接 KILL 也等 exit 事件，最多等 1 秒避免 RPC 挂死。
      const exited = await waitExit(entry, 1_000);
      persist();
      return { exited };
    }
    const exited = await waitExit(entry, STOP_GRACE_MS);
    if (!exited) {
      killGroup(pid, 'SIGKILL');
      const killed = await waitExit(entry, 1_000);
      persist();
      return { exited: killed };
    }
    persist();
    return { exited: true };
  }

  function waitExit(entry: Entry, timeoutMs: number): Promise<boolean> {
    if (entry.proc === null) return Promise.resolve(true);
    const child = entry.proc;
    return new Promise((resolveExit) => {
      const timer = setTimeout(() => {
        child.off('exit', onExit);
        resolveExit(false);
      }, timeoutMs);
      timer.unref?.();
      const onExit = (): void => {
        clearTimeout(timer);
        resolveExit(true);
      };
      child.once('exit', onExit);
    });
  }

  function list(): readonly ServiceRuntimeInfo[] {
    return [...entries.values()].map((entry) => ({
      serviceId: entry.spec.serviceId,
      pid: entry.pid,
      state: entry.state,
      port: entry.port
    }));
  }

  function logs(serviceId: string, maxBytes?: number): string {
    const entry = entries.get(serviceId);
    if (!entry) throw new ServiceHostError('not_found', '服务不存在');
    const text = entry.log;
    if (maxBytes === undefined) return text;
    return maxBytes <= 0 ? '' : text.slice(-maxBytes);
  }

  /** services.json 里的历史记录：只有 `always` 才重拉，其余保持原状态或标 failed。 */
  async function revive(): Promise<void> {
    let raw: string;
    try {
      raw = readFileSync(statePath, 'utf8');
    } catch {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const rows = (parsed as { services?: unknown }).services;
    if (!Array.isArray(rows)) return;
    for (const row of rows as PersistedEntry[]) {
      if (typeof row?.serviceId !== 'string' || entries.has(row.serviceId)) continue;
      const spec: ServiceSpec = {
        serviceId: row.serviceId,
        root: row.root,
        command: row.command,
        port: row.port ?? null,
        env: row.env ?? {},
        restart: row.restart ?? 'never'
      };
      if (spec.restart === 'always') {
        try {
          await start(spec);
        } catch (error) {
          options.log?.(`重拉服务 ${spec.serviceId} 失败：${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }
      if (row.state !== 'running' && row.state !== 'starting') continue;
      entries.set(spec.serviceId, {
        spec,
        proc: null,
        state: 'failed',
        pid: null,
        port: null,
        detail: '机器重启后没有拉起来',
        log: '',
        attempts: 0,
        retry: null,
        portTimer: null,
        stopping: false
      });
      options.onState({ serviceId: spec.serviceId, state: 'failed', pid: null, detail: '机器重启后没有拉起来', port: null });
      persist();
    }
  }

  function dispose(): void {
    disposed = true;
    for (const entry of entries.values()) {
      clearTimers(entry);
      entry.stopping = true;
      if (entry.pid !== null) killGroup(entry.pid, 'SIGTERM');
    }
  }

  return { start, stop, list, logs, revive, dispose };
}

