import { Buffer } from 'node:buffer';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns';
import { constants as fsConstants, createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createMcpEgress,
  normalizeEgressHost,
  type EgressResolver,
  type ResolvedAddress
} from './mcp-egress.ts';

/**
 * 隔离执行器里的「项目 HTTPS Git 抓取」机制（不接路由，不碰会话工作区）。
 *
 * 一次操作只做：
 *   git fetch <loopback bridge> +refs/heads/<branch>:refs/heads/<branch>
 * 然后在一个全新的 bare 暂存里生成并校验「单分支、自包含」的 bundle。
 *
 * 边界：
 * - Git 只看到一个每操作随机生成的 `http://127.0.0.1:<port>/r/<token>/repo.git`；
 *   远端 URL 与 Authorization 只存在于本进程的 bridge 闭包里，不进入 Git 参数 / 环境 / 配置。
 * - bridge 只接受两条精确路由：`GET …/info/refs?service=git-upload-pack` 与
 *   `POST …/git-upload-pack`。其它路径 / 方法 / 查询参数一律 404，不触上游。
 * - 上游出口复用 `createMcpEgress`：只 HTTPS、DNS 只解析公网地址、不跟随重定向、私有 Agent。
 * - 上游响应必须是 identity 编码，GET/POST 两次响应共享一个硬字节上限；超限即销毁连接，
 *   不让下游把截断内容当成成功。POST 请求体同样有上限。
 * - Git 用全新暂存目录、隔离 HOME、空 system/global config、禁用 hooks / helper / 子模块 /
 *   除 http 之外的所有协议；不使用 `--depth`，只抓指定分支的完整历史，不抓 tag。
 * - 结果 bundle 先在本进程内校验（`bundle verify`、list-heads 恰好一个 ref、tip 一致、
 *   文件大小有界、SHA-256），再复制到调用方给定的输出目录；暂存目录始终清理。
 *
 * **不是 OS 级隔离**：Git 与 hub 同账号运行，磁盘、进程和配置隔离都靠本机制自觉。
 * 生产启用前需要专用 UID、专用数据目录和磁盘配额；在这些到位前不要接路由。
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_UPSTREAM_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_UPLOAD_PACK_REQUEST_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT = 1;
const MAX_GIT_STDOUT_BYTES = 64 * 1024;
const MAX_BRANCH_LENGTH = 255;
const MAX_AUTHORIZATION_LENGTH = 8192;

const ADVERTISEMENT_CONTENT_TYPE = 'application/x-git-upload-pack-advertisement';
const REQUEST_CONTENT_TYPE = 'application/x-git-upload-pack-request';
const RESULT_CONTENT_TYPE = 'application/x-git-upload-pack-result';
const USER_AGENT = 'agent-hub-isolated-git/1';

const MESSAGES: Record<ProjectGitFetchFailureCode, string> = {
  bad_target: '仓库目标不合法',
  blocked: '仓库目标不在允许范围内',
  bad_branch: '分支名不合法',
  bad_authorization: '仓库凭据格式不正确',
  busy: '仓库抓取繁忙，请稍后再试',
  closed: '仓库抓取已关闭',
  timeout: '仓库抓取超时',
  upstream: '仓库上游请求失败',
  too_large: '仓库抓取超出上限',
  git_failed: '仓库抓取失败',
  bundle_invalid: '仓库抓取结果校验失败',
  io: '仓库抓取暂存失败',
  generic: '仓库抓取失败'
};

export type ProjectGitFetchFailureCode =
  | 'bad_target'
  | 'blocked'
  | 'bad_branch'
  | 'bad_authorization'
  | 'busy'
  | 'closed'
  | 'timeout'
  | 'upstream'
  | 'too_large'
  | 'git_failed'
  | 'bundle_invalid'
  | 'io'
  | 'generic';

export interface ProjectGitFetchRequest {
  /** 父级从已登记仓库解析出的精确 HTTPS 克隆地址；不接受 query / fragment / userinfo。 */
  readonly repoUrl: string;
  /** 精确分支名（也接受 `refs/heads/<branch>`）；不接受选项、通配或其它 ref 命名空间。 */
  readonly branch: string;
  /** 已经生成好的 `Basic …` 头值；空串表示无凭据。 */
  readonly authorization: string;
}

export interface ProjectGitFetchResult {
  readonly branch: string;
  readonly ref: string;
  /** 抓取后 bare 暂存里该分支的提交 SHA。 */
  readonly tip: string;
  /** 已校验完成的单分支 bundle；位于调用方给定的 outputDir 下。 */
  readonly bundlePath: string;
  readonly bundleBytes: number;
  readonly bundleSha256: string;
}

