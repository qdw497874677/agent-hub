/**
 * 外部 agent 全程只走 MCP（t436u–t440u）。
 * 不进默认 `npm run e2e`（不是 *.spec.ts）。
 *
 * 自己拉起隔离 Hub + 两台 origin=remote 的本地 worker 进程（当作两台机器）。
 * 只用 Hub 管理的 glm-5.3-flash / Pi，不走 Go。
 * 测试进程保留 ZAI_CODING_CN_API_KEY，不把它传给 hub / worker。
 * 日志和证据里不打印令牌。
 *
 * 运行：在仓库根目录
 *   E2E_HUB_MODEL=hub-cn-glm-flash/glm-5.3-flash node e2e/real-mcp-multi-repo-live.ts
 */
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reservePort, spawnHub, stop, readHubLog } from './spawn-hub.ts';
import { serverEnv } from './server-env.ts';
import { e2eWorkerPath, e2eWorkerRoots } from './isolation.ts';
import { e2eHubModel, parseE2eHubModel, hubProviderBody, hubProviderBaseUrl } from './hub-model.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EVIDENCE_DIR = '/tmp/real-mcp-multi-repo';
const EVIDENCE = join(EVIDENCE_DIR, 'evidence.json');
const LOG = join(EVIDENCE_DIR, 'run.log');
const FAKE_GH_TOKEN = 'ghp_e2eFakeToken000000000000000000ABCD';
const HEALTH_PORT = 18777;
const TEST_EMAIL = 'test@agent-hub.local';
const TEST_PASSWORD = 'mcp-e2e-pass-241';

type Step = { step: string; pass: boolean; detail: string };
const steps: Step[] = [];

function redact(text: string): string {
  return text
    .replace(/ahp_[A-Za-z0-9._-]+/g, 'ahp_[redacted]')
    .replace(/ghp_[A-Za-z0-9]+/g, 'ghp_[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/HUB_WORKER_CREDENTIAL[=: ]+\S+/g, 'HUB_WORKER_CREDENTIAL=[redacted]');
}

function log(line: string) {
  const text = redact(line);
  console.log(text);
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  appendFileSync(LOG, `${text}\n`);
}

function record(step: string, pass: boolean, detail: string) {
  const safe = redact(detail).slice(0, 2000);
  steps.push({ step, pass, detail: safe });
  log(`${pass ? 'PASS' : 'FAIL'}  ${step}  ${safe}`);
}

function writeEvidence(extra: Record<string, unknown> = {}) {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(EVIDENCE, `${JSON.stringify({ at: new Date().toISOString(), steps, ...extra }, null, 2)}\n`);
}

type Pr = { number: number; repo: string; state: 'open' | 'merged'; sha: string; url: string };
function startFakeGithub(): { server: Server; prs: Pr[]; setMerged: () => void } {
  const prs: Pr[] = [];
  let next = 201;
  const merged = { on: false };
  const read = (req: IncomingMessage) =>
    new Promise<string>((done) => {
      let text = '';
      req.on('data', (c) => (text += c));
      req.on('end', () => done(text));
    });
  const server = createServer(async (req, res) => {
    const body = await read(req);
    const url = req.url ?? '';
    res.setHeader('content-type', 'application/json');
    const create = /^\/repos\/e2e\/([^/]+)\/pulls$/.exec(url);
    if (req.method === 'POST' && create) {
      const repo = create[1]!;
      const number = next++;
      const parsed = body ? (JSON.parse(body) as { head?: string }) : {};
      const pr: Pr = { number, repo, state: 'open', sha: 'pending', url: `https://github.com/e2e/${repo}/pull/${number}` };
      prs.push(pr);
      res.statusCode = 201;
      res.end(JSON.stringify({ number, html_url: pr.url, state: 'open', head: { sha: pr.sha, ref: parsed.head }, merged_at: null }));
      return;
    }
    const view = /^\/repos\/e2e\/([^/]+)\/pulls\/(\d+)$/.exec(url);
    if (req.method === 'GET' && view) {
      const pr = prs.find((item) => item.repo === view[1] && item.number === Number(view[2]));
      if (!pr) {
        res.statusCode = 404;
        res.end(JSON.stringify({ message: 'Not Found' }));
        return;
      }
      const state = merged.on || pr.state === 'merged' ? 'closed' : 'open';
      res.end(JSON.stringify({
        number: pr.number,
        html_url: pr.url,
        state,
        head: { sha: pr.sha },
        merged_at: merged.on || pr.state === 'merged' ? '2026-11-18T16:00:00Z' : null
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ message: 'Not Found' }));
  });
  return {
    server,
    prs,
    setMerged: () => {
      merged.on = true;
      for (const pr of prs) pr.state = 'merged';
    }
  };
}

function sh(cwd: string, ...args: string[]) {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'e2e',
      GIT_AUTHOR_EMAIL: 'e2e@example.invalid',
      GIT_COMMITTER_NAME: 'e2e',
      GIT_COMMITTER_EMAIL: 'e2e@example.invalid'
    }
  });
}

