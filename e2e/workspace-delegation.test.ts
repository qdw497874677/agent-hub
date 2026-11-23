import assert from 'node:assert/strict';
import { execFile, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';
import { e2eWorkerPath, e2eWorkerRoots } from './isolation.ts';
import { readHubLog, reservePort, spawnHub, stop } from './spawn-hub.ts';
import { GITHUB_ORIGIN, GITHUB_REPO, startFakeGitHub, startGitOrigin, type FakeGitHub, type GitOrigin } from './workspace-delegation-origin.ts';

/**
 * 持久工作空间派工（docs/design/workspace-delegation.md）的真链路 e2e：
 *
 * - 真的 spawn 生产入口 apps/server/src/main.ts（HUB_SPAWN_WORKER=0）+ 一台通过 websocket
 *   接入的 remote Worker；agent 是真的 ACP 适配器带 fake-agent。
 * - origin 是 `https://github.com/e2e/demo.git`，但只在本机 CONNECT 代理 + 自签证书里
 *   落到真实的 bare 仓库（git http-backend）；push / fetch 都是真 git 传输，没有 insteadOf。
 * - GitHub REST 是本机假服务；create PR 时从 bare 读该分支的真实 sha，hub 的 PR 校验因此
 *   证明「PR 的 head 就是批准的那个提交」。
 *
 * 阶段 1（人走 HTTP）：派工 → 立即 prepared（真 worker 建 worktree+分支）→ 真 agent 写文件
 *   → 人提交 → 批准 exact SHA → 真 push 到 bare → 草稿 PR → 同 key 重放 → 换 key 拒绝
 *   → 错误 SHA 拒绝 → 源仓库没被碰。
 * 阶段 2（MCP 提案）：真的通过 session/new 下发的 HTTP MCP server 调 workspace.delegate，
 *   记录停在 pending（没有 worktree / 分支 / 执行会话），只有带 cookie+CSRF 的人确认后才建。
 */

const FAKE = resolve('packages/adapters/acp/test-fixtures/fake-agent.mjs');
const GIT_TOKEN = 'ghs_e2eDelegationToken0000000000';
const TEST_EMAIL = 'test@agent-hub.local';

const run = promisify(execFile);

interface Ctx {
  readonly base: string;
  readonly cookie: string;
  readonly csrf: string;
}

interface World {
  readonly root: string;
  readonly source: string;
  readonly bare: string;
  readonly taskId: string;
  readonly repoId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly workerId: string;
  readonly coordinatorSessionId: string;
  readonly ctx: Ctx;
  readonly origin: GitOrigin;
  readonly github: FakeGitHub;
}

const cleanups: (() => Promise<void>)[] = [];
let logs: { hub: string; worker: string } = { hub: '', worker: '' };

after(async () => {
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup();
    } catch {
      // 清理失败不覆盖真正的断言结果
    }
  }
});

function tail(kind: 'hub' | 'worker', lines = 25): string {
  return logs[kind].split('\n').slice(-lines).join('\n');
}

async function must(response: Response, where: string): Promise<Response> {
  if (response.ok) return response;
  const body = await response.text();
  throw new Error(`${where} 失败：HTTP ${response.status} ${body}\n--- hub ---\n${tail('hub')}\n--- worker ---\n${tail('worker')}`);
}

async function json<T>(response: Response, where: string): Promise<T> {
  return (await (await must(response, where)).json()) as T;
}

async function request(
  ctx: Ctx,
  path: string,
  options: { method?: string; json?: unknown; body?: string; anonymous?: boolean } = {}
): Promise<Response> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { origin: ctx.base };
  if (!options.anonymous) {
    headers['cookie'] = ctx.cookie;
    if (method !== 'GET') headers['x-hub-csrf'] = ctx.csrf;
  }
  if (options.json !== undefined) headers['content-type'] = 'application/json';
  const body = options.json !== undefined ? JSON.stringify(options.json) : options.body;
  return fetch(`${ctx.base}${path}`, { method, headers, ...(body === undefined ? {} : { body }) });
}

/** 断言用的 git：fixture 服务器挂在同一个事件循环上，必须异步跑子进程。 */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', ...args], {
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  });
  return stdout;
}

async function bareGit(bare: string, ...args: string[]): Promise<string> {
  return git(process.cwd(), '--git-dir', bare, ...args);
}

async function branchesOf(bare: string): Promise<string[]> {
  const out = await bareGit(bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads');
  return out.split('\n').map((line) => line.trim()).filter(Boolean).sort();
}

async function waitFor(what: string, check: () => Promise<boolean>, attempts = 120, interval = 500): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, interval));
  }
  throw new Error(`等不到：${what}`);
}

async function waitTurns(ctx: Ctx, sid: string, count: number): Promise<void> {
  await waitFor(`${sid} 的第 ${count} 轮检查点`, async () => {
    const body = await json<{ turns?: { after: string | null }[] }>(await request(ctx, `/api/sessions/${sid}/git/turns`), 'turns');
    const turns = body.turns ?? [];
    return turns.length >= count && turns.every((turn) => turn.after !== null);
  });
}

async function snapshot(dir: string) {
  return {
    head: await git(dir, 'rev-parse', 'HEAD'),
    branch: (await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).trim(),
    status: await git(dir, 'status', '--porcelain'),
    diff: await git(dir, 'diff'),
    untracked: (await git(dir, 'ls-files', '--others', '--exclude-standard')).trim()
  };
}

interface CanvasTask {
  id: string;
  projectId: string;
  title: string;
  status: string;
  parentTaskId?: string | null;
}

interface CanvasWorkspace {
  id: string;
  path: string;
  kind: 'long_lived' | 'temporary';
  source: 'linked' | 'created' | 'cloned' | 'worktree';
  baseWorkspaceId: string | null;
  branch: string | null;
  ownerTaskId: string | null;
  workerId: string | null;
  state: string;
}

interface CanvasSession {
  id: string;
  taskId: string | null;
  workspaceId: string | null;
  workerId: string | null;
}

interface CanvasView {
  tasks: CanvasTask[];
  workspaces: CanvasWorkspace[];
  sessions: CanvasSession[];
}

async function canvas(ctx: Ctx, projectId: string): Promise<CanvasView> {
  return json<CanvasView>(await request(ctx, `/api/projects/${projectId}/canvas`), '项目画布');
}

interface Observation {
  action: 'task.create' | 'worktree.start' | 'handoff' | 'candidate.import' | 'asset.list' | 'asset.read' | 'asset.create' | 'asset.revise' | 'asset.set_enabled';
  names: string[];
  listError?: unknown;
  callError?: unknown;
  isError: boolean;
  text: string;
}

/** fake-agent 把项目工具调用结果写成一行 `project-observation:<json>`（见 test-fixtures/fake-agent.mjs）。 */
async function observations(ctx: Ctx, sid: string, action: Observation['action']): Promise<Observation[]> {
  const entries = await json<{ event: { kind?: string; delta?: string } }[]>(
    await request(ctx, `/api/sessions/${sid}/events?after=0`),
    '会话事件'
  );
  const found: Observation[] = [];
  for (const entry of entries) {
    const text = entry.event.kind === 'text' ? (entry.event.delta ?? '') : '';
    const marker = text.indexOf('project-observation:');
    if (marker < 0) continue;
    try {
      const parsed = JSON.parse(text.slice(marker + 'project-observation:'.length)) as Observation;
      if (parsed.action === action && typeof parsed.text === 'string') found.push(parsed);
    } catch {
      // 不是完整 JSON 的文本块忽略；下一轮会重读整段事件
    }
  }
  return found;
}

async function waitObservation(ctx: Ctx, sid: string, action: Observation['action'], count: number): Promise<Observation> {
  let seen: Observation[] = [];
  await waitFor(`${sid} 的第 ${count} 次 ${action} 观测`, async () => {
    seen = await observations(ctx, sid, action);
    return seen.length >= count;
  }, 180, 500);
  return seen[count - 1]!;
}

function toolPayload<T>(observation: Observation, key: 'task' | 'worktree'): T {
  assert.equal(observation.isError, false, `${observation.action} 不应报错：${observation.text}`);
  assert.equal(observation.callError ?? null, null, `${observation.action} JSON-RPC 调用不应报错：${JSON.stringify(observation.callError)}`);
  const body = JSON.parse(observation.text) as Record<string, T>;
  const value = body[key];
  assert.ok(value, `${observation.action} 应返回 ${key}：${observation.text}`);
  return value;
}

/** 交接 / 候选导入的响应本身就是平铺 JSON；解析后断言调用没有报错。 */
function observationValue<T>(observation: Observation): T {
  assert.equal(observation.isError, false, `${observation.action} 不应报错：${observation.text}`);
  assert.equal(observation.callError ?? null, null, `${observation.action} JSON-RPC 调用不应报错：${JSON.stringify(observation.callError)}`);
  return JSON.parse(observation.text) as T;
}

async function turnCount(ctx: Ctx, sid: string): Promise<number> {
  const body = await json<{ turns?: unknown[] }>(await request(ctx, `/api/sessions/${sid}/git/turns`), 'turns');
  return body.turns?.length ?? 0;
}

let booted: Promise<World> | null = null;
function world(): Promise<World> {
  booted ??= bootstrap();
  return booted;
}

