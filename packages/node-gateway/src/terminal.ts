import { createRequire } from 'node:module';
import pidtree from 'pidtree';

/**
 * 会话终端的 worker 侧（docs/design/terminal.md §5）：在这台机器上跑 PTY，cwd 就是会话的工作目录。
 *
 * 这里只做「PTY 宿主」：开 / 关 / 改尺寸 / 读写 / 回收。协议怎么走（RPC、单向帧、base64）
 * 在 worker-link 里；hub 不知道 cwd，也不知道 shell 是什么。
 *
 * node-pty 是原生模块：装不上（没有编译产物、Node 大版本没预编译）时整个 host 返回 null，
 * `terminal.open` 回 unsupported，界面不显示终端页签。**降级不能拖垮 worker 启动**。
 */

/** node-pty 的 IDisposable：解绑监听用（关终端时先解绑，避免 kill 触发第二遍 onExit）。 */
export interface PtyDisposable {
  dispose(): void;
}

export interface PtyExitEvent {
  readonly exitCode: number;
  readonly signal?: number;
}

/** node-pty 的 IPty 里我们用到的部分。测试注入假实现，不依赖真的原生模块。 */
export interface PtyProcessLike {
  readonly pid: number;
  onData(listener: (data: string) => void): PtyDisposable;
  onExit(listener: (event: PtyExitEvent) => void): PtyDisposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  pause(): void;
  resume(): void;
}

export interface PtySpawnOptions {
  readonly name: string;
  readonly cols: number;
  readonly rows: number;
  readonly cwd: string;
  readonly env: Record<string, string>;
}

export interface PtyModuleLike {
  spawn(file: string, args: readonly string[], options: PtySpawnOptions): PtyProcessLike;
}

export interface TerminalOpenParams {
  readonly terminalId: string;
  readonly sessionId: string;
  readonly cols: number;
  readonly rows: number;
  /** hub 指定的工作目录（会话结束后 hub 仍知道它）；不给就从本进程的 sessions 表取。 */
  readonly cwd?: string;
}

export interface TerminalOpenResult {
  readonly cols: number;
  readonly rows: number;
  readonly reused: boolean;
  /** 复用已有终端时回放的最近输出（base64）；新开或太旧时没有。 */
  readonly scrollback?: string;
}

/**
 * 会话还没在这台机器上登记工作目录（刚派下来、agent 还在启动）。
 * hub 据此短暂重试，而不是把「点开终端就报错」暴露给用户。
 */
export class TerminalNotReadyError extends Error {
  constructor(message = '会话还没有在这台机器上就绪') {
    super(message);
    this.name = 'TerminalNotReadyError';
  }
}

export interface TerminalHostOptions {
  /** TERMINAL_SHELL，默认由组合根选（$SHELL 或 /bin/bash）。 */
  readonly shell: string;
  /** 这台机器同时最多几个 PTY，默认 16。 */
  readonly max?: number;
  /** 多久没动静就回收（浏览器断开后开始计时），默认 30 分钟。 */
  readonly lingerMs?: number;
  /** WorkerFiles.check：cwd 必须还在 WORKER_ROOTS 里。 */
  readonly check: (path: string) => Promise<string | null>;
  /** 当前连往 hub 的 ws 的 bufferedAmount（终端背压只看自己这条链路）。 */
  readonly backpressure: () => number;
  /** 会话的工作目录；不在这台机器上跑 = undefined。 */
  readonly cwdOf: (sessionId: string) => string | undefined;
  readonly onData: (terminalId: string, chunk: Uint8Array) => void;
  readonly onExit: (terminalId: string, code: number, signal?: number) => void;
  /**
   * 原始输出旁路一份（base64 之前），给预览的端口发现用（docs/design/preview.md §5）。
   * 回调抛错只记日志：发现端口坏了不能影响终端本身。
   */
  readonly onOutput?: (sessionId: string, text: string) => void;
  /** 注入 pty 实现（测试 / 嵌入式）；不给就动态 import('node-pty')。 */
  readonly pty?: PtyModuleLike;
  /** 自定义加载器：返回 null = 这台机器用不了。默认 `import('node-pty')`。 */
  readonly load?: () => Promise<PtyModuleLike | null>;
  /** 父进程环境；默认 process.env。 */
  readonly env?: NodeJS.ProcessEnv;
  /** 关闭时找残留前台进程：默认 pidtree。 */
  readonly descendants?: (pid: number) => Promise<readonly number[]>;
  /** 杀一个进程；默认 process.kill。 */
  readonly killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  readonly log?: (message: string) => void;
  /** 输出合并的 tick，默认 16ms（测试调小用）。 */
  readonly tickMs?: number;
  /** 暂停后多久查一次背压，默认 100ms（测试调小用）。 */
  readonly pollMs?: number;
}

