import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Context, Hono } from 'hono';
import { WebSocket, WebSocketServer } from 'ws';
import type { Principal, Subject, WorkdirSafety, WorkdirTerminal, WorkdirTerminalStore, WorkdirTerminalState } from '@agent-hub/domain';
import { loginTokenOf, originMatches } from './terminal-bridge.ts';
import { sameSecret } from './request-guard.ts';
import { workDirTerminalEligibility, type WorkDirTerminalAccessOptions } from './workdir-terminal-access.ts';

type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string; readonly message: string };
interface Gateway {
  inventory(): Promise<Outcome<{ epoch: string; terminals: readonly { terminalId: string; workspaceId: string; state: 'running' | 'closing' }[] }>>;
  create(input: { terminalId: string; workspaceId: string; cwd: string; epoch: string }): Promise<Outcome<{ state: 'running' | 'closing' | 'ended' }>>;
  attach(input: { terminalId: string; epoch: string; cols: number; rows: number }): Promise<Outcome<{ scrollback?: string }>>;
  resize(input: { terminalId: string; epoch: string; cols: number; rows: number }): Promise<Outcome<{ ok: true }>>;
  close(input: { terminalId: string; epoch: string }): Promise<Outcome<{ exited: boolean }>>;
  detach(input: { terminalId: string; epoch: string }): void;
  input(input: { terminalId: string; epoch: string; data: string }): boolean;
}
export interface WorkdirTerminalServiceOptions {
  /** Disabling prevents new PTYs, not reconciliation or reuse of a confirmed prior receipt. */
  readonly enabled: () => boolean;
  /** In managed mode, only logins proved at the protected ingress can reach this service. */
  readonly protectedLogin?: { token(c: Context): string; socketToken(request: IncomingMessage): string };
  readonly workerReady?: (workerId: string) => boolean;
  readonly admissionReady?: () => boolean;
  readonly access: WorkDirTerminalAccessOptions;
  readonly terminals: WorkdirTerminalStore;
  readonly safety: WorkdirSafety;
  readonly gateway: (workerId: string) => Gateway;
  readonly authenticate: (token: string) => Promise<Principal | null>;
  /** Fresh account and permissions, independent of any particular browser login. */
  readonly owner: (userId: string) => Promise<Principal | null>;
  readonly hostAllowed: (host: string | undefined) => boolean;
  readonly now?: () => number;
}

type Entry = { readonly socket: WebSocket; readonly token: string; readonly row: WorkdirTerminal; queue: Promise<void>; queuedBytes: number; alive: boolean; slowSince: number | null; attaching: boolean };
const pathPattern = /^\/api\/projects\/([^/]+)\/workdir-tabs\/([^/]+)\/terminals\/([^/]+)\/socket$/;
const base = '/api/projects/:projectId/workdir-tabs/:workspaceId/terminals';
const dto = (row: WorkdirTerminal) => ({ id: row.id, title: '终端', state: row.state, createdAt: row.createdAt });