async function bootstrap(): Promise<World> {
  const root = await mkdtemp(join('/tmp', 'hub-e2e-delegation-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const tmp = join(root, 'tmp');
  await mkdir(home, { recursive: true });
  await mkdir(tmp, { recursive: true });

  // ── 真实 bare 仓库 + 源仓库（有未提交改动，用来证明派工不碰源）──
  const source = join(root, 'repo', 'demo');
  const bare = join(root, 'origin', GITHUB_REPO + '.git');
  await mkdir(source, { recursive: true });
  await mkdir(join(root, 'origin', GITHUB_REPO), { recursive: true });
  await git(source, 'init', '-q', '-b', 'main');
  await writeFile(join(source, 'README.md'), '# demo\n');
  await writeFile(join(source, 'app.txt'), 'base\n');
  await git(source, 'add', '.');
  await git(source, 'commit', '-qm', 'init');
  await git(process.cwd(), 'init', '-q', '--bare', '-b', 'main', bare);
  await bareGit(bare, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  await bareGit(bare, 'config', 'http.receivepack', 'true');
  await git(source, 'remote', 'add', 'origin', GITHUB_ORIGIN);
  // 先直接推到 bare 路径播种（origin 文本保持原样，之后 worker 里才经本机代理走真 HTTPS）。
  await git(source, 'push', '-q', bare, 'main');
  // 未提交改动 + 未跟踪文件：派工结束后必须还在
  await writeFile(join(source, 'README.md'), '# demo\n\nlocal edit\n');
  await writeFile(join(source, 'scratch.txt'), 'untracked\n');
  const before = await snapshot(source);
  const baseSha = (await bareGit(bare, 'rev-parse', 'refs/heads/main')).trim();

  // ── 本机 HTTPS git origin + 假 GitHub ──
  const origin = await startGitOrigin(join(root, 'origin'), { workDir: join(root, 'tls') });
  cleanups.push(() => origin.close());
  // 让 worker 里所有 git 命令都经本机代理：origin 文本保持原样，所以 publishRef 的
  // readOriginDestination（insteadOf 检查）会通过；网络只到本进程。
  await git(source, 'config', 'http.proxy', `http://127.0.0.1:${origin.port}`);
  // 先证明校验确实开着：没有本机 CA 时 TLS 必须失败（不是 sslVerify=false 的通道）。
  await assert.rejects(
    git(source, 'ls-remote', 'origin'),
    (error: unknown) => /certificate|SSL/i.test(error instanceof Error ? error.message : String(error)),
    '未信任本机证书时 TLS 必须失败'
  );
  // 只信任本次运行生成的证书，且只对这一个 origin URL 生效；TLS 校验保持开启。
  await git(source, 'config', `http.https://github.com/e2e/demo.git.sslCAInfo`, origin.caFile);
  // 失败关闭：origin 必须是原样的 github.com（publishRef 会拒绝被 insteadOf 改写的地址），
  // 唯一出网路径是本机代理，校验必须开着且只信本机证书。
  assert.equal((await git(source, 'remote', 'get-url', 'origin')).trim(), GITHUB_ORIGIN, 'origin 必须保持原样');
  assert.equal((await git(source, 'config', '--get-regexp', '^url\\..*\\.insteadof$').catch(() => '')).trim(), '', '不能有 insteadOf 改写');
  assert.match((await git(source, 'config', 'http.proxy')).trim(), new RegExp(`^http://127\\.0\\.0\\.1:${origin.port}$`), 'git 必须经本机代理');
  assert.notEqual((await git(source, 'config', 'http.sslVerify').catch(() => '')).trim(), 'false', '不能关闭 TLS 校验');
  assert.equal((await git(source, 'config', 'http.sslCAInfo').catch(() => '')).trim(), '', '不能有全局 sslCAInfo');
  assert.equal((await git(source, 'config', 'http.https://github.com/e2e/demo.git.sslCAInfo')).trim(), origin.caFile, '证书必须 scoped 到 origin URL');

  // Worker 使用真实的系统 git；不要改 Worker 环境或实现。
  const PATH = e2eWorkerPath();

  const github = await startFakeGitHub({ bare, repo: GITHUB_REPO });
  cleanups.push(() => github.close());

  // ── 生产 hub（不 spawn 本地 worker）──
  const port = await reservePort();
  const base = `http://127.0.0.1:${port}`;
  const hubLog = join(root, 'hub.log');
  logs.hub = readHubLog(hubLog);
  const passwordFile = join(home, 'test-account');
  const hub = spawnHub(process.execPath, ['apps/server/src/main.ts'], {
    env: {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: home,
      TMPDIR: tmp,
      HUB_HOST: '127.0.0.1',
      HUB_PORT: String(port),
      HUB_DATA_DIR: join(root, 'data'),
      HUB_SPAWN_WORKER: '0',
      HUB_TEST_ACCOUNT: TEST_EMAIL,
      HUB_TEST_ACCOUNT_FILE: passwordFile,
      HUB_MAIL_PROVIDER: 'log',
      HUB_MAIL_OUTBOX: join(root, 'outbox.jsonl'),
      HUB_GITHUB_API: github.base
    },
    logFile: hubLog,
    detached: true
  });
  cleanups.push(() => stop(hub));
  const refresh = () => {
    logs.hub = readHubLog(hubLog);
  };
  await waitFor('hub health', async () => {
    refresh();
    return fetch(`${base}/api/health`).then((res) => res.ok).catch(() => false);
  }, 80, 100);
  const password = await waitFor(
    '测试账号密码文件',
    async () => {
      refresh();
      const text = await readFile(passwordFile, 'utf8').catch(() => '');
      return text.trim().length > 0;
    },
    80,
    100
  ).then(() => readFile(passwordFile, 'utf8'));

  // ── 登录（真 cookie + CSRF）──
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ email: TEST_EMAIL, password: password.trim() })
  });
  await must(login, '登录');
  const cookie = login.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  const csrf = /(?:^|;\s*)hub_csrf=([^;]+)/.exec(cookie)?.[1] ?? '';
  assert.ok(cookie.includes('hub_login='), '登录后应有会话 cookie');
  assert.ok(csrf.length > 0, '登录后应有 CSRF cookie');
  const ctx: Ctx = { base, cookie, csrf };

  await must(await request(ctx, '/api/git-host/token', { method: 'PUT', json: { token: GIT_TOKEN } }), '设置团队 GitHub token');

  // ── 派一台 remote worker ──
  const label = `e2e delegation ${Date.now().toString(36)}`;
  const pairing = await json<{ code: string }>(await request(ctx, '/api/workers/pairing', { method: 'POST', json: {} }), 'pairing');
  assert.ok(pairing.code, 'pairing 应给 code');
  const hubUrl = `${base.replace(/^http/, 'ws')}/worker`;
  const enrolled = await run(process.execPath, ['apps/worker/src/enroll.ts'], {
    env: { PATH, HOME: home, HUB_URL: hubUrl, HUB_PAIR: pairing.code, WORKER_LABEL: label }
  }).catch((error) => {
    throw new Error(`worker 注册失败：${error.message}\n${error.stderr ?? ''}`);
  });
  const [workerId = '', credential = ''] = enrolled.stdout.trim().split('\n');
  assert.ok(workerId && credential, '注册应输出 workerId 和凭据');

  const workerLog = join(root, 'worker.log');
  const worker: ChildProcess = spawnHub(process.execPath, ['apps/worker/src/main.ts'], {
    env: {
      PATH,
      HOME: home,
      TMPDIR: tmp,
      HUB_URL: hubUrl,
      HUB_WORKER_CREDENTIAL: credential,
      WORKER_ID: workerId,
      WORKER_ORIGIN: 'remote',
      WORKER_LABEL: label,
      WORKER_ROOTS: e2eWorkerRoots(),
      WORKER_STATE_DIR: join(home, '.config', 'agent-hub'),
      WORKER_RUNTIMES_DIR: join(home, '.agent-hub', 'runtimes'),
      WORKER_GROUPS_DIR: join(root, 'groups'),
      WORKER_MODEL_CHECK: '0',
      ACP_AGENTS: JSON.stringify([
        {
          id: 'fakeacp',
          label: '假 ACP',
          command: process.execPath,
          args: [FAKE, '--mcp-http'],
          listModelsArgs: [FAKE, '--models']
        }
      ])
    },
    logFile: workerLog,
    detached: true
  });
  cleanups.push(() => stop(worker));
  const refreshWorker = () => {
    logs.worker = readHubLog(workerLog);
  };
  await waitFor(`${workerId} 上线`, async () => {
    refresh();
    refreshWorker();
    const workers = await json<{ id?: string; workerId?: string; state: string }[]>(await request(ctx, '/api/workers'), 'workers');
    return workers.some((entry) => (entry.workerId ?? entry.id) === workerId && entry.state === 'online');
  });

  // ── 项目 + 仓库 + 关联已有目录（pin 到 remote worker）──
  const project = await json<{ id: string }>(
    await request(ctx, '/api/projects', { method: 'POST', json: { name: `e2e 派工 ${Date.now().toString(36)}` } }),
    '建项目'
  );
  const patched = await json<{ repos: { id: string; name: string }[] }>(
    await request(ctx, `/api/projects/${project.id}`, {
      method: 'PATCH',
      json: { repos: [{ name: 'demo', url: GITHUB_ORIGIN, defaultBranch: 'main', credential: GIT_TOKEN }] }
    }),
    '设仓库'
  );
  const repo = patched.repos[0];
  assert.ok(repo?.id, '项目应返回仓库 id（tokenSecret 不外露）');

  const workspace = await json<{ id: string; isGit: boolean; path: string; workerId: string | null }>(
    await request(ctx, `/api/projects/${project.id}/workspaces`, {
      method: 'POST',
      json: { kind: 'long_lived', mode: 'link', path: source, workerId }
    }),
    '关联工作空间'
  );
  assert.equal(workspace.isGit, true, '关联的工作空间应被识别成 git 仓库');
  assert.equal(workspace.workerId, workerId, '工作空间应落在 remote worker 上');

  const task = await json<{ id: string }>(await request(ctx, '/api/tasks', { method: 'POST', json: { projectId: project.id, title: '派工：加文件' } }), '建任务');

  const coordinator = await json<{ session: { id: string; taskId: string | null } }>(
    await request(ctx, '/api/coordinators', { method: 'POST', json: { projectId: project.id, workspaceId: workspace.id, agentId: 'fakeacp', model: '' } }),
    '建主会话'
  );
  assert.equal(coordinator.session.taskId, null, '主会话不应绑任务');

  return {
    root,
    source,
    bare,
    taskId: task.id,
    repoId: repo.id,
    projectId: project.id,
    workspaceId: workspace.id,
    workerId,
    coordinatorSessionId: coordinator.session.id,
    ctx,
    origin,
    github
  };
}

interface DelegationView {
  id: string;
  requestKey: string;
  state: string;
  canConfirm: boolean;
  baseBranch: string;
  baseSha: string | null;
  workerId: string;
  executionSessionId: string | null;
  worktreePath: string | null;
  branch: string | null;
  projectId: string;
  taskId: string;
  repoId: string;
}

interface PublishView {
  delegationId: string;
  state: string;
  headSha: string | null;
  branch: string;
  attempt: {
    state: string;
    headSha: string | null;
    remote: { sha: string; remoteSha: string | null; published: boolean; branch: string } | null;
    pullRequest: { draft?: boolean; headSha: string | null; base: string | null; headRef: string | null; number: number } | null;
  } | null;
  attempted: boolean;
  replayed: boolean;
}