export type ProjectGitFetchOutcome =
  | { readonly ok: true; readonly result: ProjectGitFetchResult }
  | { readonly ok: false; readonly code: ProjectGitFetchFailureCode; readonly message: string };

export interface ProjectGitFetchOptions {
  /** 精确的 operator 放行 origin，例如 `https://github.com`；不接受通配、路径、query、fragment。 */
  readonly allowedOrigins: readonly string[];
  /** 父级拥有的输出目录；bundle 以随机文件名写入这里，必须是绝对路径。 */
  readonly outputDir: string;
  /** 暂存根目录，默认 `os.tmpdir()`；生产应指向专用数据目录。 */
  readonly scratchRoot?: string;
  /**
   * 测试 / 父级真实 TLS fixture 专用：额外放行 loopback（127.0.0.1 / ::1 / localhost）。
   * 生产保持关闭。
   */
  readonly testOnlyAllowLoopback?: boolean;
  /** 整次操作（含 Git 子进程与 bundle 校验）的硬超时，默认 30 秒。 */
  readonly timeoutMs?: number;
  /** 一次操作内所有上游响应（GET 广告 + POST 结果）合计的硬字节上限。 */
  readonly maxUpstreamBytes?: number;
  /** 单次 upload-pack 请求体的硬上限。 */
  readonly maxUploadPackRequestBytes?: number;
  /** 最终 bundle 文件的硬上限。 */
  readonly maxBundleBytes?: number;
  /** 同时在途的操作数上限，默认 1；超出的请求直接失败，不排队。 */
  readonly maxConcurrent?: number;
  /** 测试 / 宿主注入的 DNS 解析器；生产默认 node:dns。 */
  readonly resolve?: EgressResolver;
  /** 测试注入的 fetch；仍会经过本模块与 `createMcpEgress` 的 URL 校验。 */
  readonly fetchImpl?: typeof fetch;
  /** 测试注入的 git 可执行文件；默认 `git`。 */
  readonly gitCommand?: string;
  /** 仅测试：bridge 监听成功后、启动 Git 前回调。 */
  readonly testOnlyOnBridgeReady?: (url: string) => void | Promise<void>;
  /** 仅测试：每次 spawn Git 前回调（参数与最终环境），用于断言「Git 看不到远端与凭据」。 */
  readonly testOnlyOnGitSpawn?: (info: {
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
  }) => void;
}

export interface ProjectGitFetcher {
  fetch(input: ProjectGitFetchRequest): Promise<ProjectGitFetchOutcome>;
  close(): Promise<void>;
}

class FetchFailure extends Error {
  readonly code: ProjectGitFetchFailureCode;

  constructor(code: ProjectGitFetchFailureCode, message?: string) {
    super(message ?? MESSAGES[code] ?? MESSAGES.generic);
    this.name = 'ProjectGitFetchFailure';
    this.code = code;
  }
}

function failure(code: ProjectGitFetchFailureCode): ProjectGitFetchOutcome {
  return { ok: false, code, message: MESSAGES[code] ?? MESSAGES.generic };
}

/** 精确 origin 的规范化 key；IPv6 主机名重新加回方括号。 */
function originKey(url: URL): string {
  const host = normalizeEgressHost(url.hostname);
  const hostPart = host.includes(':') ? `[${host}]` : host;
  return `${url.protocol}//${hostPart}${url.port === '' ? '' : `:${url.port}`}`;
}

function parseAllowedOrigins(entries: readonly string[]): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const entry of entries) {
    const raw = entry.trim();
    if (raw === '' || raw.includes('*')) {
      throw new Error('ProjectGitFetch: allowedOrigins 必须是精确的 HTTPS origin');
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error('ProjectGitFetch: allowedOrigins 里有不合法的 URL');
    }
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      (url.pathname !== '' && url.pathname !== '/')
    ) {
      throw new Error('ProjectGitFetch: allowedOrigins 只接受纯 HTTPS origin');
    }
    origins.add(originKey(url));
  }
  return origins;
}

const METADATA_HOSTS = new Set(['metadata', 'metadata.google.internal', 'instance-data']);
const METADATA_ADDRESSES = new Set(['169.254.169.254', '169.254.170.2', '100.100.100.200', 'fd00:ec2::254']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function isMetadataHost(host: string): boolean {
  if (METADATA_HOSTS.has(host)) return true;
  if (host.endsWith('.metadata.google.internal')) return true;
  if (METADATA_ADDRESSES.has(host)) return true;
  return host.includes('169.254.169.254') || host.includes('100.100.100.200');
}

function isLoopbackAddress(address: string): boolean {
  if (address === '::1') return true;
  const parts = address.split('.');
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
  );
}

