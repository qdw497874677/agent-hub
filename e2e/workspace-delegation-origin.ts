import { execFile, spawn } from 'node:child_process';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

/**
 * workspace delegation E2E 的本机替身：
 *
 * 1. Git origin：origin 保持**原样的** `https://github.com/e2e/demo.git`（不使用 insteadOf ——
 *    生产的 publishRef 会拒绝被改写过的 origin），repo-local 只把
 *    `http.https://github.com/e2e/demo.git.sslCAInfo` 指到**本次运行**由 openssl 生成的
 *    自签 CA 证书，并配 `http.proxy` 指到这里的 CONNECT 代理。TLS 校验保持开启：
 *    证书不是静态入库的，也没有任何全局 / 环境信任；证书不匹配就失败关闭。
 * 2. 假 GitHub REST：create PR 时从 bare 仓库读出该分支的真实 sha 放进 `head.sha`，
 *    hub 的校验（PR head sha == 批准的提交）因此是真证据。
 *
 * 只监听 127.0.0.1，出站只到本进程内的代理；没有外部请求。
 * 依赖：openssl 在 PATH 上（仅测试用，每次跑现场生成 1 天期的证书）。
 */
export const GITHUB_ORIGIN = 'https://github.com/e2e/demo.git';
export const GITHUB_REPO = 'e2e/demo';

const execFileAsync = promisify(execFile);

export interface GitOrigin {
  /** CONNECT 代理端口；repo-local `http.proxy` 指向它。 */
  readonly port: number;
  /** 本次运行生成的 CA 证书路径；测试把它写进 repo-local scoped sslCAInfo。 */
  readonly caFile: string;
  /** 实际收到的 smart-HTTP 请求，例如 `GET /e2e/demo.git/info/refs?service=git-receive-pack`。 */
  readonly requests: string[];
  close(): Promise<void>;
}

