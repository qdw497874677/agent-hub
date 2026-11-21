#!/usr/bin/env node
/**
 * agent-hub-workbench 的本机 MCP 客户端：只做 login / check / wait。
 *
 * - 令牌只从显式 TTY 登录读取，命令行不接受令牌；配置 0600 原子替换，读取拒绝 symlink。
 * - 默认 HTTPS；本机 / 受信隧道走 HTTP 时必须显式 --allow-http，且端点写死在配置里。
 * - 不跟随重定向，不调用 reply/cancel；wait 只轮询只读的 events 工具。
 */
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, renameSync, unlinkSync, writeSync
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export class UsageError extends Error {}
export class CredentialError extends Error {}

export type McpFailureKind = 'unreachable' | 'auth' | 'protocol' | 'http' | 'redirect' | 'timeout' | 'aborted' | 'tool';

export class McpError extends Error {
  kind: McpFailureKind;
  status: number | undefined;
  retryable: boolean;
  retryAfterMs: number | undefined;

  constructor(kind: McpFailureKind, message: string, extra: { status?: number; retryable?: boolean; retryAfterMs?: number } = {}) {
    super(message);
    this.name = 'McpError';
    this.kind = kind;
    this.status = extra.status;
    this.retryable = extra.retryable ?? false;
    this.retryAfterMs = extra.retryAfterMs;
  }
}

/** 输出前把令牌本身及其 JSON / URL 转义形式抹掉；不依赖正则，避免令牌里的元字符。 */
export function redactSecrets(text: string, token?: string): string {
  if (!token) return text;
  for (const variant of new Set([token, JSON.stringify(token).slice(1, -1), encodeURIComponent(token)])) {
    if (variant) text = text.split(variant).join('[REDACTED]');
  }
  return text;
}

const TRUSTED_HTTP_HOSTS = [
  /^localhost$/i, /\.localhost$/i, /\.ts\.net$/i, /\.local$/i, /\.internal$/i, /\.lan$/i,
  /^127(?:\.\d{1,3}){3}$/, /^10(?:\.\d{1,3}){3}$/, /^192\.168(?:\.\d{1,3}){2}$/,
  /^172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}$/,
  /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2}$/,
  /^169\.254(?:\.\d{1,3}){2}$/,
  /^\[?::1\]?$/, /^\[?f[cd][0-9a-f]{2}:/i, /^\[?fe[89ab][0-9a-f]:/i
];

/** HTTPS 默认；HTTP 只有显式允许且目标是本机 / 受信隧道时才接受。 */
export function parseEndpoint(raw: string, allowHttp = false): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError('端点不是合法 URL');
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new UsageError('端点不能包含用户信息、查询参数或片段');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UsageError('端点必须是 https://；本机 / 受信隧道可用 --allow-http 显式走 http://');
  }
  if (url.protocol === 'http:' && (!allowHttp || !TRUSTED_HTTP_HOSTS.some((re) => re.test(url.hostname)))) {
    throw new UsageError('HTTP 端点需要 --allow-http，且只允许 localhost、私网或 Tailscale 等受信隧道主机');
  }
  if (!url.pathname.endsWith('/mcp')) throw new UsageError('端点路径必须以 /mcp 结尾');
  return url;
}

export function configPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env['AGENT_HUB_WORKBENCH_MCP_CONFIG'] ||
    join(env['XDG_CONFIG_HOME'] || join(home, '.config'), 'agent-hub', 'workbench-mcp.json');
}

export type StoredConfig = { endpoint: string; token: string; insecure: boolean };
export type LoadedConfig = StoredConfig & { path: string; url: URL };

function checkMode(stat: { mode: number; uid: number }, path: string): void {
  if ((stat.mode & 0o077) !== 0) throw new CredentialError(`凭据文件权限过宽（需 0600）：${path}`);
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) throw new CredentialError(`凭据文件所有者不是当前用户：${path}`);
}

