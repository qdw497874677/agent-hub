import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { PtyModuleLike, PtyProcessLike } from './terminal.ts';

type Key = { terminalId: string; epoch: string };
type Size = { cols: number; rows: number };
type Entry = { workspaceId: string; cwd: string; pty: PtyProcessLike; state: 'running' | 'closing'; attached: boolean; timer: NodeJS.Timeout | null; history: Buffer; paused: boolean; poll: NodeJS.Timeout | null };

export interface WorkdirTerminalHost {
  readonly epoch: string;
  inventory(): Promise<{ epoch: string; terminals: { terminalId: string; workspaceId: string; state: 'running' | 'closing' }[] }>;
  create(input: Key & { workspaceId: string; cwd: string }): Promise<{ state: 'running' | 'closing' | 'ended' }>;
  attach(input: Key & Size): Promise<{ cols: number; rows: number; reused: boolean; scrollback?: string }>;
  resize(input: Key & Size): Promise<{ ok: true }>;
  close(input: Key): Promise<{ exited: boolean }>;
  detach(input: Key): void;
  detachAll(): void;
  input(input: Key & { data: Uint8Array }): boolean;
  disposeAll(): Promise<void>;
}

export function createWorkdirTerminalHost(options: {
  shell: string; check(path: string): Promise<string | null>; backpressure(): number;
  onData(epoch: string, id: string, data: Uint8Array): void; onExit(epoch: string, id: string, code: number): void;
  pty?: PtyModuleLike; max?: number; lingerMs?: number; fenceMax?: number; env?: NodeJS.ProcessEnv;
}): WorkdirTerminalHost | null {
  if (!options.pty) {
    try { createRequire(import.meta.url).resolve('node-pty'); } catch { return null; }
  }
  const epoch = randomUUID();
  const entries = new Map<string, Entry>();
  // Retain every accepted ID for the lifetime of the host. Exhaustion is fail-closed.
  const fences = new Set<string>();
  const fenceMax = options.fenceMax ?? 100_000;
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.catch(() => undefined).then(fn);
    queue = next;
    return next;
  };
  const valid = (key: Key): void => { if (key.epoch !== epoch) throw new Error('stale workdir terminal epoch'); };
  const reserve = (id: string): void => {
    if (!fences.has(id) && fences.size >= fenceMax) throw new Error('workdir terminal fence capacity exhausted');
    fences.add(id);
  };
  const stop = (entry: Entry): void => {
    entry.state = 'closing';
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    try { entry.pty.kill(); } catch { /* Keep tracking until onExit proves exit. */ }
  };
  const linger = (entry: Entry): void => {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => { if (!entry.attached && entry.state === 'running') stop(entry); }, options.lingerMs ?? 30 * 60_000);
    entry.timer.unref?.();
  };
  return {
    epoch,
    inventory: () => serial(async () => ({ epoch, terminals: [...entries].map(([terminalId, e]) => ({ terminalId, workspaceId: e.workspaceId, state: e.state })) })),
    create: (input) => serial(async () => {
      valid(input);
      const existing = entries.get(input.terminalId);
      if (existing) {
        if (existing.workspaceId !== input.workspaceId || existing.cwd !== input.cwd) throw new Error('workdir terminal identity conflict');
        return { state: existing.state };
      }
      if (fences.has(input.terminalId)) return { state: 'ended' };
      reserve(input.terminalId);
      if (entries.size >= (options.max ?? 16)) throw new Error('workdir terminal limit reached');
      const cwd = await realpath(input.cwd);
      if (cwd !== input.cwd || await options.check(cwd) !== null) throw new Error('workdir must be canonical and inside allowed roots');
      const specifier = 'node-pty';
      const loaded = options.pty ?? await import(specifier).then((m) => (m.default ?? m) as PtyModuleLike);
      if (!loaded) throw new Error('node-pty unavailable');
      const env: Record<string, string> = { TERM: 'xterm-256color', COLORTERM: 'truecolor' };
      for (const key of ['HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'LC_ALL', 'SHELL', 'TMPDIR']) {
        const value = (options.env ?? process.env)[key]; if (value !== undefined) env[key] = value;
      }
      const pty = loaded.spawn(options.shell, [], { name: 'xterm-256color', cols: 80, rows: 24, cwd, env });
      const entry: Entry = { workspaceId: input.workspaceId, cwd: input.cwd, pty, state: 'running', attached: false, timer: null, history: Buffer.alloc(0), paused: false, poll: null };
      entries.set(input.terminalId, entry);
      pty.onData((text) => {
        if (entries.get(input.terminalId) !== entry) return;
        const bytes = Buffer.from(text);
        entry.history = Buffer.concat([entry.history, bytes]).subarray(-256 * 1024);
        for (let i = 0; i < bytes.length; i += 64 * 1024) options.onData(epoch, input.terminalId, bytes.subarray(i, i + 64 * 1024));
        if (!entry.paused && options.backpressure() > 4 * 1024 * 1024) {
          entry.paused = true; try { pty.pause(); } catch { /* keep tracking */ }
          entry.poll = setInterval(() => {
            if (options.backpressure() > 512 * 1024) return;
            if (entry.poll) clearInterval(entry.poll); entry.poll = null; entry.paused = false;
            try { pty.resume(); } catch { /* keep tracking */ }
          }, 100); entry.poll.unref?.();
        }
      });
      pty.onExit(({ exitCode }) => {
        if (entries.get(input.terminalId) !== entry) return;
        entries.delete(input.terminalId);
        if (entry.timer) clearTimeout(entry.timer); if (entry.poll) clearInterval(entry.poll);
        options.onExit(epoch, input.terminalId, exitCode);
      });
      linger(entry);
      return { state: 'running' };
    }),
    attach: async (input) => {
      valid(input); const entry = entries.get(input.terminalId);
      if (!entry || entry.state !== 'running') throw new Error('workdir terminal not running');
      entry.pty.resize(input.cols, input.rows); entry.attached = true;
      if (entry.timer) clearTimeout(entry.timer); entry.timer = null;
      return { cols: input.cols, rows: input.rows, reused: true, ...(entry.history.length ? { scrollback: entry.history.toString('base64') } : {}) };
    },
    resize: async (input) => { valid(input); const e = entries.get(input.terminalId); if (!e || e.state !== 'running') throw new Error('workdir terminal not running'); e.pty.resize(input.cols, input.rows); return { ok: true }; },
    close: (input) => serial(async () => { valid(input); reserve(input.terminalId); const e = entries.get(input.terminalId); if (!e) return { exited: true }; stop(e); return { exited: !entries.has(input.terminalId) }; }),
    detach: (input) => { if (input.epoch !== epoch) return; const e = entries.get(input.terminalId); if (e && e.state === 'running') { e.attached = false; linger(e); } },
    detachAll: () => { for (const e of entries.values()) if (e.attached && e.state === 'running') { e.attached = false; linger(e); } },
    input: (input) => { if (input.epoch !== epoch) return false; const e = entries.get(input.terminalId); if (!e || e.state !== 'running' || !e.attached) return false; e.pty.write(Buffer.from(input.data).toString('utf8')); return true; },
    disposeAll: async () => { await serial(async () => { for (const entry of entries.values()) stop(entry); }); }
  };
}
