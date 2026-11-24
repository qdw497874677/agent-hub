import { Buffer } from 'node:buffer';
import type { RepoCheckProbe } from '@agent-hub/domain';
import { createMcpEgress, normalizeEgressHost, type EgressResolver } from './mcp-egress.ts';
import {
  createLoopbackResolver,
  isAcceptableBasicAuthorization,
  isMetadataHost,
  LOOPBACK_HOSTS,
  originKey,
  parseAllowedOrigins
} from './project-git-https-policy.ts';

/**
 * 项目仓库的只读 HTTPS Smart Git 广告探测。
 *
 * 只做一件事：GET `<repo>/info/refs?service=git-upload-pack`，按 v0 pkt-line 解析
 * 服务广告，回答「连不连得上、默认分支是什么、填的分支在不在」。
 * 不实现 clone / fetch / upload-pack 的其余传输，也不支持明文 HTTP / 重定向 / 自定义请求头。
 *
 * 出口策略是独立的显式策略，不继承 `MCP_EGRESS_*` 环境例外：
 * - 只允许 HTTPS；协议、userinfo、query、fragment 在发请求前拒绝；
 * - 只有 operator 显式列出的精确 origin 才放行（无通配、无后缀）；
 * - 私网 / 保留地址默认拒绝；生产没有通用私网例外，只有测试专用的 loopback 开关；
 * - 云元数据地址即使被显式放行也硬性拒绝；
 * - 复用 `createMcpEgress` 的 pinned DNS / TLS / no-redirect 出口；
 * - 请求头只有该函数自己生成的 `Accept` 和调用方给的 Basic `Authorization`。
 *
 * 所有失败都翻成固定的安全文案：不回显响应体、异常 message、URL 或凭据。
 */

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_PACKETS = 100_000;
const DEFAULT_MAX_LINE_BYTES = 64 * 1024;
const DEFAULT_MAX_CONCURRENT = 2;

const SERVICE_LINE = '# service=git-upload-pack';
const ADVERTISEMENT_CONTENT_TYPE = 'application/x-git-upload-pack-advertisement';

const MESSAGES = {
  badUrl: '仓库地址不是合法的 URL',
  httpsOnly: '仓库地址必须使用 HTTPS',
  credentialsInUrl: '仓库地址不能带用户名或密码',
  queryInUrl: '仓库地址不能带查询参数或片段',
  blocked: '仓库地址不在允许的范围内',
  badAuthorization: '仓库凭据格式不正确',
  timeout: '连接仓库超时',
  tooLarge: '仓库返回的 Git 广告超出上限',
  unsupported: '仓库不支持 Smart HTTP 的 Git 广告协议',
  protocol: '仓库返回的 Git 广告无法识别',
  authRequired: '仓库需要有效的访问凭据',
  forbidden: '仓库拒绝访问',
  notFound: '仓库不存在或无权访问',
  rateLimited: '仓库请求过于频繁',
  serverError: '仓库服务暂时不可用',
  httpError: '连接仓库失败',
  closed: '仓库检查已关闭',
  busy: '仓库检查繁忙，请稍后再试',
  generic: '连接仓库失败'
} as const;

export interface ProjectGitHttpsProbeOptions {
  /** 精确的 operator 放行 origin，例如 `https://github.com`；不接受通配、路径、query、fragment。 */
  readonly allowedOrigins: readonly string[];
  /**
   * 测试专用注入：只额外放行 loopback（127.0.0.1 / ::1 / localhost），供父级真实 TLS
   * fixture 使用。生产保持关闭；不支持任意私网主机名例外。
   */
  readonly testOnlyAllowLoopback?: boolean;
  /** 单次检查的硬超时，默认 10 秒。 */
  readonly timeoutMs?: number;
  /** 单次广告响应的总字节上限，默认 2 MiB。 */
  readonly maxBytes?: number;
  /** 单次广告响应的 pkt-line 数量上限，默认 100000。 */
  readonly maxPackets?: number;
  /** 单条 pkt-line 负载上限，默认 64 KiB。 */
  readonly maxLineBytes?: number;
  /** 同时在途的出口请求上限，默认 2。 */
  readonly maxConcurrent?: number;
  /** 测试 / 宿主注入的 DNS 解析器；生产默认 node:dns。 */
  readonly resolve?: EgressResolver;
  /** 测试注入的 fetch；仍会经过本模块与 `createMcpEgress` 的 URL 校验。 */
  readonly fetchImpl?: typeof fetch;
}