/** 只读打开配置文件；拒绝 symlink、非普通文件、组/其他可读和他人所有。 */
export function readCredential(path = configPath()): LoadedConfig {
  let before;
  try {
    before = lstatSync(path);
  } catch {
    throw new CredentialError(`没有凭据，请先运行 login：${path}`);
  }
  if (before.isSymbolicLink() || !before.isFile()) throw new CredentialError(`凭据路径必须是普通文件且不是 symlink：${path}`);
  checkMode(before, path);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) {
      throw new CredentialError(`凭据文件在读取时发生变化：${path}`);
    }
    checkMode(stat, path);
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(fd, 'utf8'));
    } catch {
      throw new CredentialError(`凭据文件不是合法 JSON：${path}`);
    }
    const config = value as Partial<StoredConfig> & { version?: unknown };
    if (config.version !== 1 || typeof config.endpoint !== 'string' || typeof config.token !== 'string' || config.token === '') {
      throw new CredentialError(`凭据文件格式不对：${path}`);
    }
    const insecure = config.insecure === true;
    return { path, endpoint: config.endpoint, token: config.token, insecure, url: parseEndpoint(config.endpoint, insecure) };
  } finally {
    closeSync(fd);
  }
}

/** 同目录临时文件（O_EXCL, 0600）→ fsync → rename；不会跟随目标 symlink。 */
export function writeCredential(path: string, config: StoredConfig): void {
  parseEndpoint(config.endpoint, config.insecure);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const body = JSON.stringify({ version: 1, endpoint: config.endpoint, token: config.token, insecure: config.insecure, savedAt: Date.now() });
  let fd: number | undefined;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    fchmodSync(fd, 0o600);
    writeSync(fd, body);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    try {
      const dir = openSync(dirname(path), constants.O_RDONLY);
      try { fsyncSync(dir); } finally { closeSync(dir); }
    } catch { /* 目录 fsync 不是所有文件系统都支持 */ }
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch { /* 已 rename 或不存在 */ }
    throw error;
  }
}

export interface TtyInput {
  isTTY?: boolean;
  setRawMode?(mode: boolean): void;
  resume(): void;
  pause(): void;
  on(event: 'data', listener: (chunk: Buffer | string) => void): void;
  off(event: 'data', listener: (chunk: Buffer | string) => void): void;
}
export interface TtyOutput { write(text: string): void }

/** 仅 TTY；回显 *，不把令牌写进 stdout/日志。 */
export function readHiddenToken(
  prompt: string,
  io: { input: TtyInput; output: TtyOutput } = { input: process.stdin, output: process.stderr }
): Promise<string> {
  const { input, output } = io;
  if (!input.isTTY) return Promise.reject(new UsageError('录入令牌需要 TTY（不要通过管道传令牌）'));
  return new Promise((resolvePromise, reject) => {
    let value = '';
    function finish(error?: Error) {
      input.off('data', onData);
      input.setRawMode?.(false);
      input.pause();
      output.write('\n');
      if (error) reject(error); else resolvePromise(value);
    }
    function onData(chunk: Buffer | string) {
      for (const ch of String(chunk)) {
        if (ch === '\x03') return finish(new UsageError('已取消'));
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\x7f' || ch === '\b') {
          if (value.length > 0) { value = value.slice(0, -1); output.write('\b \b'); }
          continue;
        }
        if (ch < ' ' || ch > '~') continue;
        if (value.length >= 4096) return finish(new UsageError('令牌过长（上限 4096 字符）'));
        value += ch;
        output.write('*');
      }
    }
    input.setRawMode?.(true);
    input.resume();
    input.on('data', onData);
    output.write(prompt);
  });
}

export interface McpClient {
  endpoint: URL;
  listTools(timeoutMs?: number): Promise<string[]>;
  callTool(name: string, args: Record<string, unknown>, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<unknown>;
}
type FetchImpl = typeof fetch;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** 先逐层抹掉字符串再交给 JSON.stringify，避免引号 / 反斜杠被转义后漏掉令牌。 */
function redactValue(value: unknown, token: string): unknown {
  if (typeof value === 'string') return redactSecrets(value, token);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, token));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, token)]));
  return value;
}
function asMcpError(error: unknown): McpError {
  return error instanceof McpError ? error : new McpError('unreachable', error instanceof Error ? error.message : String(error), { retryable: true });
}
const AUTH_TEXT = /unauthorized|invalid[ _-]?token|invalid[ _-]?bearer|令牌|认证失败|HTTP (401|403)|没有权限/i;