const defaultResolver: EgressResolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses as ResolvedAddress[]);
    });
  });

/** 测试 loopback 模式下，loopback 主机名只能解析到真 loopback。 */
function createLoopbackResolver(base: EgressResolver | undefined): EgressResolver {
  const resolve = base ?? defaultResolver;
  return async (hostname) => {
    const host = normalizeEgressHost(hostname);
    const addresses = await resolve(hostname);
    if (
      LOOPBACK_HOSTS.has(host) &&
      (addresses.length === 0 || !addresses.every((entry) => isLoopbackAddress(entry.address)))
    ) {
      throw new Error('ProjectGitFetch: 测试 loopback 目标解析到了非回环地址');
    }
    return addresses;
  };
}

function positiveInt(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`ProjectGitFetch: ${name} 必须是正整数`);
  }
  return value;
}

/**
 * 分支名只允许普通分支名：拒绝选项前缀、refspec 元字符、空白 / 控制字符、`..`、`@{`、
 * 首尾斜杠、结尾点与 `.lock`。`refs/heads/<branch>` 形式会去掉前缀后按同一规则校验，
 * 其它 `refs/` 命名空间一律拒绝（本轮只抓分支，不抓 tag / note / 任意 ref）。
 */
function checkedBranch(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  if (raw === '' || raw !== raw.trim() || raw.length > MAX_BRANCH_LENGTH) return null;
  const name = raw.startsWith('refs/heads/') ? raw.slice('refs/heads/'.length) : raw;
  if (name === '' || name.startsWith('refs/')) return null;
  if (name.startsWith('-')) return null;
  if (/[\u0000-\u0020\u007f~^:?*[\\]/u.test(name)) return null;
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return null;
  if (name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return null;
  if (name.endsWith('.lock') || name === '@') return null;
  return name;
}

/** 只接受调用方已经生成好的单行 Basic 头；空串 = 不带上游凭据。 */
function authorizationValue(raw: string): string | undefined {
  if (raw === '') return undefined;
  if (
    typeof raw !== 'string' ||
    raw.length > MAX_AUTHORIZATION_LENGTH ||
    /[\r\n\u0000]/u.test(raw) ||
    !/^Basic [A-Za-z0-9+/]+={0,2}$/iu.test(raw)
  ) {
    throw new FetchFailure('bad_authorization');
  }
  return raw;
}

/**
 * 校验父级给的仓库目标。只放行精确 allowlist origin 下的 HTTPS 仓库路径；
 * 拒绝 userinfo / query / fragment、明文 HTTP、元数据主机、编码后的路径分隔符与 `..` 段。
 */
function targetFor(raw: string, allowedOrigins: ReadonlySet<string>, egress: ReturnType<typeof createMcpEgress>): URL {
  if (typeof raw !== 'string' || raw === '' || raw !== raw.trim()) throw new FetchFailure('bad_target');
  if (/[\s\u0000-\u001f\u007f]/u.test(raw)) throw new FetchFailure('bad_target');
  if (raw.includes('\\')) throw new FetchFailure('bad_target');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchFailure('bad_target');
  }
  if (url.protocol !== 'https:') throw new FetchFailure('bad_target');
  if (url.username !== '' || url.password !== '') throw new FetchFailure('bad_target');
  if (url.search !== '' || url.hash !== '') throw new FetchFailure('bad_target');
  if (url.pathname === '' || url.pathname === '/') throw new FetchFailure('bad_target');
  // 原始串里出现编码的点段 / 分隔符时，WHATWG URL 可能先做归一化，必须按原始输入拒绝。
  if (/%2e|%2f|%5c|%3f|%23/iu.test(raw)) throw new FetchFailure('bad_target');
  // 编码后的分隔符 / 点段 / 查询符会让「登记的路径」和上游实际路径产生歧义。
  if (/%2f|%5c|%3f|%23|%2e/iu.test(url.pathname)) throw new FetchFailure('bad_target');
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    throw new FetchFailure('bad_target');
  }
  if (/[\u0000-\u001f\u007f\\]/u.test(decoded)) throw new FetchFailure('bad_target');
  if (decoded.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new FetchFailure('bad_target');
  }

  const host = normalizeEgressHost(url.hostname);
  if (host === '' || isMetadataHost(host)) throw new FetchFailure('blocked');
  if (!allowedOrigins.has(originKey(url))) throw new FetchFailure('blocked');
  const checked = egress.checkUrl(url.href, { requireHttps: true });
  if (!checked.ok) throw new FetchFailure('blocked');
  return url;
}

function repoBase(target: URL): URL {
  const url = new URL(target.href);
  url.pathname = url.pathname.replace(/\/+$/u, '');
  url.search = '';
  url.hash = '';
  return url;
}