export function createWorkdirTerminalService(options: WorkdirTerminalServiceOptions) {
  const { safety, terminals, gateway } = options;
  const now = options.now ?? Date.now;
  const clients = new Map<string, Entry>();
  const creating = new Set<string>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  const transition = (row: WorkdirTerminal, next: WorkdirTerminalState) =>
    terminals.transition(row.id, row.state, row.epoch, next, row.epoch, now());
  const eligible = (subject: Subject | null, projectId: string, workspaceId: string, ownerId?: string) =>
    workDirTerminalEligibility(options.access, subject, projectId, workspaceId, ownerId);
  const sameTarget = (row: WorkdirTerminal, target: { workerId: string; workspace: { path: string } }) =>
    row.workerId === target.workerId && row.cwd === target.workspace.path;
  const current = (entry: Entry) => clients.get(entry.row.id) === entry && entry.socket.readyState === WebSocket.OPEN;
  const workerReady = (workerId: string) => options.workerReady?.(workerId) ?? true;
  const canCreate = (workerId: string) => options.enabled() && workerReady(workerId) && (options.admissionReady?.() ?? true);
  const authorizedNow = (entry: Entry) => {
    const row = terminals.get(entry.row.id);
    return current(entry) && row?.state === 'running' && row.epoch === entry.row.epoch &&
      options.access.hasGrant(row.ownerId, row.workerId) && workerReady(row.workerId);
  };
  const send = (entry: Entry, frame: object) => { if (current(entry)) { try { entry.socket.send(JSON.stringify(frame)); } catch { /* disconnected */ } } };
  const drop = (entry: Entry) => {
    if (clients.get(entry.row.id) !== entry) return;
    if (entry.attaching) { try { entry.socket.close(); } catch { /* disconnected */ } return; }
    clients.delete(entry.row.id);
    if (entry.row.epoch) gateway(entry.row.workerId).detach({ terminalId: entry.row.id, epoch: entry.row.epoch });
    try { entry.socket.close(); } catch { /* disconnected */ }
  };
  const valid = async (entry: Entry): Promise<boolean> => {
    if (!current(entry)) return false;
    const principal = await options.authenticate(entry.token);
    if (!current(entry)) return false;
    const row = terminals.get(entry.row.id);
    if (!row || row.state !== 'running' || row.epoch !== entry.row.epoch) return false;
    const allowed = await eligible(principal, row.projectId, row.workspaceId, row.ownerId);
    const fresh = terminals.get(entry.row.id);
    return authorizedNow(entry) && !!fresh && allowed.ok && sameTarget(fresh, allowed.target);
  };
  const enqueue = (entry: Entry, fn: () => Promise<void>, bytes = 0) => {
    entry.queuedBytes += bytes;
    if (entry.queuedBytes > 4 * 1024 * 1024) { drop(entry); return; }
    entry.queue = entry.queue.then(fn).catch(() => drop(entry)).finally(() => { entry.queuedBytes -= bytes; });
  };
  // Bound epochs require an ordered close fence; absence from inventory is not proof.
  const closeRow = async (initial: WorkdirTerminal): Promise<WorkdirTerminal> => {
    let row = terminals.get(initial.id) ?? initial;
    if (row.state === 'ended') return row;
    if (row.epoch === null && (row.state === 'pending' || row.state === 'closing')) {
      // Locally proven: create is never dispatched until the null epoch is durably
      // bound. CAS prevents ending an intent whose epoch was bound concurrently.
      const ended = transition(row, 'ended');
      if (ended) return ended;
      row = terminals.get(row.id) ?? row;
      if (row.state === 'ended') return row;
    }
    if (row.state !== 'closing') row = transition(row, 'closing') ?? terminals.get(row.id) ?? row;
    if (row.state === 'ended') return row;
    const entry = clients.get(row.id);
    if (entry) drop(entry);
    if (!row.epoch) return row;
    try {
      const inv = await gateway(row.workerId).inventory();
      if (!inv.ok || inv.value.epoch !== row.epoch) return row;
      const result = await gateway(row.workerId).close({ terminalId: row.id, epoch: row.epoch });
      if (result.ok && result.value.exited) {
        const fresh = terminals.get(row.id);
        if (fresh?.state === 'closing' && fresh.epoch === row.epoch) row = transition(fresh, 'ended') ?? fresh;
      }
    } catch { /* ambiguous: retain closing */ }
    return terminals.get(row.id) ?? row;
  };
  const checkOwner = async (row: WorkdirTerminal): Promise<boolean> => {
    try {
      const principal = await options.owner(row.ownerId);
      const result = await eligible(principal, row.projectId, row.workspaceId, row.ownerId);
      return result.ok && sameTarget(row, result.target);
    } catch {
      return false;
    }
  };
  let reconciling = false;
  let reconcileCursor = 0;
  const reconcile = async () => {
    if (reconciling) return;
    reconciling = true;
    try {
      for (const entry of clients.values()) {
        try {
          if (!(await valid(entry))) drop(entry);
          else if (entry.socket.bufferedAmount > 4 * 1024 * 1024) {
            entry.slowSince ??= now();
            if (now() - entry.slowSince >= 5000) drop(entry);
          } else entry.slowSince = null;
        } catch { drop(entry); }
      }
      const all = terminals.listNonEnded();
      const batch = all.length <= 32 ? all : Array.from({ length: 32 }, (_, index) => all[(reconcileCursor + index) % all.length]!);
      reconcileCursor = all.length <= 32 ? 0 : (reconcileCursor + batch.length) % all.length;
      for (const row of batch) {
        if (creating.has(row.id)) continue;
        try {
          if (row.epoch === null || row.state === 'closing') { await closeRow(row); continue; }
          if (!(await checkOwner(row))) { await closeRow(row); continue; }
          if (!row.epoch) continue;
          const inv = await gateway(row.workerId).inventory();
          if (!inv.ok || inv.value.epoch !== row.epoch) continue;
          const item = inv.value.terminals.find((t) => t.terminalId === row.id);
          if (item && item.workspaceId !== row.workspaceId) { await closeRow(row); continue; }
          if (!item || item.state === 'closing') { await closeRow(row); continue; }
          if (row.state === 'pending') transition(row, 'running');
        } catch { /* unknown: retain reservation */ }
      }
    } finally { reconciling = false; }
  };

  async function cookie(c: Context): Promise<Principal | null> {
    const token = options.protectedLogin ? options.protectedLogin.token(c) : loginTokenOf(c.req.header('cookie'));
    if (!token) return null;
    const principal = await options.authenticate(token);
    return principal && principal.via === undefined ? principal : null;
  }
  const error = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 503, code: string, message: string) => c.json({ error: { code, message } }, status);
  function install(app: Hono) {
    const identify = async (c: Context) => {
      const principal = await cookie(c);
      if (!principal) return { response: error(c, 401, 'unauthorized', '请先登录') } as const;
      const result = await eligible(principal, c.req.param('projectId') ?? '', c.req.param('workspaceId') ?? '');
      if (!result.ok) return { response: error(c, result.reason === 'not_found' ? 404 : result.reason === 'unavailable' ? 503 : 403, result.reason, '工作目录不可用') } as const;
      return { principal, target: result.target } as const;
    };
    const csrf = (c: Context) => {
      const value = (c.req.header('cookie') ?? '').split(';').map((part) => part.trim()).find((part) => part.startsWith('hub_csrf='))?.slice(9) ?? '';
      return value !== '' && sameSecret(value, c.req.header('x-hub-csrf') ?? '');
    };
    app.get(base, async (c) => {
      const access = await identify(c);
      if ('response' in access) return access.response;
      c.header('cache-control', 'no-store');
      const rows = terminals.listByOwner(access.principal.user.id).filter((row) => row.projectId === c.req.param('projectId') && row.workspaceId === c.req.param('workspaceId'));
      if (!options.enabled()) return c.json({ available: false, reason: '工作目录终端未启用', terminals: rows.map(dto) });
      if (!canCreate(access.target.workerId)) return c.json({ available: false, reason: '机器未通过独立终端安全检查', terminals: rows.map(dto) });
      try {
        const inv = await gateway(access.target.workerId).inventory();
        return c.json({ available: inv.ok, ...(!inv.ok ? { reason: inv.code === 'unsupported' ? '机器不支持独立终端' : '机器暂时不可用' } : {}), terminals: rows.map(dto) });
      } catch { return c.json({ available: false, reason: '机器暂时不可用', terminals: rows.map(dto) }); }
    });
    app.post(base, async (c) => {
      if (!csrf(c)) return error(c, 403, 'forbidden', 'CSRF 校验失败');
      const access = await identify(c);
      if ('response' in access) return access.response;
      const body = await c.req.json().catch(() => null) as unknown;
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || typeof (body as { requestId?: unknown }).requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test((body as { requestId: string }).requestId)) return error(c, 400, 'invalid', '请求体不合法');
      const requestId = (body as { requestId: string }).requestId;
      try {
        const existing = terminals.getByRequest(access.principal.user.id, requestId);
        if (existing) {
          if (existing.projectId !== c.req.param('projectId') || existing.workspaceId !== c.req.param('workspaceId') || !sameTarget(existing, access.target)) return error(c, 409, 'conflict', '请求已用于其他目录');
          return c.json(dto(existing), 202);
        }
        if (!canCreate(access.target.workerId)) return error(c, 503, 'unavailable', '工作目录终端未启用或机器未就绪');
        const inv = await gateway(access.target.workerId).inventory();
        if (!inv.ok) return error(c, 503, 'unavailable', inv.code === 'unsupported' ? '机器不支持独立终端' : '机器暂时不可用');
        const result = await safety.runExclusive(async () => {
          const principal = await cookie(c);
          if (!principal || principal.user.id !== access.principal.user.id) throw new Error('changed');
          const fresh = await eligible(principal, c.req.param('projectId'), c.req.param('workspaceId'));
          if (!fresh.ok || fresh.target.workerId !== access.target.workerId || fresh.target.workspace.path !== access.target.workspace.path) throw new Error('changed');
          safety.assertNoRemoval({ workspaceId: fresh.target.workspace.id, workerId: fresh.target.workspace.workerId, cwd: fresh.target.workspace.path });
          const old = terminals.getByRequest(access.principal.user.id, requestId);
          if (old) {
            if (old.projectId !== c.req.param('projectId') || old.workspaceId !== c.req.param('workspaceId') || !sameTarget(old, fresh.target)) throw new Error('changed');
            return { row: old, created: false };
          }
          if (!options.access.hasGrant(principal.user.id, fresh.target.workerId) || !canCreate(fresh.target.workerId)) return null;
          const timestamp = now();
          const intent = terminals.create({ id: `wdt_${randomUUID()}`, requestId, ownerId: access.principal.user.id, projectId: c.req.param('projectId'), workspaceId: fresh.target.workspace.id, workerId: fresh.target.workerId, cwd: fresh.target.workspace.path, epoch: null, state: 'pending', createdAt: timestamp, updatedAt: timestamp });
          const row = terminals.transition(intent.id, 'pending', null, 'pending', inv.value.epoch, now());
          if (!row) throw new Error('intent changed before epoch binding');
          // No await between the durable epoch binding and this in-flight guard.
          creating.add(row.id);
          return { row, created: true };
        });
        if (result === null) return error(c, 503, 'unavailable', '工作目录终端未启用或机器未就绪');
        if (!result.created) return c.json(dto(result.row), 202);
        let row = result.row;
        try {
          const principal = await cookie(c);
          const allowed = await eligible(principal, row.projectId, row.workspaceId, row.ownerId);
          const admitted = terminals.get(row.id);
          if (!allowed.ok || !sameTarget(row, allowed.target) || !options.access.hasGrant(row.ownerId, row.workerId) || !canCreate(row.workerId) || admitted?.state !== 'pending' || admitted.epoch !== row.epoch) {
            if (admitted?.state === 'pending' || admitted?.state === 'closing') row = transition(admitted, 'ended') ?? admitted;
            return c.json(dto(terminals.get(row.id) ?? row), 202);
          }
          const created = await gateway(row.workerId).create({ terminalId: row.id, workspaceId: row.workspaceId, cwd: row.cwd, epoch: row.epoch! });
          const fresh = terminals.get(row.id);
          if (created.ok && fresh?.state === 'pending' && fresh.epoch === row.epoch && created.value.state !== 'ended') row = transition(fresh, created.value.state) ?? fresh;
        } catch { /* never retry an ambiguous create */ } finally { creating.delete(row.id); }
        return c.json(dto(terminals.get(row.id) ?? row), 202);
      } catch { return error(c, 409, 'conflict', '工作目录正在变更或不可用'); }
    });
    app.delete(`${base}/:terminalId`, async (c) => {
      if (!csrf(c)) return error(c, 403, 'forbidden', 'CSRF 校验失败');
      const access = await identify(c);
      if ('response' in access) return access.response;
      const row = terminals.get(c.req.param('terminalId'));
      if (!row || row.ownerId !== access.principal.user.id || row.projectId !== c.req.param('projectId') || row.workspaceId !== c.req.param('workspaceId') || !sameTarget(row, access.target)) return error(c, 404, 'not_found', '终端不存在');
      return c.json(dto(await closeRow(row)), 202);
    });
  }

  const reject = (socket: Duplex, status: number) => {
    if (!socket.writableEnded) socket.end(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : status === 404 ? 'Not Found' : 'Forbidden'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };
  async function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const match = pathPattern.exec((request.url ?? '').split('?')[0] ?? '');
    if (!match || !options.hostAllowed(request.headers.host) || !originMatches(request.headers.origin, request.headers.host, request.socket.remoteAddress)) return reject(socket, 403);
    let projectId: string, workspaceId: string, terminalId: string;
    try { [projectId, workspaceId, terminalId] = [decodeURIComponent(match[1]!), decodeURIComponent(match[2]!), decodeURIComponent(match[3]!)]; }
    catch { return reject(socket, 403); }
    const token = options.protectedLogin ? options.protectedLogin.socketToken(request) : loginTokenOf(request.headers.cookie);
    const principal = token ? await options.authenticate(token) : null;
    if (!principal || principal.via !== undefined) return reject(socket, 401);
    const row = terminals.get(terminalId);
    if (!row || row.projectId !== projectId || row.workspaceId !== workspaceId || row.ownerId !== principal.user.id || row.state !== 'running' || !row.epoch) return reject(socket, 404);
    const result = await eligible(principal, projectId, workspaceId, row.ownerId);
    if (!result.ok || !sameTarget(row, result.target) || terminals.get(row.id)?.state !== 'running' || !options.access.hasGrant(row.ownerId, row.workerId) || !workerReady(row.workerId)) return reject(socket, 404);
    if (clients.has(row.id)) return reject(socket, 403);
    const query = new URL(request.url ?? '/', 'http://hub').searchParams;
    const size = (name: string, fallback: number) => Math.max(1, Math.min(1000, Math.trunc(Number(query.get(name)) || fallback)));
    const cols = size('cols', 80), rows = size('rows', 24);
    wss.handleUpgrade(request, socket, head, (ws) => {
      // Another upgrade may have completed while authorization was awaiting.
      if (clients.has(row.id)) { ws.close(1008, 'already open'); return; }
      const entry: Entry = { socket: ws, token, row, queue: Promise.resolve(), queuedBytes: 0, alive: true, slowSince: null, attaching: true };
      clients.set(row.id, entry);
      ws.on('close', () => drop(entry));
      ws.on('error', () => drop(entry));
      ws.on('pong', () => { entry.alive = true; });
      ws.on('message', (raw) => {
        let frame: { t?: unknown; d?: unknown; cols?: unknown; rows?: unknown };
        try { frame = JSON.parse(raw.toString()) as typeof frame; } catch { return; }
        if (!frame || typeof frame !== 'object') return;
        if (frame.t === 'ping') { entry.alive = true; send(entry, { t: 'pong' }); return; }
        enqueue(entry, async () => {
          if (!(await valid(entry)) || !authorizedNow(entry)) return drop(entry);
          if (frame.t === 'input' && typeof frame.d === 'string' && frame.d.length > 0 && frame.d.length <= 131_072) gateway(row.workerId).input({ terminalId: row.id, epoch: row.epoch!, data: frame.d });
          if (frame.t === 'resize') {
            const c = Math.trunc(Number(frame.cols)), r = Math.trunc(Number(frame.rows));
            if (Number.isFinite(c) && Number.isFinite(r) && c >= 1 && c <= 1000 && r >= 1 && r <= 1000) await gateway(row.workerId).resize({ terminalId: row.id, epoch: row.epoch!, cols: c, rows: r });
          }
        }, raw.toString().length);
      });
      entry.queue = (async () => {
        try {
          const inv = await gateway(row.workerId).inventory();
          if (!inv.ok || inv.value.epoch !== row.epoch || !inv.value.terminals.some((item) => item.terminalId === row.id && item.workspaceId === row.workspaceId && item.state === 'running')) return;
          const admitted = await safety.runExclusive(async () => {
            if (!(await valid(entry))) return false;
            safety.assertNoRemoval({ workspaceId: row.workspaceId, workerId: row.workerId, cwd: row.cwd });
            return current(entry);
          });
          if (!admitted || !authorizedNow(entry)) return;
          const attached = await gateway(row.workerId).attach({ terminalId: row.id, epoch: row.epoch!, cols, rows });
          if (!attached.ok || !(await valid(entry)) || !authorizedNow(entry)) return;
          send(entry, { t: 'ready', terminalId: row.id });
          if (attached.value.scrollback) {
            if (!(await valid(entry)) || !authorizedNow(entry)) return;
            send(entry, { t: 'data', d: attached.value.scrollback });
          }
          entry.attaching = false;
          return;
        } catch { /* fail closed */ }
        finally { if (entry.attaching) { entry.attaching = false; drop(entry); } }
      })();
    });
  }
  const timer = setInterval(() => { void reconcile().catch(() => undefined); }, 5_000);
  timer.unref();
  const heartbeat = setInterval(() => {
    for (const entry of clients.values()) {
      if (!entry.alive) { drop(entry); continue; }
      entry.alive = false;
      try { entry.socket.ping(); } catch { drop(entry); }
    }
  }, 25_000);
  heartbeat.unref();
  return {
    install,
    attach(request: IncomingMessage, socket: Duplex, head: Buffer) { void upgrade(request, socket, head).catch(() => reject(socket, 403)); },
    onData(workerId: string, epoch: string, terminalId: string, data: string) {
      const entry = clients.get(terminalId);
      if (!entry || entry.row.workerId !== workerId || entry.row.epoch !== epoch) return;
      enqueue(entry, async () => { if (await valid(entry) && authorizedNow(entry)) send(entry, { t: 'data', d: data }); else drop(entry); }, data.length);
    },
    onExit(workerId: string, epoch: string, terminalId: string, code: number) {
      const row = terminals.get(terminalId);
      if (!row || row.workerId !== workerId || row.epoch !== epoch || row.state === 'ended') return;
      transition(row, 'ended');
      const entry = clients.get(terminalId);
      if (entry) {
        void (async () => {
          const principal = await options.authenticate(entry.token);
          if (!current(entry)) return;
          const allowed = await eligible(principal, row.projectId, row.workspaceId, row.ownerId);
          if (current(entry) && allowed.ok && sameTarget(row, allowed.target) && options.access.hasGrant(row.ownerId, row.workerId) && workerReady(row.workerId)) send(entry, { t: 'exit', code });
        })().catch(() => undefined).finally(() => drop(entry));
      }
    },
    onWorkerGone(workerId: string) { for (const entry of clients.values()) if (entry.row.workerId === workerId) drop(entry); },
    onRevoked() {
      for (const entry of clients.values()) if (!authorizedNow(entry)) drop(entry);
      void reconcile().catch(() => undefined);
    },
    reconcile,
    close() { clearInterval(timer); clearInterval(heartbeat); for (const entry of clients.values()) drop(entry); wss.close(); }
  };
}