export function createMcpClient(options: {
  endpoint: URL; token: string; fetchImpl?: FetchImpl; requestTimeoutMs?: number;
}): McpClient {
  const { endpoint, token } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const defaultTimeout = options.requestTimeoutMs ?? 70_000;
  const redact = (text: string) => redactSecrets(text, token);

  const request = async (method: string, params: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<Record<string, unknown>> => {
    if (signal?.aborted) throw new McpError('aborted', '已取消');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    let response: Response;
    let text: string;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream'
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: controller.signal
      });
      text = await response.text();
    } catch (error) {
      if (signal?.aborted) throw new McpError('aborted', '已取消');
      if (controller.signal.aborted) throw new McpError('timeout', `请求超时（${timeoutMs}ms）`, { retryable: true });
      throw new McpError('unreachable', `无法连接 ${endpoint.origin}：${error instanceof Error ? error.message : String(error)}`, { retryable: true });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }

    const rawRetryAfter = response.headers.get('retry-after');
    const retryAfter = rawRetryAfter === null ? Number.NaN : Number(rawRetryAfter);
    if (response.status >= 300 && response.status < 400) {
      throw new McpError('redirect', `服务端返回重定向 HTTP ${response.status}；为保护令牌不跟随`, { status: response.status });
    }
    if (response.status === 401 || response.status === 403) {
      throw new McpError('auth', `认证失败（HTTP ${response.status}），检查令牌或权限`, { status: response.status });
    }
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new McpError('http', `MCP 请求失败（HTTP ${response.status}）：${redact(text).slice(0, 300)}`, {
        status: response.status, retryable,
        ...(Number.isFinite(retryAfter) && retryAfter >= 0 ? { retryAfterMs: retryAfter * 1000 } : {})
      });
    }
    let rpc: unknown;
    try {
      rpc = JSON.parse(text);
    } catch {
      throw new McpError('protocol', `MCP 响应不是 JSON：${redact(text).slice(0, 200)}`);
    }
    if (!isRecord(rpc)) throw new McpError('protocol', 'MCP 响应格式不对');
    if (isRecord(rpc['error'])) {
      const message = redact(String(rpc['error']['message'] ?? 'MCP 错误'));
      if (AUTH_TEXT.test(message) || rpc['error']['code'] === -32001) throw new McpError('auth', message);
      throw new McpError('protocol', message);
    }
    if (!isRecord(rpc['result'])) throw new McpError('protocol', 'MCP 响应缺少 result');
    return rpc['result'];
  };

  return {
    endpoint,
    async listTools(timeoutMs = defaultTimeout) {
      const result = await request('tools/list', {}, timeoutMs);
      if (!Array.isArray(result['tools'])) throw new McpError('protocol', 'tools/list 响应缺少 tools 数组');
      return (result['tools'] as unknown[]).flatMap((tool: unknown) => isRecord(tool) && typeof tool['name'] === 'string' ? [tool['name']] : []);
    },
    async callTool(name, args, call = {}) {
      const result = await request('tools/call', { name, arguments: args }, call.timeoutMs ?? defaultTimeout, call.signal);
      const content = (Array.isArray(result['content']) ? result['content'] : []) as unknown[];
      const detail = content.flatMap((part: unknown) => isRecord(part) && typeof part['text'] === 'string' ? [part['text']] : []).join('\n');
      if (result['isError'] === true) {
        const message = redact(detail || '工具调用失败');
        throw new McpError(AUTH_TEXT.test(message) ? 'auth' : 'tool', message);
      }
      if (!isRecord(result['structuredContent'])) {
        throw new McpError('protocol', `工具 ${name} 没有返回 structuredContent`);
      }
      return result['structuredContent'];
    }
  };
}