test('人走 HTTP：派工 → 真提交 → 批准 exact SHA → 真 push + 草稿 PR → 重放/换 key/错 SHA，源不变', { timeout: 240_000 }, async () => {
  const w = await world();
  const { ctx } = w;
  const sourceBefore = await snapshot(w.source);

  const created = await request(ctx, `/api/coordinators/${w.coordinatorSessionId}/delegations`, {
    method: 'POST',
    json: {
      requestKey: 'human-1',
      taskId: w.taskId,
      repoId: w.repoId,
      baseBranch: 'main',
      instructions: '请加一个 feature.txt',
      agentId: 'fakeacp',
      model: ''
    } satisfies Record<string, unknown>
  });
  const delegated = await json<{ created: boolean; claimed: boolean; delegation: DelegationView }>(created, '发起派工');
  assert.equal(created.status, 201);
  assert.equal(delegated.created, true, 'HTTP 人发起应直接分配（created）');
  const view = delegated.delegation;
  assert.equal(view.state, 'prepared', '人走 HTTP 应同步准备完成');
  assert.equal(view.workerId, w.workerId);
  assert.equal(view.baseBranch, 'main');
  assert.match(String(view.branch), /^delegation\/[0-9a-f]{24}$/);
  assert.ok(view.executionSessionId, 'prepared 应有执行会话');
  assert.ok(view.worktreePath && view.worktreePath !== w.source, 'worktree 必须是独立目录');
  assert.equal(view.baseSha, (await bareGit(w.bare, 'rev-parse', 'refs/heads/main')).trim(), 'baseSha 应是远端 main');

  // 真 worker 建了 worktree + 分支；远端还没有这个分支
  assert.equal(existsSync(join(view.worktreePath!, '.git')), true, 'worktree 目录应真实存在');
  assert.equal((await git(view.worktreePath!, 'rev-parse', '--abbrev-ref', 'HEAD')).trim(), view.branch);
  assert.equal((await git(view.worktreePath!, 'rev-parse', 'HEAD')).trim(), view.baseSha);
  assert.equal((await branchesOf(w.bare)).includes(String(view.branch)), false, '确认前不应有远端分支');

  // 真 agent（真的 ACP 适配器 + fake-agent）在 worktree 里写文件
  await must(
    await request(ctx, `/api/sessions/${view.executionSessionId}/prompt`, { method: 'POST', json: { text: 'please-write:feature.txt=hello_from_delegation' } }),
    '执行会话 prompt'
  );
  await waitTurns(ctx, view.executionSessionId!, 1);
  assert.equal(await readFile(join(view.worktreePath!, 'feature.txt'), 'utf8'), 'hello_from_delegation\n');

  const state = await json<{ branch: string; files: { path: string }[] }>(
    await request(ctx, `/api/sessions/${view.executionSessionId}/git/state`),
    'git state'
  );
  assert.equal(state.branch, view.branch);
  assert.ok(state.files.some((file) => file.path === 'feature.txt'), 'git state 应看到 agent 写的文件');

  // 人在执行会话上真提交（HTTP 路由用的是登录人的身份，不是 agent 的 git 工具）
  const committed = await json<{ sha: string; committed: boolean; branch: string }>(
    await request(ctx, `/api/sessions/${view.executionSessionId}/git/run`, { method: 'POST', json: { action: 'commit', message: 'feat: delegation adds feature.txt' } }),
    '提交'
  );
  assert.equal(committed.committed, true);
  assert.match(committed.sha, /^[0-9a-f]{40}$/);
  assert.equal(committed.branch, view.branch);
  assert.equal((await git(view.worktreePath!, 'rev-parse', 'HEAD')).trim(), committed.sha, '提交真的落在 worktree 上');

  // 批准前：publish 视图给的就是这个 SHA
  const preview = await json<PublishView>(await request(ctx, `/api/workspace-delegations/${view.id}/publish`), 'publish preview');
  assert.equal(preview.state, 'prepared');
  assert.equal(preview.headSha, committed.sha, '预览 HEAD 应等于刚提交的 SHA');

  const acceptancePath = `/api/workspace-delegations/${view.id}/acceptance`;
  const initialAcceptance = await json<{ headSha: string; status: string }>(await request(ctx, acceptancePath), '读取待验收提交');
  assert.equal(initialAcceptance.headSha, committed.sha);
  assert.equal(initialAcceptance.status, 'none');
  const acceptanceBody = { requestKey: 'human-accept-1', expectedHeadSha: committed.sha, note: '人工确认交付内容' };
  const accepted = await json<{ acceptance: { sha: string } }>(
    await request(ctx, acceptancePath, { method: 'POST', json: acceptanceBody }), '记录人工验收'
  );
  assert.equal(accepted.acceptance.sha, committed.sha);
  assert.equal(w.github.created.length, 0, '人工验收不能创建 PR');
  assert.equal((await branchesOf(w.bare)).includes(String(view.branch)), false, '人工验收不能推送分支');

  // 错误的 SHA 先被拒（还没有任何 attempt）
  const wrong = await request(ctx, `/api/workspace-delegations/${view.id}/publish`, {
    method: 'POST',
    json: { approvalKey: 'wrong-sha', expectedHeadSha: 'b'.repeat(40) }
  });
  assert.equal(wrong.status, 409, '错误 SHA 必须 409');
  assert.match(await wrong.text(), /已经不是批准的提交/);

  // 真发布：worker 真 push 到 bare，hub 再建草稿 PR
  const published = await json<PublishView>(
    await request(ctx, `/api/workspace-delegations/${view.id}/publish`, { method: 'POST', json: { approvalKey: 'approve-1', expectedHeadSha: committed.sha } }),
    '发布'
  );
  assert.equal(published.attempted, true);
  assert.equal(published.replayed, false);
  assert.equal(published.attempt?.state, 'published');
  assert.equal(published.attempt?.headSha, committed.sha);
  assert.equal(published.attempt?.remote?.published, true, '远端应真的更新了');
  assert.equal(published.attempt?.remote?.remoteSha, committed.sha);
  assert.equal(published.attempt?.pullRequest?.draft, true, 'PR 必须是草稿');
  assert.equal(published.attempt?.pullRequest?.headSha, committed.sha);
  assert.equal(published.attempt?.pullRequest?.base, 'main');
  assert.equal(published.attempt?.pullRequest?.headRef, view.branch);

  // bare 仓库里真的有这个分支，且指向批准的提交
  assert.equal((await bareGit(w.bare, 'rev-parse', `refs/heads/${view.branch}`)).trim(), committed.sha);
  // 假 GitHub 收到的就是真 bare 的 sha，而且只建了一个草稿 PR
  assert.equal(w.github.created.length, 1);
  assert.equal(w.github.created[0]?.sha, committed.sha);
  assert.equal(w.github.created[0]?.head, view.branch);
  assert.equal(w.github.created[0]?.base, 'main');
  assert.equal(w.github.created[0]?.draft, true);
  assert.equal(w.github.created[0]?.title, '应用人工批准的改动');
  // 真 git 传输发生过（proxy 上的 smart-HTTP 请求）
  assert.ok(w.origin.requests.some((line) => line.includes('service=git-receive-pack')), `应真的 push 过；收到：${w.origin.requests.join(' | ')}`);

  // 同一个批准键重放：只读记录，不再碰远端 / GitHub
  const replay = await json<PublishView>(
    await request(ctx, `/api/workspace-delegations/${view.id}/publish`, { method: 'POST', json: { approvalKey: 'approve-1', expectedHeadSha: committed.sha } }),
    '重放'
  );
  assert.equal(replay.attempted, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.attempt?.state, 'published');
  assert.equal(w.github.created.length, 1, '重放不应再建 PR');

  // 换一个批准键：拒绝
  const secondKey = await request(ctx, `/api/workspace-delegations/${view.id}/publish`, {
    method: 'POST',
    json: { approvalKey: 'approve-2', expectedHeadSha: committed.sha }
  });
  assert.equal(secondKey.status, 409);
  assert.match(await secondKey.text(), /已经发布过 PR/);

  await git(view.worktreePath!, 'commit', '--allow-empty', '-qm', 'chore: new revision after acceptance');
  const newerHead = (await git(view.worktreePath!, 'rev-parse', 'HEAD')).trim();
  assert.notEqual(newerHead, committed.sha);
  const movedAcceptance = await json<{ headSha: string; status: string; history: { sha: string }[] }>(
    await request(ctx, acceptancePath), '读取 HEAD 变化后的验收'
  );
  assert.equal(movedAcceptance.headSha, newerHead);
  assert.equal(movedAcceptance.status, 'changed');
  assert.deepEqual(movedAcceptance.history.map((entry) => entry.sha), [committed.sha]);
  const staleAcceptance = await request(ctx, acceptancePath, {
    method: 'POST', json: { ...acceptanceBody, requestKey: 'human-accept-stale' }
  });
  assert.equal(staleAcceptance.status, 409, '旧 SHA 不得新增验收');

  // 源仓库完全没被派工碰过
  assert.deepEqual(await snapshot(w.source), sourceBefore, '源仓库的 HEAD / 分支 / 工作区应保持不变');
  assert.equal((await branchesOf(w.bare)).includes('main'), true);
});

test('MCP 提案：workspace.delegate 只产生 pending，确认前没有 worktree / 分支 / 执行会话', { timeout: 180_000 }, async () => {
  const w = await world();
  const { ctx } = w;
  const beforeBranches = await branchesOf(w.bare);
  const beforeWorktrees = await git(w.source, 'worktree', 'list', '--porcelain');

  // 真 agent 用 session/new 下发的 HTTP MCP server 调 workspace.delegate
  await must(
    await request(ctx, `/api/sessions/${w.coordinatorSessionId}/prompt`, {
      method: 'POST',
      json: { text: `please-delegate task=${w.taskId} repo=${w.repoId} key=mcp-1 agent=fakeacp` }
    }),
    '主会话 prompt'
  );
  await waitTurns(ctx, w.coordinatorSessionId, 1);

  const listed = await json<{ delegations: DelegationView[] }>(
    await request(ctx, `/api/coordinators/${w.coordinatorSessionId}/delegations`),
    '列派工'
  );
  const pending = listed.delegations.find((entry) => entry.requestKey === 'mcp-1');
  assert.ok(pending, `应有 mcp-1 提案；实际：${listed.delegations.map((d) => d.requestKey).join(',')}`);
  assert.equal(pending.state, 'pending', 'MCP 提案应停在 pending');
  assert.equal(pending.canConfirm, true, 'pending 提案应可确认');
  // 提案记录里带的是**规划**：确认前 worktree 目录、本地/远端分支、执行会话都不存在。
  assert.ok(pending.worktreePath, 'pending 应带上规划的工作树路径');
  assert.equal(existsSync(pending.worktreePath!), false, '确认前 worktree 目录不应存在');
  assert.ok(pending.branch, 'pending 应带上规划的分支名');

  // 确认前：远端分支、本地 worktree、本地分支、派工目录都没多出来
  assert.deepEqual(await branchesOf(w.bare), beforeBranches, '确认前远端不应多出分支');
  assert.equal(await git(w.source, 'worktree', 'list', '--porcelain'), beforeWorktrees, '确认前不应建出 worktree');
  assert.equal((await git(w.source, 'branch', '--format=%(refname:short)')).split('\n').includes(String(pending.branch)), false, '确认前不应建出本地分支');
  assert.deepEqual((await readdir(join(w.root, 'repo'))).filter((name) => name === pending.worktreePath!.split('/').pop()), [], '确认前不应有派工目录');

  // 没有登录 cookie 的人不能确认
  const anonymous = await request(ctx, `/api/coordinators/${w.coordinatorSessionId}/delegations/${pending.id}/confirm`, {
    method: 'POST',
    body: '',
    anonymous: true
  });
  assert.equal(anonymous.status, 401, '未登录确认应被拒');

  // 登录的人确认（空 body；启动配置只从服务端记录读）
  const confirmed = await json<{ delegation: DelegationView }>(
    await request(ctx, `/api/coordinators/${w.coordinatorSessionId}/delegations/${pending.id}/confirm`, { method: 'POST', body: '' }),
    '确认派工'
  );
  const prepared = confirmed.delegation;
  assert.equal(prepared.state, 'prepared');
  assert.equal(prepared.canConfirm, false);
  assert.equal(prepared.worktreePath, pending.worktreePath, '确认应沿用提案里冻结的路径');
  assert.equal(prepared.branch, pending.branch, '确认应沿用提案里冻结的分支');
  assert.ok(prepared.executionSessionId, '确认后应有执行会话');
  assert.match(String(prepared.branch), /^delegation\/[0-9a-f]{24}$/);
  assert.equal(existsSync(join(String(prepared.worktreePath), '.git')), true, '确认后 worktree 应真实存在');
  assert.equal((await git(w.source, 'rev-parse', '--verify', `refs/heads/${prepared.branch}`)).trim(), prepared.baseSha, '本地分支应从 baseSha 起');
  assert.equal((await branchesOf(w.bare)).includes(String(prepared.branch)), false, '确认还没发布，远端不应有分支');

  // 确认后的执行会话真的能写进新 worktree
  await must(
    await request(ctx, `/api/sessions/${prepared.executionSessionId}/prompt`, { method: 'POST', json: { text: 'please-write:mcp.txt=from_mcp_lane' } }),
    '执行会话 prompt'
  );
  await waitTurns(ctx, prepared.executionSessionId!, 1);
  assert.equal(await readFile(join(String(prepared.worktreePath), 'mcp.txt'), 'utf8'), 'from_mcp_lane\n');
});

