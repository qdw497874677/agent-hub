import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { readHubLog, reservePort, spawnHub, stop } from './spawn-hub.ts';

/**
 * 隔离仓库探测的生产组合 e2e（docs/design/project-git-access.md + project-git-probe-routes.ts）：
 *
 * 1. 不起本地 Worker、也没有运营白名单时，生产入口 apps/server/src/main.ts 不安装隔离路由
 *    → 默认 404（这就是「默认关闭」）。
 * 2. 项目 ID 只能在建项目之后才知道，所以同一份数据目录重启。白名单齐全、仍然不 spawn Worker，
 *    但数据目录是 0755 时，私有目录 gate 必须继续 404，而且不写凭据、不产生 TCP。
 * 3. 把同一份数据目录 chmod 0700 后再带白名单启动（仍然 HUB_SPAWN_WORKER=0），隔离路由才出现；
 *    浏览器 cookie + CSRF 才能写 / 删隔离凭据、触发检查；API token 通道不参与。
 * 4. 仓库地址是 `https://127.0.0.1:<fixturePort>/demo.git`。生产组合不传 testOnlyAllowLoopback，
 *    出口策略在 DNS / TCP 之前就拒绝 loopback，所以检查返回 unreachable，而且本机监听器
 *    收到 0 个连接——证明拒绝是策略拒绝，不是「连了但 TLS 握手失败」。
 * 5. 同一份数据、同样的白名单，但 HUB_SPAWN_WORKER=1：guard 让隔离路由继续 404；本机 Worker
 *    用隔离的 HOME / PATH / WORKER_ROOTS 拉起，目录边界只在测试临时目录里。
 *
 * 真正的 TLS loopback Git 广告解析在 project-git-https-probe.test.ts 里，用测试专用开关；
 * 这里刻意不复用那个开关，也不引入任何外部服务或生产凭据。
 */

const TEST_EMAIL = 'test@agent-hub.local';
const PROBE_TOKEN = 'fixture-only-isolated-token';

interface Ctx {
  readonly base: string;
  readonly cookie: string;
  readonly csrf: string;
}

interface Hub {
  readonly base: string;
  readonly ctx: Ctx;
  readonly log: () => string;
  readonly stop: () => Promise<void>;
}

interface ProbeWatcher {
  readonly port: number;
  readonly connections: () => number;
  readonly close: () => Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

async function waitFor<T>(
  what: string,
  check: () => Promise<T | null | false | undefined>,
  attempts = 150,
  interval = 100
): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    const value = await check().catch(() => null);
    if (value) return value;
    await sleep(interval);
  }
  throw new Error(`等不到：${what}`);
}

function tail(log: string, lines = 40): string {
  return log.split('\n').slice(-lines).join('\n');
}

/** 只在状态不符时读响应体，成功路径把 body 留给 JSON 断言。 */
async function expectStatus(
  response: Response,
  status: number,
  where: string,
  log: () => string
): Promise<void> {
  if (response.status === status) return;
  const body = await response.text();
  throw new Error(`${where}：HTTP ${response.status}（期望 ${status}）${body}\n--- hub ---\n${tail(log())}`);
}