export interface TerminalHost {
  /** 同 terminalId 存活 = 改尺寸后回 reused；cwd 由 cwdOf + check 决定，不走协议。 */
  open(params: TerminalOpenParams): Promise<TerminalOpenResult>;
  resize(terminalId: string, cols: number, rows: number): Promise<{ ok: true }>;
  /** 键盘输入写 stdin。终端不存在 = false（不抛，输入是单向帧）。 */
  write(terminalId: string, data: Uint8Array): boolean;
  close(terminalId: string): Promise<{ ok: true }>;
  list(): { terminalId: string; sessionId: string }[];
  /** 浏览器断开：开始 linger 计时；重连（open）会清掉。 */
  detach(terminalId: string): void;
  /** 会话结束：一次回收这条会话的所有终端。 */
  closeSession(sessionId: string): Promise<void>;
  /** worker 退出：回收全部。 */
  disposeAll(): Promise<void>;
}

/** 每个终端留多少历史输出用于重连回放（原始字节）。 */
const HISTORY_BYTES = 256 * 1024;
/** 单帧最多 64 KB 原始输出（base64 后约 87 KB，契约上限 131 072 字符）。 */
const MAX_FRAME_BYTES = 64 * 1024;
/** 出站积压超过 4 MB 暂停读 PTY，降到 512 KB 再恢复。 */
const BACKPRESSURE_HIGH = 4 * 1024 * 1024;
const BACKPRESSURE_LOW = 512 * 1024;
/** 暂停期间最多攒这么多原始输出，再多就丢新的（PTY 已 pause，正常到不了）。 */
const MAX_PENDING_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX = 16;
const DEFAULT_LINGER_MS = 30 * 60_000;
const DEFAULT_TICK_MS = 16;
const DEFAULT_POLL_MS = 100;
/** 这些只属于 worker 进程，不能漏给用户在终端里开的 shell。 */
const SCRUBBED_ENV = ['HUB_TOKEN', 'HUB_WORKER_CREDENTIAL', 'HUB_LOCAL_SECRET', 'HUB_PARENT_PID', 'HUB_URL'];