test('项目会话 MCP：普通任务会话授权 → 子任务 + 独立 worktree → 同 key 重放不重复 → 撤权后旧 token 不能再写', { timeout: 300_000 }, async () => {
  const w = await world();
  const { ctx } = w;
  const sourceBefore = await snapshot(w.source);
  const remoteBranchesBefore = await branchesOf(w.bare);
  const sourceWorktreesBefore = await git(w.source, 'worktree', 'list', '--porcelain');

  // 普通任务会话：绑在同一个长期工作空间 / 同一台 remote worker 上，但不是登记过的主会话。
  const ordinary = await json<{ id: string; taskId: string | null; workspaceId: string | null; workerId: string | null }>(
    await request(ctx, '/api/sessions/derive', {
      method: 'POST',
      json: { taskId: w.taskId, agentId: 'fakeacp', workspaceId: w.workspaceId, workerId: w.workerId }
    }),
    '派生普通任务会话'
  );
  assert.equal(ordinary.taskId, w.taskId);
  assert.equal(ordinary.workspaceId, w.workspaceId);
  assert.equal(ordinary.workerId, w.workerId);
  const registered = await json<{ coordinators: { sessionId: string }[] }>(
    await request(ctx, `/api/coordinators?projectId=${w.projectId}`),
    '列主会话'
  );
  assert.equal(registered.coordinators.some((entry) => entry.sessionId === ordinary.id), false, '普通任务会话不应登记成主会话');
  assert.equal(registered.coordinators.some((entry) => entry.sessionId === w.coordinatorSessionId), true, '原主会话仍在登记簿里');

  const canvasBefore = await canvas(ctx, w.projectId);
  const taskCountBefore = canvasBefore.tasks.length;
  const sessionCountBefore = canvasBefore.sessions.length;
  const workspaceCountBefore = canvasBefore.workspaces.length;

  // 人通过浏览器 cookie + CSRF 显式授权项目能力；agent 自己不能签发。
  const grantedResponse = await request(ctx, `/api/sessions/${ordinary.id}/project-tool-grant`, {
    method: 'PUT',
    json: { scopes: ['task:write'] }
  });
  const granted = await json<{ grant: { scopes: string[] } }>(grantedResponse, '项目工具授权');
  assert.deepEqual([...granted.grant.scopes].sort(), ['task:write']);

  // derive 会立刻托管并下发默认工具令牌；扩大授权范围时必须先作废旧 bearer，
  // 下一次投递才会重新托管换新令牌（新授权替换已有授权会走实现里的 revoke 路径）。
  const regranted = await json<{ grant: { scopes: string[] } }>(
    await request(ctx, `/api/sessions/${ordinary.id}/project-tool-grant`, {
      method: 'PUT',
      json: { scopes: ['task:write', 'worktree:open'] }
    }),
    '扩大项目工具授权'
  );
  assert.deepEqual([...regranted.grant.scopes].sort(), ['task:write', 'worktree:open']);
  const activeGrant = await json<{ grant: { scopes: string[] } | null }>(
    await request(ctx, `/api/sessions/${ordinary.id}/project-tool-grant`),
    '当前项目工具授权'
  );
  assert.deepEqual([...(activeGrant.grant?.scopes ?? [])].sort(), ['task:write', 'worktree:open']);

  const tag = Date.now().toString(36);
  const childTitle = `e2e-project-child-${tag}`;
  const revokedTitle = `e2e-project-revoked-${tag}`;
  const taskKey = `project-task-${tag}`;
  const worktreeKey = `project-worktree-${tag}`;
  const instructions = `add-isolated-file-${tag}`;

  // ── project.task.create：真 MCP tools/list 里应出现两个项目工具，调用只建任务 ──
  await must(
    await request(ctx, `/api/sessions/${ordinary.id}/prompt`, {
      method: 'POST',
      json: { text: `please-project-create key=${taskKey} title=${childTitle} parent=${w.taskId} goal=verify-project-session-mcp` }
    }),
    '项目工具建任务 prompt'
  );
  await waitTurns(ctx, ordinary.id, 1);
  const createdObservation = await waitObservation(ctx, ordinary.id, 'task.create', 1);
  assert.equal(createdObservation.isError, false, `项目工具调用不应失败；实际：${createdObservation.text}`);
  assert.ok(
    createdObservation.names.includes('project_task_create'),
    `MCP 工具清单应含 project_task_create；实际：${createdObservation.names.join(',')}；listError：${JSON.stringify(createdObservation.listError)}；callError：${JSON.stringify(createdObservation.callError)}；响应：${createdObservation.text}`
  );
  assert.ok(createdObservation.names.includes('project_worktree_start'), `MCP 工具清单应含 project_worktree_start；实际：${createdObservation.names.join(',')}`);
  const created = toolPayload<{ id: string; projectId: string; parentTaskId: string | null; status: string }>(createdObservation, 'task');
  assert.equal(created.projectId, w.projectId);
  assert.equal(created.parentTaskId, w.taskId, '子任务应记录父任务');
  assert.equal(created.status, 'todo');

  const afterCreate = await canvas(ctx, w.projectId);
  assert.equal(afterCreate.tasks.filter((entry) => entry.title === childTitle).length, 1, '应只建出一个子任务');
  assert.equal(afterCreate.tasks.find((entry) => entry.id === created.id)?.parentTaskId, w.taskId, '画布里的子任务应带父级');
  assert.equal(afterCreate.sessions.length, sessionCountBefore, '建任务不应隐式创建会话');
  assert.equal(afterCreate.workspaces.length, workspaceCountBefore, '建任务不应隐式建工作区');

  // ── 同 key 同参数重放：返回原任务，不重复建 ──
  await must(
    await request(ctx, `/api/sessions/${ordinary.id}/prompt`, {
      method: 'POST',
      json: { text: `please-project-create key=${taskKey} title=${childTitle} parent=${w.taskId} goal=verify-project-session-mcp` }
    }),
    '项目工具建任务重放'
  );
  await waitTurns(ctx, ordinary.id, 2);
  const replayedTask = toolPayload<{ id: string; projectId: string; parentTaskId: string | null; status: string }>(
    await waitObservation(ctx, ordinary.id, 'task.create', 2),
    'task'
  );
  assert.deepEqual(replayedTask, created, '同 key 重放应返回原任务快照');
  const afterTaskReplay = await canvas(ctx, w.projectId);
  assert.equal(afterTaskReplay.tasks.length, taskCountBefore + 1, '任务重放不应多建任务');
  assert.equal(afterTaskReplay.tasks.filter((entry) => entry.title === childTitle).length, 1);
  assert.equal(afterTaskReplay.sessions.length, sessionCountBefore);

  // ── project.worktree.start：为子任务开严格 Git worktree + 执行会话 ──
  await must(
    await request(ctx, `/api/sessions/${ordinary.id}/prompt`, {
      method: 'POST',
      json: { text: `please-project-worktree key=${worktreeKey} task=${created.id} repo=${w.repoId} base=main agent=fakeacp instructions=${instructions}` }
    }),
    '项目工具开 worktree prompt'
  );
  await waitTurns(ctx, ordinary.id, 3);
  const worktreeObservation = await waitObservation(ctx, ordinary.id, 'worktree.start', 1);
  const started = toolPayload<{
    delegationId: string;
    executionSessionId: string;
    workspaceId: string;
    taskId: string;
    repoId: string;
    branch: string;
    baseSha: string;
  }>(worktreeObservation, 'worktree');
  assert.ok(started.delegationId, '应返回派工 ID');
  assert.ok(started.executionSessionId, '应返回执行会话 ID');
  assert.equal(started.taskId, created.id);
  assert.equal(started.repoId, w.repoId);
  assert.match(started.branch, /^delegation\/[0-9a-f]{24}$/);
  const mainSha = (await bareGit(w.bare, 'rev-parse', 'refs/heads/main')).trim();
  assert.equal(started.baseSha, mainSha, 'worktree 基线应是远端 main 的提交');
  assert.notEqual(started.workspaceId, w.workspaceId, '开 worktree 不应复用源长期工作区的 ID');

  const afterStart = await canvas(ctx, w.projectId);
  const worktree = afterStart.workspaces.find((entry) => entry.id === started.workspaceId);
  assert.ok(worktree, `画布应登记新工作区 ${started.workspaceId}`);
  assert.equal(worktree.kind, 'temporary');
  assert.equal(worktree.source, 'worktree');
  assert.equal(worktree.baseWorkspaceId, w.workspaceId, '新 worktree 应记录源长期工作区');
  assert.equal(worktree.ownerTaskId, created.id, '新 worktree 应归属子任务');
  assert.equal(worktree.branch, started.branch);
  assert.equal(worktree.workerId, w.workerId);
  assert.notEqual(worktree.path, w.source, 'worktree 必须是独立目录');
  assert.equal(worktree.path.startsWith(w.source + '/'), false, 'worktree 不能嵌在源目录里');
  assert.equal(existsSync(join(worktree.path, '.git')), true, 'worktree 目录应真实存在');
  assert.equal((await git(worktree.path, 'rev-parse', '--show-toplevel')).trim(), worktree.path);
  assert.equal((await git(worktree.path, 'rev-parse', 'HEAD')).trim(), started.baseSha);
  assert.equal((await git(worktree.path, 'rev-parse', '--abbrev-ref', 'HEAD')).trim(), started.branch);
  // 独立 checkout：源目录里的未提交改动 / 未跟踪文件没有跟过去。
  assert.equal(await readFile(join(worktree.path, 'README.md'), 'utf8'), '# demo\n');
  assert.equal(await readFile(join(worktree.path, 'app.txt'), 'utf8'), 'base\n');
  assert.equal(existsSync(join(worktree.path, 'scratch.txt')), false, '源目录的未跟踪文件不应出现在 worktree');
  assert.equal((await git(w.source, 'worktree', 'list', '--porcelain')).includes(worktree.path), true, 'worktree 应登记在源仓库');
  assert.equal((await git(w.source, 'rev-parse', '--verify', `refs/heads/${started.branch}`)).trim(), started.baseSha, '本地分支应从 baseSha 起');
  assert.equal((await branchesOf(w.bare)).includes(started.branch), false, '只开 worktree 不应推远端分支');

  const exec = afterStart.sessions.find((entry) => entry.id === started.executionSessionId);
  assert.ok(exec, '执行会话应出现在画布上');
  assert.equal(exec.taskId, created.id);
  assert.equal(exec.workspaceId, started.workspaceId);
  assert.equal(exec.workerId, w.workerId);
  const execDetail = await json<{ id: string; taskId: string | null; workspaceId: string | null }>(
    await request(ctx, `/api/sessions/${started.executionSessionId}`),
    '执行会话详情'
  );
  assert.equal(execDetail.id, started.executionSessionId);
  assert.equal(execDetail.taskId, created.id);
  assert.equal(execDetail.workspaceId, started.workspaceId);
  const registeredAfterStart = await json<{ coordinators: { sessionId: string }[] }>(
    await request(ctx, `/api/coordinators?projectId=${w.projectId}`),
    '列主会话（开工后）'
  );
  assert.equal(registeredAfterStart.coordinators.some((entry) => entry.sessionId === started.executionSessionId), false, '直接开的执行会话不应登记成主会话');
  // 新执行会话不继承父会话的项目写授权：自己的 grant 查询应为空。
  const execGrants = await json<{ grant: unknown | null }>(
    await request(ctx, `/api/sessions/${started.executionSessionId}/project-tool-grant`),
    '执行会话项目授权'
  );
  assert.equal(execGrants.grant, null, '执行会话不应继承项目写授权');

  const worktreeCount = afterStart.workspaces.length;
  const sessionCount = afterStart.sessions.length;
  const taskCount = afterStart.tasks.length;
  const worktreesAfterStart = await git(w.source, 'worktree', 'list', '--porcelain');
  const branchesAfterStart = await branchesOf(w.bare);

  // ── 同 key 同参数重放开 worktree：同一派工 / 会话 / 工作区 / 分支，不重复建 ──
  await must(
    await request(ctx, `/api/sessions/${ordinary.id}/prompt`, {
      method: 'POST',
      json: { text: `please-project-worktree key=${worktreeKey} task=${created.id} repo=${w.repoId} base=main agent=fakeacp instructions=${instructions}` }
    }),
    '项目工具开 worktree 重放'
  );
  await waitTurns(ctx, ordinary.id, 4);
  const replayedWorktree = toolPayload<typeof started>(await waitObservation(ctx, ordinary.id, 'worktree.start', 2), 'worktree');
  assert.deepEqual(replayedWorktree, started, '同 key 重放应返回原 worktree 快照');
  const afterWorktreeReplay = await canvas(ctx, w.projectId);
  assert.equal(afterWorktreeReplay.workspaces.length, worktreeCount, 'worktree 重放不应多建工作区');
  assert.equal(afterWorktreeReplay.sessions.length, sessionCount, 'worktree 重放不应多建会话');
  assert.equal(afterWorktreeReplay.tasks.length, taskCount, 'worktree 重放不应多建任务');
  assert.equal(await git(w.source, 'worktree', 'list', '--porcelain'), worktreesAfterStart, 'worktree 重放不应多建 worktree');
  assert.deepEqual(await branchesOf(w.bare), branchesAfterStart, 'worktree 重放不应多推分支');

  // 源仓库的未提交改动、未跟踪文件和 HEAD 全程不变；只多了 git worktree 登记。
  assert.deepEqual(await snapshot(w.source), sourceBefore, '源仓库内容应保持不变');
  assert.deepEqual(await branchesOf(w.bare), remoteBranchesBefore, '不开工发布就不应出现远端分支');
  const worktreesAfter = await git(w.source, 'worktree', 'list', '--porcelain');
  const worktreeCountBefore = (sourceWorktreesBefore.match(/^worktree /gm) ?? []).length;
  assert.equal((worktreesAfter.match(/^worktree /gm) ?? []).length, worktreeCountBefore + 1, '只应多出一个 worktree 登记');
  assert.ok(
    worktreesAfter.includes(`worktree ${worktree.path}\nHEAD ${started.baseSha}\nbranch refs/heads/${started.branch}`),
    `新 worktree 应登记在源仓库：${worktreesAfter}`
  );

  // ── 撤权：已有工具 token / 旧 MCP server 仍在，但下一次调用必须被拒，且不会自动重新授权 ──
  const revoked = await json<{ grant: null }>(
    await request(ctx, `/api/sessions/${ordinary.id}/project-tool-grant`, { method: 'DELETE' }),
    '撤销项目工具授权'
  );
  assert.equal(revoked.grant, null, '撤销成功后当前授权应为空');
  const afterRevokeList = await json<{ grant: { scopes: string[] } | null }>(
    await request(ctx, `/api/sessions/${ordinary.id}/project-tool-grant`),
    '项目工具授权（撤销后）'
  );
  assert.equal(afterRevokeList.grant, null, '撤销后不应还有生效的项目授权');

  const tasksBeforeRevoked = afterWorktreeReplay.tasks.length;
  await must(
    await request(ctx, `/api/sessions/${ordinary.id}/prompt`, {
      method: 'POST',
      json: { text: `please-project-create key=project-task-revoked-${tag} title=${revokedTitle} parent=${w.taskId}` }
    }),
    '撤权后项目工具 prompt'
  );
  await waitTurns(ctx, ordinary.id, 5);
  const denied = await waitObservation(ctx, ordinary.id, 'task.create', 3);
  assert.equal(denied.isError, true, `撤权后调用应失败；实际：${denied.text}`);
  // DELETE 会作废旧 bearer，下一次投递会先重新托管；此时旧的项目工具已不在清单里，
  // 拒绝可能表现为未知工具 / 401 / 403，不必强求具体文案，只要没建任务且没有自动补授权。
  assert.match(
    denied.text,
    /授权|权限|project:task-write|401|Unauthorized|未知|not found|工具/i,
    `错误应指出项目工具不可用；实际：${denied.text}`
  );
  const afterDenied = await canvas(ctx, w.projectId);
  assert.equal(afterDenied.tasks.length, tasksBeforeRevoked, '被拒的调用不应建任务');
  assert.equal(afterDenied.tasks.some((entry) => entry.title === revokedTitle), false, '被拒的调用不应留下任务');

  const stillRevoked = await json<{ grant: { scopes: string[] } | null }>(
    await request(ctx, `/api/sessions/${ordinary.id}/project-tool-grant`),
    '列项目工具授权（拒绝后）'
  );
  assert.equal(stillRevoked.grant, null, '被拒调用不应自动重新授权');
  assert.deepEqual(await snapshot(w.source), sourceBefore, '整条项目工具链路都不应碰源仓库');
});