export interface ProjectGitHttpsProbe {
  check(input: { url: string; branch: string | null; authorization: string }): Promise<RepoCheckProbe>;
  close(): Promise<void>;
}

class ProbeFailure extends Error {
  readonly safeMessage: string;

  constructor(safeMessage: string) {
    super(safeMessage);
    this.name = 'ProjectGitHttpsProbeFailure';
    this.safeMessage = safeMessage;
  }
}

function positiveInt(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`ProjectGitHttpsProbe: ${name} 必须是正整数`);
  }
  return value;
}

function stripLineEnding(text: string): string {
  let end = text.length;
  if (end > 0 && text[end - 1] === '\n') end -= 1;
  if (end > 0 && text[end - 1] === '\r') end -= 1;
  return text.slice(0, end);
}

/** 只比较 media type token，参数（charset 等）忽略；`...advertisement-x` 不算匹配。 */
function isAdvertisementMediaType(value: string | null): boolean {
  if (value === null) return false;
  const token = value.split(';', 1)[0] ?? '';
  return token.trim().toLowerCase() === ADVERTISEMENT_CONTENT_TYPE;
}

function parsePktLength(header: Buffer): number | null {
  const text = header.toString('latin1');
  return /^[0-9a-fA-F]{4}$/u.test(text) ? Number.parseInt(text, 16) : null;
}

/** Git ref 名里不允许控制字符、空白、空段与 `..`；只用于收缩解析面，不做 git 全量规则。 */
function isSafeRefName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    !/[\u0000-\u0020\u007f]/u.test(name) &&
    !name.includes('..') &&
    !name.startsWith('/') &&
    !name.endsWith('/') &&
    !name.includes('//')
  );
}

function parseHeadSymref(capabilities: string): string | null {
  for (const token of capabilities.split(/\s+/u)) {
    if (!token.startsWith('symref=HEAD:')) continue;
    const target = token.slice('symref=HEAD:'.length);
    if (!target.startsWith('refs/heads/')) return null;
    if (!isSafeRefName(target)) return null;
    return target.slice('refs/heads/'.length);
  }
  return null;
}

/** 只把 plain 分支当 `refs/heads/<branch>`；已经写的完整 ref 必须精确匹配 `refs/heads/`。 */
function expectedRefFor(branch: string | null): string | null {
  if (branch === null) return null;
  const value = branch.trim();
  if (value === '') return null;
  return value.startsWith('refs/') ? value : `refs/heads/${value}`;
}