export type CheckResult = { ok: boolean; kind?: 'unreachable' | 'auth' | 'protocol' | 'missing-tools';
  message?: string; tools?: string[]; missing?: string[] };
export const REQUIRED_TOOLS = ['events', 'get_session'] as const;

export async function checkConnection(client: McpClient, required: readonly string[] = REQUIRED_TOOLS): Promise<CheckResult> {
  let tools: string[];
  try {
    tools = await client.listTools();
  } catch (error) {
    const e = asMcpError(error);
    const kind = e.kind === 'auth' ? 'auth'
      : e.kind === 'protocol' || e.kind === 'tool' || e.kind === 'redirect' || (e.kind === 'http' && !e.retryable) ? 'protocol'
      : 'unreachable';
    return { ok: false, kind, message: e.message };
  }
  const missing = required.filter((name) => !tools.includes(name));
  if (missing.length > 0) {
    return { ok: false, kind: 'missing-tools', tools, missing, message: `令牌看不到必需工具：${missing.join(', ')}` };
  }
  return { ok: true, tools };
}

export interface ProjectedEvent {
  seq?: number;
  at?: number;
  turn?: number;
  event: { kind: string; text?: string; name?: string; ok?: boolean; outcome?: string; reason?: string; level?: string };
}
export interface EventPage { events: ProjectedEvent[]; nextAfter: number }

/** 只认部署中的 structuredContent 形状：{ events, nextAfter }。 */
export function readEventPage(value: unknown): EventPage {
  if (!isRecord(value) || !Array.isArray(value['events']) || !Number.isInteger(value['nextAfter']) || (value['nextAfter'] as number) < 0) {
    throw new McpError('protocol', 'events 返回缺少合法的 { events, nextAfter }');
  }
  for (const entry of value['events']) {
    if (!isRecord(entry) || !isRecord(entry['event']) || typeof entry['event']['kind'] !== 'string') {
      throw new McpError('protocol', 'events 数组里有过期 / 非法事件');
    }
  }
  return { events: value['events'] as ProjectedEvent[], nextAfter: value['nextAfter'] as number };
}

export interface WaitOptions {
  sessionId: string;
  turn: number;
  after?: number;
  timeoutMs?: number;
  pollWaitSec?: number;
  maxTransientRetries?: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onEvent?: (event: ProjectedEvent) => void;
}
export type WaitResult = {
  ok: boolean; kind?: 'deadline' | 'unreachable' | 'auth' | 'protocol' | 'aborted'; message?: string; outcome?: string; reason?: string;
  nextAfter: number; events: ProjectedEvent[]; elapsedMs: number;
};