interface MessageView {
  messageId: string;
  from: string;
  fromLabel: string;
  targetSessionId: string | null;
  body: string;
  status: string;
  wake: boolean;
  parts: unknown;
}

test('项目会话 MCP 阶段 2：同项目交接只进收件箱 → 候选通知不导入 → 接收会话独立授权导入 → 重放/负例不重复', { timeout: 300_000 }, async () => {
  const w = await world();
  const { ctx } = w;
  const sourceBefore = await snapshot(w.source);
  const bareBranchesBefore = await branchesOf(w.bare);
  const tag = Date.now().toString(36);

  // ── 同一台 Worker 上的第二个独立 clone：接收方仓库 ──
  // 用本地 bare 真 clone，再登记成 link 工作空间；Worker 在导入时核对真实 origin。
  const receiverPath = join(w.root, 'receiver', 'demo');
  await mkdir(join(w.root, 'receiver'), { recursive: true });
  await git(w.root, 'clone', '-q', w.bare, receiverPath);
  await git(receiverPath, 'remote', 'set-url', 'origin', GITHUB_ORIGIN);
  const receiverWorkspace = await json<{ id: string; path: string; workerId: string | null; isGit: boolean }>(
    await request(ctx, `/api/projects/${w.projectId}/workspaces`, {
      method: 'POST',
      json: { kind: 'long_lived', mode: 'link', path: receiverPath, workerId: w.workerId }
    }),
    '登记接收工作空间'
  );
  assert.equal(receiverWorkspace.isGit, true);
  assert.equal(receiverWorkspace.workerId, w.workerId, '接收克隆必须和来源在同一台 Worker');
  assert.notEqual(receiverWorkspace.path, w.source, '接收克隆必须是独立目录');
  assert.equal(receiverWorkspace.path, receiverPath);
  assert.equal((await git(receiverPath, 'remote', 'get-url', 'origin')).trim(), GITHUB_ORIGIN);
  assert.equal((await git(receiverPath, 'rev-parse', '--abbrev-ref', 'HEAD')).trim(), 'main');
  assert.equal((await git(receiverPath, 'rev-parse', 'HEAD')).trim(), (await bareGit(w.bare, 'rev-parse', 'refs/heads/main')).trim());
  const receiverBefore = await snapshot(receiverPath);

  const receiverTask = await json<{ id: string }>(
    await request(ctx, '/api/tasks', { method: 'POST', json: { projectId: w.projectId, title: `接收任务 ${tag}` } }),
    '建接收任务'
  );
  const senderTask = await json<{ id: string }>(
    await request(ctx, '/api/tasks', { method: 'POST', json: { projectId: w.projectId, title: `发送任务 ${tag}` } }),
    '建发送任务'
  );
  const sender = await json<{ id: string; taskId: string | null; workspaceId: string | null; workerId: string | null }>(
    await request(ctx, '/api/sessions/derive', {
      method: 'POST',
      json: { taskId: senderTask.id, agentId: 'fakeacp', workspaceId: w.workspaceId, workerId: w.workerId }
    }),
    '派生发送会话'
  );
  const receiver = await json<{ id: string; taskId: string | null; workspaceId: string | null; workerId: string | null }>(
    await request(ctx, '/api/sessions/derive', {
      method: 'POST',
      json: { taskId: receiverTask.id, agentId: 'fakeacp', workspaceId: receiverWorkspace.id, workerId: w.workerId }
    }),
    '派生接收会话'
  );
  assert.equal(sender.workspaceId, w.workspaceId);
  assert.equal(receiver.workspaceId, receiverWorkspace.id);
  assert.equal(receiver.workerId, w.workerId);
  const registered = await json<{ coordinators: { sessionId: string }[] }>(
    await request(ctx, `/api/coordinators?projectId=${w.projectId}`),
    '列主会话（阶段 2）'
  );
  assert.equal(registered.coordinators.some((entry) => entry.sessionId === receiver.id), false, '接收方必须是普通任务会话，不是登记主会话');

  // ── 来源派工：在记录的 delegated 分支上做一条未推送提交（候选） ──
  const delegationResponse = await request(ctx, `/api/coordinators/${w.coordinatorSessionId}/delegations`, {
    method: 'POST',
    json: {
      requestKey: `phase2-source-${tag}`,
      taskId: senderTask.id,
      repoId: w.repoId,
      baseBranch: 'main',
      instructions: 'phase2 candidate',
      agentId: 'fakeacp',
      model: ''
    }
  });
  const delegated = await json<{ delegation: DelegationView }>(delegationResponse, '阶段 2 来源派工');
  const source = delegated.delegation;
  assert.equal(source.state, 'prepared');
  assert.ok(source.worktreePath && source.branch && source.executionSessionId);
  assert.notEqual(source.worktreePath, receiverPath, '来源/接收必须是同一 Worker 上的两个独立 clone');
  assert.equal(receiverPath.startsWith(`${source.worktreePath!}/`), false);
  assert.equal((await git(source.worktreePath!, 'rev-parse', '--abbrev-ref', 'HEAD')).trim(), source.branch);
  await writeFile(join(source.worktreePath!, 'candidate.txt'), 'phase2_candidate\n');
  await git(source.worktreePath!, 'add', 'candidate.txt');
  await git(source.worktreePath!, 'commit', '-qm', 'feat: phase2 candidate');
  const candidateSha = (await git(source.worktreePath!, 'rev-parse', 'HEAD')).trim();
  assert.match(candidateSha, /^[0-9a-f]{40}$/);
  assert.equal((await git(source.worktreePath!, 'rev-parse', `refs/heads/${source.branch}`)).trim(), candidateSha, '候选提交必须在记录的分支上');
  assert.equal((await branchesOf(w.bare)).includes(String(source.branch)), false, '候选提交还没推送到远端');
  await assert.rejects(bareGit(w.bare, 'cat-file', '-e', candidateSha), '候选提交不应出现在 bare 仓库');

  // ── 未授权的接收会话先调用一次：工具清单里不应有候选导入，调用失败且无副作用 ──
  await must(
    await request(ctx, `/api/sessions/${receiver.id}/prompt`, {
      method: 'POST',
      json: { text: `please-project-import key=phase2-denied-${tag} source=${source.executionSessionId} target=${receiver.id} repo=${w.repoId} sha=${candidateSha}` }
    }),
    '未授权候选导入 prompt'
  );
  await waitTurns(ctx, receiver.id, 1);
  const deniedObservation = await waitObservation(ctx, receiver.id, 'candidate.import', 1);
  assert.equal(deniedObservation.isError, true, `未授权导入应失败；实际：${deniedObservation.text}`);
  assert.equal(deniedObservation.names.includes('project_candidate_import'), false, '未授权会话的 MCP 工具清单不应出现候选导入');
  assert.equal(await git(receiverPath, 'for-each-ref', '--format=%(refname)', 'refs/agent-hub/imports'), '', '未授权调用不应写导入 ref');
  assert.deepEqual(await snapshot(receiverPath), receiverBefore, '未授权调用不应改变接收仓库');

  // ── 发送方独立授权 message:send；第二次 PUT 改范围会作废旧 bearer，下一次投递重新托管 ──
  const senderFirst = await json<{ grant: { scopes: string[] } }>(
    await request(ctx, `/api/sessions/${sender.id}/project-tool-grant`, {
      method: 'PUT', json: { scopes: ['message:send'] }
    }),
    '发送方项目授权'
  );
  assert.deepEqual([...senderFirst.grant.scopes].sort(), ['message:send']);
  const senderSecond = await json<{ grant: { scopes: string[] } }>(
    await request(ctx, `/api/sessions/${sender.id}/project-tool-grant`, {
      method: 'PUT', json: { scopes: ['message:send', 'project:read'] }
    }),
    '发送方扩大项目授权'
  );
  assert.deepEqual([...senderSecond.grant.scopes].sort(), ['message:send', 'project:read']);

  const receiverTurnsBeforeHandoff = await turnCount(ctx, receiver.id);
  const handoffKey = `phase2-handoff-${tag}`;
  await must(
    await request(ctx, `/api/sessions/${sender.id}/prompt`, {
      method: 'POST',
      json: {
        text: `please-project-handoff key=${handoffKey} target=${receiver.id} body=handoff_body_v1 candidate_source=${source.executionSessionId} candidate_repo=${w.repoId} candidate_sha=${candidateSha}`
      }
    }),
    '项目交接 prompt'
  );
  await waitTurns(ctx, sender.id, 1);
  const handoffObservation = await waitObservation(ctx, sender.id, 'handoff', 1);
  assert.ok(handoffObservation.names.includes('project_session_handoff'), `工具清单应含 project_session_handoff；实际：${handoffObservation.names.join(',')}`);
  const handoff = observationValue<{ messageId: string; targetSessionId: string; status: string; wake: boolean }>(handoffObservation);
  assert.equal(handoff.targetSessionId, receiver.id);
  assert.equal(handoff.status, 'done', 'wake=false 的交接应直接落在收件箱（done），不排队唤醒');
  assert.equal(handoff.wake, false, '默认不应唤醒');
  assert.ok(handoff.messageId);

  // 接收方收件箱里能看到这条交接；带的是候选提示 part，但没有任何导入 ref。
  const inbox = await json<{ messages: MessageView[] }>(
    await request(ctx, `/api/sessions/${receiver.id}/messages`),
    '接收方收件箱'
  );
  const message = inbox.messages.find((entry) => entry.body === 'handoff_body_v1');
  assert.ok(message, `接收方收件箱应有交接消息；实际：${JSON.stringify(inbox.messages.map((m) => m.body))}`);
  assert.equal(message.from, `session:${sender.id}`);
  assert.equal(message.targetSessionId, receiver.id);
  assert.equal(message.wake, false, '消息行必须记录 wake=false');
  assert.equal(message.status, 'done');
  const parts = Array.isArray(message.parts) ? message.parts as { type?: string; schema?: string; data?: Record<string, unknown> }[] : [];
  const notice = parts.find((part) => part.schema === 'project-candidate/v1');
  assert.ok(notice, `交接消息应带 project-candidate/v1 提示；实际：${JSON.stringify(message.parts)}`);
  assert.equal(notice.data?.sha, candidateSha);
  assert.equal(notice.data?.sourceSessionId, source.executionSessionId);
  assert.equal(notice.data?.repoId, w.repoId);
  assert.equal(notice.data?.projectId, w.projectId);
  assert.equal(typeof notice.data?.notice, 'string');
  const handoffManifest = await json<{
    state: string;
    handoffs: { messageId: string; transport: string; body: string; candidate: { repoId: string; sha: string } }[];
  }>(await request(ctx, `/api/workspace-delegations/${source.id}/handoff`), '读取派工交接清单');
  assert.equal(handoffManifest.state, 'recorded');
  assert.deepEqual(handoffManifest.handoffs.map(({ messageId, transport, body, candidate }) => ({ messageId, transport, body, candidate })), [{
    messageId: handoff.messageId,
    transport: 'inbox',
    body: 'handoff_body_v1',
    candidate: { repoId: w.repoId, sha: candidateSha }
  }]);
  assert.equal(await turnCount(ctx, receiver.id), receiverTurnsBeforeHandoff, 'wake=false 的交接不应唤醒接收会话');
  assert.equal(await git(receiverPath, 'for-each-ref', '--format=%(refname)', 'refs/agent-hub/imports'), '', '候选通知本身绝不能触发导入');
  assert.deepEqual(await snapshot(receiverPath), receiverBefore, '候选通知本身不应改变接收仓库');

  // ── 接收方独立授权 candidate:import（与发送方授权完全分开） ──
  const receiverFirst = await json<{ grant: { scopes: string[] } }>(
    await request(ctx, `/api/sessions/${receiver.id}/project-tool-grant`, {
      method: 'PUT', json: { scopes: ['candidate:import'] }
    }),
    '接收方候选导入授权'
  );
  assert.deepEqual([...receiverFirst.grant.scopes].sort(), ['candidate:import']);
  const receiverSecond = await json<{ grant: { scopes: string[] } }>(
    await request(ctx, `/api/sessions/${receiver.id}/project-tool-grant`, {
      method: 'PUT', json: { scopes: ['candidate:import', 'project:read'] }
    }),
    '接收方扩大候选导入授权'
  );
  assert.deepEqual([...receiverSecond.grant.scopes].sort(), ['candidate:import', 'project:read']);
  const senderGrant = await json<{ grant: { scopes: string[] } | null }>(
    await request(ctx, `/api/sessions/${sender.id}/project-tool-grant`),
    '发送方授权（导入前）'
  );
  assert.equal(senderGrant.grant?.scopes.includes('candidate:import'), false, '发送方不应因为交接而获得导入授权');

  const importKey = `phase2-import-${tag}`;
  await must(
    await request(ctx, `/api/sessions/${receiver.id}/prompt`, {
      method: 'POST',
      json: { text: `please-project-import key=${importKey} source=${source.executionSessionId} target=${receiver.id} repo=${w.repoId} sha=${candidateSha}` }
    }),
    '候选导入 prompt'
  );
  await waitTurns(ctx, receiver.id, 2);
  const importObservation = await waitObservation(ctx, receiver.id, 'candidate.import', 2);
  assert.ok(importObservation.names.includes('project_candidate_import'), `接收方工具清单应含 project_candidate_import；实际：${importObservation.names.join(',')}`);
  const imported = observationValue<{ ref: string; sha: string; alreadyPresent: boolean; targetSessionId: string }>(importObservation);
  const expectedRef = `refs/agent-hub/imports/${receiver.id}/${candidateSha}`;
  assert.deepEqual(imported, { ref: expectedRef, sha: candidateSha, alreadyPresent: false, targetSessionId: receiver.id });
  assert.equal((await git(receiverPath, 'rev-parse', '--verify', expectedRef)).trim(), candidateSha, '专用 ref 必须精确指向候选 SHA');
  assert.equal((await git(receiverPath, 'cat-file', '-t', candidateSha)).trim(), 'commit', '专用 ref 指向的必须是真实提交');
  assert.equal((await git(receiverPath, 'for-each-ref', '--format=%(refname)', 'refs/agent-hub/imports')).trim(), expectedRef, '只应有一个导入 ref');

  // 接收方 HEAD / 分支 / 工作区完全不变；候选只进专用 ref，不 checkout、不建本地分支、不碰 bare。
  assert.deepEqual(await snapshot(receiverPath), receiverBefore, '导入后接收仓库的 HEAD / 分支 / 工作区应保持不变');
  assert.equal(existsSync(join(receiverPath, 'candidate.txt')), false, '导入不应把候选文件 checkout 到工作区');
  assert.equal((await git(receiverPath, 'rev-parse', '--abbrev-ref', 'HEAD')).trim(), 'main');
  await assert.rejects(
    git(receiverPath, 'rev-parse', '--verify', `refs/heads/${source.branch}`),
    '不应创建候选分支'
  );
  assert.deepEqual(await branchesOf(w.bare), bareBranchesBefore, '导入不应推送 bare 分支');
  await assert.rejects(bareGit(w.bare, 'cat-file', '-e', candidateSha), '导入不应把候选提交推到 bare');

  // ── 同 key 同参数重放：相同响应，不新增 ref / 分支 / 工作区副作用 ──
  await must(
    await request(ctx, `/api/sessions/${receiver.id}/prompt`, {
      method: 'POST',
      json: { text: `please-project-import key=${importKey} source=${source.executionSessionId} target=${receiver.id} repo=${w.repoId} sha=${candidateSha}` }
    }),
    '候选导入重放 prompt'
  );
  await waitTurns(ctx, receiver.id, 3);
  const replayObservation = await waitObservation(ctx, receiver.id, 'candidate.import', 3);
  const replayed = observationValue<typeof imported>(replayObservation);
  assert.deepEqual(replayed, imported, '同 key 重放应返回第一次的回执快照');
  assert.equal((await git(receiverPath, 'for-each-ref', '--format=%(refname)', 'refs/agent-hub/imports')).trim(), expectedRef, '重放不应新增导入 ref');
  assert.deepEqual(await snapshot(receiverPath), receiverBefore, '重放不应改变接收仓库');
  assert.deepEqual(await branchesOf(w.bare), bareBranchesBefore, '重放不应推送 bare 分支');

  // ── 负例 1：目标会话必须等于接收绑定，不能借发送会话的名义导入 ──
  await must(
    await request(ctx, `/api/sessions/${receiver.id}/prompt`, {
      method: 'POST',
      json: { text: `please-project-import key=phase2-wrong-target-${tag} source=${source.executionSessionId} target=${sender.id} repo=${w.repoId} sha=${candidateSha}` }
    }),
    '错误目标会话 prompt'
  );
  await waitTurns(ctx, receiver.id, 4);
  const wrongTarget = await waitObservation(ctx, receiver.id, 'candidate.import', 4);
  assert.equal(wrongTarget.isError, true, `目标会话不匹配应失败；实际：${wrongTarget.text}`);
  assert.match(wrongTarget.text, /目标会话与当前绑定会话不一致/, `错误应指出绑定会话不一致；实际：${wrongTarget.text}`);

  // ── 负例 2：SHA 必须是完整 40 位小写，不接受缩写或大写 ──
  const upperSha = candidateSha.toUpperCase() === candidateSha ? `${candidateSha.slice(0, 39)}A` : candidateSha.toUpperCase();
  for (const [label, badSha] of [
    ['短 SHA', candidateSha.slice(0, 39)],
    ['大写 SHA', upperSha]
  ] as const) {
    await must(
      await request(ctx, `/api/sessions/${receiver.id}/prompt`, {
        method: 'POST',
        json: { text: `please-project-import key=phase2-bad-sha-${label === '短 SHA' ? 'short' : 'upper'}-${tag} source=${source.executionSessionId} target=${receiver.id} repo=${w.repoId} sha=${badSha}` }
      }),
      `${label} prompt`
    );
    await waitTurns(ctx, receiver.id, label === '短 SHA' ? 5 : 6);
    const bad = await waitObservation(ctx, receiver.id, 'candidate.import', label === '短 SHA' ? 5 : 6);
    assert.equal(bad.isError, true, `${label} 应被拒；实际：${bad.text}`);
    assert.match(bad.text, /40 位小写|小写提交号|sha/i, `错误应指出完整小写 SHA；实际：${bad.text}`);
  }

  // 所有负例都不留下新 ref / 分支 / 工作区改动；源仓库也一直没被碰。
  assert.equal((await git(receiverPath, 'for-each-ref', '--format=%(refname)', 'refs/agent-hub/imports')).trim(), expectedRef, '负例不应新增导入 ref');
  assert.deepEqual(await snapshot(receiverPath), receiverBefore, '负例不应改变接收仓库');
  assert.deepEqual(await snapshot(w.source), sourceBefore, '阶段 2 也不应改变源仓库');
  assert.deepEqual(await branchesOf(w.bare), bareBranchesBefore, '阶段 2 不应推送 bare 分支');
});