function upstreamUrl(base: URL, suffix: string): string {
  const url = new URL(base.href);
  url.pathname = `${url.pathname}${suffix}`;
  url.search = suffix === '/info/refs' ? '?service=git-upload-pack' : '';
  return url.href;
}

function mediaType(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  return (value.split(';', 1)[0] ?? '').trim().toLowerCase();
}

function isOid(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value);
}

class ConcurrencyLimiter {
  private active = 0;
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  tryAcquire(): boolean {
    if (this.active >= this.limit) return false;
    this.active += 1;
    return true;
  }

  release(): void {
    if (this.active > 0) this.active -= 1;
  }
}

interface OperationState {
  upstreamBytes: number;
  readonly maxUpstreamBytes: number;
  failure: FetchFailure | null;
}

function recordFailure(state: OperationState, failureValue: FetchFailure): void {
  state.failure ??= failureValue;
}

interface Bridge {
  readonly url: string;
  close(): Promise<void>;
}

interface BridgeOptions {
  readonly target: URL;
  readonly authorization: string | undefined;
  readonly egress: ReturnType<typeof createMcpEgress>;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly maxUpstreamBytes: number;
  readonly maxUploadPackRequestBytes: number;
  readonly state: OperationState;
}

const BRIDGE_IN_FLIGHT_LIMIT = 2;

async function startBridge(options: BridgeOptions): Promise<Bridge> {
  const token = randomBytes(24).toString('base64url');
  const route = `/r/${token}/repo.git`;
  const getRoute = `${route}/info/refs?service=git-upload-pack`;
  const postRoute = `${route}/git-upload-pack`;
  const base = repoBase(options.target);
  const sockets = new Set<Socket>();
  let inFlight = 0;
  let port = 0;

  const server: Server = createServer((req, res) => {
    void handle(req, res);
  });
  server.keepAliveTimeout = 1_000;
  server.headersTimeout = Math.min(5_000, options.timeoutMs);
  server.requestTimeout = options.timeoutMs + 1_000;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => {
    socket.destroy();
  });

  function deny(res: ServerResponse, status = 404): void {
    if (res.headersSent || res.destroyed) {
      res.destroy();
      return;
    }
    res.statusCode = status;
    res.setHeader('cache-control', 'no-store');
    res.setHeader('connection', 'close');
    res.end();
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers.host !== `127.0.0.1:${port}`) {
      deny(res, 421);
      return;
    }
    if (inFlight >= BRIDGE_IN_FLIGHT_LIMIT) {
      deny(res, 503);
      return;
    }
    inFlight += 1;
    try {
      if (req.method === 'GET' && req.url === getRoute) {
        await relayGet(req, res);
        return;
      }
      if (req.method === 'POST' && req.url === postRoute) {
        await relayPost(req, res);
        return;
      }
      deny(res);
    } catch (error) {
      if (options.signal.aborted) {
        recordFailure(options.state, new FetchFailure('timeout'));
      } else if (error instanceof FetchFailure) {
        recordFailure(options.state, error);
      } else if (!res.destroyed && !res.writableEnded) {
        recordFailure(options.state, new FetchFailure('upstream'));
      }
      if (res.headersSent || res.destroyed) res.destroy();
      else deny(res, 502);
    } finally {
      inFlight -= 1;
    }
  }

  async function relayGet(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // GET 广告不允许携带请求体。
    if (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0') {
      deny(res, 400);
      return;
    }
    const headers: Record<string, string> = {
      accept: ADVERTISEMENT_CONTENT_TYPE,
      'accept-encoding': 'identity',
      'user-agent': USER_AGENT
    };
    if (options.authorization !== undefined) headers['authorization'] = options.authorization;
    const response = await options.egress.fetch(upstreamUrl(base, '/info/refs'), {
      method: 'GET',
      headers,
      signal: options.signal,
      redirect: 'error'
    });
    await relayResponse(response, res, ADVERTISEMENT_CONTENT_TYPE, options);
  }

  async function relayPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (mediaType(req.headers['content-type']) !== REQUEST_CONTENT_TYPE) {
      deny(res, 415);
      return;
    }
    const encoding = (req.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
    if (encoding !== '' && encoding !== 'identity' && encoding !== 'gzip') {
      deny(res, 415);
      return;
    }
    let body: Buffer;
    try {
      body = await readBoundedBody(req, options.maxUploadPackRequestBytes);
    } catch (error) {
      recordFailure(options.state, error instanceof FetchFailure ? error : new FetchFailure('upstream'));
      deny(res, 413);
      return;
    }
    const headers: Record<string, string> = {
      'content-type': REQUEST_CONTENT_TYPE,
      accept: RESULT_CONTENT_TYPE,
      'accept-encoding': 'identity',
      'user-agent': USER_AGENT
    };
    if (encoding === 'gzip') headers['content-encoding'] = 'gzip';
    if (options.authorization !== undefined) headers['authorization'] = options.authorization;
    const response = await options.egress.fetch(upstreamUrl(base, '/git-upload-pack'), {
      method: 'POST',
      headers,
      body,
      signal: options.signal,
      redirect: 'error'
    });
    await relayResponse(response, res, RESULT_CONTENT_TYPE, options);
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new FetchFailure('io');
  }
  port = address.port;

  let closed = false;
  return {
    url: `http://127.0.0.1:${port}${route}`,
    close(): Promise<void> {
      if (closed) return Promise.resolve();
      closed = true;
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  };
}