/** 从 cursor 开始等目标轮次；只前进 nextAfter，不重发 prompt / 不取消。 */
export async function waitForTurn(client: McpClient, options: WaitOptions): Promise<WaitResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const timeoutMs = options.timeoutMs ?? 600_000;
  const pollWaitSec = Math.max(1, Math.min(50, options.pollWaitSec ?? 50));
  const maxRetries = options.maxTransientRetries ?? 4;
  const started = now();
  const deadline = started + timeoutMs;
  const events: ProjectedEvent[] = [];
  let after = options.after ?? 0;
  let retries = 0;

  const failed = (kind: NonNullable<WaitResult['kind']>, message: string): WaitResult =>
    ({ ok: false, kind, message, nextAfter: after, events, elapsedMs: now() - started });

  for (;;) {
    if (options.signal?.aborted) return failed('aborted', '已取消');
    const remaining = deadline - now();
    if (remaining <= 0) return failed('deadline', `等待超过 ${timeoutMs}ms，轮次 ${options.turn} 仍未结束`);

    const waitSec = Math.max(1, Math.min(pollWaitSec, Math.ceil(remaining / 1000)));
    const requestTimeout = Math.min(remaining, options.requestTimeoutMs ?? (waitSec + 10) * 1000);
    const before = after;
    try {
      const result = await client.callTool('events', {
        sessionId: options.sessionId, after, sinceTurn: options.turn, waitSec
      }, { timeoutMs: requestTimeout, signal: options.signal });
      const page = readEventPage(result);
      if (page.nextAfter < before) throw new McpError('protocol', `nextAfter 回退（${before} → ${page.nextAfter}）`);
      if (page.events.length > 0 && page.nextAfter === before) throw new McpError('protocol', '有事件但 nextAfter 未前进');
      after = page.nextAfter;
      for (const event of page.events) {
        events.push(event);
        options.onEvent?.(event);
      }
      const ended = page.events.find((entry) => entry.turn === options.turn && entry.event.kind === 'ended');
      if (ended) {
        return { ok: true, outcome: ended.event.outcome ?? 'done', reason: ended.event.reason, nextAfter: after, events, elapsedMs: now() - started };
      }
      retries = 0;
      if (page.events.length === 0 && after === before) await sleep(Math.min(500, Math.max(0, deadline - now())));
    } catch (error) {
      if (options.signal?.aborted) return failed('aborted', '已取消');
      const e = asMcpError(error);
      if (e.kind === 'auth') return failed('auth', e.message);
      if (e.kind === 'protocol' || e.kind === 'tool' || e.kind === 'redirect' || (e.kind === 'http' && !e.retryable)) {
        return failed('protocol', e.message);
      }
      if (!e.retryable) return failed('unreachable', e.message);
      retries += 1;
      if (retries > maxRetries) return failed('unreachable', `连接反复失败（已重试 ${maxRetries} 次）：${e.message}`);
      const backoff = e.retryAfterMs ?? Math.min(5_000, 250 * 2 ** (retries - 1));
      await sleep(Math.min(backoff, Math.max(0, deadline - now())));
    }
  }
}

function formatEvent(entry: ProjectedEvent, token = ''): string {
  const event = entry.event;
  const seq = entry.seq === undefined ? '' : `#${entry.seq} `;
  if (event.kind === 'text') return `${seq}${event.text ?? ''}`;
  if (event.kind === 'tool') return `${seq}tool: ${event.name ?? ''}`;
  if (event.kind === 'tool_result') return `${seq}tool_result: ${event.name ?? ''} ${event.ok ? 'ok' : 'failed'}`;
  if (event.kind === 'ended') return `${seq}ended: ${event.outcome ?? 'done'}${event.reason ? ` (${event.reason})` : ''}`;
  if (event.kind === 'diagnostic') return `${seq}diagnostic: ${event.text ?? ''}`;
  return `${seq}${JSON.stringify(redactValue(event, token))}`;
}

const HELP = `用法：
  node scripts/workbench-mcp.ts login <https://hub/openapi/v1/mcp> [--allow-http]
  node scripts/workbench-mcp.ts check
  node scripts/workbench-mcp.ts wait <sessionId> <turn> [--after N] [--timeout-sec N] [--wait-sec N] [--json]
  node scripts/workbench-mcp.ts help

登录只从 TTY 隐藏录入令牌；配置路径由 AGENT_HUB_WORKBENCH_MCP_CONFIG 覆盖。
check 校验认证与 events/get_session；wait 只轮询 events，不重发 prompt、不取消。`;

const EXIT: Record<string, number> = {
  unreachable: 3, auth: 4, protocol: 5, 'missing-tools': 6, deadline: 7, aborted: 130
};