function makeOrigin(root: string, name: string, writeSeed: (seed: string) => void): { bare: string; url: string } {
  const seed = join(root, `${name}-seed`);
  mkdirSync(seed, { recursive: true });
  sh(seed, 'init', '-q', '-b', 'main');
  writeSeed(seed);
  sh(seed, 'add', '.');
  sh(seed, 'commit', '-qm', `init ${name}`);
  const bare = join(root, `${name}.git`);
  sh(root, 'clone', '-q', '--bare', seed, bare);
  sh(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  return { bare, url: `https://github.com/e2e/${name}.git` };
}

function gitConfigHome(home: string, origins: { bare: string; url: string }[]) {
  execFileSync('git', ['config', '--global', 'user.name', 'e2e'], { env: { ...process.env, HOME: home } });
  execFileSync('git', ['config', '--global', 'user.email', 'e2e@example.invalid'], { env: { ...process.env, HOME: home } });
  for (const origin of origins) {
    execFileSync('git', ['config', '--global', `url.${origin.bare}.insteadOf`, origin.url], { env: { ...process.env, HOME: home } });
  }
}

function worktreeList(repo: string): string {
  try {
    return execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim();
  } catch (error) {
    return `ERROR ${redact(error instanceof Error ? error.message : String(error))}`;
  }
}

function commonDirOf(worktree: string): string | null {
  try {
    const raw = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: worktree, encoding: 'utf8' }).trim();
    const resolved = raw.startsWith('/') ? raw : join(worktree, raw);
    return resolved.replace(/\/\.git$/, '');
  } catch {
    return null;
  }
}

