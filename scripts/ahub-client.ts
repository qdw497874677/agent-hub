import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { isIPv4 } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';

export interface HubProfile { hubUrl: string; token: string }
export interface HubConnection { hubUrl: string; token: string }
export interface ConnectionOptions { allowHttp?: boolean }
export interface ClientOptions extends ConnectionOptions { fetch?: typeof fetch; timeoutMs?: number; maxResponseBytes?: number }
export interface ProfileOptions extends ClientOptions { directory?: string }
export interface HubRequestOptions { method?: string; body?: unknown; headers?: HeadersInit; signal?: AbortSignal }
export interface HubClient { request<T = unknown>(path: string, options?: HubRequestOptions): Promise<T> }
export type HubErrorKind = 'configuration' | 'storage' | 'http' | 'redirect' | 'network' | 'timeout' | 'aborted' | 'protocol';
export class HubClientError extends Error {
  readonly kind: HubErrorKind;
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  constructor(kind: HubErrorKind, message: string, details: { status?: number; retryable?: boolean; retryAfterMs?: number } = {}) {
    super(message);
    this.name = 'HubClientError';
    this.kind = kind;
    this.status = details.status;
    this.retryable = details.retryable ?? false;
    this.retryAfterMs = details.retryAfterMs;
  }
}
const fail = (kind: HubErrorKind, message: string): never => { throw new HubClientError(kind, message); };
function tokenValid(token: unknown): token is string {
  return typeof token === 'string' && /^ahp_[A-Za-z0-9_-]+$/.test(token);
}
function checkedToken(token: unknown): string {
  if (!tokenValid(token)) return fail('configuration', 'Invalid access token');
  return token;
}
function safePath(path: string): boolean {
  // Avoid ambiguities across proxies, including nested encodings and WHATWG dot normalization.
  if (!path.startsWith('/') || path.includes('\\') || /[\x00-\x20\x7f]/.test(path)) return false;
  for (const segment of path.split('/')) {
    if (!segment) continue;
    let decoded = segment;
    try {
      for (let i = 0; i < 4 && decoded.includes('%'); i++) decoded = decodeURIComponent(decoded);
    } catch { return false; }
    if (decoded.includes('%') || decoded === '.' || decoded === '..' || /[/\\?#\x00-\x20\x7f]/.test(decoded)) return false;
  }
  return true;
}
export function parseHubBase(raw: string, allowHttp = false): URL {
  if (typeof raw !== 'string' || /[?#\\\x00-\x20\x7f]/.test(raw)) return fail('configuration', 'Invalid Hub URL');
  const match = /^(https?):\/\/([^/]+)(\/.*)?$/i.exec(raw);
  if (!match || match[2].includes('@') || !safePath(match[3] ?? '/')) return fail('configuration', 'Invalid Hub URL');
  let url: URL;
  try { url = new URL(raw); } catch { return fail('configuration', 'Invalid Hub URL'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return fail('configuration', 'Invalid Hub URL');
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || (isIPv4(url.hostname) && url.hostname.startsWith('127.'));
  if (url.protocol === 'http:' && (!allowHttp || !loopback)) return fail('configuration', 'HTTP requires explicit permission and a loopback address');
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url;
}
function normalized(profile: HubProfile, allowHttp = false): HubConnection {
  if (!profile || typeof profile !== 'object') return fail('configuration', 'Invalid Hub profile');
  return { hubUrl: parseHubBase(profile.hubUrl, allowHttp).href.replace(/\/$/, ''), token: checkedToken(profile.token) };
}
export function resolveConnection(env: NodeJS.ProcessEnv, profile?: HubProfile, options: ConnectionOptions = {}): HubConnection {
  const hasUrl = env.AHUB_HUB_URL !== undefined;
  const hasToken = env.AHUB_API_TOKEN !== undefined;
  if (hasUrl !== hasToken) return fail('configuration', 'Hub URL and token must be supplied together');
  if (hasUrl) return normalized({ hubUrl: env.AHUB_HUB_URL!, token: env.AHUB_API_TOKEN! }, options.allowHttp);
  if (!profile) return fail('configuration', 'No Hub connection configured');
  return normalized(profile, options.allowHttp);
}
function directory(options: ProfileOptions): string {
  return resolve(options.directory ?? join(homedir(), '.config', 'ahub'));
}
function profilePath(name: string, options: ProfileOptions): string {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) return fail('configuration', 'Invalid profile name');
  return join(directory(options), `${name}.json`);
}
function safeDir(dir: string, create: boolean): boolean {
  // Check each component without following links; only the private directory must be 0700.
  const root = parse(dir).root;
  let current = root;
  for (const part of dir.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, part);
    let stat;
    try { stat = lstatSync(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return fail('storage', 'Cannot access profile directory');
      if (!create) return false;
      try { mkdirSync(current, { mode: 0o700 }); stat = lstatSync(current); } catch { return fail('storage', 'Cannot create profile directory'); }
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return fail('storage', 'Unsafe profile directory');
    if (current === dir && ((stat.mode & 0o7777) !== 0o700 || (process.getuid && stat.uid !== process.getuid()))) return fail('storage', 'Unsafe profile directory');
  }
  return true;
}
function readStored(path: string): HubProfile | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o7777) !== 0o600 || (process.getuid && stat.uid !== process.getuid()) || stat.size > 16384 || stat.nlink !== 1) return fail('storage', 'Unsafe profile file');
    const data = JSON.parse(readFileSync(fd, 'utf8'));
    if (!data || data.format !== 'ahub-profile-v1' || typeof data.hubUrl !== 'string' || !tokenValid(data.token) || Object.keys(data).sort().join(',') !== 'format,hubUrl,token') return fail('storage', 'Invalid profile file');
    return { hubUrl: data.hubUrl, token: data.token };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof HubClientError) throw error;
    return fail('storage', 'Cannot read profile');
  } finally { if (fd !== undefined) closeSync(fd); }
}
export async function readProfile(name: string, options: ProfileOptions = {}): Promise<HubProfile | undefined> {
  const path = profilePath(name, options);
  if (!safeDir(dirname(path), false)) return undefined;
  const profile = readStored(path);
  return profile ? normalized(profile, options.allowHttp) : undefined;
}
export async function writeProfile(name: string, profile: HubProfile, options: ProfileOptions = {}): Promise<void> {
  const path = profilePath(name, options);
  const connection = normalized(profile, options.allowHttp);
  const identity = await createHubClient(connection, options).request<{ user?: { id?: unknown }; token?: { id?: unknown } }>('/me');
  if (typeof identity?.user?.id !== 'string' || !identity.user.id || typeof identity?.token?.id !== 'string' || !identity.token.id) return fail('protocol', 'Invalid Hub identity response');
  safeDir(dirname(path), true);
  // Never replace a file that is not a valid profile owned by this client.
  readStored(path);
  const temp = join(dirname(path), `.ahub-${randomBytes(16).toString('hex')}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    fchmodSync(fd, 0o600);
    writeFileSync(fd, JSON.stringify({ format: 'ahub-profile-v1', ...connection }) + '\n');
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temp, path);
  } catch { return fail('storage', 'Cannot write profile'); }
  finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temp); } catch {} }
}
export async function removeProfile(name: string, options: ProfileOptions = {}): Promise<void> {
  const path = profilePath(name, options);
  if (!safeDir(dirname(path), false) || !readStored(path)) return;
  try { unlinkSync(path); } catch { return fail('storage', 'Cannot remove profile'); }
}
function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, Math.min(ms, 86400000)) : undefined;
}
export function createHubClient(connection: HubConnection, options: ClientOptions = {}): HubClient {
  const { hubUrl, token } = normalized(connection, options.allowHttp);
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30000;
  const maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) return fail('configuration', 'Invalid client limits');
  return {
    async request<T = unknown>(path: string, request: HubRequestOptions = {}): Promise<T> {
      if (typeof path !== 'string' || path.includes('#')) return fail('configuration', 'Invalid request path');
      const [pathname] = path.split('?');
      if (!safePath(pathname) || pathname.startsWith('//')) return fail('configuration', 'Invalid request path');
      const url = new URL(`${hubUrl}/openapi/v1${path}`);
      const base = new URL(`${hubUrl}/openapi/v1/`);
      if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return fail('configuration', 'Invalid request path');
      const method = (request.method ?? 'GET').toUpperCase();
      if (!/^[A-Z]+$/.test(method)) return fail('configuration', 'Invalid request method');
      let headers: Headers;
      try { headers = new Headers(request.headers); } catch { return fail('configuration', 'Invalid request headers'); }
      for (const name of ['authorization', 'proxy-authorization', 'cookie', 'host']) if (headers.has(name)) return fail('configuration', 'Reserved request header');
      headers.set('authorization', `Bearer ${token}`);
      headers.set('accept', 'application/json');
      let body: string | undefined;
      if (request.body !== undefined) {
        try { body = JSON.stringify(request.body); } catch { return fail('configuration', 'Invalid request body'); }
        if (body === undefined) return fail('configuration', 'Invalid request body');
        headers.set('content-type', 'application/json');
      }
      if (request.signal?.aborted) throw new HubClientError('aborted', 'Request aborted');
      const controller = new AbortController();
      let timedOut = false;
      let rejectStop!: (reason: HubClientError) => void;
      const stopped = new Promise<never>((_, reject) => { rejectStop = reject; });
      const abort = () => { controller.abort(); rejectStop(new HubClientError('aborted', 'Request aborted')); };
      const timer = setTimeout(() => { timedOut = true; controller.abort(); rejectStop(new HubClientError('timeout', 'Request timed out')); }, timeoutMs);
      request.signal?.addEventListener('abort', abort, { once: true });
      if (request.signal?.aborted) abort();
      try {
        const run = async (): Promise<T> => {
          let response: Response;
          try { response = await fetcher(url, { method, headers, body, signal: controller.signal, redirect: 'manual' }); }
          catch { throw new HubClientError('network', 'Hub request failed', { retryable: method === 'GET' }); }
          if (response.status >= 300 && response.status < 400) { void response.body?.cancel().catch(() => {}); throw new HubClientError('redirect', 'Hub redirect refused', { status: response.status }); }
          if (!response.ok) {
            void response.body?.cancel().catch(() => {});
            throw new HubClientError('http', 'Hub request failed', { status: response.status, retryable: method === 'GET' && (response.status === 429 || response.status >= 500), retryAfterMs: retryAfter(response.headers.get('retry-after')) });
          }
          const length = response.headers.get('content-length');
          if (length && /^\d+$/.test(length) && Number(length) > maxResponseBytes) { void response.body?.cancel().catch(() => {}); throw new HubClientError('protocol', 'Hub response too large'); }
          const chunks: Uint8Array[] = []; let size = 0;
          if (response.body) {
            const reader = response.body.getReader();
            try {
              for (;;) {
                let result: ReadableStreamReadResult<Uint8Array>;
                try { result = await reader.read(); }
                catch { throw new HubClientError('network', 'Hub request failed', { retryable: method === 'GET' }); }
                const { done, value } = result;
                if (done) break;
                size += value.byteLength;
                if (size > maxResponseBytes) { void reader.cancel().catch(() => {}); throw new HubClientError('protocol', 'Hub response too large'); }
                chunks.push(value);
              }
            } finally { reader.releaseLock(); }
          }
          if (!size) return undefined as T;
          try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T; } catch { throw new HubClientError('protocol', 'Invalid Hub response'); }
        };
        return await Promise.race([run(), stopped]);
      } catch (error) {
        if (error instanceof HubClientError) throw error;
        if (timedOut) throw new HubClientError('timeout', 'Request timed out');
        if (request.signal?.aborted) throw new HubClientError('aborted', 'Request aborted');
        throw new HubClientError('network', 'Hub request failed', { retryable: method === 'GET' });
      } finally { clearTimeout(timer); request.signal?.removeEventListener('abort', abort); }
    }
  };
}