export async function startGitOrigin(projectRoot: string, options: { workDir: string }): Promise<GitOrigin> {
  const requests: string[] = [];
  const sockets = new Set<Socket>();

  // 每次运行现场生成：不把私钥 / 证书固化进仓库，也不进任何信任库。
  await mkdir(options.workDir, { recursive: true });
  const caFile = join(options.workDir, 'origin-ca.pem');
  const keyFile = join(options.workDir, 'origin-key.pem');
  try {
    await execFileAsync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyFile, '-out', caFile, '-days', '1',
      '-subj', '/CN=github.com',
      '-addext', 'subjectAltName=DNS:github.com',
      '-addext', 'basicConstraints=critical,CA:TRUE'
    ]);
  } catch (error) {
    throw new Error(`生成测试证书失败（需要本机 openssl）：${error instanceof Error ? error.message : String(error)}`);
  }
  const [cert, key] = await Promise.all([readFile(caFile, 'utf8'), readFile(keyFile, 'utf8')]);

  const httpsServer = createHttpsServer({ key, cert }, (request, response) => {
    void serve(request, response);
  });

  async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    await serveSmartHttp(request, response, { projectRoot, requests });
  }

  // 只接受 github.com:443 的 CONNECT：git 的 http.proxy 走这里，TLS 由上面的 https 服务终止。
  const proxy: NetServer = createNetServer((socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.once('data', (chunk: Buffer) => {
      const line = chunk.toString('latin1').split('\r\n')[0] ?? '';
      const target = /^CONNECT\s+([^:\s]+):(\d+)\s+HTTP\/1\.[01]$/.exec(line);
      if (!target || target[1] !== 'github.com' || target[2] !== '443') {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      httpsServer.emit('connection', socket);
    });
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (proxy.address() as { port: number }).port;
  return {
    port,
    caFile,
    requests,
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all([
        new Promise<void>((resolve) => proxy.close(() => resolve())),
        new Promise<void>((resolve) => httpsServer.close(() => resolve()))
      ]);
    }
  };
}

export interface DirectGitOrigin {
  /** 直连地址（`https://127.0.0.1:<port>/<repo>.git`）：没有代理、没有外部 DNS。 */
  readonly url: string;
  /** 本次运行生成的 CA 证书路径；测试把它写进隔离 HOME 的 scoped `sslCAInfo`。 */
  readonly caFile: string;
  /** 实际收到的 smart-HTTP 请求，例如 `GET /demo.git/info/refs?service=git-upload-pack`。 */
  readonly requests: string[];
  /** 每个请求收到的 `Authorization` 头（没有就是空串），用来断言令牌只到了预期 origin。 */
  readonly authorization: string[];
  close(): Promise<void>;
}

/**
 * 只给单文件回归用的直连 HTTPS origin：真实的 `git http-backend`，监听 127.0.0.1，
 * 证书按 IP SAN 现场生成，TLS 校验保持开启。出站只到本进程内；不碰系统信任库。
 */
export async function startDirectGitOrigin(options: { bare: string; workDir: string; redirect?: boolean }): Promise<DirectGitOrigin> {
  const requests: string[] = [];
  const authorization: string[] = [];
  await mkdir(options.workDir, { recursive: true });
  const caFile = join(options.workDir, 'origin-ca.pem');
  const keyFile = join(options.workDir, 'origin-key.pem');
  try {
    await execFileAsync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyFile, '-out', caFile, '-days', '1',
      '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1',
      '-addext', 'basicConstraints=critical,CA:TRUE'
    ]);
  } catch (error) {
    throw new Error(`生成测试证书失败（需要本机 openssl）：${error instanceof Error ? error.message : String(error)}`);
  }
  const [cert, key] = await Promise.all([readFile(caFile, 'utf8'), readFile(keyFile, 'utf8')]);
  const projectRoot = dirname(resolve(options.bare));
  const repoPath = `/${basename(options.bare)}`;
  const httpsServer = createHttpsServer({ key, cert }, (request, response) => {
    if (options.redirect === true && request.url?.startsWith(`${repoPath}/info/refs?`)) {
      requests.push(`${request.method} ${request.url}`);
      authorization.push(request.headers.authorization ?? '');
      response.writeHead(302, { location: `/redirected${request.url}` }).end();
      return;
    }
    void serveSmartHttp(request, response, { projectRoot, requests, authorization });
  });
  await new Promise<void>((resolve, reject) => {
    httpsServer.once('error', reject);
    httpsServer.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (httpsServer.address() as { port: number }).port;
  return {
    url: `https://127.0.0.1:${port}${repoPath}`,
    caFile,
    requests,
    authorization,
    close: () => new Promise<void>((resolve) => httpsServer.close(() => resolve()))
  };
}

interface SmartHttpSink {
  readonly projectRoot: string;
  readonly requests: string[];
  readonly authorization?: string[];
}

/** git smart-HTTP（upload-pack / receive-pack）的本机后端；服务端配置与用户环境隔离。 */
async function serveSmartHttp(request: IncomingMessage, response: ServerResponse, sink: SmartHttpSink): Promise<void> {
  // git http-backend 只读仓库配置；这里再显式清掉用户级 / 系统级 Git 配置，避免环境里的
  // 任何信任或改写混进来（与 worker 的 publishEnv 同样的隔离方向）。
  const backendEnv: Record<string, string | undefined> = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PROJECT_ROOT: sink.projectRoot,
    GIT_HTTP_EXPORT_ALL: '1',
    REMOTE_USER: 'x-access-token',
    REMOTE_ADDR: '127.0.0.1',
    SERVER_PROTOCOL: 'HTTP/1.1',
    GATEWAY_INTERFACE: 'CGI/1.1'
  };
  delete backendEnv['GIT_SSL_NO_VERIFY'];
  delete backendEnv['GIT_SSL_CAINFO'];

  const url = new URL(request.url ?? '/', 'https://127.0.0.1');
  const query = url.searchParams.toString();
  sink.requests.push(`${request.method ?? 'GET'} ${url.pathname}${query ? `?${query}` : ''}`);
  sink.authorization?.push(String(request.headers.authorization ?? ''));
  const child = spawn('git', ['http-backend'], {
    env: {
      ...backendEnv,
      PATH_INFO: url.pathname,
      REQUEST_METHOD: request.method ?? 'GET',
      QUERY_STRING: query,
      CONTENT_TYPE: String(request.headers['content-type'] ?? ''),
      CONTENT_LENGTH: String(request.headers['content-length'] ?? ''),
      HTTP_GIT_PROTOCOL: String(request.headers['git-protocol'] ?? '')
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const chunks: Buffer[] = [];
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => (stderr += String(chunk)));
  child.on('error', (error) => {
    if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
    response.end(`git http-backend 起不来：${error.message}`);
  });
  child.on('close', (code) => {
    if (response.writableEnded) return;
    const output = Buffer.concat(chunks);
    const split = output.indexOf('\r\n\r\n');
    if (code !== 0 || split < 0) {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(`git http-backend 失败（${code}）：${stderr.slice(0, 500)}`);
      return;
    }
    const head = output.subarray(0, split).toString('utf8');
    const body = output.subarray(split + 4);
    let status = 200;
    const headers: Record<string, string> = {};
    for (const line of head.split('\r\n')) {
      const index = line.indexOf(':');
      if (index < 0) continue;
      const name = line.slice(0, index).trim();
      const value = line.slice(index + 1).trim();
      if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10) || 200;
      else headers[name] = value;
    }
    response.writeHead(status, headers);
    response.end(body);
  });
  request.pipe(child.stdin);
}

export interface PullCreate {
  readonly head: string;
  readonly base: string;
  readonly draft: boolean;
  readonly title: string;
  readonly body: string;
  readonly sha: string;
}

export interface FakeGitHub {
  /** 给 hub 的 HUB_GITHUB_API。 */
  readonly base: string;
  readonly created: PullCreate[];
  close(): Promise<void>;
}

/** 假 GitHub REST：create PR 时的 head.sha 从真实 bare 仓库读，hub 才能对得上批准的提交。 */
export async function startFakeGitHub(options: { bare: string; repo: string }): Promise<FakeGitHub> {
  const created: PullCreate[] = [];
  const server = createHttpServer(async (request, response) => {
    const url = request.url ?? '/';
    if (request.method === 'GET' && url.startsWith(`/repos/${options.repo}/pulls?`) ) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify([]));
      return;
    }
    if (request.method === 'POST' && url === `/repos/${options.repo}/pulls`) {
      const body = await readBody(request);
      const parsed = (() => {
        try {
          return JSON.parse(body) as { head?: string; base?: string; draft?: boolean; title?: string; body?: string };
        } catch {
          return {};
        }
      })();
      const head = String(parsed.head ?? '');
      const base = String(parsed.base ?? '');
      const { stdout } = await execFileAsync('git', ['--git-dir', options.bare, 'rev-parse', `refs/heads/${head}`]);
      const sha = stdout.trim();
      created.push({ head, base, draft: parsed.draft === true, title: String(parsed.title ?? ''), body: String(parsed.body ?? ''), sha });
      const pull = {
        number: created.length,
        html_url: `https://github.com/${options.repo}/pull/${created.length}`,
        state: 'open',
        draft: parsed.draft === true,
        merged_at: null,
        head: { ref: head, sha, repo: { full_name: options.repo } },
        base: { ref: base, repo: { full_name: options.repo } }
      };
      response.statusCode = 201;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(pull));
      return;
    }
    response.statusCode = 404;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ message: 'Not Found' }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${port}`,
    created,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    request.on('data', (chunk) => (text += String(chunk)));
    request.on('end', () => resolve(text));
    request.on('error', reject);
  });
}