interface Entry {
  readonly terminalId: string;
  readonly sessionId: string;
  readonly pty: PtyProcessLike;
  cols: number;
  rows: number;
  /** 还没发出去的输出（按到达顺序）。 */
  readonly chunks: Buffer[];
  pending: number;
  tick: NodeJS.Timeout | null;
  linger: NodeJS.Timeout | null;
  poll: NodeJS.Timeout | null;
  paused: boolean;
  closed: boolean;
  /** 最近的输出（环形，≤ HISTORY_BYTES）：刷新后重连时回放，页面不至于一片空白。 */
  readonly history: Buffer[];
  historyBytes: number;
  readonly disposables: PtyDisposable[];
  warnedOverflow: boolean;
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * 能不能 `import('node-pty')`：先同步 resolve 一次模块路径（不加载原生 .node）。
 * 解析不到就直接不建 host，worker 正常启动、`terminal.open` 回 unsupported。
 */
function nodePtyAvailable(): boolean {
  try {
    createRequire(import.meta.url).resolve('node-pty');
    return true;
  } catch {
    return false;
  }
}

/** CJS 包经 ESM 加载时真正的模块对象在 default 上（node-pty 两种都试）。 */
async function importNodePty(): Promise<PtyModuleLike | null> {
  // 写成变量：没装 node-pty / 没类型时 tsc 不会因为找不到模块而失败（它本来就可以缺席）。
  const specifier = 'node-pty';
  try {
    const loaded = (await import(specifier)) as PtModuleNamespace;
    const module = loaded.default ?? loaded;
    return typeof module.spawn === 'function' ? (module as PtyModuleLike) : null;
  } catch {
    return null;
  }
}

type PtModuleNamespace = Partial<PtyModuleLike> & { default?: Partial<PtyModuleLike> };

export function createTerminalHost(options: TerminalHostOptions): TerminalHost | null {
  const log = options.log ?? ((): void => undefined);
  const injected = options.pty ?? null;
  let load: () => Promise<PtyModuleLike | null>;
  if (injected) {
    load = async () => injected;
  } else if (options.load) {
    load = options.load;
  } else {
    if (!nodePtyAvailable()) {
      log('没装 node-pty，终端不可用（hub 上不显示终端页签）');
      return null;
    }
    load = importNodePty;
  }

  const max = Math.max(1, options.max ?? DEFAULT_MAX);
  const lingerMs = Math.max(1, options.lingerMs ?? DEFAULT_LINGER_MS);
  const tickMs = Math.max(1, options.tickMs ?? DEFAULT_TICK_MS);
  const pollMs = Math.max(1, options.pollMs ?? DEFAULT_POLL_MS);
  const descendants = options.descendants ?? ((pid: number) => pidtree(pid));
  const killProcess = options.killProcess ?? ((pid: number, signal: NodeJS.Signals): void => {
    try {
      process.kill(pid, signal);
    } catch {
      // 已经退出了
    }
  });

  const entries = new Map<string, Entry>();
  /** 同一 terminalId 的 open / close 串行：两个 RPC 撞一起时只 spawn 一次。 */
  const busy = new Map<string, Promise<unknown>>();

  function serial<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = busy.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    busy.set(key, next);
    return next.finally(() => {
      if (busy.get(key) === next) busy.delete(key);
    });
  }

  function clearTimers(entry: Entry): void {
    if (entry.tick) clearTimeout(entry.tick);
    if (entry.linger) clearTimeout(entry.linger);
    if (entry.poll) clearInterval(entry.poll);
    entry.tick = null;
    entry.linger = null;
    entry.poll = null;
  }

  function unbind(entry: Entry): void {
    for (const disposable of entry.disposables.splice(0)) {
      try {
        disposable.dispose();
      } catch {
        // 已经解绑过
      }
    }
  }

  /** 记住最近的输出（粘 UTF-8 边界，回放时起点不会花屏）。 */
  function remember(entry: Entry, chunk: Buffer): void {
    entry.history.push(chunk);
    entry.historyBytes += chunk.length;
    while (entry.historyBytes > HISTORY_BYTES && entry.history.length > 0) {
      const head = entry.history[0]!;
      const excess = entry.historyBytes - HISTORY_BYTES;
      if (head.length <= excess) {
        entry.history.shift();
        entry.historyBytes -= head.length;
        continue;
      }
      let skip = excess;
      while (skip < head.length && (head[skip]! & 0xc0) === 0x80) skip += 1;
      entry.history[0] = head.subarray(skip);
      entry.historyBytes -= skip;
    }
  }

  /** 空闲计时：有输出 / 输入 / 重连都会重新开始，到点回收。 */
  function armLinger(entry: Entry): void {
    if (entry.closed) return;
    if (entry.linger) clearTimeout(entry.linger);
    const timer = setTimeout(() => {
      entry.linger = null;
      log(`终端 ${entry.terminalId} 空闲 ${Math.round(lingerMs / 1000)} 秒，回收`);
      void closeEntry(entry.terminalId, true, entry);
    }, lingerMs);
    timer.unref?.();
    entry.linger = timer;
  }