function request(
  ctx: Ctx,
  path: string,
  options: { method?: string; json?: unknown } = {}
): Promise<Response> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { origin: ctx.base, cookie: ctx.cookie };
  if (method !== 'GET') headers['x-hub-csrf'] = ctx.csrf;
  if (options.json !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${ctx.base}${path}`, {
    method,
    headers,
    ...(options.json === undefined ? {} : { body: JSON.stringify(options.json) })
  });
}

/** 只监听、不响应：任何 TCP 连接都会被计数并立刻断开。 */
async function watchTcp(): Promise<ProbeWatcher> {
  let seen = 0;
  const server: Server = createServer((socket) => {
    seen += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  assert.ok(port > 0, '监听器应拿到端口');
  return {
    port,
    connections: () => seen,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

async function startHub(options: {
  readonly root: string;
  readonly home: string;
  readonly tmp: string;
  readonly data: string;
  readonly outbox: string;
  readonly extraEnv?: Record<string, string>;
}): Promise<Hub> {
  const port = await reservePort();
  const base = `http://127.0.0.1:${port}`;
  const logFile = join(options.root, `hub-${port}.log`);
  const passwordFile = join(options.home, 'test-account');
  const child = spawnHub(process.execPath, ['apps/server/src/main.ts'], {
    env: {
      // 固定 PATH：不把宿主机上的 pi / opencode / grok 带进本机 Worker 的运行时探测。
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: options.home,
      TMPDIR: options.tmp,
      SHELL: '/bin/sh',
      TERMINAL_SHELL: '/bin/sh',
      HUB_HOST: '127.0.0.1',
      HUB_PORT: String(port),
      HUB_DATA_DIR: options.data,
      // 默认不 spawn 本地 Worker；第三阶段显式覆盖成 1，验证生产组合的 guard。
      HUB_SPAWN_WORKER: '0',
      HUB_TEST_ACCOUNT: TEST_EMAIL,
      HUB_TEST_ACCOUNT_FILE: passwordFile,
      HUB_MAIL_PROVIDER: 'log',
      HUB_MAIL_OUTBOX: options.outbox,
      HUB_LOGIN_RATE_MAX: '100',
      // 关掉定时后台任务，避免测试里出现无关的 Git / 资产检查。
      HUB_ASSET_CHECK_MS: '0',
      OBSERVE: '0',
      // 万一拉起本机 Worker（第三阶段），所有状态、目录边界和自检都关在测试临时目录里。
      WORKER_ROOTS: options.tmp,
      WORKER_STATE_DIR: join(options.root, 'worker-state'),
      WORKER_ENV_FILE: join(options.root, 'worker.env'),
      WORKER_ASSETS_DIR: join(options.root, 'worker-assets'),
      WORKER_GROUPS_DIR: join(options.root, 'worker-groups'),
      WORKER_WORKTREES_DIR: join(options.root, 'worker-worktrees'),
      WORKER_MODEL_CHECK: '0',
      WORKER_INVENTORY: '0',
      WORKER_COMPONENTS: '0',
      WORKER_METRICS: '0',
      HUB_PREVIEW: '0',
      ...options.extraEnv
    },
    logFile,
    detached: true
  });
  const log = () => readHubLog(logFile);

  try {
    await waitFor('hub health', async () => (await fetch(`${base}/api/health`)).ok);
    const password = await waitFor('测试账号密码文件', async () => {
      const text = (await readFile(passwordFile, 'utf8').catch(() => '')).trim();
      return text.length > 0 ? text : null;
    });
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ email: TEST_EMAIL, password })
    });
    if (!login.ok) throw new Error(`登录失败：HTTP ${login.status} ${await login.text()}`);
    const cookie = login.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
    const csrf = /(?:^|;\s*)hub_csrf=([^;]+)/.exec(cookie)?.[1] ?? '';
    assert.ok(cookie.includes('hub_login='), '登录后应有会话 cookie');
    assert.ok(csrf.length > 0, '登录后应有 CSRF cookie');
    return { base, ctx: { base, cookie, csrf }, log, stop: () => stop(child) };
  } catch (error) {
    await stop(child).catch(() => {});
    throw new Error(`${(error as Error).message}\n--- hub ${base} ---\n${tail(log())}`);
  }
}