async function relayResponse(
  response: Response,
  res: ServerResponse,
  expectedType: string,
  options: BridgeOptions
): Promise<void> {
  if (response.status !== 200) {
    void response.body?.cancel().catch(() => {});
    recordFailure(options.state, new FetchFailure('upstream'));
    res.statusCode = 502;
    res.setHeader('cache-control', 'no-store');
    res.setHeader('connection', 'close');
    res.end();
    return;
  }
  if (mediaType(response.headers.get('content-type')) !== expectedType) {
    void response.body?.cancel().catch(() => {});
    recordFailure(options.state, new FetchFailure('upstream'));
    res.statusCode = 502;
    res.setHeader('cache-control', 'no-store');
    res.setHeader('connection', 'close');
    res.end();
    return;
  }
  const encoding = (response.headers.get('content-encoding') ?? 'identity').trim().toLowerCase();
  if (encoding !== '' && encoding !== 'identity') {
    void response.body?.cancel().catch(() => {});
    recordFailure(options.state, new FetchFailure('upstream'));
    res.statusCode = 502;
    res.setHeader('cache-control', 'no-store');
    res.setHeader('connection', 'close');
    res.end();
    return;
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared >= 0) {
    if (options.state.upstreamBytes + declared > options.state.maxUpstreamBytes) {
      void response.body?.cancel().catch(() => {});
      recordFailure(options.state, new FetchFailure('too_large'));
      res.statusCode = 502;
      res.setHeader('cache-control', 'no-store');
      res.setHeader('connection', 'close');
      res.end();
      return;
    }
  }

  res.statusCode = 200;
  res.setHeader('content-type', expectedType);
  res.setHeader('cache-control', 'no-store');
  await streamResponse(response, res, options);
}

/** 流式转发上游响应，逐块累加共享上限；超限 / 中止 / 下游断开都立即取消上游并销毁下游。 */
async function streamResponse(response: Response, res: ServerResponse, options: BridgeOptions): Promise<void> {
  const body = response.body;
  if (body === null) throw new FetchFailure('upstream');
  const reader = body.getReader();
  let cancelled = false;
  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    void reader.cancel().catch(() => {});
  };
  const onAbort = (): void => cancel();
  const onClose = (): void => cancel();
  options.signal.addEventListener('abort', onAbort, { once: true });
  res.once('close', onClose);
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value = chunk.value;
      if (value === undefined) continue;
      options.state.upstreamBytes += value.byteLength;
      if (options.state.upstreamBytes > options.state.maxUpstreamBytes) {
        cancel();
        recordFailure(options.state, new FetchFailure('too_large'));
        res.destroy();
        return;
      }
      if (!res.write(Buffer.from(value))) await waitDrainOrClose(res, options.signal);
      if (res.destroyed) {
        cancel();
        return;
      }
    }
    res.end();
  } finally {
    options.signal.removeEventListener('abort', onAbort);
    res.off('close', onClose);
    cancel();
  }
}

function waitDrainOrClose(res: ServerResponse, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => {
      res.off('drain', done);
      res.off('close', done);
      signal.removeEventListener('abort', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
    signal.addEventListener('abort', done, { once: true });
  });
}

async function readBoundedBody(req: IncomingMessage, cap: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += value.length;
    if (total > cap) throw new FetchFailure('too_large');
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

interface GitResult {
  readonly stdout: string;
}

interface RunGitOptions {
  readonly gitCommand: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly extraEnv?: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly capture?: boolean;
  readonly onSpawn?: (info: { readonly args: readonly string[]; readonly env: Readonly<Record<string, string>> }) => void;
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // 已经退出
    }
  }
}