class CookieJar {
  private readonly map = new Map<string, string>();
  store(res: Response) {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const line of list) {
      const nv = line.split(';', 1)[0] ?? '';
      const i = nv.indexOf('=');
      if (i > 0) this.map.set(nv.slice(0, i), nv.slice(i + 1));
    }
  }
  header(): string {
    return [...this.map].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  csrf(): string {
    return this.map.get('hub_csrf') ?? '';
  }
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitHttp(url: string, timeoutMs: number) {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      last = `${res.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(300);
  }
  throw new Error(`等不到 ${url}：${last}`);
}

type McpResult = { isError?: boolean; structuredContent?: unknown; content?: { type: string; text?: string }[] };

function mcpText(result: McpResult): string {
  const texts = (result.content ?? []).map((c) => c.text ?? '').join('\n');
  return redact(texts || JSON.stringify(result.structuredContent ?? result));
}

async function main() {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  if (existsSync(LOG)) writeFileSync(LOG, '');

  const model = e2eHubModel();
  if (model !== 'hub-cn-glm-flash/glm-5.3-flash') {
    throw new Error(`必须使用 hub-cn-glm-flash/glm-5.3-flash，当前是 ${model || '(空)'}`);
  }
  const spec = parseE2eHubModel(model);
  if (!spec) throw new Error('E2E_HUB_MODEL 解析失败');
  const apiKey = process.env['ZAI_CODING_CN_API_KEY'] ?? '';
  if (!apiKey) throw new Error('测试进程没有 ZAI_CODING_CN_API_KEY');

  const hubPort = await reservePort();
  const ghPort = await reservePort();
  if (hubPort === 17923 || ghPort === 17923) throw new Error('不能占用 17923');

  const dataDir = mkdtempSync(join(tmpdir(), 'real-mcp-hub-'));
  const originRoot = mkdtempSync(join(tmpdir(), 'real-mcp-origins-'));
  const w1Home = mkdtempSync(join(tmpdir(), 'real-mcp-w1-'));
  const w2Home = mkdtempSync(join(tmpdir(), 'real-mcp-w2-'));
  const ghBin = mkdtempSync(join(tmpdir(), 'real-mcp-ghbin-'));
  writeFileSync(
    join(ghBin, 'gh'),
    `#!/bin/sh\nif [ "$2" = "create" ]; then echo "https://github.com/e2e/web/pull/299"; exit 0; fi\necho '{"number":299,"url":"https://github.com/e2e/web/pull/299","state":"OPEN","headRefOid":"y","mergedAt":null}'\n`
  );
  chmodSync(join(ghBin, 'gh'), 0o755);

  const origins = {
    web: makeOrigin(originRoot, 'web', (seed) => {
      writeFileSync(
        join(seed, 'AGENTS.md'),
        '# web 主仓库\n\n组合工作空间的主仓库（cwd）。附加仓在 `../repos/api` 与 `../repos/lib`。\n'
      );
      writeFileSync(join(seed, 'README.md'), '# web\n');
    }),
    api: makeOrigin(originRoot, 'api', (seed) => {
      writeFileSync(join(seed, 'README.md'), '# api\n');
    }),
    lib: makeOrigin(originRoot, 'lib', (seed) => {
      writeFileSync(join(seed, 'README.md'), '# lib\n');
    })
  };
  gitConfigHome(w1Home, Object.values(origins));
  gitConfigHome(w2Home, Object.values(origins));

  const github = startFakeGithub();
  await new Promise<void>((done) => github.server.listen(ghPort, '127.0.0.1', done));

  const hubLog = join(EVIDENCE_DIR, 'hub.log');
  const w1Log = join(EVIDENCE_DIR, 'worker1.log');
  const w2Log = join(EVIDENCE_DIR, 'worker2.log');
  const passwordFile = join(dataDir, 'test-account');
  const hubEnv = {
    ...serverEnv(),
    HUB_PORT: String(hubPort),
    HUB_DATA_DIR: dataDir,
    HUB_GITHUB_API: `http://127.0.0.1:${ghPort}`,
    HUB_SPAWN_WORKER: '0',
    HUB_LOGIN_RATE_MAX: '1000',
    HUB_ENROLL_RATE_MAX: '1000',
    HUB_MAIL_RATE_MAX: '1000',
    HUB_MAIL_PROVIDER: 'log',
    HUB_PUBLIC_URL: `http://127.0.0.1:${hubPort}`,
    HUB_MAIL_OUTBOX: join(dataDir, 'outbox.jsonl'),
    HUB_TEST_ACCOUNT: TEST_EMAIL,
    HUB_TEST_ACCOUNT_FILE: passwordFile,
    HUB_TEST_ACCOUNT_PASSWORD: TEST_PASSWORD,
    WORKER_ROOTS: '/tmp',
    WORKER_MODEL_CHECK: '0'
  };
  const hub = spawnHub(process.execPath, [join(ROOT, 'apps/server/src/main.ts')], {
    env: hubEnv,
    cwd: ROOT,
    logFile: hubLog,
    detached: true
  });

  let worker1: ChildProcess | null = null;
  let worker2: ChildProcess | null = null;
  const children: ChildProcess[] = [hub];

  const shutdown = async () => {
    for (const child of [worker1, worker2, hub]) {
      if (child) await stop(child).catch(() => undefined);
    }
    github.server.close();
  };

  try {
    await waitHttp(`http://127.0.0.1:${hubPort}/api/health`, 45_000);
    record('0. 隔离 Hub 就绪', true, `port=${hubPort} data=${dataDir}`);

    const jar = new CookieJar();
    const base = `http://127.0.0.1:${hubPort}`;
    const api = async (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set('cookie', jar.header());
      if (init.method && init.method !== 'GET') {
        headers.set('origin', base);
        headers.set('x-hub-csrf', jar.csrf());
        if (!headers.has('content-type') && init.body) headers.set('content-type', 'application/json');
      }
      const res = await fetch(`${base}${path}`, { ...init, headers });
      jar.store(res);
      return res;
    };

    const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }), headers: { 'content-type': 'application/json' } });
    if (!login.ok) throw new Error(`登录失败 HTTP ${login.status}`);
    jar.store(login);

    const provider = await api('/api/providers', {
      method: 'POST',
      body: JSON.stringify(hubProviderBody(spec, hubProviderBaseUrl(), apiKey))
    });
    const providerText = await provider.text();
    if (providerText.includes(apiKey)) throw new Error(`创建供应商失败：响应里出现了密钥（已不打印正文）HTTP ${provider.status}`);
    if (!provider.ok) throw new Error(`创建供应商失败：HTTP ${provider.status} ${redact(providerText).slice(0, 300)}`);
    record('0b. 种入 Hub 模型', true, model);

    const workerPath = e2eWorkerPath(ghBin, { agents: true });
    const startRemote = async (label: string, home: string, logFile: string) => {
      const pairing = await api('/api/workers/pairing', { method: 'POST', body: '{}' });
      if (!pairing.ok) throw new Error(`pairing 失败 HTTP ${pairing.status} ${redact(await pairing.text())}`);
      const { code } = (await pairing.json()) as { code: string };
      const hubWs = `ws://127.0.0.1:${hubPort}/worker`;
      const enrolled = spawnSync(process.execPath, [join(ROOT, 'apps/worker/src/enroll.ts')], {
        env: { PATH: workerPath, HUB_URL: hubWs, HUB_PAIR: code, WORKER_LABEL: label },
        encoding: 'utf8',
        cwd: ROOT
      });
      if (enrolled.status !== 0) throw new Error(`enroll ${label} 失败：${redact(enrolled.stderr || enrolled.stdout)}`);
      const [workerId = '', credential = ''] = enrolled.stdout.trim().split('\n');
      const child = spawnHub(process.execPath, [join(ROOT, 'apps/worker/src/main.ts')], {
        cwd: ROOT,
        logFile,
        detached: true,
        env: {
          ...serverEnv(),
          PATH: workerPath,
          HOME: home,
          HUB_URL: hubWs,
          HUB_WORKER_CREDENTIAL: credential,
          WORKER_ID: workerId,
          WORKER_ORIGIN: 'remote',
          WORKER_LABEL: label,
          WORKER_ROOTS: e2eWorkerRoots(),
          WORKER_STATE_DIR: home,
          WORKER_GROUPS_DIR: join(home, 'groups'),
          WORKER_RUNTIMES_DIR: join(home, 'runtimes'),
          WORKER_MODEL_CHECK: '0'
        }
      });
      children.push(child);
      return { workerId, child };
    };

    const w1 = await startRemote('mcp-dev-worker', w1Home, w1Log);
    const w2 = await startRemote('mcp-verify-worker', w2Home, w2Log);
    worker1 = w1.child;
    worker2 = w2.child;

    const waitOnline = async (id: string, timeoutMs = 30_000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const res = await api('/api/workers');
        const list = (await res.json()) as Array<{ workerId: string; state: string; origin: string; agentIds?: string[] }>;
        const found = list.find((row) => row.workerId === id && row.state === 'online');
        if (found) return found;
        await sleep(400);
      }
      throw new Error(`worker ${id} 未上线`);
    };
    const online1 = await waitOnline(w1.workerId);
    const online2 = await waitOnline(w2.workerId);
    record('0c. 两台远程 worker 在线', true, `w1=${w1.workerId} agents=${(online1.agentIds ?? []).join(',')} w2=${w2.workerId} agents=${(online2.agentIds ?? []).join(',')}`);
    const agentId = online1.agentIds?.includes('pi') ? 'pi' : online1.agentIds?.[0];
    if (!agentId) throw new Error('worker1 没有可用 agent');
    if (agentId !== 'pi') throw new Error(`必须用 Pi，当前 agent=${agentId}`);

    const tokenRes = await api('/api/tokens', {
      method: 'POST',
      body: JSON.stringify({
        name: 'mcp-e2e-delegate',
        scopes: ['projects:read', 'projects:write', 'sessions:read', 'sessions:write', 'providers:use', 'files:read', 'workers:read']
      })
    });
    if (!tokenRes.ok) throw new Error(`建令牌失败 HTTP ${tokenRes.status}`);
    const minted = (await tokenRes.json()) as { token: string; info: { id: string } };
    const token = minted.token;
    const tokenId = minted.info.id;
    if (!token.startsWith('ahp_')) throw new Error('令牌格式不对');

    let rpcId = 1;
    const mcp = async (name: string, args: Record<string, unknown> = {}, tokenToUse = token): Promise<McpResult> => {
      const body = { jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } };
      const res = await fetch(`${base}/openapi/v1/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokenToUse}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream'
        },
        body: JSON.stringify(body)
      });
      if (res.status === 401) return { isError: true, content: [{ type: 'text', text: 'HTTP 401：令牌无效' }] };
      const json = (await res.json()) as { result?: McpResult; error?: { message?: string } };
      if (json.error) throw new Error(`MCP ${name} JSON-RPC：${redact(json.error.message ?? '')}`);
      if (!json.result) throw new Error(`MCP ${name} 无 result HTTP ${res.status}`);
      return json.result;
    };
    const mcpOk = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await mcp(name, args);
      if (result.isError) throw new Error(`MCP ${name} 失败：${mcpText(result)}`);
      return (result.structuredContent ?? result) as Record<string, unknown>;
    };
    const asList = (value: unknown): unknown[] => {
      if (Array.isArray(value)) return value;
      if (value && typeof value === 'object') {
        const rec = value as Record<string, unknown>;
        for (const key of ['result', 'events', 'entries', 'workers', 'items', 'pullRequests']) {
          if (Array.isArray(rec[key])) return rec[key] as unknown[];
        }
      }
      return [];
    };
    const waitTurnEnded = async (sessionId: string, sinceTurn: number, timeoutMs: number, label: string) => {
      const start = Date.now();
      let last = '';
      while (Date.now() - start < timeoutMs) {
        const ev = await mcpOk('events', { sessionId, sinceTurn });
        const entries = asList(ev);
        last = redact(JSON.stringify(entries)).slice(-3000);
        const ended = entries.find((entry) => {
          const row = entry as { turn?: number; event?: { kind?: string; outcome?: string; reason?: string } };
          return row.event?.kind === 'ended' && (row.turn === undefined || row.turn === sinceTurn);
        }) as { turn?: number; event?: { outcome?: string; reason?: string } } | undefined;
        if (ended) {
          const outcome = ended.event?.outcome ?? 'done';
          if (outcome !== 'done') throw new Error(`${label} 这一轮 ${outcome}：${ended.event?.reason ?? last}`);
          return { entries, ended };
        }
        await sleep(3000);
      }
      throw new Error(`${label} 等待 ended(turn=${sinceTurn}) 超时：${last}`);
    };
    const reqId = (label: string) => `mcp-e2e-${Date.now().toString(36)}-${label}`;

    const init = await fetch(`${base}/openapi/v1/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mcp-e2e', version: '1' } } })
    });
    if (!init.ok) throw new Error(`MCP initialize HTTP ${init.status}`);

    const listed = await fetch(`${base}/openapi/v1/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    });
    const listedBody = (await listed.json()) as { result?: { tools?: { name: string }[] } };
    const toolNames = (listedBody.result?.tools ?? []).map((t) => t.name).sort();
    const needed = [
      'workspace_group_create',
      'workspace_group_add_member',
      'workspace_group_get',
      'session_git_state',
      'session_git_run',
      'task_pull_requests',
      'session_settle',
      'workspace_sweep',
      'workspace_sweep_records'
    ];
    const missingTools = needed.filter((n) => !toolNames.includes(n));
    record('1. tools/list 含多仓工具', missingTools.length === 0, missingTools.length ? `缺 ${missingTools.join(',')}` : `共 ${toolNames.length} 个`);
    if (missingTools.length) throw new Error('MCP 工具清单不完整');

    const workers = await mcpOk('list_workers');
    const listArr = asList(workers) as Array<{ workerId?: string; origin?: string }>;
    const hasLocal = listArr.some((w) => w.origin === 'local');
    record('1b. list_workers 不暴露本机（或本实例未拉本机 worker）', !hasLocal, `count=${listArr.length} local=${hasLocal}`);

    const project = (await mcpOk('project_create', {
      name: `mcp-e2e ${Date.now().toString(36)}`,
      workerId: w1.workerId,
      clientRequestId: reqId('project')
    })) as { id: string };
    const reposSet = await mcpOk('project_repos', {
      projectId: project.id,
      primaryRepoId: 'web',
      repos: [
        { id: 'web', name: 'web', url: origins.web.url, defaultBranch: 'main' },
        { id: 'api', name: 'api', url: origins.api.url, defaultBranch: 'main' },
        { id: 'lib', name: 'lib', url: origins.lib.url, defaultBranch: 'main' }
      ],
      clientRequestId: reqId('repos')
    });
    const credLeak = JSON.stringify(reposSet).includes(FAKE_GH_TOKEN);
    record('2. project_create + project_repos（主仓库+三仓，凭证不回显）', !credLeak, credLeak ? '凭证泄漏' : `project=${project.id}`);
    if (credLeak) throw new Error('project_repos 回显了凭证');

    // 夹具：准备命令不在 MCP 里，用内部 API 写上，后面建组时由主仓库跑。
    const setupRes = await api(`/api/projects/${project.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        worktree: { mode: 'isolated', setup: { command: 'echo setup-ok > .setup-ok', waitForSetup: true, timeoutSeconds: 60 } }
      })
    });
    if (!setupRes.ok) throw new Error(`设置 setup 失败 HTTP ${setupRes.status} ${redact(await setupRes.text())}`);
    await api('/api/git-host/token', { method: 'PUT', body: JSON.stringify({ token: FAKE_GH_TOKEN }) });

    const task = (await mcpOk('task_create', {
      projectId: project.id,
      title: 'MCP 全程：改 web/api，验证，合并清理',
      clientRequestId: reqId('task')
    })) as { id: string };

    const group = (await mcpOk('workspace_group_create', {
      projectId: project.id,
      taskId: task.id,
      workerId: w1.workerId,
      repoIds: ['web', 'api'],
      clientRequestId: reqId('group-dev')
    })) as { id: string; root: string; members: Array<{ workspaceId: string; repoId: string; name: string; state: string; error?: string | null }> };

    const waitGroup = async (id: string, timeoutMs = 120_000) => {
      const start = Date.now();
      let current = group;
      while (Date.now() - start < timeoutMs) {
        current = (await mcpOk('workspace_group_get', { groupId: id })) as typeof group;
        const states = current.members.map((m) => m.state);
        if (states.every((s) => s === 'ready')) return current;
        if (states.some((s) => s === 'failed')) throw new Error(`组 ${id} 成员失败：${JSON.stringify(current.members)}`);
        await sleep(1000);
      }
      throw new Error(`组 ${id} 准备超时：${JSON.stringify(current.members)}`);
    };
    const readyDev = await waitGroup(group.id);
    const hasLib = readyDev.members.some((m) => m.name === 'lib' || m.repoId === 'lib');
    record('3. workspace_group_create 子集（主仓库+api，不含 lib）', readyDev.members.length === 2 && !hasLib, `members=${readyDev.members.map((m) => `${m.name}:${m.state}`).join(',') } root=${readyDev.root}`);

    const added = (await mcpOk('workspace_group_add_member', {
      groupId: group.id,
      repoId: 'lib',
      clientRequestId: reqId('add-lib')
    })) as typeof group;
    const readyAdded = await waitGroup(group.id);
    record('4. workspace_group_add_member 追加 lib', readyAdded.members.some((m) => m.repoId === 'lib' && m.state === 'ready'), `members=${readyAdded.members.map((m) => `${m.name}:${m.state}`).join(',')}`);

    const setupOk = existsSync(join(readyAdded.root, 'web', '.setup-ok')) || existsSync(join(readyAdded.root, '.setup-ok'));
    record('4b. 主仓库跑了准备命令', setupOk, `root=${readyAdded.root} setupOk=${setupOk}`);

    const started = (await mcpOk('session_start', {
      taskId: task.id,
      workerId: w1.workerId,
      agentId,
      groupId: group.id,
      model,
      clientRequestId: reqId('start-dev')
    })) as { id: string; status?: string; turn?: number };
    const sessionId = started.id;
    const waitRunning = async (id: string, timeoutMs = 120_000) => {
      const start = Date.now();
      let last = '';
      while (Date.now() - start < timeoutMs) {
        const session = (await mcpOk('get_session', { sessionId: id })) as { status?: string };
        last = String(session.status ?? '');
        if (session.status === 'running') return session;
        if (session.status === 'failed' || session.status === 'interrupted') throw new Error(`会话 ${id} ${session.status}`);
        await sleep(1000);
      }
      throw new Error(`会话 ${id} 未进入 running：${last}`);
    };
    await waitRunning(sessionId);
    const devReply = (await mcpOk('session_reply', {
      sessionId,
      text:
        '你在组合工作空间里。当前目录是主仓库 web（.），附加仓在 ../repos/api 与 ../repos/lib。\n' +
        '请只做下面两件事，不要 git commit / push，不要启动服务：\n' +
        `1. 在主仓库创建 server.mjs，必须是 Node HTTP 服务，监听 127.0.0.1:${HEALTH_PORT}，GET /health 返回 200 且正文正好是 ok。不要用其他端口。\n` +
        '2. 在 ../repos/api 创建 VERIFY.txt，写入一行 api-ready。\n' +
        '完成后只用一两句话汇报这两个文件的路径。',
      clientRequestId: reqId('reply-dev')
    })) as { turn?: number };
    const devTurn = Number(devReply.turn ?? 1);
    await waitTurnEnded(sessionId, devTurn, 240_000, 'dev-reply');

    const serverPath = join(readyAdded.root, 'web', 'server.mjs');
    const verifyPath = join(readyAdded.root, 'repos', 'api', 'VERIFY.txt');
    const serverExists = existsSync(serverPath);
    const verifyExists = existsSync(verifyPath);
    const verifyText = verifyExists ? readFileSync(verifyPath, 'utf8') : '';
    record('5. 开发会话改了主仓库和 api', serverExists && verifyExists && verifyText.includes('api-ready'), `server=${serverExists} verify=${verifyExists} text=${verifyText.trim().slice(0, 80)}`);
    if (!serverExists || !verifyExists) throw new Error('agent 没有写出预期文件');

    const gitRun = async (member: string, action: 'commit' | 'push' | 'pr', message: string) =>
      mcpOk('session_git_run', { sessionId, action, message, title: message, member, clientRequestId: reqId(`git-${action}-${member}`) });

    const webPr = await gitRun('web', 'pr', 'feat: add health server');
    const apiPr = await gitRun('api', 'pr', 'feat: add VERIFY.txt');
    const prsAfter = (await mcpOk('task_pull_requests', { taskId: task.id, refresh: '1' })) as { pullRequests?: Array<{ url?: string; number?: number; repo?: string }> };
    const prCount = (prsAfter.pullRequests ?? []).length;
    record('6. session_git_run 按仓开 PR 并挂到任务', prCount >= 2, `web=${JSON.stringify(webPr).slice(0, 300)} api=${JSON.stringify(apiPr).slice(0, 300)} prs=${prCount}`);
    if (prCount < 2) throw new Error('任务上 PR 不足 2 条');

    // 记录源仓库，供两端 worktree list 验收
    const sourceRepos: Record<string, string[]> = { w1: [], w2: [] };
    const collectSources = (label: 'w1' | 'w2', root: string, members: typeof readyAdded.members) => {
      for (const member of members) {
        const path =
          member.repoId === 'web' || member.name === 'web' ? join(root, 'web') : join(root, 'repos', member.name || member.repoId);
        const common = existsSync(path) ? commonDirOf(path) : null;
        if (common && !sourceRepos[label]!.includes(common)) sourceRepos[label]!.push(common);
      }
    };
    collectSources('w1', readyAdded.root, readyAdded.members);

    const verifyGroup = (await mcpOk('workspace_group_create', {
      projectId: project.id,
      taskId: task.id,
      workerId: w2.workerId,
      fromGroupId: group.id,
      clientRequestId: reqId('group-verify')
    })) as typeof group;
    const readyVerify = await waitGroup(verifyGroup.id);
    const verifySetup = existsSync(join(readyVerify.root, 'web', '.setup-ok')) || existsSync(join(readyVerify.root, '.setup-ok'));
    const verifyServer = existsSync(join(readyVerify.root, 'web', 'server.mjs'));
    record('7. 在 worker2 上 fromGroupId 再建一组并跑主仓库 setup', readyVerify.members.every((m) => m.state === 'ready') && verifySetup && verifyServer, `root=${readyVerify.root} setup=${verifySetup} server=${verifyServer} members=${readyVerify.members.map((m) => `${m.name}:${m.state}`).join(',')}`);
    collectSources('w2', readyVerify.root, readyVerify.members);

    const started2 = (await mcpOk('session_start', {
      taskId: task.id,
      workerId: w2.workerId,
      agentId,
      groupId: verifyGroup.id,
      model,
      clientRequestId: reqId('start-verify')
    })) as { id: string };
    await waitRunning(started2.id);
    const verifyReply = (await mcpOk('session_reply', {
      sessionId: started2.id,
      text:
        `当前目录是主仓库 web。请：\n` +
        `1. 确认 server.mjs 存在，../repos/api/VERIFY.txt 含 api-ready。\n` +
        `2. 用 node 在后台启动 server.mjs（监听 127.0.0.1:${HEALTH_PORT}），不要一直占着前台。\n` +
        `3. 执行 curl -sS -m 5 http://127.0.0.1:${HEALTH_PORT}/health\n` +
        `4. 在回复里明确写 HEALTH=ok 或 HEALTH=fail，以及 curl 正文。\n` +
        `不要改代码，不要提交。`,
      clientRequestId: reqId('reply-verify')
    })) as { turn?: number };
    const verifyTurn = Number(verifyReply.turn ?? 1);
    const verifyEnded = await waitTurnEnded(started2.id, verifyTurn, 240_000, 'verify-reply');
    const joined = verifyEnded.entries
      .map((entry) => {
        const ev = (entry as { event?: { kind?: string; text?: string; name?: string; ok?: boolean } }).event;
        if (!ev) return '';
        if (typeof ev.text === 'string') return ev.text;
        if (ev.kind === 'tool') return `[tool:${ev.name ?? ''}]`;
        if (ev.kind === 'tool_result') return `[tool_result:${ev.ok === false ? 'fail' : 'ok'}]`;
        return '';
      })
      .join('');
    const healthOk = /HEALTH\s*=\s*ok/i.test(joined) || /验证通过/.test(joined);
    writeFileSync(join(EVIDENCE_DIR, 'verify-events.json'), `${redact(JSON.stringify(verifyEnded.entries))}\n`);
    writeFileSync(join(EVIDENCE_DIR, 'verify-text.txt'), `${redact(joined)}\n`);
    record('8. worker2 验证：启动服务并健康检查', healthOk, `turn=${verifyTurn} healthOk=${healthOk} text=${redact(joined).slice(-400)}`);

    await mcpOk('append_task_log', {
      taskId: task.id,
      body: healthOk ? 'worker2 健康检查通过（HEALTH=ok）' : 'worker2 健康检查未在回复中确认',
      sessionId: started2.id,
      clientRequestId: reqId('log-verify')
    });

    // 停掉验证会话里可能还在跑的服务，避免占端口（尽力而为）
    spawnSync('pkill', ['-f', `127.0.0.1:${HEALTH_PORT}`], { stdio: 'ignore' });

    github.setMerged();
    const refreshed = (await mcpOk('task_pull_requests', { taskId: task.id, refresh: '1' })) as { pullRequests?: Array<{ state?: string; mergedAt?: string | null }> };
    const allMerged = (refreshed.pullRequests ?? []).length >= 2 && (refreshed.pullRequests ?? []).every((pr) => pr.state === 'merged' || pr.state === 'closed' || pr.mergedAt);
    record('9. task_pull_requests refresh=1 看到已合并', allMerged, JSON.stringify(refreshed.pullRequests ?? []).slice(0, 500));

    const cancelIfNeeded = async (id: string) => {
      const session = (await mcpOk('get_session', { sessionId: id })) as { status?: string };
      if (session.status === 'running') {
        await mcp('session_cancel', { sessionId: id, clientRequestId: reqId(`cancel-${id.slice(0, 8)}`) }).catch(() => undefined);
        await sleep(1000);
      }
    };
    await cancelIfNeeded(sessionId);
    await cancelIfNeeded(started2.id);
    await mcpOk('session_settle', { sessionId, settled: true, clientRequestId: reqId('settle-dev') });
    await mcpOk('session_settle', { sessionId: started2.id, settled: true, clientRequestId: reqId('settle-verify') });

    const firstSweep = await mcpOk('workspace_sweep', { projectId: project.id, clientRequestId: reqId('sweep-1') });
    const stillDev = existsSync(join(readyAdded.root, 'web'));
    const stillVerify = existsSync(join(readyVerify.root, 'web'));
    record('10. 第一轮 sweep 先收起，目录通常还在', true, `devStill=${stillDev} verifyStill=${stillVerify} report=${JSON.stringify(firstSweep).slice(0, 400)}`);

    const secondSweep = await mcpOk('workspace_sweep', { projectId: project.id, clientRequestId: reqId('sweep-2') });
    const devGone = !existsSync(join(readyAdded.root, 'web')) && !existsSync(join(readyAdded.root, 'repos', 'api'));
    const verifyGone = !existsSync(join(readyVerify.root, 'web')) && !existsSync(join(readyVerify.root, 'repos', 'api'));
    const lists: Record<string, string> = {};
    let listsClean = true;
    for (const [label, repos] of Object.entries(sourceRepos)) {
      for (const repo of repos) {
        const listedWt = worktreeList(repo);
        lists[`${label}:${repo}`] = listedWt;
        const leftover = listedWt.split('\n').some((line) => line.startsWith('worktree ') && (line.includes(readyAdded.root) || line.includes(readyVerify.root)));
        if (leftover) listsClean = false;
      }
    }
    writeFileSync(join(EVIDENCE_DIR, 'worktree-lists-after-sweep.txt'), redact(JSON.stringify(lists, null, 2)));
    record('11. 第二轮 sweep：两端 worktree 目录消失且源仓 worktree list 干净', devGone && verifyGone && listsClean, `devGone=${devGone} verifyGone=${verifyGone} listsClean=${listsClean} second=${JSON.stringify(secondSweep).slice(0, 400)}`);

    // dirty-kept：新建一组，弄脏后收起再扫
    const dirtyGroup = (await mcpOk('workspace_group_create', {
      projectId: project.id,
      taskId: task.id,
      workerId: w1.workerId,
      repoIds: ['web'],
      clientRequestId: reqId('group-dirty')
    })) as typeof group;
    const readyDirty = await waitGroup(dirtyGroup.id);
    const dirtyStarted = (await mcpOk('session_start', {
      taskId: task.id,
      workerId: w1.workerId,
      agentId,
      groupId: dirtyGroup.id,
      model,
      clientRequestId: reqId('start-dirty')
    })) as { id: string };
    await waitRunning(dirtyStarted.id);
    const dirtyFile = join(readyDirty.root, 'web', 'DIRTY.txt');
    writeFileSync(dirtyFile, 'keep-me\n');
    await mcp('session_cancel', { sessionId: dirtyStarted.id, clientRequestId: reqId('cancel-dirty') }).catch(() => undefined);
    await sleep(1000);
    await mcpOk('session_settle', { sessionId: dirtyStarted.id, settled: true, clientRequestId: reqId('settle-dirty') });
    const dirtySweep1 = await mcpOk('workspace_sweep', { projectId: project.id, clientRequestId: reqId('sweep-dirty-1') });
    const dirtySweep2 = await mcpOk('workspace_sweep', { projectId: project.id, clientRequestId: reqId('sweep-dirty-2') });
    const records = (await mcpOk('workspace_sweep_records', { projectId: project.id })) as { items?: Array<{ action?: string; reason?: string; workspaceId?: string }> };
    const kept = (records.items ?? []).some((item) => item.action === 'kept' && String(item.reason ?? '').length > 0);
    const dirtyStill = existsSync(dirtyFile);
    writeFileSync(join(EVIDENCE_DIR, 'sweep-records.json'), `${redact(JSON.stringify({ dirtySweep1, dirtySweep2, records }, null, 2))}\n`);
    record('12. dirty-kept：脏工作区整组留下并有原因', kept && dirtyStill, `kept=${kept} dirtyStill=${dirtyStill} records=${JSON.stringify(records).slice(0, 500)}`);

    // token rotate / revoke + audit
    const activityBefore = await api(`/api/tokens/${tokenId}/activity`);
    const callsBefore = ((await activityBefore.json()) as Array<{ action: string; detail: string }>).filter((row) => row.action === 'mcp.call');
    const rotateRes = await api(`/api/tokens/${tokenId}/rotate`, { method: 'POST', body: '{}' });
    if (!rotateRes.ok) throw new Error(`轮换失败 HTTP ${rotateRes.status}`);
    const rotated = (await rotateRes.json()) as { token?: string; info?: { id?: string } };
    const newToken = rotated.token ?? '';
    const newTokenId = rotated.info?.id ?? tokenId;
    const oldDenied = await mcp('list_projects', {}, token);
    const oldRejected = oldDenied.isError === true || /401|无效|吊销/.test(mcpText(oldDenied));
    const rawOld = await fetch(`${base}/openapi/v1/projects`, { headers: { authorization: `Bearer ${token}` } });
    const newOkRes = await fetch(`${base}/openapi/v1/projects`, { headers: { authorization: `Bearer ${newToken}` } });
    const activityAfter = await api(`/api/tokens/${tokenId}/activity`);
    const callsAfter = ((await activityAfter.json()) as Array<{ action: string; detail: string }>).filter((row) => row.action === 'mcp.call');
    record(
      '13. 令牌轮换后旧令牌 401、新令牌可用，审计 mcp.call 仍在',
      rawOld.status === 401 && newOkRes.ok && callsAfter.length >= callsBefore.length && callsBefore.length > 0,
      `oldHttp=${rawOld.status} newHttp=${newOkRes.status} oldMcpRejected=${oldRejected} auditBefore=${callsBefore.length} auditAfter=${callsAfter.length}`
    );

    const revokeRes = await api(`/api/tokens/${newTokenId}`, { method: 'DELETE' });
    const afterRevoke = await fetch(`${base}/openapi/v1/projects`, { headers: { authorization: `Bearer ${newToken}` } });
    record('14. 吊销后新令牌也 401', revokeRes.ok && afterRevoke.status === 401, `revoke=${revokeRes.status} after=${afterRevoke.status} newId=${newTokenId !== tokenId ? 'rotated' : 'same'}`);

    writeEvidence({
      hubPort,
      ghPort,
      projectId: project.id,
      taskId: task.id,
      devGroupId: group.id,
      verifyGroupId: verifyGroup.id,
      dirtyGroupId: dirtyGroup.id,
      sessionId,
      verifySessionId: started2.id,
      sourceRepos,
      worktreeLists: lists,
      githubPrs: github.prs.map((p) => ({ repo: p.repo, number: p.number, state: p.state })),
      evidenceDir: EVIDENCE_DIR
    });
  } catch (error) {
    record('fatal', false, error instanceof Error ? error.stack ?? error.message : String(error));
    writeEvidence({ hubLog: redact(readHubLog(hubLog).slice(-4000)), worker1Log: redact(readHubLog(w1Log).slice(-2000)), worker2Log: redact(readHubLog(w2Log).slice(-2000)) });
    throw error;
  } finally {
    await shutdown();
  }

  const failed = steps.filter((s) => !s.pass);
  if (failed.length) {
    log(`结束：${failed.length} 步失败，证据 ${EVIDENCE}`);
    process.exitCode = 1;
    return;
  }
  log(`结束：全部通过，证据 ${EVIDENCE}`);
}

main().catch((error) => {
  record('fatal', false, error instanceof Error ? error.stack ?? error.message : String(error));
  writeEvidence();
  console.error(redact(error instanceof Error ? error.stack ?? error.message : String(error)));
  process.exitCode = 1;
});