export async function main(argv: string[], io: { out: TtyOutput; err: TtyOutput; input?: TtyInput } = { out: process.stdout, err: process.stderr, input: process.stdin }): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
      io.out.write(`${HELP}\n`);
      return 0;
    }

    if (command === 'login') {
      const allowHttp = rest.includes('--allow-http');
      const positional = rest.filter((arg) => arg !== '--allow-http');
      if (positional.length !== 1) throw new UsageError('login 需要一个端点');
      const endpoint = parseEndpoint(positional[0]!, allowHttp);
      const token = (await readHiddenToken('令牌（隐藏输入）：', { input: io.input ?? process.stdin, output: io.err })).trim();
      if (token === '') throw new UsageError('令牌为空');
      if (/\s/.test(token)) throw new UsageError('令牌不能包含空白字符');
      const path = configPath();
      writeCredential(path, { endpoint: endpoint.toString(), token, insecure: endpoint.protocol === 'http:' });
      io.out.write(`已保存 ${endpoint.origin}${endpoint.pathname} → ${path}\n下一步：node scripts/workbench-mcp.ts check\n`);
      return 0;
    }

    if (command === 'check') {
      if (rest.length > 0) throw new UsageError('check 不接受参数');
      const config = readCredential();
      const client = createMcpClient({ endpoint: config.url, token: config.token });
      const result = await checkConnection(client);
      if (!result.ok) {
        io.err.write(`check 失败（${result.kind}）：${redactSecrets(result.message ?? '', config.token)}\n`);
        return EXIT[result.kind ?? 'protocol'] ?? 1;
      }
      io.out.write(`ok：${result.tools?.length ?? 0} 个工具；必需工具 events、get_session 可见\n`);
      return 0;
    }

    if (command === 'wait') {
      const positional: string[] = [];
      let after = 0;
      let timeoutMs = 600_000;
      let waitSec = 50;
      let json = false;
      for (let i = 0; i < rest.length; i += 1) {
        const arg = rest[i]!;
        if (arg === '--json') { json = true; continue; }
        if (arg === '--after' || arg === '--timeout-sec' || arg === '--wait-sec') {
          const raw = rest[++i];
          const value = Number(raw);
          if (!Number.isInteger(value) || value < 0) throw new UsageError(`${arg} 需要非负整数`);
          if (arg === '--after') after = value;
          if (arg === '--timeout-sec') timeoutMs = value * 1000;
          if (arg === '--wait-sec') waitSec = value;
          continue;
        }
        if (arg.startsWith('--')) throw new UsageError(`未知参数：${arg}`);
        positional.push(arg);
      }
      if (positional.length !== 2) throw new UsageError('wait 需要 sessionId 和 turn');
      const turn = Number(positional[1]);
      if (!Number.isInteger(turn) || turn < 1) throw new UsageError('turn 必须是正整数');
      if (timeoutMs === 0) throw new UsageError('--timeout-sec 必须大于 0');
      if (waitSec < 1 || waitSec > 50) throw new UsageError('--wait-sec 必须在 1..50');

      const config = readCredential();
      const client = createMcpClient({ endpoint: config.url, token: config.token });
      const controller = new AbortController();
      const onInterrupt = () => controller.abort();
      process.once('SIGINT', onInterrupt);
      const result = await waitForTurn(client, { sessionId: positional[0]!, turn, after, timeoutMs, pollWaitSec: waitSec, signal: controller.signal })
        .finally(() => process.removeListener('SIGINT', onInterrupt));
      const clean = (text: string) => redactSecrets(text, config.token);

      if (json) {
        io.out.write(`${JSON.stringify(redactValue(result, config.token), null, 2)}\n`);
      } else {
        for (const event of result.events) io.out.write(`${clean(formatEvent(event, config.token))}\n`);
        if (result.ok) io.out.write(`turn ${turn} ended: ${clean(result.outcome ?? '')}（${result.elapsedMs}ms，下一 cursor ${result.nextAfter}）\n`);
        else io.err.write(`wait 失败（${result.kind}）：${clean(result.message ?? '')}（下一 cursor ${result.nextAfter}）\n`);
      }
      return result.ok ? 0 : EXIT[result.kind ?? 'protocol'] ?? 1;
    }

    throw new UsageError(`未知命令：${command}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.err.write(`${message}\n`);
    if (error instanceof UsageError || error instanceof CredentialError) return 2;
    if (error instanceof McpError) return EXIT[error.kind] ?? 1;
    return 1;
  }
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
if (invoked !== '' && invoked === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