function advertisementUrl(base: URL): URL {
  const url = new URL(base.href);
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/info/refs`;
  url.search = '?service=git-upload-pack';
  url.hash = '';
  return url;
}

/**
 * `authorization` 是调用方已经生成好的 Basic 头值；这里只接受单行 Basic，
 * 不允许借它塞其它请求头或 CRLF。
 */
function authorizationValue(raw: string): string | undefined {
  if (raw === '') return undefined;
  if (!isAcceptableBasicAuthorization(raw)) {
    throw new ProbeFailure(MESSAGES.badAuthorization);
  }
  return raw;
}

function failure(message: string): RepoCheckProbe {
  return { reachable: false, defaultBranch: null, branchExists: false, message };
}

function statusMessage(status: number): string {
  if (status === 401) return MESSAGES.authRequired;
  if (status === 403) return MESSAGES.forbidden;
  if (status === 404) return MESSAGES.notFound;
  if (status === 429) return MESSAGES.rateLimited;
  if (status >= 500) return MESSAGES.serverError;
  return MESSAGES.httpError;
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

interface ProbeRuntime {
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly maxPackets: number;
  readonly maxLineBytes: number;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly egress: ReturnType<typeof createMcpEgress>;
}

export function createProjectGitHttpsProbe(options: ProjectGitHttpsProbeOptions): ProjectGitHttpsProbe {
  const allowedOrigins = parseAllowedOrigins(options.allowedOrigins, 'ProjectGitHttpsProbe');
  const testLoopback = options.testOnlyAllowLoopback === true;
  const allowPrivateHosts = testLoopback ? [...LOOPBACK_HOSTS] : [];
  const resolve = testLoopback ? createLoopbackResolver(options.resolve, 'ProjectGitHttpsProbe') : options.resolve;
  const runtime: ProbeRuntime = {
    timeoutMs: positiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs'),
    maxBytes: positiveInt(options.maxBytes, DEFAULT_MAX_BYTES, 'maxBytes'),
    maxPackets: positiveInt(options.maxPackets, DEFAULT_MAX_PACKETS, 'maxPackets'),
    maxLineBytes: positiveInt(options.maxLineBytes, DEFAULT_MAX_LINE_BYTES, 'maxLineBytes'),
    allowedOrigins,
    egress: createMcpEgress({
      // 独立显式策略：不读 MCP_EGRESS_*，明文 HTTP 始终不放行；私网只给测试 loopback 开。
      policy: { allowPrivateHosts, allowHttpHosts: [] },
      ...(resolve === undefined ? {} : { resolve }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
    })
  };
  const limiter = new ConcurrencyLimiter(positiveInt(options.maxConcurrent, DEFAULT_MAX_CONCURRENT, 'maxConcurrent'));

  let closed = false;
  let closing: Promise<void> | null = null;

  function probeTarget(raw: string): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ProbeFailure(MESSAGES.badUrl);
    }
    if (url.protocol !== 'https:') throw new ProbeFailure(MESSAGES.httpsOnly);
    if (url.username !== '' || url.password !== '') throw new ProbeFailure(MESSAGES.credentialsInUrl);
    if (url.search !== '' || url.hash !== '') throw new ProbeFailure(MESSAGES.queryInUrl);

    const host = normalizeEgressHost(url.hostname);
    if (host === '' || isMetadataHost(host)) throw new ProbeFailure(MESSAGES.blocked);
    if (!runtime.allowedOrigins.has(originKey(url))) throw new ProbeFailure(MESSAGES.blocked);

    // createMcpEgress 再用同一份策略校验 URL（内网 / 保留地址 / 单段主机名 / 协议）；
    // 无论它给出什么细节，对外只回固定文案。
    const checked = runtime.egress.checkUrl(url.href, { requireHttps: true });
    if (!checked.ok) throw new ProbeFailure(MESSAGES.blocked);
    return url;
  }

  async function readAdvertisement(response: Response, signal: AbortSignal, expectedRef: string | null): Promise<RepoCheckProbe> {
    const body = response.body;
    if (body === null) throw new ProbeFailure(MESSAGES.protocol);
    const reader = body.getReader();
    let cancelled = false;
    const cancel = (): void => {
      if (cancelled) return;
      cancelled = true;
      void reader.cancel().catch(() => {});
    };
    const onAbort = (): void => cancel();
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      let buffer = Buffer.alloc(0);
      let totalBytes = 0;
      let packetCount = 0;
      let seenService = false;
      let inRefs = false;
      let firstRef = true;
      let defaultBranch: string | null = null;
      const heads = new Set<string>();

      const consume = (): boolean => {
        while (buffer.length >= 4) {
          const length = parsePktLength(buffer.subarray(0, 4));
          if (length === null) {
            throw new ProbeFailure(seenService ? MESSAGES.protocol : MESSAGES.unsupported);
          }
          if (length === 0) {
            buffer = buffer.subarray(4);
            if (!seenService) throw new ProbeFailure(MESSAGES.protocol);
            if (inRefs) return true;
            inRefs = true;
            continue;
          }
          // 0001 / 0002 是 protocol v2 的 delimiter / response-end；本探测只认 v0 广告。
          if (length < 4) throw new ProbeFailure(MESSAGES.unsupported);
          if (length - 4 > runtime.maxLineBytes) throw new ProbeFailure(MESSAGES.tooLarge);
          if (buffer.length < length) return false;

          const payload = buffer.subarray(4, length);
          buffer = buffer.subarray(length);
          packetCount += 1;
          if (packetCount > runtime.maxPackets) throw new ProbeFailure(MESSAGES.tooLarge);

          if (!seenService) {
            const line = stripLineEnding(payload.toString('utf8'));
            if (line !== SERVICE_LINE) throw new ProbeFailure(MESSAGES.unsupported);
            seenService = true;
            continue;
          }
          if (!inRefs) throw new ProbeFailure(MESSAGES.protocol);

          const nul = payload.indexOf(0);
          const refText = (nul === -1 ? payload : payload.subarray(0, nul)).toString('utf8');
          const capabilities = nul === -1 ? '' : payload.subarray(nul + 1).toString('utf8');
          if (firstRef) {
            firstRef = false;
            defaultBranch = parseHeadSymref(capabilities);
          }

          const line = stripLineEnding(refText);
          const match = /^([0-9a-f]{40}|[0-9a-f]{64}) (\S+)$/iu.exec(line);
          if (match === null) throw new ProbeFailure(MESSAGES.protocol);
          const name = match[2] as string;
          if (!isSafeRefName(name)) throw new ProbeFailure(MESSAGES.protocol);
          if (name.startsWith('refs/heads/')) heads.add(name);
        }
        return false;
      };

      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const value = chunk.value;
        if (value === undefined) continue;
        totalBytes += value.byteLength;
        if (totalBytes > runtime.maxBytes) throw new ProbeFailure(MESSAGES.tooLarge);
        const piece = Buffer.from(value);
        buffer = buffer.length === 0 ? piece : Buffer.concat([buffer, piece]);
        if (consume()) {
          // symref 只是声明；只有目标确实出现在本次广告的 refs/heads 里才算证据。
          const verifiedDefaultBranch =
            defaultBranch !== null && heads.has(`refs/heads/${defaultBranch}`) ? defaultBranch : null;
          return {
            reachable: true,
            defaultBranch: verifiedDefaultBranch,
            branchExists:
              expectedRef === null ? heads.size > 0 : expectedRef.startsWith('refs/heads/') && heads.has(expectedRef),
            message: null
          };
        }
      }
      // 流结束前没有 refs 段的 flush：要么被截断，要么根本不是完整广告。
      throw new ProbeFailure(seenService ? MESSAGES.protocol : MESSAGES.unsupported);
    } finally {
      signal.removeEventListener('abort', onAbort);
      cancel();
    }
  }

  async function checkOnce(input: { url: string; branch: string | null; authorization: string }): Promise<RepoCheckProbe> {
    let target: URL;
    let authorization: string | undefined;
    try {
      target = probeTarget(input.url);
      authorization = authorizationValue(input.authorization);
    } catch (error) {
      return failure(error instanceof ProbeFailure ? error.safeMessage : MESSAGES.generic);
    }

    const expectedRef = expectedRefFor(input.branch);
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new ProbeFailure(MESSAGES.timeout));
      }, runtime.timeoutMs);
    });

    const headers: Record<string, string> = { accept: ADVERTISEMENT_CONTENT_TYPE };
    if (authorization !== undefined) headers['authorization'] = authorization;

    const operation = (async (): Promise<RepoCheckProbe> => {
      const response = await runtime.egress.fetch(advertisementUrl(target).href, {
        method: 'GET',
        headers,
        signal: controller.signal,
        redirect: 'error'
      });
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        throw new ProbeFailure(statusMessage(response.status));
      }
      const contentType = response.headers.get('content-type');
      if (!isAdvertisementMediaType(contentType)) {
        void response.body?.cancel().catch(() => {});
        throw new ProbeFailure(MESSAGES.unsupported);
      }
      return readAdvertisement(response, controller.signal, expectedRef);
    })();

    try {
      return await Promise.race([operation, deadline]);
    } catch (error) {
      if (error instanceof ProbeFailure) return failure(error.safeMessage);
      if (timedOut || (error instanceof Error && error.name === 'AbortError')) return failure(MESSAGES.timeout);
      return failure(MESSAGES.generic);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  return {
    async check(input): Promise<RepoCheckProbe> {
      if (closed) return failure(MESSAGES.closed);
      if (!limiter.tryAcquire()) return failure(MESSAGES.busy);
      try {
        if (closed) return failure(MESSAGES.closed);
        return await checkOnce(input);
      } finally {
        limiter.release();
      }
    },
    close(): Promise<void> {
      closed = true;
      closing ??= runtime.egress.close();
      return closing;
    }
  };
}