  async function killLeftovers(pid: number): Promise<void> {
    try {
      const leftovers = await descendants(pid);
      for (const child of leftovers) {
        if (child === pid) continue;
        killProcess(child, 'SIGKILL');
      }
    } catch (error) {
      log(`兜底回收终端进程失败：${reasonOf(error)}`);
    }
  }

  async function closeEntry(terminalId: string, notifyHub = false, expected?: Entry): Promise<void> {
    const entry = entries.get(terminalId);
    // 计时器到点时可能有同 id 的新终端顶上来了：只关自己那把。
    if (!entry || (expected !== undefined && entry !== expected)) return;
    entries.delete(terminalId);
    entry.closed = true;
    clearTimers(entry);
    // 先解绑：kill 之后 onExit 会再报一次，重复回调会让 hub 以为进程又退了一次。
    unbind(entry);
    entry.chunks.length = 0;
    entry.pending = 0;
    entry.history.length = 0;
    entry.historyBytes = 0;
    const pid = typeof entry.pty.pid === 'number' ? entry.pty.pid : 0;
    try {
      entry.pty.kill();
    } catch (error) {
      log(`结束终端 ${terminalId} 失败：${reasonOf(error)}`);
    }
    if (pid > 0) await killLeftovers(pid);
    // 空闲回收是这台机器自己决定的：得告诉 hub 一声，不然界面一直以为终端还开着。
    if (notifyHub) options.onExit(terminalId, 0);
  }

  /**
   * 取至多 max 字节，并保证切在 UTF-8 字符边界上（base64 只是编码，切坏多字节字符照样花屏）。
   * 账目（entry.pending、chunks）都在这里结清。
   */
  function take(entry: Entry, limit: number): Buffer {
    const pieces: Buffer[] = [];
    let size = 0;
    while (entry.chunks.length > 0 && size < limit) {
      const head = entry.chunks[0]!;
      const room = limit - size;
      if (head.length <= room) {
        pieces.push(head);
        entry.chunks.shift();
        size += head.length;
      } else {
        pieces.push(head.subarray(0, room));
        entry.chunks[0] = head.subarray(room);
        size += room;
        break;
      }
    }
    const merged = pieces.length === 1 ? pieces[0]! : Buffer.concat(pieces, size);
    // 从尾部往回找最后一个字符的起点：它没被切全就留到下一帧（不然多字节字符会变成乱码）。
    let cut = merged.length;
    for (let back = 1; back <= Math.min(4, merged.length); back += 1) {
      const byte = merged[merged.length - back]!;
      if ((byte & 0xc0) === 0x80) continue; // 续字节，继续往前找
      const expected = (byte & 0x80) === 0 ? 1 : (byte & 0xe0) === 0xc0 ? 2 : (byte & 0xf0) === 0xe0 ? 3 : (byte & 0xf8) === 0xf0 ? 4 : 1;
      if (back < expected) cut = merged.length - back;
      break;
    }
    if (cut <= 0) {
      // 整块都切不出一个完整字符：放回去等更多数据（正常不会发生，64 KB 远大于 4 字节）
      if (merged.length > 0) entry.chunks.unshift(merged);
      return Buffer.alloc(0);
    }
    if (cut < merged.length) entry.chunks.unshift(merged.subarray(cut));
    entry.pending -= cut;
    return merged.subarray(0, cut);
  }

  function scheduleFlush(entry: Entry): void {
    if (entry.closed || entry.paused || entry.tick) return;
    if (entry.pending === 0) return;
    const timer = setTimeout(() => {
      entry.tick = null;
      flush(entry);
    }, tickMs);
    timer.unref?.();
    entry.tick = timer;
  }