function runGit(args: readonly string[], options: RunGitOptions): Promise<GitResult> {
  return new Promise<GitResult>((resolve, reject) => {
    if (options.signal.aborted) {
      reject(new FetchFailure('timeout'));
      return;
    }
    const env = options.extraEnv === undefined ? { ...options.env } : { ...options.env, ...options.extraEnv };
    options.onSpawn?.({ args: [...args], env: { ...env } });
    let child: ChildProcess;
    try {
      child = spawn(options.gitCommand, [...args], {
        cwd: options.cwd,
        env,
        detached: true,
        stdio: ['ignore', options.capture === true ? 'pipe' : 'ignore', 'ignore']
      });
    } catch {
      reject(new FetchFailure('git_failed'));
      return;
    }

    let settled = false;
    let stdout = '';
    let stdoutBytes = 0;

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener('abort', onAbort);
      child.stdout?.removeAllListeners('data');
      callback();
    };
    const onAbort = (): void => {
      killTree(child);
      finish(() => reject(new FetchFailure(options.signal.aborted ? 'timeout' : 'git_failed')));
    };
    options.signal.addEventListener('abort', onAbort, { once: true });
    if (options.signal.aborted) {
      onAbort();
      return;
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_GIT_STDOUT_BYTES) {
        killTree(child);
        finish(() => reject(new FetchFailure('git_failed')));
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.once('error', () => {
      finish(() => reject(new FetchFailure('git_failed')));
    });
    child.once('exit', (code) => {
      finish(() => {
        if (code === 0) resolve({ stdout });
        else reject(new FetchFailure('git_failed'));
      });
    });
  });
}

interface Deadline {
  readonly signal: AbortSignal;
  isTimedOut(): boolean;
  clear(): void;
}

function createDeadline(timeoutMs: number, controllers: Set<AbortController>): Deadline {
  const controller = new AbortController();
  controllers.add(controller);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref();
  return {
    signal: controller.signal,
    isTimedOut: () => timedOut,
    clear: () => {
      clearTimeout(timer);
      controllers.delete(controller);
    }
  };
}

/** Git 的最终环境：只保留可执行文件查找与 locale，其余全部由本模块给出。 */
function gitEnvironment(input: {
  readonly scratch: string;
  readonly home: string;
  readonly emptyConfig: string;
}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: input.home,
    XDG_CONFIG_HOME: join(input.home, '.config'),
    TMPDIR: input.scratch,
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: input.emptyConfig,
    GIT_CONFIG_GLOBAL: input.emptyConfig,
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/false',
    SSH_ASKPASS: '/bin/false',
    GIT_ALLOW_PROTOCOL: 'http',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CEILING_DIRECTORIES: input.scratch,
    // 即使上层环境有代理，也只允许直连本机 bridge。
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    NO_PROXY: '*',
    http_proxy: '',
    https_proxy: '',
    all_proxy: '',
    no_proxy: '*'
  };
  return env;
}

/** 所有 Git 命令共用的安全配置；不加载暂存目录之外的任何配置、hooks 或 helper。 */
function gitConfigArgs(hooks: string): string[] {
  return [
    '-c',
    'core.hooksPath=' + hooks,
    '-c',
    'core.fsmonitor=false',
    '-c',
    'protocol.version=0',
    '-c',
    'protocol.allow=never',
    '-c',
    'protocol.http.allow=always',
    '-c',
    'http.followRedirects=false',
    '-c',
    'http.sslVerify=true',
    '-c',
    'http.proxy=',
    '-c',
    'credential.helper=',
    '-c',
    'fetch.recurseSubmodules=false',
    '-c',
    'submodule.recurse=false',
    '-c',
    'gc.auto=0',
    '-c',
    'maintenance.auto=false',
    '-c',
    'fetch.writeCommitGraph=false',
    '-c',
    'init.defaultBranch=main'
  ];
}

async function sha256File(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    if (signal?.aborted === true) throw new FetchFailure('timeout');
    hash.update(chunk as Buffer);
  }
  if (signal?.aborted === true) throw new FetchFailure('timeout');
  return hash.digest('hex');
}

function parseSingleHead(output: string, ref: string): string | null {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length !== 1) return null;
  const match = /^([0-9a-f]{40}|[0-9a-f]{64}) (\S+)$/u.exec(lines[0] as string);
  if (match === null) return null;
  if (match[2] !== ref) return null;
  return match[1] as string;
}