interface AssetListEntry {
  assetId: string;
  kind: string;
  name: string;
  scope: string;
  sourceType: string;
  enabled: boolean;
  overridden: boolean;
  shadowedBy: string | null;
  published: boolean;
}

interface AssetWriteSnapshot {
  assetId: string;
  kind: string;
  name: string;
  scope: string;
  digest: string;
  published: boolean;
  submissionId: string;
  submissionStatus: string;
}

interface ReadSnapshot {
  asset: {
    assetId: string;
    kind: string;
    name: string;
    scope: string;
    digest: string;
    files: { path: string; sha256: string; size: number }[];
    file: null | { path: string; content: string; size: number };
  };
}

interface EnvironmentView {
  revision: number;
  appliedRevision: number;
  pending: boolean;
  supported: boolean;
}

test('项目会话 MCP 阶段 3：独立 project:read / asset:write 授权 → 项目资产提交待审 → 审批后可见可读 → 重放/改版/开关 → 不重配运行会话', { timeout: 300_000 }, async () => {
  const w = await world();
  const { ctx } = w;
  const tag = Date.now().toString(36);
  const assetName = `phase3-asset-${tag}`;
  const sourceBefore = await snapshot(w.source);

  const task = await json<{ id: string }>(
    await request(ctx, '/api/tasks', { method: 'POST', json: { projectId: w.projectId, title: `资产任务 ${tag}` } }),
    '建资产任务'
  );
  const session = await json<{ id: string; taskId: string | null; workspaceId: string | null; workerId: string | null }>(
    await request(ctx, '/api/sessions/derive', {
      method: 'POST',
      json: { taskId: task.id, agentId: 'fakeacp', workspaceId: w.workspaceId, workerId: w.workerId }
    }),
    '派生资产会话'
  );
  assert.equal(session.workspaceId, w.workspaceId);
  const registered = await json<{ coordinators: { sessionId: string }[] }>(
    await request(ctx, `/api/coordinators?projectId=${w.projectId}`),
    '列主会话（阶段 3）'
  );
  assert.equal(registered.coordinators.some((entry) => entry.sessionId === session.id), false, '资产会话必须是普通任务会话');

  const grant = async (scopes: string[], where: string): Promise<void> => {
    const body = await json<{ grant: { scopes: string[] } }>(
      await request(ctx, `/api/sessions/${session.id}/project-tool-grant`, { method: 'PUT', json: { scopes } }),
      where
    );
    assert.deepEqual([...body.grant.scopes].sort(), [...scopes].sort(), `${where} 应原样返回授权范围`);
  };
  const environment = async (where: string): Promise<EnvironmentView> =>
    json<EnvironmentView>(await request(ctx, `/api/sessions/${session.id}/environment`), where);
  const prompt = async (text: string, turns: number, where: string): Promise<void> => {
    await must(
      await request(ctx, `/api/sessions/${session.id}/prompt`, { method: 'POST', json: { text } }),
      where
    );
    await waitTurns(ctx, session.id, turns);
  };
  const approve = async (submissionId: string, where: string): Promise<{ published: boolean; selfApproved: boolean }> =>
    json<{ published: boolean; selfApproved: boolean }>(
      await request(ctx, `/api/assets/reviews/${submissionId}/approve`, { method: 'POST', json: { acknowledgeHigh: true } }),
      where
    );

  // ── 只读授权：list/read 可用，写工具不出现；写调用被拒且不留任何资产 ──
  // 第一次 PUT 之后的 DELETE 才作废 derive 时发出的默认 bearer；随后再授权只读，
  // 保证下一条 prompt 会重新托管，而不是继续用旧 token 的默认工具清单。
  await grant(['project:read'], '阶段 3 只读授权（占位）');
  const revoked = await json<{ grant: null }>(
    await request(ctx, `/api/sessions/${session.id}/project-tool-grant`, { method: 'DELETE' }),
    '作废旧工具令牌（阶段 3）'
  );
  assert.equal(revoked.grant, null);
  await grant(['project:read'], '阶段 3 只读授权');

  await prompt('please-project-asset-list include_disabled=true', 1, '只读 list prompt');
  const readOnlyList = await waitObservation(ctx, session.id, 'asset.list', 1);
  assert.ok(readOnlyList.names.includes('project_asset_list'), `只读工具清单应含 list；实际：${readOnlyList.names.join(',')}`);
  assert.ok(readOnlyList.names.includes('project_asset_read'), `只读工具清单应含 read；实际：${readOnlyList.names.join(',')}`);
  for (const writeTool of ['project_asset_create', 'project_asset_revise', 'project_asset_set_enabled']) {
    assert.equal(readOnlyList.names.includes(writeTool), false, `只读清单不应出现 ${writeTool}`);
  }

  await prompt(`please-project-asset-create key=phase3-denied-${tag} kind=skill name=${assetName} body=version_one`, 2, '只读 create prompt');
  const deniedCreate = await waitObservation(ctx, session.id, 'asset.create', 1);
  assert.equal(deniedCreate.isError, true, `只读授权下 create 应失败；实际：${deniedCreate.text}`);
  const mineBefore = await json<{ asset: { id: string; name: string } }[]>(await request(ctx, '/api/assets/mine'), '我的资产（提交前）');
  assert.equal(mineBefore.some((entry) => entry.asset.name === assetName), false, '被拒的 create 不应创建资产');

  // ── 只写授权：create 可用，list/read 不可用；提交只停在待审，不自动发布 ──
  await grant(['asset:write'], '阶段 3 只写授权');
  const createKey = `phase3-create-${tag}`;
  await prompt(`please-project-asset-create key=${createKey} kind=skill name=${assetName} body=version_one replay=true`, 3, '写 create prompt');
  const createFirst = await waitObservation(ctx, session.id, 'asset.create', 2);
  const createSecond = await waitObservation(ctx, session.id, 'asset.create', 3);
  assert.ok(createFirst.names.includes('project_asset_create'), `写工具清单应含 create；实际：${createFirst.names.join(',')}`);
  assert.ok(createFirst.names.includes('project_asset_revise'), `写工具清单应含 revise；实际：${createFirst.names.join(',')}`);
  assert.ok(createFirst.names.includes('project_asset_set_enabled'), `写工具清单应含 set_enabled；实际：${createFirst.names.join(',')}`);
  assert.equal(createFirst.names.includes('project_asset_list'), false, '只写清单不应出现 list');
  assert.equal(createFirst.names.includes('project_asset_read'), false, '只写清单不应出现 read');
  const created = observationValue<{ asset: AssetWriteSnapshot }>(createFirst).asset;
  const createdReplay = observationValue<{ asset: AssetWriteSnapshot }>(createSecond).asset;
  assert.deepEqual(createdReplay, created, '同 request_key 的 create 重放应返回同一份快照');
  assert.equal(created.assetId.length > 0, true);
  assert.equal(created.kind, 'skill');
  assert.equal(created.name, assetName);
  assert.equal(created.scope, 'project');
  assert.equal(created.published, false, 'create 绝不能直接发布');
  assert.match(created.digest, /^[0-9a-f]{64}$/);
  assert.ok(created.submissionId);
  assert.equal(created.submissionStatus, 'pending');

  const minePending = await json<{ asset: { id: string; name: string }; published: boolean; latestSubmission: { id: string; status: string } | null }[]>(
    await request(ctx, '/api/assets/mine'),
    '我的资产（待审）'
  );
  const pendingEntry = minePending.find((entry) => entry.asset.name === assetName);
  assert.ok(pendingEntry, '创建后应能在「我的资产」看到待审项');
  assert.equal(pendingEntry.asset.id, created.assetId);
  assert.equal(pendingEntry.published, false);
  assert.equal(pendingEntry.latestSubmission?.id, created.submissionId);
  assert.equal(pendingEntry.latestSubmission?.status, 'pending');

  const catalogPending = await json<unknown[]>(await request(ctx, '/api/assets/catalog'), '目录（待审前）');
  assert.equal(JSON.stringify(catalogPending).includes(created.assetId), false, '待审资产不应出现在公开目录');

  // ── 读写授权：待审仍不可见；通过既有审核策略用户审批后才进入项目清单 ──
  await grant(['project:read', 'asset:write'], '阶段 3 读写授权');
  await prompt('please-project-asset-list', 4, '待审后 list prompt');
  const listPending = observationValue<{ assets: AssetListEntry[]; truncated: boolean }>(
    await waitObservation(ctx, session.id, 'asset.list', 2)
  );
  assert.equal(listPending.assets.some((entry) => entry.assetId === created.assetId), false, '待审资产不应出现在项目资产清单');
  assert.equal(typeof listPending.truncated, 'boolean');

  // 这一轮已经用上完整授权并重新托管；之后只调资产工具，不应再改运行环境。
  const envBefore = await environment('资产调用前环境');
  assert.equal(envBefore.supported, true);

  await prompt(`please-project-asset-read asset=${created.assetId}`, 5, '待审 read prompt');
  const readPending = await waitObservation(ctx, session.id, 'asset.read', 1);
  assert.equal(readPending.isError, true, `待审版本不应可读；实际：${readPending.text}`);
  assert.equal(readPending.names.includes('project_asset_read'), true, '读写清单应含 read');

  const approvedFirst = await approve(created.submissionId, '审批首个版本');
  assert.equal(approvedFirst.published, true, '既有策略用户应能通过项目资产提交');

  await prompt('please-project-asset-list', 6, '审批后 list prompt');
  const listPublished = observationValue<{ assets: AssetListEntry[]; truncated: boolean }>(
    await waitObservation(ctx, session.id, 'asset.list', 3)
  );
  const publishedEntry = listPublished.assets.find((entry) => entry.assetId === created.assetId);
  assert.ok(publishedEntry, '审批通过后项目清单应能看到资产');
  assert.equal(publishedEntry.kind, 'skill');
  assert.equal(publishedEntry.name, assetName);
  assert.equal(publishedEntry.scope, 'project');
  assert.equal(publishedEntry.sourceType, 'upload');
  assert.equal(publishedEntry.published, true);
  assert.equal(publishedEntry.enabled, true);
  assert.equal(publishedEntry.overridden, false);
  assert.equal(publishedEntry.shadowedBy, null);

  await prompt(`please-project-asset-read asset=${created.assetId}`, 7, '读清单 prompt');
  const manifest = observationValue<ReadSnapshot>(await waitObservation(ctx, session.id, 'asset.read', 2)).asset;
  assert.equal(manifest.assetId, created.assetId);
  assert.equal(manifest.digest, created.digest);
  assert.equal(manifest.name, assetName);
  assert.equal(manifest.file, null);
  assert.equal(manifest.files.length, 1);
  assert.equal(manifest.files[0]!.path, 'SKILL.md');
  assert.match(manifest.files[0]!.sha256, /^[0-9a-f]{64}$/);
  assert.ok(manifest.files[0]!.size > 0);

  await prompt(`please-project-asset-read asset=${created.assetId} path=SKILL.md`, 8, '读文件 prompt');
  const fileOne = observationValue<ReadSnapshot>(await waitObservation(ctx, session.id, 'asset.read', 3)).asset;
  assert.equal(fileOne.digest, created.digest);
  assert.ok(fileOne.file);
  assert.equal(fileOne.file.path, 'SKILL.md');
  assert.match(fileOne.file.content, /version_one/);
  assert.equal(fileOne.file.size, Buffer.byteLength(fileOne.file.content));

  // ── 改版：同 key 重放不产生第二份待审；未审批前仍读旧版本，审批后才切到新版本 ──
  const reviseKey = `phase3-revise-${tag}`;
  await prompt(`please-project-asset-revise key=${reviseKey} asset=${created.assetId} name=${assetName} body=version_two replay=true`, 9, '改版 prompt');
  const reviseFirst = await waitObservation(ctx, session.id, 'asset.revise', 1);
  const reviseSecond = await waitObservation(ctx, session.id, 'asset.revise', 2);
  const revised = observationValue<{ asset: AssetWriteSnapshot }>(reviseFirst).asset;
  const revisedReplay = observationValue<{ asset: AssetWriteSnapshot }>(reviseSecond).asset;
  assert.deepEqual(revisedReplay, revised, '同 request_key 的 revise 重放应返回同一份快照');
  assert.equal(revised.assetId, created.assetId);
  assert.equal(revised.scope, 'project');
  assert.equal(revised.published, false, '改版在审批前不能发布');
  assert.equal(revised.submissionStatus, 'pending');
  assert.notEqual(revised.digest, created.digest);
  assert.notEqual(revised.submissionId, created.submissionId);

  await prompt('please-project-asset-list', 10, '改版待审 list prompt');
  const listWhileRevisionPending = observationValue<{ assets: AssetListEntry[]; truncated: boolean }>(
    await waitObservation(ctx, session.id, 'asset.list', 4)
  );
  const stillPinned = listWhileRevisionPending.assets.find((entry) => entry.assetId === created.assetId);
  assert.ok(stillPinned, '改版待审时已发布版本仍应可见');
  assert.equal(stillPinned.published, true);

  await prompt(`please-project-asset-read asset=${created.assetId} path=SKILL.md`, 11, '改版待审读文件 prompt');
  const fileStillOne = observationValue<ReadSnapshot>(await waitObservation(ctx, session.id, 'asset.read', 4)).asset;
  assert.equal(fileStillOne.digest, created.digest, '未审批的改版不应改变可读版本');
  assert.match(fileStillOne.file!.content, /version_one/);

  const approvedRevision = await approve(revised.submissionId, '审批改版');
  assert.equal(approvedRevision.published, true);

  await prompt(`please-project-asset-read asset=${created.assetId} path=SKILL.md`, 12, '改版审批后读文件 prompt');
  const fileTwo = observationValue<ReadSnapshot>(await waitObservation(ctx, session.id, 'asset.read', 5)).asset;
  assert.equal(fileTwo.digest, revised.digest);
  assert.match(fileTwo.file!.content, /version_two/);

  // ── 开关：同 key 重放幂等；关闭后默认清单不出现，include_disabled 才出现；再打开 ──
  const disableKey = `phase3-disable-${tag}`;
  await prompt(`please-project-asset-enable key=${disableKey} asset=${created.assetId} enabled=false replay=true`, 13, '关闭资产 prompt');
  const disableFirst = await waitObservation(ctx, session.id, 'asset.set_enabled', 1);
  const disableSecond = await waitObservation(ctx, session.id, 'asset.set_enabled', 2);
  const disabled = observationValue<{ projectAsset: { assetId: string; enabled: boolean; overridden: boolean } }>(disableFirst).projectAsset;
  const disabledReplay = observationValue<{ projectAsset: { assetId: string; enabled: boolean; overridden: boolean } }>(disableSecond).projectAsset;
  assert.deepEqual(replaySafe(disabledReplay), replaySafe(disabled), '同 request_key 的 set_enabled 重放应返回同一份快照');
  assert.deepEqual(disabled, { assetId: created.assetId, enabled: false, overridden: true });

  await prompt('please-project-asset-list', 14, '关闭后默认 list prompt');
  const listDisabled = observationValue<{ assets: AssetListEntry[]; truncated: boolean }>(
    await waitObservation(ctx, session.id, 'asset.list', 5)
  );
  assert.equal(listDisabled.assets.some((entry) => entry.assetId === created.assetId), false, '默认清单不应包含已关闭资产');

  await prompt('please-project-asset-list include_disabled=true', 15, '关闭后 include_disabled list prompt');
  const listIncludeDisabled = observationValue<{ assets: AssetListEntry[]; truncated: boolean }>(
    await waitObservation(ctx, session.id, 'asset.list', 6)
  );
  const disabledEntry = listIncludeDisabled.assets.find((entry) => entry.assetId === created.assetId);
  assert.ok(disabledEntry, 'include_disabled=true 应能看到已关闭资产');
  assert.equal(disabledEntry.enabled, false);
  assert.equal(disabledEntry.overridden, true);

  const enableKey = `phase3-enable-${tag}`;
  await prompt(`please-project-asset-enable key=${enableKey} asset=${created.assetId} enabled=true`, 16, '重新打开资产 prompt');
  const enabled = observationValue<{ projectAsset: { assetId: string; enabled: boolean; overridden: boolean } }>(
    await waitObservation(ctx, session.id, 'asset.set_enabled', 3)
  ).projectAsset;
  assert.deepEqual(enabled, { assetId: created.assetId, enabled: true, overridden: true });

  // 资产工具调用（含 create/revise/set_enabled）不得隐式重配正在运行的会话：
  // 授权变更导致的 rehost 已经发生，这里比较的是同一份运行环境的 appliedRevision。
  const envAfter = await environment('资产调用后环境');
  assert.equal(envAfter.supported, true);
  assert.equal(envAfter.appliedRevision, envBefore.appliedRevision, '资产工具调用不应重新配置运行会话');

  const mineFinal = await json<{ asset: { id: string; name: string }; latestSubmission: { id: string; status: string } | null }[]>(
    await request(ctx, '/api/assets/mine'),
    '我的资产（最终）'
  );
  const finalEntry = mineFinal.find((entry) => entry.asset.name === assetName);
  assert.ok(finalEntry);
  assert.equal(finalEntry.latestSubmission?.status, 'approved', '最后一次改版应已通过');

  assert.deepEqual(await snapshot(w.source), sourceBefore, '项目资产工具链不应改变源仓库');
});

/** 只比较 set_enabled 的业务字段，避免把未来的附加审计字段误判成不稳定输出。 */
function replaySafe(value: { assetId: string; enabled: boolean; overridden: boolean }) {
  return { assetId: value.assetId, enabled: value.enabled, overridden: value.overridden };
}