  /** 16ms 一次，把攒下的输出按 64 KB 分帧发出；背压高就先停。 */
  function flush(entry: Entry): void {
    while (!entry.closed && !entry.paused && entry.pending > 0) {
      const backlog = options.backpressure();
      if (backlog > BACKPRESSURE_HIGH) {
        pause(entry, backlog);
        return;
      }
      const chunk = take(entry, MAX_FRAME_BYTES);
      if (chunk.length === 0) return;
      try {
        options.onData(entry.terminalId, chunk);
      } catch (error) {
        log(`转发终端 ${entry.terminalId} 输出失败：${reasonOf(error)}`);
      }
    }
  }

  function pause(entry: Entry, backlog: number): void {
    if (entry.paused || entry.closed) return;
    entry.paused = true;
    if (entry.tick) clearTimeout(entry.tick);
    entry.tick = null;
    try {
      entry.pty.pause();
    } catch (error) {
      log(`暂停终端 ${entry.terminalId} 失败：${reasonOf(error)}`);
    }
    log(`终端 ${entry.terminalId} 出站积压 ${Math.round(backlog / 1024)} KB，暂停读取`);
    const timer = setInterval(() => {
      if (entry.closed) {
        if (entry.poll) clearInterval(entry.poll);
        entry.poll = null;
        return;
      }
      const now = options.backpressure();
      if (now > BACKPRESSURE_LOW) return;
      if (entry.poll) clearInterval(entry.poll);
      entry.poll = null;
      entry.paused = false;
      try {
        entry.pty.resume();
      } catch (error) {
        log(`恢复终端 ${entry.terminalId} 失败：${reasonOf(error)}`);
      }
      scheduleFlush(entry);
    }, pollMs);
    timer.unref?.();
    entry.poll = timer;
  }

  function onPtyData(entry: Entry, data: string): void {
    if (entry.closed || data === '') return;
    const chunk = Buffer.from(data, 'utf8');
    if (chunk.length === 0) return;
    if (options.onOutput) {
      try {
        options.onOutput(entry.sessionId, chunk.toString('utf8'));
      } catch (error) {
        log(`转发终端 ${entry.terminalId} 输出给端口发现失败：${reasonOf(error)}`);
      }
    }
    if (entry.pending + chunk.length > MAX_PENDING_BYTES) {
      if (!entry.warnedOverflow) {
        entry.warnedOverflow = true;
        log(`终端 ${entry.terminalId} 输出积压超过 ${Math.round(MAX_PENDING_BYTES / 1024 / 1024)} MB，丢弃新的输出`);
      }
      return;
    }
    entry.chunks.push(chunk);
    entry.pending += chunk.length;
    remember(entry, chunk);
    armLinger(entry);
    scheduleFlush(entry);
  }

  function onPtyExit(entry: Entry, event: PtyExitEvent): void {
    if (entry.closed) return;
    // 退出前可能还有没发出的输出（`exit` 前的最后一行）：先冲干净再报退出。
    while (entry.pending > 0) {
      const chunk = take(entry, MAX_FRAME_BYTES);
      if (chunk.length === 0) break;
      try {
        options.onData(entry.terminalId, chunk);
      } catch {
        break;
      }
    }
    entry.closed = true;
    entries.delete(entry.terminalId);
    clearTimers(entry);
    unbind(entry);
    if (event.signal === undefined) options.onExit(entry.terminalId, event.exitCode);
    else options.onExit(entry.terminalId, event.exitCode, event.signal);
  }