export function createProjectGitFetcher(options: ProjectGitFetchOptions): ProjectGitFetcher {
  if (!isAbsolute(options.outputDir)) {
    throw new Error('ProjectGitFetch: outputDir 必须是绝对路径');
  }
  const allowedOrigins = parseAllowedOrigins(options.allowedOrigins);
  const testLoopback = options.testOnlyAllowLoopback === true;
  const allowPrivateHosts = testLoopback ? [...LOOPBACK_HOSTS] : [];
  const resolve = testLoopback ? createLoopbackResolver(options.resolve) : options.resolve;
  const egress = createMcpEgress({
    // 独立显式策略：不读 MCP_EGRESS_*，上游只允许 HTTPS 公网；私网只给测试 loopback 开。
    policy: { allowPrivateHosts, allowHttpHosts: [] },
    ...(resolve === undefined ? {} : { resolve }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
  });

  const runtime = {
    outputDir: options.outputDir,
    scratchRoot: options.scratchRoot ?? tmpdir(),
    timeoutMs: positiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs'),
    maxUpstreamBytes: positiveInt(options.maxUpstreamBytes, DEFAULT_MAX_UPSTREAM_BYTES, 'maxUpstreamBytes'),
    maxUploadPackRequestBytes: positiveInt(
      options.maxUploadPackRequestBytes,
      DEFAULT_MAX_UPLOAD_PACK_REQUEST_BYTES,
      'maxUploadPackRequestBytes'
    ),
    maxBundleBytes: positiveInt(options.maxBundleBytes, DEFAULT_MAX_BUNDLE_BYTES, 'maxBundleBytes'),
    gitCommand: options.gitCommand ?? 'git'
  };
  const limiter = new ConcurrencyLimiter(positiveInt(options.maxConcurrent, DEFAULT_MAX_CONCURRENT, 'maxConcurrent'));
  const controllers = new Set<AbortController>();

  let closed = false;
  let closing: Promise<void> | null = null;

  async function fetchOnce(input: ProjectGitFetchRequest): Promise<ProjectGitFetchOutcome> {
    let target: URL;
    let branch: string;
    let authorization: string | undefined;
    try {
      target = targetFor(input.repoUrl, allowedOrigins, egress);
      const checked = checkedBranch(input.branch);
      if (checked === null) throw new FetchFailure('bad_branch');
      branch = checked;
      authorization = authorizationValue(input.authorization);
    } catch (error) {
      return failure(error instanceof FetchFailure ? error.code : 'bad_target');
    }

    const ref = `refs/heads/${branch}`;
    const state: OperationState = {
      upstreamBytes: 0,
      maxUpstreamBytes: runtime.maxUpstreamBytes,
      failure: null
    };
    const deadline = createDeadline(runtime.timeoutMs, controllers);

    let scratch: string | null = null;
    let bridge: Bridge | null = null;
    try {
      await mkdir(runtime.outputDir, { recursive: true, mode: 0o700 });
      await mkdir(runtime.scratchRoot, { recursive: true, mode: 0o700 });
      scratch = await mkdtemp(join(runtime.scratchRoot, 'agent-hub-git-fetch-'));
      const home = join(scratch, 'home');
      const hooks = join(scratch, 'hooks');
      const emptyConfig = join(scratch, 'empty.gitconfig');
      const repoDir = join(scratch, 'repo.git');
      const bundleTmp = join(scratch, 'out.bundle');
      await mkdir(home, { recursive: true, mode: 0o700 });
      await mkdir(join(home, '.config'), { recursive: true, mode: 0o700 });
      await mkdir(hooks, { recursive: true, mode: 0o700 });
      await writeFile(emptyConfig, '', { mode: 0o600 });

      const env = gitEnvironment({ scratch, home, emptyConfig });
      const config = gitConfigArgs(hooks);
      const run = (args: readonly string[], capture = false, extraEnv?: Readonly<Record<string, string>>): Promise<GitResult> =>
        runGit(args, {
          gitCommand: runtime.gitCommand,
          cwd: scratch as string,
          env,
          ...(extraEnv === undefined ? {} : { extraEnv }),
          signal: deadline.signal,
          capture,
          ...(options.testOnlyOnGitSpawn === undefined ? {} : { onSpawn: options.testOnlyOnGitSpawn })
        });

      bridge = await startBridge({
        target,
        authorization,
        egress,
        signal: deadline.signal,
        timeoutMs: runtime.timeoutMs,
        maxUpstreamBytes: runtime.maxUpstreamBytes,
        maxUploadPackRequestBytes: runtime.maxUploadPackRequestBytes,
        state
      });
      await options.testOnlyOnBridgeReady?.(bridge.url);

      await run([...config, 'init', '--bare', '--quiet', repoDir]);
      // 只抓指定分支的完整历史：显式 refspec、无 depth、无 tag、无子模块。
      await run([
        ...config,
        '-C',
        repoDir,
        'fetch',
        '--quiet',
        '--no-tags',
        '--no-recurse-submodules',
        '--force',
        '--',
        bridge.url,
        `+${ref}:${ref}`
      ]);

      // 抓取已结束；后续本地校验不再需要 bridge，也不应让它继续监听。
      if (bridge !== null) {
        const finished = bridge;
        bridge = null;
        try {
          await finished.close();
        } catch {
          // 关闭失败不影响已经完成的抓取结果
        }
      }

      const refs = (await run([...config, '-C', repoDir, 'for-each-ref', '--format=%(refname)'], true)).stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
      if (refs.length !== 1 || refs[0] !== ref) throw new FetchFailure('bundle_invalid');

      const tip = (await run([...config, '-C', repoDir, 'rev-parse', '--verify', '--quiet', ref], true)).stdout.trim();
      if (!isOid(tip)) throw new FetchFailure('bundle_invalid');

      await run([...config, '-C', repoDir, 'bundle', 'create', bundleTmp, ref]);
      await run([...config, '-C', repoDir, 'bundle', 'verify', bundleTmp]);
      const heads = (await run([...config, '-C', repoDir, 'bundle', 'list-heads', bundleTmp], true)).stdout;
      if (parseSingleHead(heads, ref) !== tip) throw new FetchFailure('bundle_invalid');

      const info = await stat(bundleTmp);
      if (!info.isFile() || info.size <= 0) throw new FetchFailure('bundle_invalid');
      if (info.size > runtime.maxBundleBytes) throw new FetchFailure('too_large');

      // 真正的可恢复性校验：把 bundle 导入第二个空 bare 仓库。
      // 只对这一步放开本地 file 协议，且只导入指定的单个 ref / 精确 SHA。
      const verifyDir = join(scratch, 'verify.git');
      await run([...config, 'init', '--bare', '--quiet', verifyDir]);
      await run(
        [
          ...config,
          '-c',
          'protocol.file.allow=always',
          '-C',
          verifyDir,
          'fetch',
          '--quiet',
          '--no-tags',
          '--no-recurse-submodules',
          '--',
          bundleTmp,
          `+${ref}:${ref}`
        ],
        false,
        { GIT_ALLOW_PROTOCOL: 'file' }
      );
      const importedRefs = (await run([...config, '-C', verifyDir, 'for-each-ref', '--format=%(refname)'], true)).stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
      if (importedRefs.length !== 1 || importedRefs[0] !== ref) throw new FetchFailure('bundle_invalid');
      const importedTip = (await run([...config, '-C', verifyDir, 'rev-parse', '--verify', '--quiet', ref], true)).stdout.trim();
      if (importedTip !== tip) throw new FetchFailure('bundle_invalid');
      await run([...config, '-C', verifyDir, 'fsck', '--connectivity-only', '--no-dangling']);

      if (deadline.signal.aborted) throw new FetchFailure('timeout');
      const bundleSha256 = await sha256File(bundleTmp, deadline.signal);

      if (deadline.signal.aborted) throw new FetchFailure('timeout');
      const outPath = join(runtime.outputDir, `git-fetch-${randomBytes(12).toString('hex')}.bundle`);
      try {
        await copyFile(bundleTmp, outPath, fsConstants.COPYFILE_EXCL);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          await rm(outPath, { force: true }).catch(() => {});
        }
        throw error;
      }
      // 复制本身不可中断；若复制期间已超时，必须删掉刚写出的文件且不能报成功。
      if (deadline.signal.aborted) {
        await rm(outPath, { force: true }).catch(() => {});
        throw new FetchFailure('timeout');
      }
      return {
        ok: true,
        result: {
          branch,
          ref,
          tip,
          bundlePath: outPath,
          bundleBytes: info.size,
          bundleSha256
        }
      };
    } catch (error) {
      if (deadline.isTimedOut()) return failure('timeout');
      if (closed) return failure('closed');
      if (state.failure !== null) return failure(state.failure.code);
      if (error instanceof FetchFailure) return failure(error.code);
      return failure('generic');
    } finally {
      deadline.clear();
      if (bridge !== null) {
        try {
          await bridge.close();
        } catch {
          // 已经关闭
        }
      }
      if (scratch !== null) {
        try {
          await rm(scratch, { recursive: true, force: true });
        } catch {
          // 清理失败不覆盖真正的失败原因
        }
      }
    }
  }

  return {
    async fetch(input: ProjectGitFetchRequest): Promise<ProjectGitFetchOutcome> {
      if (closed) return failure('closed');
      if (!limiter.tryAcquire()) return failure('busy');
      try {
        if (closed) return failure('closed');
        return await fetchOnce(input);
      } finally {
        limiter.release();
      }
    },
    close(): Promise<void> {
      closed = true;
      for (const controller of controllers) controller.abort();
      controllers.clear();
      closing ??= egress.close();
      return closing;
    }
  };
}