test('隔离探测：默认 404；只有 0700 数据目录且不 spawn Worker 的专用 Hub 才开放凭据与检查', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'project-git-probe-hub-'));
  const home = join(root, 'home');
  const tmp = join(root, 'tmp');
  const data = join(root, 'data');
  await Promise.all([mkdir(home, { recursive: true }), mkdir(tmp, { recursive: true })]);
  // 负例先造一个确定的 0755 数据目录（显式 chmod 抵消 umask），后面再 chmod 0700 做正例。
  await mkdir(data, { recursive: true });
  await chmod(data, 0o755);

  // 本机监听器只用来证明「策略拒绝 = 0 次 TCP 连接」。它不说 TLS，也不提供 Git。
  const watcher = await watchTcp();
  const probeOrigin = `https://127.0.0.1:${watcher.port}`;
  const probeUrl = `${probeOrigin}/demo.git`;
  let active: Hub | null = null;

  t.after(async () => {
    if (active) await active.stop().catch(() => {});
    await watcher.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  // ── 阶段 1：生产默认值，没有白名单，也没有本地 Worker ──
  const first = await startHub({ root, home, tmp, data, outbox: join(root, 'outbox.jsonl') });
  active = first;

  const created = await request(first.ctx, '/api/projects', {
    method: 'POST',
    json: {
      name: '隔离探测 e2e',
      repos: [
        { id: 'repo_probe_fixture', name: 'demo', url: probeUrl, defaultBranch: 'main' },
        // 同一个项目里、但 origin 不在运营白名单中的仓库：用来证明放行是「项目 + origin」双条件。
        { id: 'repo_probe_foreign', name: 'other', url: `https://127.0.0.2:${watcher.port}/other.git`, defaultBranch: 'main' }
      ]
    }
  });
  await expectStatus(created, 201, '建项目', first.log);
  const project = (await created.json()) as {
    id: string;
    repos: { id: string; name: string; url: string; defaultBranch: string | null }[];
  };
  assert.ok(project.id.length > 0, '项目应有 id');
  const repo = project.repos.find((candidate) => candidate.id === 'repo_probe_fixture');
  assert.ok(repo, '项目应登记指定 id 的仓库');
  assert.equal(repo.url, probeUrl);
  assert.equal(repo.defaultBranch, 'main');

  const isolatedBase = `/api/projects/${encodeURIComponent(project.id)}/repos/${encodeURIComponent(repo.id)}/isolated`;
  const offCheck = await request(first.ctx, `${isolatedBase}-check`, { method: 'POST', json: {} });
  assert.equal(offCheck.status, 404, '未启用时检查路由必须不存在');
  const offPut = await request(first.ctx, `${isolatedBase}-credential`, {
    method: 'PUT',
    json: { credential: PROBE_TOKEN }
  });
  assert.equal(offPut.status, 404, '未启用时凭据路由必须不存在');

  await first.stop();
  active = null;

  // ── 阶段 2：白名单齐全、仍然不 spawn Worker，但数据目录还是 0755 ──
  // 私有目录 gate 必须在安装路由之前就失败：404，且不读 / 写凭据、不发起 TCP。
  const permissive = await startHub({
    root,
    home,
    tmp,
    data,
    outbox: join(root, 'outbox.jsonl'),
    extraEnv: {
      HUB_PROJECT_GIT_PROBE_ORIGINS: probeOrigin,
      HUB_PROJECT_GIT_PROBE_PROJECTS: project.id
    }
  });
  active = permissive;
  assert.match(permissive.log(), /隔离探测要求数据目录/, '应以「数据目录不够私有」拒绝启用');
  const permissiveCheck = await request(permissive.ctx, `${isolatedBase}-check`, { method: 'POST', json: {} });
  assert.equal(permissiveCheck.status, 404, '数据目录 0755 时检查路由必须不存在');
  const permissivePut = await request(permissive.ctx, `${isolatedBase}-credential`, {
    method: 'PUT',
    json: { credential: PROBE_TOKEN }
  });
  assert.equal(permissivePut.status, 404, '数据目录 0755 时凭据路由必须不存在');
  assert.equal(watcher.connections(), 0, '私有目录 gate 下不应产生任何 TCP 连接');
  await permissive.stop();
  active = null;

  // ── 阶段 3：同一份数据目录 chmod 0700，再显式白名单 + 仍然不 spawn Worker ──
  await chmod(data, 0o700);
  const second = await startHub({
    root,
    home,
    tmp,
    data,
    outbox: join(root, 'outbox.jsonl'),
    extraEnv: {
      HUB_PROJECT_GIT_PROBE_ORIGINS: probeOrigin,
      HUB_PROJECT_GIT_PROBE_PROJECTS: project.id
    }
  });
  active = second;

  // 上一阶段是 404，凭据不应被写进共享库；先检查一次应直接说「没有可用凭据」。
  const beforePut = await request(second.ctx, `${isolatedBase}-check`, { method: 'POST', json: {} });
  await expectStatus(beforePut, 200, '写凭据前检查', second.log);
  assert.deepEqual(await beforePut.json(), {
    repoId: repo.id,
    status: 'credential_unavailable',
    readable: false,
    defaultBranch: null,
    branch: 'main',
    branchExists: false,
    executor: 'hub'
  });

  const put = await request(second.ctx, `${isolatedBase}-credential`, {
    method: 'PUT',
    json: { credential: PROBE_TOKEN }
  });
  await expectStatus(put, 200, '写凭据', second.log);
  assert.equal(put.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await put.json(), { ok: true, executor: 'hub' });

  const check = await request(second.ctx, `${isolatedBase}-check`, { method: 'POST', json: {} });
  await expectStatus(check, 200, '检查仓库', second.log);
  assert.equal(check.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await check.json(), {
    repoId: repo.id,
    status: 'unreachable',
    readable: false,
    defaultBranch: null,
    branch: 'main',
    branchExists: false,
    executor: 'hub'
  });
  // 生产组合没传 testOnlyAllowLoopback：loopback 在 DNS / TCP 之前就被出口策略拒绝。
  assert.equal(watcher.connections(), 0, '策略拒绝不应产生任何 TCP 连接');

  // 同一个项目、已登记但 origin 不在运营白名单：404（不读凭据、不探测）。
  const foreignOrigin = await request(second.ctx, `/api/projects/${encodeURIComponent(project.id)}/repos/repo_probe_foreign/isolated-check`, {
    method: 'POST',
    json: {}
  });
  assert.equal(foreignOrigin.status, 404, 'origin 不在白名单的已登记仓库必须是 404');

  const foreignRepo = await request(second.ctx, `/api/projects/${encodeURIComponent(project.id)}/repos/repo_other/isolated-check`, {
    method: 'POST',
    json: {}
  });
  assert.equal(foreignRepo.status, 404, '未登记的 repoId 必须是 404');

  const removed = await request(second.ctx, `${isolatedBase}-credential`, { method: 'DELETE' });
  await expectStatus(removed, 200, '删凭据', second.log);
  assert.deepEqual(await removed.json(), { ok: true, executor: 'hub' });

  const afterDelete = await request(second.ctx, `${isolatedBase}-check`, { method: 'POST', json: {} });
  await expectStatus(afterDelete, 200, '删凭据后检查', second.log);
  assert.deepEqual(await afterDelete.json(), {
    repoId: repo.id,
    status: 'credential_unavailable',
    readable: false,
    defaultBranch: null,
    branch: 'main',
    branchExists: false,
    executor: 'hub'
  });

  await second.stop();
  active = null;

  // ── 阶段 4：白名单照旧、目录也已 0700，但这次拉起本机 Worker ──
  // main.ts 的 guard 是 `spawnWorker === '0'`，所以隔离路由必须继续不存在（404）；
  // 路由是否安装是 Hub 启动时的同步组合，不需要等 Worker 注册。
  const embedded = await startHub({
    root,
    home,
    tmp,
    data,
    outbox: join(root, 'outbox.jsonl'),
    extraEnv: {
      HUB_PROJECT_GIT_PROBE_ORIGINS: probeOrigin,
      HUB_PROJECT_GIT_PROBE_PROJECTS: project.id,
      HUB_SPAWN_WORKER: '1'
    }
  });
  active = embedded;

  // 证明本机 Worker 真的被拉起，而且目录边界只放开测试临时目录。
  await waitFor('本机 Worker 启动日志', async () => (embedded.log().includes(`允许访问的目录（WORKER_ROOTS）：${tmp}`) ? true : null));

  const guardedCheck = await request(embedded.ctx, `${isolatedBase}-check`, { method: 'POST', json: {} });
  assert.equal(guardedCheck.status, 404, '拉起本机 Worker 时检查路由必须不存在');
  const guardedPut = await request(embedded.ctx, `${isolatedBase}-credential`, {
    method: 'PUT',
    json: { credential: PROBE_TOKEN }
  });
  assert.equal(guardedPut.status, 404, '拉起本机 Worker 时凭据路由必须不存在');
  assert.equal(watcher.connections(), 0, 'guard 下也不应有任何探测 TCP 连接');

  await embedded.stop();
  active = null;
});