  function shellEnv(): Record<string, string> {
    const source = options.env ?? process.env;
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) continue;
      if (SCRUBBED_ENV.includes(key)) continue;
      env[key] = value;
    }
    env['TERM'] = 'xterm-256color';
    env['COLORTERM'] = 'truecolor';
    return env;
  }

  async function openNow(params: TerminalOpenParams): Promise<TerminalOpenResult> {
    const { terminalId, sessionId, cols, rows } = params;
    const live = entries.get(terminalId);
    if (live) {
      if (live.sessionId !== sessionId) throw new Error('这个终端已经被另一条会话占用');
      live.pty.resize(cols, rows);
      live.cols = cols;
      live.rows = rows;
      armLinger(live);
      const scrollback = live.historyBytes > 0 ? Buffer.concat(live.history, live.historyBytes).toString('base64') : '';
      return { cols, rows, reused: true, ...(scrollback === '' ? {} : { scrollback }) };
    }
    const root = params.cwd ?? options.cwdOf(sessionId);
    if (root === undefined) throw new TerminalNotReadyError('会话不在这台机器上运行');
    // v1 一条会话只给一个终端：同会话换 id 再开说明前端状态乱了，直接拒绝比留个孤儿 shell 好。
    if ([...entries.values()].some((entry) => entry.sessionId === sessionId)) throw new Error('这条会话已经有一个终端了');
    const blocked = await options.check(root);
    if (blocked !== null) throw new Error(`目录不在允许的范围内：${blocked}`);
    if (entries.size >= max) throw new Error(`终端数量已达上限（${max}）`);
    const module = await load();
    if (!module) throw new Error('终端不可用：node-pty 没能加载');
    let pty: PtyProcessLike;
    try {
      pty = module.spawn(options.shell, ['-l'], { name: 'xterm-256color', cols, rows, cwd: root, env: shellEnv() });
    } catch (error) {
      throw new Error(`起不了终端：${reasonOf(error)}`);
    }
    const entry: Entry = {
      terminalId,
      sessionId,
      pty,
      cols,
      rows,
      chunks: [],
      pending: 0,
      tick: null,
      linger: null,
      poll: null,
      paused: false,
      closed: false,
      history: [],
      historyBytes: 0,
      disposables: [],
      warnedOverflow: false
    };
    entries.set(terminalId, entry);
    entry.disposables.push(
      pty.onData((data) => onPtyData(entry, data)),
      pty.onExit((event) => onPtyExit(entry, event))
    );
    armLinger(entry);
    log(`终端 ${terminalId} 已启动（会话 ${sessionId}，cwd ${root}，pid ${pty.pid}）`);
    return { cols, rows, reused: false };
  }

  function validSize(cols: number, rows: number): boolean {
    return Number.isInteger(cols) && Number.isInteger(rows) && cols >= 1 && cols <= 1000 && rows >= 1 && rows <= 1000;
  }

  async function closeSession(sessionId: string): Promise<void> {
    const doomed = [...entries.values()].filter((entry) => entry.sessionId === sessionId).map((entry) => entry.terminalId);
    await Promise.all(doomed.map((terminalId) => serial(terminalId, () => closeEntry(terminalId))));
  }

  return {
    open(params) {
      return serial(params.terminalId, () => openNow(params));
    },
    async resize(terminalId, cols, rows) {
      if (!validSize(cols, rows)) throw new Error('终端尺寸不合法（1..1000）');
      const entry = entries.get(terminalId);
      if (!entry || entry.closed) throw new Error('终端不存在');
      entry.pty.resize(cols, rows);
      entry.cols = cols;
      entry.rows = rows;
      armLinger(entry);
      return { ok: true };
    },
    write(terminalId, data) {
      const entry = entries.get(terminalId);
      if (!entry || entry.closed) return false;
      entry.pty.write(Buffer.from(data).toString('utf8'));
      armLinger(entry);
      return true;
    },
    close(terminalId) {
      return serial(terminalId, async () => {
        await closeEntry(terminalId); // 不存在也算成功
        return { ok: true } as const;
      });
    },
    list() {
      return [...entries.values()].map((entry) => ({ terminalId: entry.terminalId, sessionId: entry.sessionId }));
    },
    detach(terminalId) {
      const entry = entries.get(terminalId);
      if (!entry || entry.closed) return;
      armLinger(entry);
    },
    closeSession,
    async disposeAll() {
      const ids = [...entries.keys()];
      await Promise.all(ids.map((terminalId) => serial(terminalId, () => closeEntry(terminalId))));
    }
  };
}
