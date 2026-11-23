import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { addTeamMember, fakeAssetSets, fakeSessionLinks, inMemoryAccounts, inMemoryApiTokens, inMemoryAssetReview, inMemoryAssets, inMemoryDeps, type FakeGit } from '@agent-hub/domain/testing';
import {
  asAgentId,
  asSessionId,
  BUILTIN_CHROMIUM,
  createAccessPolicy,
  createMessageBus,
  createTask,
  defaultHandle,
  deriveSession,
  newWorkspace,
  permissionsOf,
  uploadAsset,
  createWorkspaceFilesService,
  notFound,
  type AgentDescriptor,
  type AgentMessage,
  type AssetReviewDeps,
  type CatalogComponent,
  type ComponentDeps,
  type MessageStore,
  type WorkerComponentPin,
  type WorkerStatus,
  type WorkspaceBrowser
} from '@agent-hub/domain';
import { projectSchema, sessionSchema, taskSchema } from '@agent-hub/contract';
import { createApp } from './http.ts';
import { createStreamHub } from './stream-hub.ts';
import { buildSpecApp, openApiInfo } from './openapi/app.ts';
import { clientRequestIdSchema, mcpTools, mcpToolsFor, projectEvents } from './openapi/mcp.ts';
import { sessionWithHandleSchema } from './openapi/routes/schemas.ts';
import { workbenchSkillManifest, workbenchSkillZip } from './workbench-skill.ts';
import { createRepoAuth } from './repo-auth.ts';

const PASSWORD = 'long enough pw';
const fake: AgentDescriptor = {
  id: asAgentId('fake'),
  label: 'Fake',
  capabilities: Object.fromEntries(
    ['prompt', 'interrupt', 'fork', 'resume', 'tool_calls', 'artifacts', 'structured_events', 'attachments'].map((key) => [key, { state: 'available' }])
  ) as AgentDescriptor['capabilities'],
  models: ['m1'],
  defaultModel: 'm1',
  options: []
};


function memoryAgentDefaults() {
  const rows = new Map<string, Record<string, string>>();
  return {
    async forTeam(teamId: string) {
      return rows.get(teamId) ?? {};
    },
    async save(teamId: string, defaults: Record<string, string>) {
      rows.set(teamId, defaults);
    }
  };
}

/** 消息总线的内存 MessageStore（和 domain messaging.test.ts 里的同一份实现）。 */
function memoryMessages(): MessageStore & { all: Map<string, AgentMessage> } {
  const all = new Map<string, AgentMessage>();
  const handles = new Map<string, string>();
  const list = () => [...all.values()].sort((a, b) => a.createdAt - b.createdAt);
  return {
    all,
    save: async (m) => void all.set(m.id, m),
    byId: async (id) => all.get(id) ?? null,
    byIdempotencyKey: async (from, key) => list().find((m) => m.fromSessionId === from && m.idempotencyKey === key) ?? null,
    queuedFor: async (s) => list().filter((m) => m.targetSessionId === s && m.status === 'queued'),
    deliveredTo: async (s) => list().filter((m) => m.targetSessionId === s && m.status === 'delivered'),
    byTrace: async (t) => list().filter((m) => m.traceId === t),
    forSession: async (s, limit) => list().filter((m) => m.fromSessionId === s || m.targetSessionId === s).reverse().slice(0, limit),
    byCandidateSource: async () => [],
    awaitingApproval: async (p) => list().filter((m) => m.projectId === p && m.status === 'awaiting_approval'),
    overdue: async (now) => list().filter((m) => m.kind === 'ask' && (m.status === 'queued' || m.status === 'delivered') && m.deadlineAt !== null && m.deadlineAt <= now),
    config: async () => null,
    saveConfig: async () => undefined,
    saveSpawn: async () => undefined,
    spawnOf: async () => null,
    spawnsForRole: async () => [],
    pendingTargets: async () => [],
    setHandle: async (record) => {
      handles.set(record.sessionId, record.handle);
      return true;
    },
    handleOf: async (sessionId) => handles.get(sessionId) ?? null,
    toAddress: async (address, after, limit) => list().filter((m) => m.to === address && m.createdAt > after).slice(0, limit),
    sessionByHandle: async (_taskId, handle) => ([...handles].find(([, value]) => value === handle)?.[0] ?? null) as ReturnType<typeof asSessionId> | null,
    audit: async () => undefined,
    auditByTrace: async () => []
  };
}

/** workspace_diff / workspace_read_file 用的假浏览器：文件都登记在 files 里，read 按 maxBytes 切。 */
function fakeFilesBrowser(state: { calls: string[]; files: Record<string, { bytes: Uint8Array; binary?: boolean }> }): WorkspaceBrowser {
  return {
    list: async (root, path, options) => {
      state.calls.push(`list:${root}:${path}`);
      const all = Object.entries(state.files).map(([p, file], index) => ({
        name: p.split('/').pop()!,
        path: p,
        type: 'file' as const,
        size: file.bytes.length,
        modifiedAt: 1000 + index,
        ignored: false,
        sensitive: /^\.env/.test(p.split('/').pop()!),
        git: null
      }));
      const limit = options?.limit ?? all.length;
      return { ok: true, value: { path, entries: all.slice(0, limit), truncated: all.length > limit, isGit: true } };
    },
    read: async (_root, path, maxBytes) => {
      state.calls.push(`read:${path}:${maxBytes ?? 'all'}`);
      const file = state.files[path];
      if (!file) return { ok: false, error: notFound(`文件不存在：${path}`) };
      const cut = Math.min(maxBytes ?? file.bytes.length, file.bytes.length);
      return {
        ok: true,
        value: {
          path,
          size: file.bytes.length,
          modifiedAt: 1234,
          binary: file.binary ?? false,
          truncated: file.bytes.length > cut,
          bytes: file.bytes.subarray(0, cut)
        }
      };
    },
    find: async () => ({ ok: true, value: [] }),
    changes: async () => ({ ok: true, value: [] }),
    diff: async (_root, path) => ({ ok: true, value: { path, patch: '', truncated: false, binary: false } }),
    checkpoint: async () => ({ ok: true, value: 'c0ffee' }),
    dropRefs: async () => ({ ok: true, value: 0 }),
    restore: async () => ({ ok: true, value: { safety: 'safe' as const, restored: 0, removed: 0 } }),
    head: async () => ({ ok: true, value: 'abc1234' }),
    branchBase: async () => ({ ok: true, value: { branch: 'main', commit: 'abc1234' } }),
    watch: async () => ({ ok: true, value: () => undefined })
  };
}

function harness(rate?: { general?: number; prompt?: number; streams?: number }, enrolledBy: Map<string, string> = new Map(), withMessaging = false) {
  const accounts = inMemoryAccounts(() => Date.now());
  const world = inMemoryDeps();
  world.agents.push(fake);
  const access = createAccessPolicy({
    users: accounts.users,
    settings: accounts.settings,
    enrollment: { credentialFor: async (workerId) => (enrolledBy.has(workerId) ? ({ enrolledBy: enrolledBy.get(workerId)! } as never) : null) },
    gateway: world.deps.gateway
  });
  const agentDefaults = memoryAgentDefaults();
  const deps = {
    ...world.deps,
    access,
    agentDefaults,
    links: fakeSessionLinks(),
    repoAuth: createRepoAuth({ projects: world.deps.projects, workspaces: world.deps.workspaces, secrets: world.deps.secrets })
  };
  // peers / messages 这几条开放路由要消息总线在场（#243）：轻量内存实现，不真的拉 agent。
  let messaging: { bus: ReturnType<typeof createMessageBus>; messages: ReturnType<typeof memoryMessages> } | undefined;
  if (withMessaging) {
    const messages = memoryMessages();
    const bus = createMessageBus({
      now: () => Date.now(),
      sessions: world.deps.sessions,
      projects: world.deps.projects,
      workspaces: world.deps.workspaces,
      workspaceGroups: world.deps.workspaceGroups,
      tasks: world.deps.tasks,
      links: deps.links,
      messages,
      bots: world.deps.bots,
      policy: access,
      principalOf: async (id) => {
        const user = await accounts.users.byId(id as never);
        return user ? ({ user, loginId: 'l' } as never) : null;
      },
      deliver: async () => ({ ok: true, value: null } as never),
      spawn: async ({ project, role }) => {
        const task = createTask({ projectId: project.id, title: 'spawned', goal: '', now: Date.now() });
        assert.ok(task.ok);
        await world.deps.tasks.save(task.value);
        const spawned = deriveSession({ task: task.value, agentId: asAgentId('fake'), model: role.ref.model ?? '', now: Date.now() });
        assert.ok(spawned.ok);
        await world.deps.sessions.save(spawned.value);
        return spawned.value as never;
      }
    });
    messaging = { bus, messages };
  }
  const apiTokens = inMemoryApiTokens();
  const tokenDeps = { apiTokens, users: accounts.users, projects: world.deps.projects, tokens: accounts.tokens, audit: accounts.audit, now: () => Date.now() };
  // workspace_diff / workspace_read_file（只读开放工具）：假浏览器 + inMemoryDeps 自带的假 git。
  const filesStore = { calls: [] as string[], files: {} as Record<string, { bytes: Uint8Array; binary?: boolean }> };
  const fileBases = new Map<string, string>();
  const files = createWorkspaceFilesService({
    projects: world.deps.projects,
    tasks: world.deps.tasks,
    sessions: world.deps.sessions,
    workspaces: world.deps.workspaces,
    workspaceGroups: world.deps.workspaceGroups,
    bots: world.deps.bots,
    gateway: world.deps.gateway,
    access,
    audit: accounts.audit!,
    local: fakeFilesBrowser(filesStore),
    remote: () => fakeFilesBrowser(filesStore),
    bases: { get: async (id) => fileBases.get(id) ?? null, setIfAbsent: async (id, head) => void (fileBases.has(id) || fileBases.set(id, head)) },
    git: world.deps.git,
    now: () => Date.now()
  });
  const hub = createStreamHub();
  // 资产自动化（导入 → 发布 → 分配）要资产中心在场：MCP 的 asset_* 工具靠它干活
  const assetsStore = inMemoryAssets(() => Date.now());
  const reviewStore = inMemoryAssetReview();
  const assetReview: AssetReviewDeps = {
    ...assetsStore.deps,
    projects: world.deps.projects,
    review: reviewStore.review,
    notifications: reviewStore.notifications,
    audit: accounts.audit!,
    users: accounts.users,
    teams: accounts.teams,
    policy: access
  };
  // 内置浏览器开放接口（install_builtin_browser / worker_component_status）要组件设施在场：轻量内存实现，机器清单由用例往 componentWorkers 里塞。
  const componentWorkers: WorkerStatus[] = [];
  const componentCatalog = new Map<string, CatalogComponent>();
  const componentPins: WorkerComponentPin[] = [];
  const componentDeps: ComponentDeps = {
    catalog: { list: async () => [...componentCatalog.values()], byId: async (key) => componentCatalog.get(key) ?? null, save: async (item) => void componentCatalog.set(`${item.id}@${item.version}`, item) },
    pins: {
      pinsFor: (w) => componentPins.filter((p) => p.workerId === w),
      upsert: (pin) => {
        const i = componentPins.findIndex((p) => p.workerId === pin.workerId && p.componentId === pin.componentId);
        if (i >= 0) componentPins.splice(i, 1);
        componentPins.push(pin);
      },
      remove: (w, c) => {
        const i = componentPins.findIndex((p) => p.workerId === w && p.componentId === c);
        if (i >= 0) componentPins.splice(i, 1);
      }
    },
    workers: { list: async () => componentWorkers, runtimeJob: async () => true },
    sessions: { listAll: async () => [] },
    audit: accounts.audit!,
    access,
    resolveNpm: async (name, version) => ({ name, version, resolved: `https://r/${name}-${version}.tgz`, integrity: BUILTIN_CHROMIUM.integrity, scripts: {}, dependencyCount: 0 }),
    now: () => 10,
    newJobId: () => 'job-t'
  };
  const browserMachine = (id: string, extra: Partial<WorkerStatus> = {}): WorkerStatus => ({
    workerId: id,
    label: id,
    origin: 'remote',
    state: 'online',
    agentIds: ['pi'],
    inventory: { runtimes: [{ agentId: 'pi', version: '0.1.0', source: 'machine' }], components: [], capabilities: [], collectedAt: 1, componentInstall: true },
    ...extra
  });
  const app = createApp({
    deps,
    hub,
    token: null,
    auth: { accounts },
    activity: { audit: accounts.audit!, users: accounts.users },
    assets: { deps: assetReview, audit: accounts.audit!, assetSets: fakeAssetSets() },
    files,
    ...(messaging ? { messaging } : {}),
    openApi: { tokens: tokenDeps, manage: tokenDeps, rate, settings: accounts.settings, audit: accounts.audit!, teams: accounts.teams },
    components: componentDeps
  });
  const browser = () => {
    const jar = new Map<string, string>();
    return async (path: string, init: RequestInit = {}) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      if (jar.get('hub_csrf')) headers['x-hub-csrf'] = jar.get('hub_csrf')!;
      const response = await app.fetch(new Request(`http://hub${path}`, { ...init, headers }));
      for (const line of response.headers.getSetCookie()) {
        const [name, value] = line.split(';')[0]!.split('=');
        if (value === '' || /Max-Age=0/.test(line)) jar.delete(name!);
        else jar.set(name!, value!);
      }
      return { status: response.status, body: (await response.json().catch(() => null)) as any };
    };
  };
  const api = (token: string) => async (path: string, init: RequestInit = {}) => {
    const response = await app.fetch(
      new Request(`http://hub/openapi/v1${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(init.headers ?? {}) } })
    );
    return { status: response.status, headers: response.headers, body: (await response.json().catch(() => null)) as any };
  };
  return { accounts, world, app, hub, apiTokens, assetsStore, browser, api, enrolledBy, messaging, componentWorkers, browserMachine, filesStore, files };
}
const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) });

/** 幂等中间件要 Promise 版 replay store（裸 Map 会在 v1 内部请求里炸掉）。 */
const replayStore = () => {
  const rows = new Map<string, string>();
  return {
    async get(key: string) {
      return rows.get(key) ?? null;
    },
    async put(key: string, body: string) {
      rows.set(key, body);
    }
  };
};

async function setup(rate?: Parameters<typeof harness>[0], enrolledBy?: Map<string, string>, withMessaging = false) {
  const h = harness(rate, enrolledBy, withMessaging);
  const david = h.browser();
  assert.equal((await david('/api/auth/register', post({ email: 'david@b.co', password: PASSWORD }))).status, 200);
  const mint = async (who: ReturnType<typeof h.browser>, scopes: string[], extra: Record<string, unknown> = {}) => {
    const created = await who('/api/tokens', post({ name: 'bot', scopes, ...extra }));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return created.body as { token: string; info: { id: string } };
  };
  return { ...h, david, mint };
}

test('令牌：明文只给一次、只存哈希；列表不带哈希；吊销后 401', async () => {
  const { david, mint, api, apiTokens } = await setup();
  const { token, info } = await mint(david, ['projects:read']);
  assert.match(token, /^ahp_/);
  const row = [...apiTokens.rows.values()][0]!;
  assert.notEqual(row.tokenHash, token);
  const listed = (await david('/api/tokens')).body;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].tokenHash, undefined);

  assert.equal((await api(token)('/projects')).status, 200);
  assert.equal((await api('ahp_nope')('/projects')).status, 401);
  assert.equal((await api(token)('/me')).body.token.id, info.id);
  assert.equal((await david(`/api/tokens/${info.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await api(token)('/projects')).status, 401);
});

test('令牌不认 cookie、令牌也造不了令牌；开放 API 不接受 cookie 登录', async () => {
  const { david, mint, app } = await setup();
  const { token } = await mint(david, ['projects:read']);
  // /api/tokens 不认 Bearer ahp_（只认登录态）
  const viaToken = await app.fetch(new Request('http://hub/api/tokens', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x', scopes: ['projects:read'] }) }));
  assert.equal(viaToken.status, 401);
  // 开放 API 不认 cookie
  assert.equal((await david('/openapi/v1/projects')).status, 401);
});

test('权限范围：只读令牌不能写；没有 workers:read 看不到机器', async () => {
  const { david, mint, api } = await setup();
  const read = api((await mint(david, ['projects:read'])).token);
  assert.equal((await read('/projects', post({ name: 'p' }))).status, 403);
  assert.equal((await read('/workers')).status, 403);
  const write = api((await mint(david, ['projects:read', 'projects:write'])).token);
  const created = await write('/projects', post({ name: 'p' }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  projectSchema.parse(created.body);
  const task = await write('/tasks', post({ projectId: created.body.id, title: 't', goal: '' }));
  assert.equal(task.status, 201);
  taskSchema.parse(task.body);
  assert.equal((await read(`/tasks?projectId=${created.body.id}`)).body.length, 1);
  assert.equal((await read(`/tasks/${task.body.id}`)).body.sessions.length, 0);
  // 只读令牌不能开会话
  assert.equal((await read('/sessions', post({ taskId: task.body.id, agentId: 'fake', model: 'm1' }))).status, 403);
});

test('成员的令牌不超过成员本人的权限：看不见主人的项目', async () => {
  const h = await setup();
  await addTeamMember(h.accounts, 'm@b.co', PASSWORD);
  const member = h.browser();
  assert.equal((await member('/api/auth/login', post({ email: 'm@b.co', password: PASSWORD }))).status, 200);
  const his = (await h.david('/api/projects', post({ name: 'his' }))).body;
  const token = (await h.mint(member, ['projects:read', 'projects:write'])).token;
  assert.equal((await h.api(token)(`/tasks?projectId=${his.id}`)).status, 404);
  assert.deepEqual((await h.api(token)('/projects')).body, []);
  // 成员建不了服务账号
  assert.equal((await member('/api/tokens', post({ name: 's', kind: 'service', scopes: ['projects:read'] }))).status, 403);
});

test('内置浏览器面：列 / 启用内置资产；机器浏览器状态；管理员令牌能装，本机和没权限的不行', async () => {
  const { david, mint, api, componentWorkers, browserMachine, accounts } = await setup();
  const scopes = ['projects:read', 'projects:write', 'assets:read', 'assets:submit', 'workers:read'];
  const full = api((await mint(david, scopes)).token);
  const bare = api((await mint(david, ['projects:read'])).token);
  const project = (await full('/projects', post({ name: 'p' }))).body;
  // 没权限的令牌：读不到（403），不是 404
  assert.equal((await bare('/builtin-assets?projectId=x')).status, 403);
  assert.equal((await bare('/workers/browser-status')).status, 403);
  // 列内置资产：尚未启用
  const list = await full(`/builtin-assets?projectId=${project.id}`);
  assert.equal(list.status, 200, JSON.stringify(list.body));
  const playwright = list.body.find((row: { id: string }) => row.id === 'playwright');
  assert.equal(playwright.enabled, null);
  assert.equal(playwright.requiresBrowser, true);
  // 启用：created true；再启用：幂等 created false；网页端开关同步出现
  const made = await full('/builtin-assets/playwright/enable', post({ projectId: project.id }));
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal(made.body.created, true);
  const again = await full('/builtin-assets/playwright/enable', post({ projectId: project.id }));
  assert.equal(again.body.created, false);
  // 网页端同一条数据源：现在也看到已启用
  const web = (await david(`/api/assets/builtin?projectId=${project.id}`)).body;
  assert.ok(web.find((row: { id: string; enabled: { on: boolean } | null }) => row.id === 'playwright' && row.enabled?.on === true));
  // 机器浏览器状态：两台在线机器都没就绪
  componentWorkers.push(browserMachine('w1'), browserMachine('hub-local', { origin: 'local' }));
  const status = await full('/workers/browser-status');
  assert.equal(status.status, 200);
  assert.deepEqual(status.body.map((row: { workerId: string; ready: boolean; installing: boolean }) => [row.workerId, row.ready, row.installing]), [['w1', false, false], ['hub-local', false, false]]);
  // 本机：开放 API 永远不能装（管理员令牌也不行）
  const localDenied = await full('/workers/hub-local/builtin-browser', post({}));
  assert.equal(localDenied.status, 403);
  assert.match(localDenied.body.error.message, /本机/);
  // 管理员令牌：扶植目录（提交→自准）→ 202 安装任务
  const started = await full('/workers/w1/builtin-browser', post({}));
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.equal(started.body.jobId, 'job-t');
  assert.equal(started.body.action, 'install_component');
  // 404：没这台机器
  assert.equal((await full('/workers/nope/builtin-browser', post({}))).status, 404);
  // 通用能力状态 / 组件安装（别名之外的主接口）
  const caps = await full('/workers/capability-status?capability=browser:chromium');
  assert.equal(caps.status, 200);
  assert.equal(caps.body[0]?.capability, 'browser:chromium');
  const generic = await full('/workers/w1/components', post({ capability: 'browser:chromium' }));
  // 第一次已经把任务发出去了：再装同一版本是冲突或又一次 202（幂等由用例决定），这里至少不是 404/401
  assert.ok([202, 409].includes(generic.status), JSON.stringify(generic.body));
  // 浏览器状态露出进行中的安装任务（workerControl 会把运行中的任务合到机器状态上）
  Object.assign(componentWorkers[0] as WorkerStatus, { runtimeJob: {
    jobId: 'job-t',
    agentId: 'pi',
    action: 'install_component',
    version: BUILTIN_CHROMIUM.version,
    component: {
      componentId: BUILTIN_CHROMIUM.componentId,
      runtime: 'pi',
      packageName: BUILTIN_CHROMIUM.packageName,
      version: BUILTIN_CHROMIUM.version,
      resolved: '',
      integrity: BUILTIN_CHROMIUM.integrity,
      provides: [{ capability: BUILTIN_CHROMIUM.capability, mode: BUILTIN_CHROMIUM.mode }],
      ignoreScripts: true,
      expectedCurrent: null
    },
    state: 'running',
    message: '正在安装组件 chromium 1.66.0-alpha-2026-11-09',
    log: '',
    startedAt: 10,
    endedAt: null,
    actorEmail: 'david@b.co'
    } });
  const after = await full('/workers/browser-status');
  const w1 = after.body.find((row: { workerId: string }) => row.workerId === 'w1');
  assert.equal(w1.installing, true);
  assert.deepEqual(w1.installJob, { jobId: 'job-t', state: 'running', message: '正在安装组件 chromium 1.66.0-alpha-2026-11-09' });
  assert.equal(w1.acquisition, null);
  assert.equal(w1.capability, 'browser:chromium');
  // 审计带令牌名
  const davidUser = await accounts.users.byEmail('david@b.co');
  assert.ok(davidUser);
  const entries = await accounts.audit!.query({ actor: 'david@b.co', limit: 50 });
  assert.ok(entries.some((e) => e.action === 'runtime.component.install' && /经令牌 bot/.test(e.detail)));
});

test('对话：开会话 → prompt（作者带 via）→ events / stream；审计写 via 令牌', async () => {
  const { david, mint, api, world, hub, accounts, app } = await setup();
  const token = (await mint(david, ['projects:read', 'projects:write', 'sessions:read', 'sessions:write', 'workers:read'])).token;
  const call = api(token);
  const project = (await call('/projects', post({ name: 'p' }))).body;
  const task = (await call('/tasks', post({ projectId: project.id, title: 't', goal: '' }))).body;
  world.workers.push({ workerId: 'w1', label: 'w1', origin: 'remote', state: 'online' } as never);
  const workerId = 'w1';
  const workspace = newWorkspace({ projectId: project.id, workerId, path: '/srv/x', kind: 'long_lived', source: 'linked', now: 1 });
  assert.ok(workspace.ok);
  await world.deps.workspaces.save(workspace.value);
  const session = await call('/sessions', post({ taskId: task.id, agentId: 'fake', model: 'm1', workspaceId: workspace.value.id }));
  assert.equal(session.status, 201, JSON.stringify(session.body));
  sessionSchema.parse(session.body);
  const prompted = await call(`/sessions/${session.body.id}/prompt`, post({ text: 'hi' }));
  assert.equal(prompted.status, 202, JSON.stringify(prompted.body));
  // 回执带轮次：调用方拿它配 sinceTurn 跟这一轮。
  assert.equal(prompted.body.turn, 1);
  const eventList = (await call(`/sessions/${session.body.id}/events`)).body;
  assert.ok(Array.isArray(eventList.events), 'events 要包在 { events, nextAfter } 里');
  assert.equal(typeof eventList.nextAfter, 'number');
  const events = eventList.events as { event: { kind: string }; turn?: number }[];
  // 对外投影不含 prompt 原文；作者 via 在 SSE 里仍能看到。
  assert.ok(!events.some((e: { event: { kind: string } }) => e.event.kind === 'prompt'));

  const second = await call(`/sessions/${session.body.id}/prompt`, post({ text: '再来一句' }));
  assert.equal(second.body.turn, 2);
  // 对外投影不含 prompt，补一条可见文本，确认 sinceTurn 能筛到这一轮。
  world.deps.sessions.journal.get(session.body.id)!.push({ seq: 50, at: 2, turn: 2, event: { kind: 'text', delta: '第二轮' } });
  const secondList = (await call(`/sessions/${session.body.id}/events?sinceTurn=2`)).body;
  const secondOnly = secondList.events as { event: { kind: string; text?: string }; turn?: number }[];
  assert.equal(typeof secondList.nextAfter, 'number');
  assert.ok(secondOnly.length > 0);
  assert.ok(secondOnly.every((entry: { turn?: number }) => entry.turn === 2));
  // 老事件没有 turn（不属于任何轮次）：sinceTurn 不返回，不带时照常给全量（#230）
  world.deps.sessions.journal.get(session.body.id)!.push({ seq: 999, at: 3, event: { kind: 'diagnostic', level: 'info', text: '老事件没有轮次' } });
  const all = (await call(`/sessions/${session.body.id}/events`)).body.events as { event: { kind: string }; turn?: number }[];
  assert.ok(all.some((entry: { event: { kind: string } }) => entry.event.kind === 'diagnostic'), '不带 sinceTurn 时老事件仍然返回');
  const turnsOnly = (await call(`/sessions/${session.body.id}/events?sinceTurn=2`)).body.events as { event: { kind: string }; turn?: number }[];
  assert.ok(turnsOnly.every((entry: { turn?: number }) => entry.turn === 2));
  assert.ok(!turnsOnly.some((entry: { event: { kind: string } }) => entry.event.kind === 'diagnostic'), '没有 turn 的旧事件被过滤');
  assert.ok(accounts.auditRows.some((row) => row.action === 'session.start' && row.detail.includes('via 令牌「bot」')));

  // SSE：补发已有事件
  const controller = new AbortController();
  const response = await app.fetch(new Request(`http://hub/openapi/v1/sessions/${session.body.id}/stream`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = response.body!.getReader();
  let text = '';
  while (!text.includes('"kind":"prompt"')) text += new TextDecoder().decode((await reader.read()).value);
  assert.match(text, /event: event\n/);
  assert.match(text, /\nid: \d+\n/);
  void hub;
  controller.abort();
  await reader.cancel().catch(() => undefined);
});

test('令牌打本机：机器没配原生模型也先 403，不把拒绝说成未配置模型', async () => {
  const { david, mint, api, world } = await setup();
  world.workers.splice(0, world.workers.length, {
    workerId: 'local',
    label: '本机',
    origin: 'local',
    state: 'online',
    agentIds: ['fake'],
    agentModels: [{ agentId: 'fake', models: [], defaultModel: '', readiness: { state: 'unavailable', reason: '未配置模型' }, providers: ['openai-chat'] }]
  });
  const call = api((await mint(david, ['projects:read', 'projects:write', 'sessions:read', 'sessions:write', 'workers:read'])).token);
  const project = (await call('/projects', post({ name: 'p' }))).body;
  const task = (await call('/tasks', post({ projectId: project.id, title: 't', goal: '' }))).body;
  const workspace = newWorkspace({ projectId: project.id, workerId: null, path: '/tmp/x', kind: 'long_lived', source: 'linked', now: 1 });
  assert.ok(workspace.ok);
  await world.deps.workspaces.save(workspace.value);
  const derived = await call('/sessions', post({ taskId: task.id, agentId: 'fake', model: '', workspaceId: workspace.value.id }));
  assert.equal(derived.status, 403, JSON.stringify(derived.body));
  assert.equal(JSON.stringify(derived.body).includes('未配置模型'), false);
  assert.equal(world.dispatched.length, 0);
});

test('worker.use_local 永远授不出去：hub 管理员的令牌也不能在本机开会话', async () => {
  const { david, mint, api, world } = await setup();
  const call = api((await mint(david, ['projects:read', 'projects:write', 'sessions:read', 'sessions:write', 'workers:read'])).token);
  const project = (await call('/projects', post({ name: 'p' }))).body;
  const task = (await call('/tasks', post({ projectId: project.id, title: 't', goal: '' }))).body;
  const workspace = newWorkspace({ projectId: project.id, workerId: null, path: '/tmp/x', kind: 'long_lived', source: 'linked', now: 1 });
  assert.ok(workspace.ok);
  await world.deps.workspaces.save(workspace.value);
  const before = world.dispatched.length;
  const derived = await call('/sessions', post({ taskId: task.id, agentId: 'fake', model: 'm1', workspaceId: workspace.value.id }));
  assert.equal(derived.status, 403, JSON.stringify(derived.body));
  assert.equal(world.dispatched.length, before);
  // 机器列表里也没有本机
  const workers = (await call('/workers')).body as { workerId: string; origin?: string }[];
  assert.ok(workers.every((w) => w.origin !== 'local'));
});

test('工作区改动与活动：都按项目/会话权限判定，不是拿到 id 就能读', async () => {
  const { david, mint, api, world } = await setup();
  const owner = api((await mint(david, ['projects:read', 'projects:write', 'sessions:read'])).token);
  const project = (await owner('/projects', post({ name: 'p' }))).body;
  const workspace = newWorkspace({ projectId: project.id, workerId: null, path: '/tmp/x', kind: 'long_lived', source: 'linked', now: 1 });
  assert.ok(workspace.ok);
  await world.deps.workspaces.save(workspace.value);

  // 项目成员 + 项目读权限能看；只有会话读权限的令牌不行。
  const allowed = await owner(`/workspaces/${workspace.value.id}/changes`);
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));

  // 权限不够时按策略返回 404（不泄露目录存在），不能是 200。
  const narrow = api((await mint(david, ['sessions:read'])).token);
  const denied = await narrow(`/workspaces/${workspace.value.id}/changes`);
  assert.equal(denied.status, 404, JSON.stringify(denied.body));

  const missing = await owner('/sessions/ses_00000000-0000-4000-8000-000000000000/activity');
  assert.equal(missing.status, 404, JSON.stringify(missing.body));
});

test('开会话：workspaceMode=isolated 一定新开临时空间，不静默复用长期目录（#236）', async () => {
  const { david, mint, api, world } = await setup();
  const call = api((await mint(david, ['projects:read', 'projects:write', 'sessions:read', 'sessions:write', 'workers:read'])).token);
  const project = (await call('/projects', post({ name: 'p' }))).body;
  const task = (await call('/tasks', post({ projectId: project.id, title: 't', goal: '' }))).body;
  world.workers.push({ workerId: 'w1', label: 'w1', origin: 'remote', state: 'online', roots: ['/srv/work'] } as never);
  const workspace = newWorkspace({ projectId: project.id, workerId: 'w1', path: '/srv/work/demo', kind: 'long_lived', source: 'linked', now: 1 });
  assert.ok(workspace.ok);
  await world.deps.workspaces.save(workspace.value);

  const derived = await call('/sessions', post({ taskId: task.id, agentId: 'fake', model: 'm1', workspaceId: workspace.value.id }));
  assert.equal(derived.status, 201, JSON.stringify(derived.body));

  const isolated = await call(
    '/sessions',
    post({ taskId: task.id, agentId: 'fake', model: 'm1', workerId: 'w1', workspaceMode: 'isolated' })
  );
  assert.equal(isolated.status, 201, JSON.stringify(isolated.body));
  assert.notEqual(isolated.body.workspaceId, workspace.value.id, '显式 isolated 不该复用长期目录');
  const made = await world.deps.workspaces.byId(isolated.body.workspaceId);
  assert.equal(made?.kind, 'temporary');
});

test('同步仓库：项目绑定多个仓库时拒绝补克隆同级目录，引导使用组合工作空间', async () => {
  const { david, mint, api, world } = await setup();
  const call = api((await mint(david, ['projects:read', 'projects:write'])).token);
  const project = (await call('/projects', post({ name: 'p', repoUrl: 'https://example.com/core.git' }))).body;
  world.workers.push({ workerId: 'w1', label: 'w1', origin: 'remote', state: 'online', roots: ['/srv/work'] } as never);
  const workspace = newWorkspace({ projectId: project.id, workerId: 'w1', path: '/srv/work/agent-hub-workspaces/demo', kind: 'long_lived', source: 'cloned', repoUrl: 'https://example.com/core.git', isGit: true, now: 1 });
  assert.ok(workspace.ok);
  await world.deps.workspaces.save(workspace.value);
  world.git.repos.add(workspace.value.path);
  world.git.remotes.set(workspace.value.path, 'https://example.com/core.git');
  world.git.absent.add('/srv/work/agent-hub-workspaces/docs');
  const clonesBefore = world.git.calls.filter((line: string) => line.includes(':clone:')).length;

  const updated = await call(`/projects/${project.id}/repos`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      repos: [
        { name: 'core', url: 'https://example.com/core.git' },
        { name: 'docs', url: 'https://example.com/docs.git', defaultBranch: 'main' }
      ]
    })
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));

  const synced = await call(`/workspaces/${workspace.value.id}/sync`, { method: 'POST' });
  assert.equal(synced.status, 400, JSON.stringify(synced.body));
  assert.match(String(synced.body.error?.message ?? synced.body.message ?? ''), /组合工作空间/);
  assert.equal(world.git.calls.filter((line: string) => line.includes(':clone:')).length, clonesBefore, '不得克隆未登记的同级目录');
});

test('同步仓库：单仓项目只报告已在场的仓库，不克隆；清单里的凭据名不会回给出站', async () => {
  const { david, mint, api, world } = await setup();
  const call = api((await mint(david, ['projects:read', 'projects:write'])).token);
  const project = (await call('/projects', post({ name: 'p', repoUrl: 'https://example.com/core.git' }))).body;
  world.workers.push({ workerId: 'w1', label: 'w1', origin: 'remote', state: 'online', roots: ['/srv/work'] } as never);
  const workspace = newWorkspace({ projectId: project.id, workerId: 'w1', path: '/srv/work/agent-hub-workspaces/demo', kind: 'long_lived', source: 'cloned', repoUrl: 'https://example.com/core.git', isGit: true, now: 1 });
  assert.ok(workspace.ok);
  await world.deps.workspaces.save(workspace.value);
  world.git.repos.add(workspace.value.path);
  world.git.remotes.set(workspace.value.path, 'https://example.com/core.git');

  const synced = await call(`/workspaces/${workspace.value.id}/sync`, { method: 'POST' });
  assert.equal(synced.status, 200, JSON.stringify(synced.body));
  assert.deepEqual(synced.body.added, []);
  assert.deepEqual(synced.body.present, [{ name: 'core', path: workspace.value.path }]);

  const again = await call(`/workspaces/${workspace.value.id}/sync`, { method: 'POST' });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual(again.body.added, []);

  const privateRepo = await call(`/projects/${project.id}/repos`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repos: [{ name: 'secret-repo', url: 'https://code.example.com/team/secret.git', credential: 'tok-123' }] })
  });
  assert.equal(privateRepo.status, 200, JSON.stringify(privateRepo.body));
  assert.ok(!JSON.stringify(privateRepo.body).includes('tok-123'));
});

test('限流：超了 429 + Retry-After', async () => {
  const { david, mint, api } = await setup({ general: 3 });
  const call = api((await mint(david, ['projects:read'])).token);
  for (let i = 0; i < 3; i++) assert.equal((await call('/projects')).status, 200);
  const limited = await call('/projects');
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
});

test('服务账号：主人能建；不占席位、不出现在成员列表；吊销即停用', async () => {
  const { david, api, accounts } = await setup();
  const created = await david('/api/tokens', post({ name: 'ci-bot', kind: 'service', scopes: ['projects:read'] }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const me = (await api(created.body.token)('/me')).body;
  assert.equal(me.user.service, true);
  assert.equal(me.user.name, 'ci-bot');
  const members = (await david('/api/team')).body;
  assert.ok(!JSON.stringify(members).includes('service.agent-hub.invalid'));
  assert.equal((await david(`/api/tokens/${created.body.info.id}`, { method: 'DELETE' })).status, 200);
  const user = await accounts.users.byId(me.user.id);
  assert.ok(user?.disabledAt);
});

test('MCP：列工具、调工具（同一个令牌、同一套权限）', async () => {
  const { david, mint, app } = await setup();
  const token = (await mint(david, ['projects:read'])).token;
  const rpc = async (body: unknown) => {
    const response = await app.fetch(new Request('http://hub/openapi/v1/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json().catch(() => null)) as any };
  };
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  assert.equal(init.status, 200, JSON.stringify(init.body));
  const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const names = list.body.result.tools.map((t: { name: string }) => t.name);
  // 只列这个令牌用得了的：projects:read 只有项目 / 任务，看不到会话、资产（#E4）
  assert.deepEqual(names.sort(), ['get_project', 'get_task', 'list_projects', 'list_task_log', 'list_tasks', 'resolve_default_agent', 'task_pull_requests', 'team_agent_defaults', 'workspace_changes', 'workspace_group_get', 'workspace_sweep_records']);
  // 写工具不进清单；注解标成只读。
  assert.ok(!names.includes('prompt') && !names.includes('create_task') && !names.includes('delete_project'));
  const project = list.body.result.tools.find((t: { name: string }) => t.name === 'list_projects');
  assert.equal(project.annotations.readOnlyHint, true);
  assert.match(project.description, /下一步/);
  const called = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_projects', arguments: {} } });
  assert.equal(called.body.result.isError, false, JSON.stringify(called.body));
  // 白名单外：不是 403，而是「没有这个工具」（连存在性都不确认）。
  const denied = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'create_task', arguments: { projectId: 'p', title: 'x' } } });
  assert.equal(denied.body.result.isError, true);
  assert.match(denied.body.result.content[0].text, /没有这个工具/);
  // 开着、但令牌没权限：调用时说清缺哪个 scope
  const locked = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_session', arguments: { sessionId: 's' } } });
  assert.equal(locked.body.result.isError, true);
  assert.match(locked.body.result.content[0].text, /403.*sessions:read/);
  // 没令牌：401
  const anonymous = await app.fetch(new Request('http://hub/openapi/v1/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
  assert.equal(anonymous.status, 401);
});

test('MCP：resources 可列出并读取 agent-hub-workbench skill；公开 GET 同样能下载', async () => {
  const { mint, david, app } = await setup();
  const token = (await mint(david, ['projects:read'])).token;
  const rpc = async (body: unknown) => {
    const response = await app.fetch(new Request('http://hub/openapi/v1/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json().catch(() => null)) as any };
  };
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  assert.equal(init.status, 200, JSON.stringify(init.body));
  assert.ok(init.body.result.capabilities.resources, 'initialize 应声明 resources 能力');
  const listed = await rpc({ jsonrpc: '2.0', id: 2, method: 'resources/list', params: {} });
  const uris = (listed.body.result.resources as { uri: string }[]).map((item) => item.uri);
  assert.ok(uris.includes('skill://agent-hub-workbench/SKILL.md'), JSON.stringify(uris));
  const toolsListed = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
  assert.ok((toolsListed.body.result.tools as { name: string }[]).some((tool) => tool.name === 'list_projects'));
  const read = await rpc({ jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'skill://agent-hub-workbench/SKILL.md' } });
  assert.equal(read.status, 200, JSON.stringify(read.body));
  const text = read.body.result.contents[0].text as string;
  assert.match(text, /session_start/);
  assert.match(text, /project_repos/);
  assert.match(text, /primaryRepoId/);
  assert.match(text, /events/);
  assert.match(text, /providers:manage/);
  // skill 点到的工具名必须出现在完整 MCP 清单里（以路由元数据为准，不看当前令牌的子集）
  const catalog = mcpToolsFor(undefined, { writes: true });
  const catalogNames = new Set(catalog.map((tool) => tool.name));
  for (const name of ['list_projects', 'get_project', 'list_workers', 'task_create', 'session_start', 'session_reply', 'events', 'get_session', 'workspace_changes', 'project_repos', 'sync_workspace']) {
    assert.ok(text.includes(name), `skill 应提到 ${name}`);
    assert.ok(catalogNames.has(name), `skill 写了不存在的工具：${name}`);
  }
  assert.match(text, /workspace_group_create|没有.*建组合组|不能建组合组/);
  assert.ok(uris.includes('skill://agent-hub-workbench/references/tools.md'), JSON.stringify(uris));
  const toolsDoc = await rpc({ jsonrpc: '2.0', id: 6, method: 'resources/read', params: { uri: 'skill://agent-hub-workbench/references/tools.md' } });
  assert.equal(toolsDoc.status, 200, JSON.stringify(toolsDoc.body));
  const toolsText = toolsDoc.body.result.contents[0].text as string;
  const missingTools = catalog.filter((tool) => !toolsText.includes('`' + tool.name + '`')).map((tool) => tool.name);
  assert.deepEqual(missingTools, [], 'MCP 资源 tools.md 应列出全部已注册工具');
  for (const name of ['provider_list', 'provider_create', 'provider_delete', 'provider_routing_set']) {
    assert.ok(toolsText.includes('`' + name + '`'), name);
  }
  const missing = await rpc({ jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: 'skill://agent-hub-workbench/nope.md' } });
  assert.ok(missing.body.error || missing.body.result?.isError, JSON.stringify(missing.body));

  const json = await app.fetch(new Request('http://hub/openapi/v1/skills/agent-hub-workbench?format=json'));
  assert.equal(json.status, 200, await json.clone().text());
  const manifest = (await json.json()) as { name: string; files: { path: string; content?: string }[] };
  assert.deepEqual(manifest, workbenchSkillManifest());
  const toolsFile = manifest.files.find((file) => file.path === 'references/tools.md');
  assert.ok(toolsFile?.content, 'json 清单应带 tools.md 正文');
  assert.equal(toolsFile!.content, toolsText);
  const skillFile = manifest.files.find((file) => file.path === 'SKILL.md');
  assert.match(skillFile?.content ?? '', /providers:manage/);
  const zip = await app.fetch(new Request('http://hub/openapi/v1/skills/agent-hub-workbench'));
  assert.equal(zip.status, 200);
  assert.equal(zip.headers.get('content-type'), 'application/zip');
  assert.match(zip.headers.get('content-disposition') ?? '', /agent-hub-workbench\.zip/);
  const bytes = Buffer.from(await zip.arrayBuffer());
  assert.deepEqual(bytes, Buffer.from(workbenchSkillZip()));
});

test('规范快照：openapi.json 与 docs/openapi/v1.json 一致（改了接口要更新快照）', async () => {
  const { app } = await setup();
  const live = await (await app.fetch(new Request('http://hub/openapi/v1/openapi.json'))).json();
  const built = buildSpecApp().getOpenAPI31Document(openApiInfo);
  assert.deepEqual(live, JSON.parse(JSON.stringify(built)));
  const file = fileURLToPath(new URL('../../../docs/openapi/v1.json', import.meta.url));
  const snapshot = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(live, snapshot, '规范变了：跑 npm run openapi:snapshot 并在 PR 里说明');
  assert.ok(Object.values(live.paths).flatMap((p: any) => Object.keys(p)).length >= 26);
  assert.equal((await app.fetch(new Request('http://hub/openapi/v1/docs'))).status, 200);
  assert.equal(mcpTools({ modules: new Set(['tasks', 'projects', 'sessions', 'assets']) }).length, 48);
});

test('过期的令牌、被停用的人的令牌：401', async () => {
  const { david, mint, api, apiTokens, accounts } = await setup();
  const { token, info } = await mint(david, ['projects:read']);
  const row = apiTokens.rows.get(info.id)!;
  apiTokens.rows.set(info.id, { ...row, expiresAt: Date.now() - 1 });
  assert.equal((await api(token)('/projects')).status, 401);
  apiTokens.rows.set(info.id, row);
  assert.equal((await api(token)('/projects')).status, 200);
  const user = (await accounts.users.byId(row.userId as never))!;
  await accounts.users.save({ ...user, disabledAt: Date.now() });
  assert.equal((await api(token)('/projects')).status, 401);
});


test('MCP 策略：按模块收窄、只读闸门；投影丢掉工具输入输出', () => {
  // 默认不强制只读：有写工具就一起列出来（能不能调由令牌权限和只读模式决定）
  assert.deepEqual(mcpTools({ modules: new Set(['tasks']) }).map((t) => t.name).sort(), ['append_task_log', 'edit_task_log', 'get_task', 'list_task_log', 'list_tasks', 'set_task_status', 'set_task_summary', 'task_create', 'task_default_agent', 'task_pull_requests']);
  assert.deepEqual(mcpTools({ modules: new Set(['projects']), readOnly: true }).map((t) => t.name).sort(), ['get_project', 'list_projects', 'resolve_default_agent', 'team_agent_defaults', 'workspace_changes']);
  assert.equal(mcpTools({ readOnly: true }).length, 29);
  const workspaceTools = mcpTools({ modules: new Set(['workspaces']), writes: true });
  const workspaceNames = workspaceTools.map((t) => t.name).sort();
  for (const name of [
    'workspace_group_add_member',
    'workspace_group_create',
    'workspace_group_get',
    'workspace_group_retry',
    'workspace_sweep',
    'workspace_sweep_records',
    'create_workspace',
    'sync_workspace'
  ]) assert.ok(workspaceNames.includes(name), name);
  assert.ok(workspaceTools.filter((t) => !t.readOnly && (t.name.startsWith('workspace_group_') || t.name.startsWith('workspace_sweep'))).every((t) => t.idempotent));
  // 资产自动化：三个新写工具只在开了写开关时出现，且都可重放
  const assetWrites = mcpTools({ modules: new Set(['assets']), writes: true });
  assert.deepEqual(assetWrites.map((t) => t.name).sort(), ['asset_assign', 'asset_create', 'asset_import', 'asset_publish', 'enable_builtin_asset', 'get_asset', 'list_assets', 'list_builtin_assets']);
  assert.ok(assetWrites.filter((t) => !t.readOnly).every((t) => t.idempotent));
  assert.equal(assetWrites.filter((t) => t.readOnly).length, 3);
  const projectedWrap = projectEvents([
    { seq: 1, at: 1, event: { kind: 'prompt', text: 'AWS_SECRET_ACCESS_KEY=abc' } },
    { seq: 2, at: 2, turn: 1, event: { kind: 'tool_call', name: 'bash', input: { command: 'echo AWS_SECRET_ACCESS_KEY=abc' } } },
    { seq: 3, at: 3, event: { kind: 'tool_result', name: 'bash', ok: true, output: 'AWS_SECRET_ACCESS_KEY=abc' } },
    { seq: 4, at: 4, event: { kind: 'text', delta: '好了' } },
    { seq: 5, at: 5, event: { kind: 'thinking', text: '密钥是 abc' } },
    { seq: 6, at: 6, event: { kind: 'ended', outcome: 'done', reason: 'ok' } }
  ]) as { events: { event: Record<string, unknown>; turn?: number; seq: number }[]; nextAfter: number };
  assert.equal(projectedWrap.nextAfter, 6);
  const projected = projectedWrap.events;
  const text = JSON.stringify(projected);
  assert.ok(!text.includes('AWS_SECRET'), text);
  assert.deepEqual(projected.map((p) => p.event['kind']), ['tool', 'tool_result', 'text', 'ended']);
  // 正文在领域里叫 delta；投影后统一成 text，不能丢内容。
  assert.deepEqual(projected[2]!.event, { kind: 'text', text: '好了' });
  assert.deepEqual(projected[0]!.event, { kind: 'tool', name: 'bash' });
  // tool_result 也要带工具名（#E 对齐 tool_call），但 output 不能投影出去。
  assert.deepEqual(projected[1]!.event, { kind: 'tool_result', name: 'bash', ok: true });
  // turn 要留给调用方（events?sinceTurn= 对得上轮次）；没有 turn 的老事件不凭空生成。
  assert.equal(projected[0]!.turn, 1);
  assert.equal('turn' in projected[1]!, false);
});


test('MCP 委派：写工具默认不出现，MCP_WRITE 打开后可建任务，clientRequestId 重放同一结果', async () => {
  const { david, mint, app } = await setup();
  const project = (await david('/api/projects', post({ name: '委派' }))).body as { id: string };
  const token = (await mint(david, ['projects:read', 'projects:write', 'sessions:write'])).token;
  const replays = new Map<string, string>();
  const store = {
    async get(key: string) {
      return replays.get(key) ?? null;
    },
    async put(key: string, body: string) {
      replays.set(key, body);
    }
  };
  const rpc = async (body: unknown, policy?: { writes?: boolean; readOnly?: boolean }) => {
    const response = await app.fetch(
      new Request('http://hub/openapi/v1/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify(body)
      }),
      { mcpReplays: store, mcpPolicy: { modules: new Set(['tasks', 'sessions', 'projects']), readOnly: false, writes: true, ...policy } }
    );
    return (await response.json().catch(() => null)) as any;
  };
  const list = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const names = list.result.tools.map((t: { name: string }) => t.name);
  assert.ok(names.includes('task_create') && names.includes('session_start') && names.includes('session_reply') && names.includes('session_cancel'));
  const writeTool = list.result.tools.find((t: { name: string }) => t.name === 'task_create');
  assert.equal(writeTool.annotations.readOnlyHint, false);
  assert.equal(writeTool.annotations.idempotentHint, true);

  const noKey = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'task_create', arguments: { projectId: project.id, title: '委派任务' } } });
  assert.equal(noKey.result.isError, true);
  assert.match(noKey.result.content[0].text, /clientRequestId/);

  const call = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'task_create', arguments: { projectId: project.id, title: '委派任务', clientRequestId: 'req-1' } } };
  const first = await rpc(call);
  assert.equal(first.result.isError, false, JSON.stringify(first.result));
  const second = await rpc({ ...call, id: 4 });
  assert.deepEqual(second.result.structuredContent, first.result.structuredContent);
  const listed = await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'list_tasks', arguments: { projectId: project.id } } });
  const tasks = JSON.parse(listed.result.content[0].text) as { id: string }[];
  assert.equal(tasks.length, 1);

  // 只读闸门压过写开关。
  const readOnly = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} }, { readOnly: true });
  assert.ok(!readOnly.result.tools.some((t: { name: string }) => t.name === 'task_create'));
});

test('MCP tools/list：所有写工具顶层 required clientRequestId，且与运行时校验同一份规则', async () => {
  const { david, mint, app } = await setup();
  const scopes = ['projects:read', 'projects:write', 'sessions:read', 'sessions:write', 'workers:read', 'assets:submit', 'assets:read', 'assets:write', 'assets:publish', 'providers:read', 'providers:use', 'providers:manage', 'groups:write', 'files:read', 'memory:read', 'memory:write', 'tokens:manage'];
  const token = (await mint(david, scopes)).token;
  const list = await app.fetch(
    new Request('http://hub/openapi/v1/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    }),
    { mcpPolicy: { readOnly: false, writes: true } }
  );
  const body = (await list.json()) as { result: { tools: { name: string; description: string; inputSchema: { properties?: Record<string, any>; required?: string[] }; annotations?: { readOnlyHint?: boolean } }[] } };
  const tools = body.result.tools;
  const writes = tools.filter((tool) => tool.annotations?.readOnlyHint === false);
  const reads = tools.filter((tool) => tool.annotations?.readOnlyHint === true);
  assert.ok(writes.length > 0 && reads.length > 0);
  for (const tool of writes) {
    assert.ok(tool.inputSchema.required?.includes('clientRequestId'), `${tool.name}: tools/list 顶层 required 缺 clientRequestId`);
    const property = tool.inputSchema.properties?.['clientRequestId'];
    assert.equal(property?.type, 'string', `${tool.name}: clientRequestId 必须是字符串`);
    assert.equal(property?.minLength, 1, `${tool.name}: clientRequestId 不能为空`);
    assert.equal(property?.maxLength, 200, `${tool.name}: clientRequestId 上限应为 200`);
    assert.equal(typeof property?.pattern, 'string', `${tool.name}: clientRequestId 要带 HTTP 安全字符的 pattern`);
    // 必须是顶层参数：nested body 工具不能把它塞进 body。
    assert.equal(tool.inputSchema.properties?.['body']?.properties?.['clientRequestId'], undefined, `${tool.name}: clientRequestId 不该藏在 body 里`);
  }
  for (const tool of reads) {
    assert.equal(tool.inputSchema.properties?.['clientRequestId'], undefined, `${tool.name}: 只读工具不该要 clientRequestId`);
    assert.ok(!tool.inputSchema.required?.includes('clientRequestId'), `${tool.name}: 只读工具 required 不该有 clientRequestId`);
  }
  // session_reply 的 clientMessageId 是消息去重键，独立于 clientRequestId（可选，保留在原有位置）。
  const reply = writes.find((tool) => tool.name === 'session_reply');
  assert.ok(reply);
  assert.ok(reply.inputSchema.properties?.['clientMessageId'], 'session_reply 仍有 clientMessageId');
  assert.ok(!reply.inputSchema.required?.includes('clientMessageId'), 'clientMessageId 仍然是可选的');
  assert.ok(reply.inputSchema.required?.includes('clientRequestId'), 'session_reply 也要 clientRequestId');
  assert.match(reply.description, /clientRequestId 是整个工具调用的重试键/);
  assert.match(reply.description, /clientMessageId 是这条消息的去重键/);
  // handle 的默认值写进 API 文档，避免调用方以为不传就没有短名。
  const start = tools.find((tool) => tool.name === 'session_start');
  const get = tools.find((tool) => tool.name === 'get_session');
  assert.match(String(start?.description), /没显式传 handle 时用默认短名/);
  assert.match(String(get?.description), /没显式设 handle 时是默认短名/);
});

test('MCP clientRequestId：非字符串 / 空值 / 超长直接拒绝且不截断；trim 后同键重试回放', async () => {
  const { david, mint, api, app } = await setup();
  const project = (await david('/api/projects', post({ name: 'client-request-id' }))).body as { id: string };
  const token = (await mint(david, ['projects:read', 'projects:write'])).token;
  const rest = api(token);
  const replays = replayStore();
  const rpc = async (arguments_: Record<string, unknown>) => {
    const response = await app.fetch(
      new Request('http://hub/openapi/v1/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'task_create', arguments: arguments_ } })
      }),
      { mcpReplays: replays, mcpPolicy: { modules: new Set(['tasks']), readOnly: false, writes: true } }
    );
    return (await response.json()) as any;
  };
  const base = { projectId: project.id, title: '重试键' };
  const rejected: [string, unknown, RegExp][] = [
    ['缺省', undefined, /clientRequestId/],
    ['数字', 42, /必须是字符串/],
    ['null', null, /必须是字符串/],
    ['对象', { id: 'x' }, /必须是字符串/],
    ['空串', '', /不能为空/],
    ['纯空白', '   ', /不能为空/],
    ['超长', 'x'.repeat(201), /最多 200/],
    ['换行', 'line\r\nbreak', /HTTP 头/],
    ['非 Latin-1', 'key-🔑', /HTTP 头/]
  ];
  for (const [label, clientRequestId, pattern] of rejected) {
    const result = await rpc({ ...base, ...(clientRequestId === undefined ? {} : { clientRequestId }) });
    assert.equal(result.result.isError, true, `${label}: 应该被拒绝`);
    assert.match(result.result.content[0].text, pattern, `${label}: 报错要说清原因`);
  }
  // 拒绝发生在转成 v1 请求之前：一条任务都没建。
  assert.equal(((await rest(`/tasks?projectId=${project.id}`)).body as unknown[]).length, 0);
  // 生成层和运行时同一份规则：换行、非 ByteString 直接拒绝；正常标点仍然可以当键。
  for (const bad of ['line\r\nbreak', 'key-🔑']) {
    assert.equal(clientRequestIdSchema.safeParse(bad).success, false, `${JSON.stringify(bad)} 应该被 schema 拒绝`);
  }
  const punctuationKey = 'retry:2026-11-21/a_b.c~!';
  assert.equal(clientRequestIdSchema.safeParse(punctuationKey).success, true, '标点组成的键应该仍然可用');
  const punctuation = await rpc({ ...base, title: '标点键', clientRequestId: punctuationKey });
  assert.equal(punctuation.result.isError, false, JSON.stringify(punctuation.result));

  // trim 后同一个键：真正重试返回同一份结果。
  const first = await rpc({ ...base, clientRequestId: '  same-key  ' });
  assert.equal(first.result.isError, false, JSON.stringify(first.result));
  const second = await rpc({ ...base, clientRequestId: 'same-key' });
  assert.equal(second.result.isError, false, JSON.stringify(second.result));
  assert.deepEqual(second.result.structuredContent, first.result.structuredContent);
  const other = await rpc({ ...base, clientRequestId: 'other-key' });
  assert.notEqual(other.result.structuredContent.id, first.result.structuredContent.id);

  // 同一个键换了请求体：沿用幂等中间件的 409 语义，既不回放旧结果，也不重新执行。
  const conflictFirst = await rpc({ ...base, title: '冲突 A', clientRequestId: 'conflict-key' });
  assert.equal(conflictFirst.result.isError, false, JSON.stringify(conflictFirst.result));
  const conflictSecond = await rpc({ ...base, title: '冲突 B', clientRequestId: 'conflict-key' });
  assert.equal(conflictSecond.result.isError, true);
  assert.match(conflictSecond.result.content[0].text, /HTTP 409/);
  assert.match(conflictSecond.result.content[0].text, /不同的请求体/);
  const replay = await rpc({ ...base, title: '冲突 A', clientRequestId: 'conflict-key' });
  assert.deepEqual(replay.result.structuredContent, conflictFirst.result.structuredContent);
  assert.equal(((await rest(`/tasks?projectId=${project.id}`)).body as unknown[]).length, 4);
});

test('session_start / get_session 的 handle 与 session_peers 同源（REST 与 MCP）', async () => {
  const { david, mint, api, app, world, messaging } = await setup(undefined, undefined, true);
  assert.ok(messaging, '这条用例要装消息总线');
  const token = (await mint(david, ['projects:read', 'projects:write', 'sessions:read', 'sessions:write', 'workers:read'])).token;
  const call = api(token);
  const project = (await call('/projects', post({ name: 'handle' }))).body as { id: string };
  const task = (await call('/tasks', post({ projectId: project.id, title: 't', goal: '' }))).body as { id: string };
  world.workers.push({ workerId: 'w1', label: 'w1', origin: 'remote', state: 'online' } as never);
  const ws = newWorkspace({ projectId: project.id as never, workerId: 'w1', path: '/srv/handle', kind: 'long_lived', source: 'linked', now: 1 });
  assert.ok(ws.ok);
  await world.deps.workspaces.save(ws.value);

  const started = await call('/sessions', post({ taskId: task.id, agentId: 'fake', model: 'm1', workspaceId: ws.value.id, handle: 'dev' }));
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.equal(started.body.handle, 'dev');
  assert.equal(sessionWithHandleSchema.parse(started.body).handle, 'dev');
  const got = await call(`/sessions/${started.body.id}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.handle, 'dev');

  // 没显式设短名：start/get 给默认短名（和 peers 展示的是同一个），不是 null。
  const peer = await call('/sessions', post({ taskId: task.id, agentId: 'fake', model: 'm1', workspaceId: ws.value.id, linkWith: [started.body.id] }));
  assert.equal(peer.status, 201, JSON.stringify(peer.body));
  assert.equal(peer.body.handle, defaultHandle(peer.body));
  assert.equal((await call(`/sessions/${peer.body.id}`)).body.handle, defaultHandle(peer.body));

  // peer 列表里 dev 的 handle 与 start/get 完全一致。
  const peers = await call(`/sessions/${peer.body.id}/peers`);
  assert.equal(peers.status, 200, JSON.stringify(peers.body));
  const explicitPeer = peers.body.peers.find((item: { address: string }) => item.address === `session:${started.body.id}`);
  assert.equal(explicitPeer?.handle, 'dev');
  assert.equal(explicitPeer?.relation, 'explicit');
  assert.equal(explicitPeer?.connected, true);

  // MCP 的 session_start / get_session 走同一份响应。
  const rpc = async (name: string, args: Record<string, unknown>, id = 1) => {
    const response = await app.fetch(
      new Request('http://hub/openapi/v1/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
      }),
      { mcpReplays: replayStore(), mcpPolicy: { modules: new Set(['sessions']), readOnly: false, writes: true } }
    );
    return (await response.json()) as any;
  };
  const viaMcp = await rpc('session_start', { taskId: task.id, agentId: 'fake', model: 'm1', workspaceId: ws.value.id, handle: 'mcp-dev', clientRequestId: 'mcp-handle-1' });
  assert.equal(viaMcp.result.isError, false, JSON.stringify(viaMcp.result));
  const mcpSession = JSON.parse(viaMcp.result.content[0].text) as { id: string; handle: string };
  assert.equal(mcpSession.handle, 'mcp-dev');
  assert.equal(sessionWithHandleSchema.parse(mcpSession).handle, 'mcp-dev');
  const mcpGet = await rpc('get_session', { sessionId: mcpSession.id }, 2);
  assert.equal(mcpGet.result.isError, false, JSON.stringify(mcpGet.result));
  assert.equal(JSON.parse(mcpGet.result.content[0].text).handle, 'mcp-dev');
  const mcpPeers = await rpc('session_peers', { sessionId: mcpSession.id }, 3);
  assert.equal(mcpPeers.result.isError, false, JSON.stringify(mcpPeers.result));
  const taskPeer = JSON.parse(mcpPeers.result.content[0].text).peers.find((item: { address: string }) => item.address === `session:${started.body.id}`);
  assert.equal(taskPeer?.relation, 'task_tree');
  assert.notEqual(taskPeer?.connected, true);
});

const b64 = (text: string) => Buffer.from(text).toString('base64');
const skillFiles = (body: string) => [{ path: 'SKILL.md', data: b64(`---\nname: greeter\ndescription: Greets people\n---\n${body}\n`) }];

test('资产自动化：assets:publish 能导入 → 发布 → 分配；没有该 scope 时 403；非集群管理员发布全局 403', async () => {
  const { david, mint, app, accounts, assetsStore, browser, world, enrolledBy } = await setup();
  const replays = new Map<string, string>();
  const store = {
    async get(key: string) {
      return replays.get(key) ?? null;
    },
    async put(key: string, body: string) {
      replays.set(key, body);
    }
  };
  const mcp = (token: string) => async (name: string, args: Record<string, unknown>) => {
    const response = await app.fetch(
      new Request('http://hub/openapi/v1/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
      }),
      { mcpReplays: store, mcpPolicy: { modules: new Set(['assets']), readOnly: false, writes: true } }
    );
    return (await response.json().catch(() => null)) as any;
  };

  const publishToken = (await mint(david, ['assets:read', 'assets:write', 'assets:publish'])).token;
  const plainToken = (await mint(david, ['assets:read', 'assets:write'])).token;
  const publish = mcp(publishToken);
  const plain = mcp(plainToken);

  // 1) 导入：publish=true 要 assets:publish；没给就在碰仓库之前 403
  const blocked = await plain('asset_import', { kind: 'skill', url: 'https://example.com/x.git', path: 'skills/foo', publish: true, clientRequestId: 'imp-0' });
  assert.equal(blocked.result.isError, true, JSON.stringify(blocked.result));
  assert.match(blocked.result.content[0].text, /403/);
  assert.match(blocked.result.content[0].text, /assets:publish/);
  // 空 path 也拒（否则技能会把整个仓库拖进来）—— 复用 create 之外的分支，走的是 400
  const noPath = await publish('asset_import', { kind: 'skill', url: 'https://example.com/x.git', clientRequestId: 'imp-1' });
  assert.equal(noPath.result.isError, true, JSON.stringify(noPath.result));
  assert.match(noPath.result.content[0].text, /400/);

  // 2) 建资产（待审核）→ 发布 → 分配
  const created = await publish('asset_create', { kind: 'skill', files: skillFiles('v1'), clientRequestId: 'create-1' });
  assert.equal(created.result.isError, false, JSON.stringify(created.result));
  const asset = created.result.structuredContent as { id: string; pinned: string; latest: string };
  assert.equal(asset.pinned, '');
  assert.notEqual(asset.latest, '');

  const published = await publish('asset_publish', { assetId: asset.id, clientRequestId: 'publish-1' });
  assert.equal(published.result.isError, false, JSON.stringify(published.result));
  assert.equal(published.result.structuredContent.pinned, asset.latest);
  // 返回的是对外视图（列表同款），不是领域对象：有 workerIds/files/bytes，没有内部 tokenSecret。
  const view = published.result.structuredContent as { workerIds: string[]; files: number; bytes: number; source: { tokenSecret?: string } };
  assert.ok(Array.isArray(view.workerIds));
  assert.equal(typeof view.files, 'number');
  assert.equal(typeof view.bytes, 'number');
  assert.equal(view.source.tokenSecret, undefined);
  // 再发一次：没有待发布的新版本 → 409
  const again = await publish('asset_publish', { assetId: asset.id, clientRequestId: 'publish-2' });
  assert.equal(again.result.isError, true);
  assert.match(again.result.content[0].text, /409/);

  const assigned = await publish('asset_assign', { assetId: asset.id, workerId: 'w1', clientRequestId: 'assign-1' });
  assert.equal(assigned.result.isError, false, JSON.stringify(assigned.result));
  assert.deepEqual(assigned.result.structuredContent, { assetId: asset.id, workerId: 'w1', installed: true });
  assert.ok(assetsStore.installs.some((row) => row.assetId === asset.id && row.workerId === 'w1'));

  // 2b) 跨团队机器（#230）：凭据归属另一个团队 → 403，不能把资产装到别人的机器上
  await accounts.users.save({
    id: 'u-outsider',
    email: 'outsider@x.co',
    displayName: 'outsider',
    role: 'member',
    passwordHash: null,
    emailVerifiedAt: 1,
    disabledAt: null,
    createdAt: 1,
    teamId: 't-other',
    clusterAdmin: false,
    deletedAt: null
  } as never);
  enrolledBy.set('w-other', 'u-outsider');
  world.workers.push({ workerId: 'w-other', label: 'other', origin: 'remote', state: 'online' } as never);
  assetsStore.workers.push({ workerId: 'w-other', label: 'other', origin: 'remote', state: 'online' } as never);
  const crossTeam = await publish('asset_assign', { assetId: asset.id, workerId: 'w-other', clientRequestId: 'assign-other' });
  assert.equal(crossTeam.result.isError, true, JSON.stringify(crossTeam.result));
  assert.match(crossTeam.result.content[0].text, /403/);
  assert.ok(!assetsStore.installs.some((row) => row.assetId === asset.id && row.workerId === 'w-other'));

  // 3) 没有 assets:publish：发布 / 分配都 403
  const publishDenied = await plain('asset_publish', { assetId: asset.id, clientRequestId: 'publish-3' });
  assert.equal(publishDenied.result.isError, true);
  assert.match(publishDenied.result.content[0].text, /403/);
  const assignDenied = await plain('asset_assign', { assetId: asset.id, workerId: 'w1', clientRequestId: 'assign-2' });
  assert.equal(assignDenied.result.isError, true);
  assert.match(assignDenied.result.content[0].text, /403/);
  // 没 assets:write 的令牌连导入都进不去
  const readOnlyToken = (await mint(david, ['assets:read'])).token;
  const importDenied = await mcp(readOnlyToken)('asset_import', { kind: 'skill', url: 'https://example.com/x.git', path: 'skills/foo', clientRequestId: 'imp-2' });
  assert.equal(importDenied.result.isError, true);
  assert.match(importDenied.result.content[0].text, /403/);

  // 4) 全局资产：非集群管理员发布 403（全局发布只有集群管理员能做）
  // 管理后台要另装 admin 路由，这里直接用领域用例造一个全局资产
  const boss = (await accounts.users.firstClusterAdmin())!;
  const globalMade = await uploadAsset(assetsStore.deps, {
    kind: 'skill',
    projectId: null,
    files: [{ path: 'SKILL.md', data: new Uint8Array(Buffer.from(`---\nname: greeter\ndescription: Greets people\n---\nglobal\n`)) }],
    scope: 'global',
    ownerId: boss.id,
    teamId: null,
    publish: true
  });
  assert.ok(globalMade.ok, JSON.stringify(globalMade));
  const global = { id: globalMade.value.id };
  assert.equal(globalMade.value.scope, 'global');
  await addTeamMember(accounts, 'a@b.co', PASSWORD, 'owner');
  const adminBrowser = browser();
  assert.equal((await adminBrowser('/api/auth/login', post({ email: 'a@b.co', password: PASSWORD }))).status, 200);
  const adminToken = (await mint(adminBrowser, ['assets:read', 'assets:write', 'assets:publish'])).token;
  const globalDenied = await mcp(adminToken)('asset_publish', { assetId: global.id, clientRequestId: 'publish-global' });
  assert.equal(globalDenied.result.isError, true, JSON.stringify(globalDenied.result));
  assert.match(globalDenied.result.content[0].text, /403/);
  assert.match(globalDenied.result.content[0].text, /集群管理员/);
  // 审计留痕：发布 / 分配都写进了活动日志，且看得出是经哪个令牌做的
  const actions = accounts.auditRows.map((row) => row.action);
  assert.ok(actions.includes('asset.publish'));
  assert.ok(actions.includes('asset.install'));
  assert.ok(accounts.auditRows.some((row) => row.action === 'asset.publish' && row.detail.includes('经令牌')));
});

test('项目级资产发布：同团队非项目成员的令牌 403；项目成员 / 负责人可以（#230）', async () => {
  const { david, mint, api, accounts, browser, assetsStore } = await setup();
  const boss = (await accounts.users.firstClusterAdmin())!;
  const project = (await david('/api/projects', post({ name: '项目' }))).body as { id: string; name: string; teamId: string; createdBy: string; members?: string[] };
  assetsStore.projectList.set(project.id, { id: project.id, name: project.name, teamId: project.teamId, createdBy: project.createdBy, members: project.members ?? [boss.id], deletedAt: null } as never);
  const made = await uploadAsset(assetsStore.deps, {
    kind: 'skill',
    projectId: project.id,
    files: skillFiles('p1').map((file) => ({ path: file.path, data: Buffer.from(file.data, 'base64') })),
    scope: 'project',
    ownerId: boss.id,
    teamId: boss.teamId,
    publish: false
  });
  assert.ok(made.ok, JSON.stringify(made));

  // 同团队成员、但不是项目成员：assets:publish 也不能发布项目级资产
  await addTeamMember(accounts, 'm@b.co', PASSWORD, 'member');
  const member = browser();
  assert.equal((await member('/api/auth/login', post({ email: 'm@b.co', password: PASSWORD }))).status, 200);
  const memberToken = (await mint(member, ['assets:read', 'assets:write', 'assets:publish'])).token;
  const denied = await api(memberToken)(`/assets/${made.value.id}/publish`, post({}));
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  assert.equal((await assetsStore.deps.assets.get(made.value.id))?.pinned, '');

  const ownerToken = (await mint(david, ['assets:read', 'assets:write', 'assets:publish'])).token;
  const published = await api(ownerToken)(`/assets/${made.value.id}/publish`, post({}));
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.equal(published.body.pinned, made.value.latest);
});

test('/openapi/v1/projects：仓库只给 hasToken，令牌名 / 明文都不出去', async () => {
  const { david, mint, api } = await setup();
  const project = (await david('/api/projects', post({ name: 'p' }))).body;
  const saved = await david(`/api/projects/${project.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ repos: [{ name: 'api', url: 'https://gitlab.test/me/api.git', credential: 'glpat-abc' }] })
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const read = api((await mint(david, ['projects:read'])).token);
  const got = await read(`/projects/${project.id}`);
  assert.equal(got.status, 200, JSON.stringify(got.body));
  assert.equal(got.body.repos[0].hasToken, true);
  assert.equal('tokenSecret' in got.body.repos[0], false);
  assert.equal(JSON.stringify(got.body).includes('glpat-abc'), false);
  const list = await read('/projects');
  assert.equal(JSON.stringify(list.body).includes('repo-git:'), false);
});

test('MCP 工具清单按令牌权限筛：只列令牌用得了的（#E4）', () => {
  const policy = { modules: new Set(['tasks', 'projects', 'sessions', 'assets'] as const), writes: true };
  const names = (scopes: Parameters<typeof permissionsOf>[0]) => mcpToolsFor(permissionsOf(scopes), policy).map((t) => t.name).sort();
  assert.deepEqual(names(['assets:read']), ['get_asset', 'list_assets', 'list_builtin_assets']);
  // 交资产（进审核）不等于发布 / 分配；启用内置资产属于「交」这一档（内部还有项目权限闸）
  assert.deepEqual(names(['assets:write']), ['asset_create', 'asset_import', 'enable_builtin_asset', 'get_asset', 'list_assets', 'list_builtin_assets']);
  assert.ok(names(['assets:publish']).includes('asset_publish') && names(['assets:publish']).includes('asset_assign'));
  // 只有 sessions:write 看不到项目写工具
  const sessions = names(['sessions:write']);
  assert.ok(sessions.includes('session_start') && !sessions.includes('project_create') && !sessions.includes('list_projects'));
  assert.ok(sessions.includes('session_settle') && sessions.includes('session_git_run') && sessions.includes('session_git_state'));
  // 没有令牌信息（单测直接调）时不筛
  assert.equal(mcpToolsFor(undefined, policy).length, mcpTools(policy).length);
});

test('外部接入：限定项目的令牌经 MCP 只看得到选中的项目；调用写进令牌的调用记录', async () => {
  const { david, app } = await setup();
  const mine = (await david('/api/projects', post({ name: '甲' }))).body as { id: string };
  const other = (await david('/api/projects', post({ name: '乙' }))).body as { id: string };
  const created = await david('/api/tokens', post({ name: 'scoped', scopes: ['projects:read'], projectIds: [mine.id] }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { token, info } = created.body as { token: string; info: { id: string; projectIds: string[] } };
  assert.deepEqual(info.projectIds, [mine.id]);
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const response = await app.fetch(
      new Request('http://hub/openapi/v1/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
      })
    );
    return (await response.json()) as any;
  };
  const listed = await rpc('list_projects', {});
  assert.equal(listed.result.isError, false, JSON.stringify(listed));
  const names = JSON.stringify(listed.result.structuredContent);
  assert.ok(names.includes('甲') && !names.includes('乙'), names);
  const denied = await rpc('get_project', { projectId: other.id });
  assert.equal(denied.result.isError, true);
  // 调用记录：每次 tools/call 一条，只有工具名和结果
  const activity = await david(`/api/tokens/${info.id}/activity`);
  assert.equal(activity.status, 200);
  const calls = (activity.body as { action: string; detail: string }[]).filter((row) => row.action === 'mcp.call');
  assert.equal(calls.length, 2);
  assert.ok(calls.some((row) => row.detail.startsWith('list_projects · 成功')));
  assert.ok(calls.some((row) => row.detail.startsWith('get_project · 失败')));
  // 能用的工具数：projects:read → 项目 + 任务的只读工具
  const tools = await david(`/api/tokens/${info.id}/tools`);
  assert.deepEqual((tools.body as { tools: { name: string }[] }).tools.map((t) => t.name).sort(), ['get_project', 'get_task', 'list_projects', 'list_task_log', 'list_tasks', 'resolve_default_agent', 'task_pull_requests', 'team_agent_defaults', 'workspace_changes', 'workspace_group_get', 'workspace_sweep_records']);
});

test('外部接入：轮换后旧令牌 401、新令牌可用，旧记录留在列表里', async () => {
  const { david, api, mint } = await setup();
  const first = await mint(david, ['projects:read']);
  const rotated = await david(`/api/tokens/${first.info.id}/rotate`, post({}));
  assert.equal(rotated.status, 201, JSON.stringify(rotated.body));
  const next = rotated.body as { token: string; info: { id: string } };
  assert.equal((await api(first.token)('/projects')).status, 401);
  assert.equal((await api(next.token)('/projects')).status, 200);
  const list = (await david('/api/tokens')).body as { id: string; revokedAt: number | null }[];
  assert.ok(list.some((t) => t.id === first.info.id && t.revokedAt !== null));
  // 吊销同样保留记录
  assert.equal((await david(`/api/tokens/${next.info.id}`, { method: 'DELETE' })).status, 200);
  assert.ok(((await david('/api/tokens')).body as { id: string; revokedAt: number | null }[]).some((t) => t.id === next.info.id && t.revokedAt !== null));
});

test('外部接入：只读模式——默认按令牌权限放行，集群管理员可强制只读；null 恢复默认；成员不能改', async () => {
  const { david, mint, app, browser, accounts } = await setup();
  const token = (await mint(david, ['projects:read', 'projects:write'])).token;
  const toolNames = async () => {
    const response = await app.fetch(
      new Request('http://hub/openapi/v1/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
      })
    );
    return ((await response.json()) as any).result.tools.map((t: { name: string }) => t.name) as string[];
  };
  const before = (await david('/api/mcp/access')).body as { readOnly: boolean; source: string; canManage: boolean };
  assert.equal(before.source, 'env');
  assert.equal(before.readOnly, false, '默认不强制只读，写不写由令牌 scope 决定');
  assert.equal(before.canManage, true, '第一个注册的人是集群管理员');
  assert.ok((await toolNames()).includes('task_create'), '有 task.create 权限的令牌默认就能看到写工具');
  const on = await david('/api/mcp/access', { method: 'PUT', body: JSON.stringify({ readOnly: true }) });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.deepEqual({ readOnly: on.body.readOnly, source: on.body.source }, { readOnly: true, source: 'setting' });
  assert.ok(!(await toolNames()).includes('task_create'), '强制只读时写工具不出现');
  const reset = await david('/api/mcp/access', { method: 'PUT', body: JSON.stringify({ readOnly: null }) });
  assert.equal(reset.body.source, 'env');
  assert.ok((await toolNames()).includes('task_create'));
  // 同一份清单，只读令牌仍然只拿到只读工具
  const reader = (await mint(david, ['projects:read'])).token;
  const readTools = await (async () => {
    const response = await app.fetch(
      new Request('http://hub/openapi/v1/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${reader}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
      })
    );
    return ((await response.json()) as any).result.tools.map((t: { name: string }) => t.name) as string[];
  })();
  assert.ok(!readTools.includes('task_create'));
  // 团队里的普通成员：能看不能改
  await addTeamMember(accounts, 'eve@b.co', PASSWORD);
  const eve = browser();
  assert.equal((await eve('/api/auth/login', post({ email: 'eve@b.co', password: PASSWORD }))).status, 200);
  const eveView = await eve('/api/mcp/access');
  assert.equal(eveView.status, 200);
  assert.equal(eveView.body.canManage, false);
  assert.equal((await eve('/api/mcp/access', { method: 'PUT', body: JSON.stringify({ readOnly: true }) })).status, 403);
});

test('外部接入：限定项目的令牌能用项目所在团队的团队资产（读 + 按权限写）；别的团队 404；个人资产看不到；项目不在团队里就没有团队资产', async () => {
  const { david, mint, api, assetsStore, world, accounts } = await setup();
  const mine = (await david('/api/projects', post({ name: '甲' }))).body as { id: string; teamId: string };
  const elsewhere = (await david('/api/projects', post({ name: '乙' }))).body as { id: string; teamId: string };
  const namedSkill = (name: string) => [{ path: 'SKILL.md', data: b64(`---\nname: ${name}\ndescription: ${name}\n---\nhi\n`) }];
  const myId = (await accounts.users.firstClusterAdmin())!.id;
  for (const p of [mine, elsewhere]) assetsStore.projectList.set(p.id, { id: p.id, name: p.id, teamId: p.teamId, createdBy: myId, members: [myId], deletedAt: null } as never);
  const make = async (name: string, scope: 'team' | 'global' | 'personal' | 'project', teamId: string | null, projectId: string | null = null) => {
    const made = await uploadAsset(assetsStore.deps, {
      kind: 'skill',
      name,
      projectId,
      files: skillFiles(name).map((file) => ({ path: file.path, data: Buffer.from(file.data, 'base64') })),
      scope,
      ownerId: myId,
      teamId,
      publish: true
    });
    assert.ok(made.ok, JSON.stringify(made));
    return made.value.id;
  };
  const teamAsset = await make('team-own', 'team', mine.teamId);
  const otherTeam = await make('team-other', 'team', 'team-somebody-else');
  const global = await make('global-one', 'global', null);
  const personal = await make('personal-one', 'personal', mine.teamId);
  const inProject = await make('project-mine', 'project', mine.teamId, mine.id);
  const outProject = await make('project-other', 'project', mine.teamId, elsewhere.id);

  const writer = (await mint(david, ['assets:read', 'assets:write', 'projects:read'], { projectIds: [mine.id] })).token;
  const call = api(writer);
  // 读：同团队团队资产、全局、范围内项目资产可见；别的团队、个人、范围外项目都看不到
  const listed = await call('/assets');
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  const ids = (listed.body as { id: string }[]).map((a) => a.id);
  for (const id of [teamAsset, global, inProject]) assert.ok(ids.includes(id), `应可见 ${id}`);
  for (const id of [otherTeam, personal, outProject]) assert.ok(!ids.includes(id), `不应可见 ${id}`);
  assert.equal((await call(`/assets/${teamAsset}`)).status, 200);
  assert.equal((await call(`/assets/${otherTeam}`)).status, 404);
  assert.equal((await call(`/assets/${personal}`)).status, 404);
  // 写：有 assets:write 就能给同团队的团队资产交新版本、建团队资产；个人资产不行；别的团队的照样 404
  const revised = await call(`/assets/${teamAsset}/revisions`, post({ files: skillFiles('team-own v2') }));
  assert.equal(revised.status, 200, JSON.stringify(revised.body));
  assert.equal((await call(`/assets/${otherTeam}/revisions`, post({ files: skillFiles('x') }))).status, 404);
  const createdTeam = await call('/assets', post({ kind: 'skill', scope: 'team', files: namedSkill('team-new') }));
  assert.equal(createdTeam.status, 201, JSON.stringify(createdTeam.body));
  assert.equal((await call('/assets', post({ kind: 'skill', scope: 'personal', files: namedSkill('mine-new') }))).status, 403);
  // 只读令牌：看得到团队资产，但交不了新版本
  const reader = (await mint(david, ['assets:read'], { projectIds: [mine.id] })).token;
  assert.equal((await api(reader)(`/assets/${teamAsset}`)).status, 200);
  assert.equal((await api(reader)(`/assets/${teamAsset}/revisions`, post({ files: skillFiles('nope') }))).status, 403);

  // 项目不在任何团队里（hub 项目）：限定到它的令牌没有团队资产可用；全局照样可读
  const loose = (await mint(david, ['assets:read', 'assets:write'], { projectIds: [elsewhere.id] })).token;
  const project = (await world.deps.projects.byId(elsewhere.id as never))!;
  await world.deps.projects.save({ ...project, teamId: null } as never);
  assert.equal((await api(loose)(`/assets/${teamAsset}`)).status, 404);
  assert.equal((await api(loose)(`/assets/${global}`)).status, 200);
  assert.equal((await api(loose)(`/assets/${teamAsset}/revisions`, post({ files: skillFiles('nope') }))).status, 404);
  assert.equal((await api(loose)('/assets', post({ kind: 'skill', scope: 'team', files: namedSkill('team-x') }))).status, 403);
});

test('开放 API project_repos：令牌只写不读，响应只有 hasToken；MCP 工具按写开关出现', async () => {
  const { david, mint, app, api } = await setup();
  const project = (await david('/api/projects', post({ name: '私有仓库' }))).body as { id: string };
  const token = (await mint(david, ['projects:read', 'projects:write'])).token;
  const call = api(token);

  const saved = await call(`/projects/${project.id}/repos`, {
    method: 'PUT',
    body: JSON.stringify({ repos: [{ name: 'api', url: 'https://gitlab.test/me/api.git', credential: 'glpat-secret' }] })
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.repos[0].hasToken, true);
  assert.equal(JSON.stringify(saved.body).includes('glpat'), false);
  assert.equal('tokenSecret' in saved.body.repos[0], false);

  // 省略 credential = 不动已有的令牌
  const kept = await call(`/projects/${project.id}/repos`, {
    method: 'PUT',
    body: JSON.stringify({ repos: [{ name: 'api', url: 'https://gitlab.test/me/api.git' }] })
  });
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  assert.equal(kept.body.repos[0].hasToken, true);

  // MCP：写开关关着就列不出来，打开后能调
  const rpc = async (body: unknown, policy?: { writes?: boolean; readOnly?: boolean }) => {
    const response = await app.fetch(
      new Request('http://hub/openapi/v1/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify(body)
      }),
      { mcpPolicy: { modules: new Set(['projects']), readOnly: false, writes: false, ...policy } }
    );
    return (await response.json().catch(() => null)) as any;
  };
  const closed = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  assert.ok(!closed.result.tools.some((t: { name: string }) => t.name === 'project_repos'));
  const open = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { writes: true });
  const tool = open.result.tools.find((t: { name: string }) => t.name === 'project_repos');
  assert.ok(tool);
  assert.equal(tool.annotations.readOnlyHint, false);
  const cleared = await rpc(
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'project_repos', arguments: { projectId: project.id, repos: [{ name: 'api', url: 'https://gitlab.test/me/api.git', credential: '' }], clientRequestId: 'req-repos' } } },
    { writes: true }
  );
  assert.equal(cleared.result.isError, false, JSON.stringify(cleared.result));
  assert.equal(cleared.result.structuredContent.hasToken === undefined ? cleared.result.structuredContent.repos[0].hasToken : cleared.result.structuredContent.hasToken, false);
});

test('MCP session_model：写工具要 clientRequestId，换模型不重启进程（同提供商）', async () => {
  const { david, mint, app, world, api } = await setup();
  const token = (await mint(david, ['projects:read', 'projects:write', 'sessions:read', 'sessions:write', 'workers:read'])).token;
  const call = api(token);
  const project = (await call('/projects', post({ name: '换模型' }))).body;
  const task = (await call('/tasks', post({ projectId: project.id, title: 't', goal: '' }))).body;
  world.workers.push({ workerId: 'w1', label: 'w1', origin: 'remote', state: 'online' } as never);
  const workspace = newWorkspace({ projectId: project.id, workerId: 'w1', path: '/srv/y', kind: 'long_lived', source: 'linked', now: 1 });
  assert.ok(workspace.ok);
  await world.deps.workspaces.save(workspace.value);
  const session = await call('/sessions', post({ taskId: task.id, agentId: 'fake', model: 'm1', workspaceId: workspace.value.id }));
  assert.equal(session.status, 201, JSON.stringify(session.body));

  const rpc = async (body: unknown, policy?: { writes?: boolean }) => {
    const response = await app.fetch(
      new Request('http://hub/openapi/v1/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify(body)
      }),
      { mcpPolicy: { modules: new Set(['sessions']), readOnly: false, writes: true, ...policy } }
    );
    return (await response.json().catch(() => null)) as any;
  };

  const list = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const tool = list.result.tools.find((t: { name: string }) => t.name === 'session_model');
  assert.ok(tool, 'MCP_WRITE 打开时会话工具里有 session_model');
  assert.equal(tool.annotations.readOnlyHint, false);
  const hidden = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { writes: false });
  assert.ok(!hidden.result.tools.some((t: { name: string }) => t.name === 'session_model'));

  const noKey = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'session_model', arguments: { sessionId: session.body.id, model: 'm2' } } });
  assert.equal(noKey.result.isError, true);
  assert.match(noKey.result.content[0].text, /clientRequestId/);

  const changed = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'session_model', arguments: { sessionId: session.body.id, model: 'm2', clientRequestId: 'req-model' } } });
  assert.equal(changed.result.isError, false, JSON.stringify(changed.result));
  // 同一提供商：只下发 set_option，不重启进程（换提供商才走 switchSessionModel）。
  const frame = world.dispatched.filter((c: { kind: string }) => c.kind === 'set_option').at(-1) as { optionId?: string; value?: unknown } | undefined;
  assert.equal(frame?.optionId, 'model');
  assert.equal(frame?.value, 'm2');
});

test('MCP 多仓工具：写要 clientRequestId；缺 git 时 503；缺主仓库建组失败', async () => {
  const { david, mint, app } = await setup();
  const token = (await mint(david, ['projects:read', 'projects:write', 'sessions:read', 'sessions:write', 'files:read', 'workers:read'])).token;
  const rpc = async (body: unknown) => {
    const response = await app.fetch(
      new Request('http://hub/openapi/v1/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify(body)
      }),
      { mcpPolicy: { readOnly: false, writes: true } }
    );
    return (await response.json().catch(() => null)) as any;
  };
  const list = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const names = (list.result.tools as { name: string }[]).map((t) => t.name);
  for (const name of [
    'workspace_group_create',
    'workspace_group_get',
    'workspace_group_add_member',
    'workspace_group_retry',
    'session_git_state',
    'session_git_run',
    'task_pull_requests',
    'session_settle',
    'workspace_sweep',
    'workspace_sweep_records'
  ]) assert.ok(names.includes(name), name);

  const noKey = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'workspace_group_create', arguments: { projectId: 'p', taskId: 't' } } });
  assert.equal(noKey.result.isError, true);
  assert.match(noKey.result.content[0].text, /clientRequestId/);

  const noPrimary = await rpc({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'workspace_group_create', arguments: { projectId: 'missing', taskId: 't', workerId: 'w1', clientRequestId: 'g1' } }
  });
  assert.equal(noPrimary.result.isError, true);

  const noGit = await rpc({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'session_git_state', arguments: { sessionId: 's1', member: 'api' } }
  });
  assert.equal(noGit.result.isError, true);
  assert.match(JSON.stringify(noGit.result), /Git 工作流未就绪|没有这个|不存在|404|503/);
});


test('events：返回 { events, nextAfter }；waitSec 在 sinceTurn 无匹配时才阻塞', async () => {
  const { david, mint, api, world, app } = await setup();
  const token = (await mint(david, ['projects:read', 'projects:write', 'sessions:read', 'sessions:write', 'workers:read'])).token;
  const call = api(token);
  const project = (await call('/projects', post({ name: 'wait-events' }))).body;
  const task = (await call('/tasks', post({ projectId: project.id, title: 't', goal: '' }))).body;
  world.workers.push({ workerId: 'w1', label: 'w1', origin: 'remote', state: 'online' } as never);
  const workspace = newWorkspace({ projectId: project.id, workerId: 'w1', path: '/srv/x', kind: 'long_lived', source: 'linked', now: 1 });
  assert.ok(workspace.ok);
  await world.deps.workspaces.save(workspace.value);
  const session = await call('/sessions', post({ taskId: task.id, agentId: 'fake', model: 'm1', workspaceId: workspace.value.id }));
  assert.equal(session.status, 201, JSON.stringify(session.body));
  world.deps.sessions.journal.set(session.body.id, [{ seq: 1, at: 1, event: { kind: 'diagnostic', level: 'info', text: '无轮次' } }]);

  const started = Date.now();
  const empty = await call(`/sessions/${session.body.id}/events?sinceTurn=1&waitSec=1`);
  const elapsed = Date.now() - started;
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.events, []);
  assert.equal(empty.body.nextAfter, 1, '无 turn 的原始事件也要把 nextAfter 推到最后一条 seq');
  assert.ok(elapsed >= 900, `waitSec 应阻塞到超时，实际 ${elapsed}ms`);

  const pending = call(`/sessions/${session.body.id}/events?sinceTurn=1&waitSec=5`);
  await new Promise((r) => setTimeout(r, 200));
  const current = world.deps.sessions.journal.get(session.body.id) ?? [];
  world.deps.sessions.journal.set(session.body.id, [
    ...current,
    { seq: 2, at: Date.now(), turn: 1, event: { kind: 'text', delta: '来了' } }
  ]);
  const got = await pending;
  assert.equal(got.status, 200);
  assert.equal(got.body.events.length, 1);
  assert.equal(got.body.events[0].event.kind, 'text');
  assert.equal(got.body.nextAfter, 2);

  const mcp = await app.fetch(
    new Request('http://hub/openapi/v1/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'events', arguments: { sessionId: session.body.id, sinceTurn: 1 } } })
    })
  );
  const payload = (await mcp.json()) as { result?: { structuredContent?: { events?: unknown; result?: unknown; nextAfter?: number } } };
  const structured = payload.result?.structuredContent;
  assert.ok(structured && Array.isArray(structured.events), JSON.stringify(structured));
  assert.equal('result' in (structured ?? {}), false);
  assert.equal(structured?.nextAfter, 2);
  assert.equal((structured?.events as { event: { kind: string } }[])[0]?.event.kind, 'text');
});

test('events：waitSec 等可投影事件；prompt/thinking 不结束等待，但 nextAfter 仍前进', async () => {
  const { david, mint, api, world } = await setup();
  const token = (await mint(david, ['projects:read', 'projects:write', 'sessions:read', 'sessions:write', 'workers:read'])).token;
  const call = api(token);
  const project = (await call('/projects', post({ name: 'wait-projectable' }))).body;
  const task = (await call('/tasks', post({ projectId: project.id, title: 't', goal: '' }))).body;
  world.workers.push({ workerId: 'w1', label: 'w1', origin: 'remote', state: 'online' } as never);
  const workspace = newWorkspace({ projectId: project.id, workerId: 'w1', path: '/srv/y', kind: 'long_lived', source: 'linked', now: 1 });
  assert.ok(workspace.ok);
  await world.deps.workspaces.save(workspace.value);
  const session = await call('/sessions', post({ taskId: task.id, agentId: 'fake', model: 'm1', workspaceId: workspace.value.id }));
  assert.equal(session.status, 201, JSON.stringify(session.body));
  world.deps.sessions.journal.set(session.body.id, [
    { seq: 1, at: 1, turn: 1, event: { kind: 'prompt', text: 'hi' } },
    { seq: 3, at: 2, turn: 1, event: { kind: 'thinking', delta: '…' } }
  ]);

  const immediate = await call(`/sessions/${session.body.id}/events`);
  assert.deepEqual(immediate.body.events, []);
  assert.equal(immediate.body.nextAfter, 3);

  const started = Date.now();
  const pending = call(`/sessions/${session.body.id}/events?after=0&waitSec=5`);
  await new Promise((r) => setTimeout(r, 200));
  const elapsedWhileWaiting = Date.now() - started;
  assert.ok(elapsedWhileWaiting >= 150, '有 prompt/thinking 时不应立刻返回');
  const current = world.deps.sessions.journal.get(session.body.id) ?? [];
  world.deps.sessions.journal.set(session.body.id, [
    ...current,
    { seq: 8, at: Date.now(), turn: 1, event: { kind: 'text', delta: '好了' } }
  ]);
  const got = await pending;
  const waited = Date.now() - started;
  assert.equal(got.status, 200);
  assert.equal(got.body.events.length, 1);
  assert.equal(got.body.events[0].event.kind, 'text');
  assert.equal(got.body.nextAfter, 8);
  assert.ok(waited < 4000, `有可投影事件后应提前返回，实际 ${waited}ms`);
});


test('project_create / get_project：hasToken=false 时给出配置提示', async () => {
  const { david, mint, api } = await setup();
  const token = (await mint(david, ['projects:read', 'projects:write'])).token;
  const call = api(token);
  const created = await call('/projects', post({ name: 'tok-hint', repoUrl: 'https://github.com/example/demo.git' }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.repos?.[0]?.hasToken, false);
  assert.match(created.body.repos?.[0]?.tokenHint ?? '', /project_repos/);
  assert.match(created.body.gitTokenHint ?? '', /project_repos/);
  const got = await call(`/projects/${created.body.id}`);
  assert.equal(got.body.repos?.[0]?.hasToken, false);
  assert.match(got.body.gitTokenHint ?? '', /credential|project_repos/);
});

test('token MCP：tokens:manage 才能列出/签发；不能提权；明文只出现一次', async () => {
  const { david, mint, app } = await setup();
  const noManage = (await mint(david, ['projects:read'])).token;
  const admin = (await mint(david, ['tokens:manage', 'projects:read', 'sessions:read'])).token;
  const rpc = async (token: string, body: unknown) => {
    const response = await app.fetch(
      new Request('http://hub/openapi/v1/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify(body)
      })
    );
    return (await response.json()) as any;
  };

  const listed = await rpc(noManage, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const names = (listed.result?.tools ?? []).map((t: { name: string }) => t.name);
  assert.ok(!names.includes('token_create') && !names.includes('token_list'));

  const adminList = await rpc(admin, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const adminNames = (adminList.result?.tools ?? []).map((t: { name: string }) => t.name);
  assert.ok(adminNames.includes('token_list') && adminNames.includes('token_create') && adminNames.includes('token_rotate') && adminNames.includes('token_revoke'));

  const denied = await rpc(noManage, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'token_list', arguments: {} }
  });
  assert.equal(denied.result.isError, true);
  assert.match(denied.result.content[0].text, /403|tokens:manage|没有这个工具/);

  const expiresAt = Date.now() + 60 * 60 * 1000;
  const created = await rpc(admin, {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'token_create', arguments: { name: 'e2e-child', scopes: ['projects:read'], expiresAt, clientRequestId: 'tok-1' } }
  });
  assert.equal(created.result.isError, false, JSON.stringify(created.result));
  const info = created.result.structuredContent;
  assert.match(info.token, /^ahp_/);
  assert.equal('token' in info.info, false);
  assert.equal('tokenHash' in info.info, false);
  const plaintext = info.token;

  const escalate = await rpc(admin, {
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'token_create', arguments: { name: 'esc', scopes: ['tokens:manage'], expiresAt, clientRequestId: 'tok-2' } }
  });
  assert.equal(escalate.result.isError, true);
  assert.ok(!JSON.stringify(escalate.result).includes(plaintext));

  const listed2 = await rpc(admin, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'token_list', arguments: {} } });
  assert.equal(listed2.result.isError, false);
  const arr = listed2.result.structuredContent.tokens as { name: string; id: string }[];
  assert.ok(Array.isArray(arr));
  assert.ok(arr.some((row) => row.name === 'e2e-child'));
  assert.ok(arr.every((row) => !('token' in row) && !('tokenHash' in row)));

  const child = arr.find((row) => row.name === 'e2e-child');
  assert.ok(child);
  const childId = child.id;
  const revoked = await rpc(admin, {
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'token_revoke', arguments: { tokenId: childId, clientRequestId: 'tok-3' } }
  });
  assert.equal(revoked.result.isError, false, JSON.stringify(revoked.result));
  assert.ok(revoked.result.structuredContent.revokedAt);
});
test('默认 Agent：读/设/清项目与任务、团队默认、解析生效值；权限与项目范围', async () => {
  const h = await setup();
  const { david, mint, api, accounts } = h;
  const write = api((await mint(david, ['projects:read', 'projects:write'])).token);
  const read = api((await mint(david, ['projects:read'])).token);
  const created = await write('/projects', post({ name: 'defaults-p' }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const projectId = created.body.id as string;
  const task = await write('/tasks', post({ projectId, title: 'defaults-t', goal: '' }));
  assert.equal(task.status, 201, JSON.stringify(task.body));
  const taskId = task.body.id as string;

  const emptyTeam = await read('/team/agent-defaults');
  assert.equal(emptyTeam.status, 200, JSON.stringify(emptyTeam.body));
  assert.deepEqual(emptyTeam.body, { defaults: {} });

  assert.equal((await read('/team/agent-defaults', { method: 'PUT', body: JSON.stringify({ defaults: { fake: 'team-model' } }) })).status, 403);

  const setTeam = await write('/team/agent-defaults', { method: 'PUT', body: JSON.stringify({ defaults: { fake: 'team-model' } }) });
  assert.equal(setTeam.status, 200, JSON.stringify(setTeam.body));
  assert.deepEqual(setTeam.body, { defaults: { fake: 'team-model' } });

  const byRuntime = await write(`/defaults/resolve?projectId=${projectId}&runtime=fake`);
  assert.equal(byRuntime.status, 200, JSON.stringify(byRuntime.body));
  assert.equal(byRuntime.body.effective.runtime, 'fake');
  assert.equal(byRuntime.body.effective.model, 'team-model');
  assert.equal(byRuntime.body.sources.runtime, 'explicit');
  assert.equal(byRuntime.body.sources.model, 'team');

  const setProject = await write(`/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify({ defaultAgent: { runtime: 'fake', model: 'hub-cn-glm-flash/glm-5.3-flash' } }) });
  assert.equal(setProject.status, 200, JSON.stringify(setProject.body));
  assert.equal(setProject.body.defaultAgent.runtime, 'fake');
  assert.equal(setProject.body.defaultAgent.model, 'hub-cn-glm-flash/glm-5.3-flash');
  assert.equal((await read(`/projects/${projectId}`)).body.defaultAgent.model, 'hub-cn-glm-flash/glm-5.3-flash');

  const resolvedProject = await read(`/defaults/resolve?projectId=${projectId}`);
  assert.equal(resolvedProject.status, 200, JSON.stringify(resolvedProject.body));
  assert.equal(resolvedProject.body.effective.runtime, 'fake');
  assert.equal(resolvedProject.body.effective.model, 'hub-cn-glm-flash/glm-5.3-flash');
  assert.deepEqual(resolvedProject.body.sources, { runtime: 'project', model: 'project' });

  assert.equal((await read(`/tasks/${taskId}/default-agent`, { method: 'PATCH', body: JSON.stringify({ defaultAgent: { runtime: 'fake', model: 'task-model' } }) })).status, 403);
  const setTask = await write(`/tasks/${taskId}/default-agent`, { method: 'PATCH', body: JSON.stringify({ defaultAgent: { runtime: 'fake', model: 'task-model' } }) });
  assert.equal(setTask.status, 200, JSON.stringify(setTask.body));
  assert.equal(setTask.body.defaultAgent.model, 'task-model');
  const resolvedTask = await read(`/defaults/resolve?projectId=${projectId}&taskId=${taskId}`);
  assert.equal(resolvedTask.body.effective.model, 'task-model');
  assert.deepEqual(resolvedTask.body.sources, { runtime: 'task', model: 'task' });

  const clearedTask = await write(`/tasks/${taskId}/default-agent`, { method: 'PATCH', body: JSON.stringify({ defaultAgent: null }) });
  assert.equal(clearedTask.status, 200, JSON.stringify(clearedTask.body));
  assert.equal(clearedTask.body.defaultAgent ?? null, null);
  assert.equal((await read(`/defaults/resolve?projectId=${projectId}&taskId=${taskId}`)).body.effective.model, 'hub-cn-glm-flash/glm-5.3-flash');

  const clearedProject = await write(`/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify({ defaultAgent: null }) });
  assert.equal(clearedProject.status, 200);
  assert.equal(clearedProject.body.defaultAgent ?? null, null);
  const afterClear = await read(`/defaults/resolve?projectId=${projectId}&runtime=fake`);
  assert.equal(afterClear.body.effective.model, 'team-model');
  assert.equal(afterClear.body.sources.model, 'team');

  const audit = accounts.auditRows.filter((row) => String(row.detail).includes('默认 Agent'));
  assert.ok(audit.length >= 3, `expected default-agent audit, got ${audit.length}`);

  const elsewhere = await write('/projects', post({ name: 'other-p' }));
  assert.equal(elsewhere.status, 201);
  const scoped = api((await mint(david, ['projects:read', 'projects:write'], { projectIds: [projectId] })).token);
  assert.equal((await scoped('/team/agent-defaults', { method: 'PUT', body: JSON.stringify({ defaults: { fake: 'nope' } }) })).status, 403);
  assert.equal((await scoped(`/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify({ defaultAgent: { runtime: 'fake', model: 'scoped-ok' } }) })).status, 200);
  assert.equal((await scoped(`/projects/${elsewhere.body.id}`, { method: 'PATCH', body: JSON.stringify({ defaultAgent: { runtime: 'fake', model: 'nope' } }) })).status, 404);
  assert.equal((await scoped(`/defaults/resolve?projectId=${elsewhere.body.id}`)).status, 404);

  await addTeamMember(accounts, 'member-defaults@b.co', PASSWORD);
  const memberBrowser = h.browser();
  assert.equal((await memberBrowser('/api/auth/login', post({ email: 'member-defaults@b.co', password: PASSWORD }))).status, 200);
  const memberWrite = api((await mint(memberBrowser, ['projects:read', 'projects:write'])).token);
  const denied = await memberWrite('/team/agent-defaults', { method: 'PUT', body: JSON.stringify({ defaults: { fake: 'member-nope' } }) });
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  const still = await read('/team/agent-defaults');
  assert.deepEqual(still.body, { defaults: { fake: 'team-model' } });
});

/** 公共前置：项目 + 任务 + 远端机器 + 工作目录 + 任务会话（events 既有测试的同一套）。 */
async function waitFixture(setupResult: Awaited<ReturnType<typeof setup>>, name: string) {
  const { david, mint, api, world } = setupResult;
  const token = (await mint(david, ['projects:read', 'projects:write', 'sessions:read', 'sessions:write', 'workers:read'])).token;
  const call = api(token);
  const project = (await call('/projects', post({ name }))).body as { id: string };
  const task = (await call('/tasks', post({ projectId: project.id, title: 't', goal: '' }))).body as { id: string };
  world.workers.push({ workerId: 'w1', label: 'w1', origin: 'remote', state: 'online' } as never);
  const workspace = newWorkspace({ projectId: project.id as never, workerId: 'w1', path: `/srv/${name}`, kind: 'long_lived', source: 'linked', now: 1 });
  assert.ok(workspace.ok);
  await world.deps.workspaces.save(workspace.value);
  const session = await call('/sessions', post({ taskId: task.id, agentId: 'fake', model: 'm1', workspaceId: workspace.value.id }));
  assert.equal(session.status, 201, JSON.stringify(session.body));
  return { token, call, project, session: session.body as { id: string } };
}

test('events：长轮询按令牌限并发（#261 LOW5）：第 6 条挂起的轮询立刻 429', async () => {
  const s = await setup();
  const { call, session, world } = { ...s, ...(await waitFixture(s, 'poll-cap')) };
  const held = Array.from({ length: 5 }, () => call(`/sessions/${session.id}/events?waitSec=50`));
  await new Promise((r) => setTimeout(r, 300)); // 让 5 条都进入挂起状态
  const sixth = await call(`/sessions/${session.id}/events?waitSec=50`);
  assert.equal(sixth.status, 429, JSON.stringify(sixth.body));
  assert.equal(sixth.body.error.code, 'rate_limited');
  assert.ok(sixth.headers.get('retry-after'), '要带 Retry-After');

  // 放一条可投影事件，5 条挂起的轮询全部正常返回；计数随之释放。
  const current = world.deps.sessions.journal.get(session.id) ?? [];
  world.deps.sessions.journal.set(session.id, [
    ...current,
    { seq: 2, at: Date.now(), turn: 1, event: { kind: 'text', delta: '放行' } }
  ]);
  for (const one of held) assert.equal((await one).status, 200);
  assert.equal((await call(`/sessions/${session.id}/events?waitSec=1`)).status, 200, '释放后不再 429');
  // 换一个令牌互不影响（上限按令牌计）。
  const other = (await s.mint(s.david, ['projects:read', 'sessions:read'])).token;
  assert.equal((await s.api(other)(`/sessions/${session.id}/events`)).status, 200);
});

test('events：客户端断开后长轮询立刻停（#261 LOW5）：abort 后不再打库', async () => {
  const s = await setup();
  const { token, session, world, app } = { ...s, ...(await waitFixture(s, 'poll-abort')) };
  let polls = 0;
  const original = world.deps.sessions.eventsAfter.bind(world.deps.sessions);
  (world.deps.sessions as { eventsAfter: typeof original }).eventsAfter = async (...args: Parameters<typeof original>) => {
    polls += 1;
    return original(...args);
  };

  const ac = new AbortController();
  const pending = app.fetch(
    new Request(`http://hub/openapi/v1/sessions/${session.id}/events?waitSec=50`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: ac.signal
    })
  );
  await new Promise((r) => setTimeout(r, 1200)); // 至少两轮 500ms 的轮询
  assert.ok(polls >= 2, `等待期间应该已经在打库（${polls} 次）`);
  const whileWaiting = polls;
  ac.abort();
  const started = Date.now();
  const response = await pending;
  assert.ok(Date.now() - started < 2000, `abort 后应该立刻返回，实际等了 ${Date.now() - started}ms`);
  assert.equal(response.status, 200);
  await response.text(); // 排干响应体，避免悬挂句柄
  const afterAbort = polls;
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(polls, afterAbort, 'abort 后不应该再出现新的 eventsAfter 调用');
  assert.ok(afterAbort >= whileWaiting, `abort 应该立刻停轮询（等待中 ${whileWaiting} 次，之后 ${afterAbort} 次）`);
});

test('#243：容器会话在开放 API 上也按项目限定（events / messages / peers）', async () => {
  const s = await setup(undefined, undefined, true);
  const { david, mint, api, world, messaging } = s;
  assert.ok(messaging, '测试要装消息总线');
  const full = (await mint(david, ['projects:read', 'projects:write', 'sessions:read', 'sessions:write', 'workers:read'])).token;
  const call = api(full);
  const me = (await call('/me')).body.user.id as string;
  const projectA = (await call('/projects', post({ name: 'container-a' }))).body as { id: string };
  const projectB = (await call('/projects', post({ name: 'container-b' }))).body as { id: string };

  world.workers.push({ workerId: 'w1', label: 'w1', origin: 'remote', state: 'online' } as never);
  const wsB = newWorkspace({ projectId: projectB.id as never, workerId: 'w1', path: '/srv/container-b', kind: 'long_lived', source: 'linked', now: 1 });
  assert.ok(wsB.ok);
  await world.deps.workspaces.save(wsB.value);
  // 长期空间可以没有 projectId（归属只作记录）；授权仍应认会话自己的来源项目。
  const wsNoProject = newWorkspace({ projectId: null, workerId: 'w1', path: '/srv/container-unowned', kind: 'long_lived', source: 'linked', now: 1 });
  assert.ok(wsNoProject.ok);
  await world.deps.workspaces.save(wsNoProject.value);
  // 新容器会话的归属来自创建时记录的项目，不是工作空间关联。
  const sessionInput = { agentId: asAgentId('fake'), model: 'm1', now: 1, createdBy: me, workerId: 'w1', workspaceId: wsB.value.id };
  const container = deriveSession({ ...sessionInput, originProjectId: wsB.value.projectId });
  const unowned = deriveSession({ ...sessionInput, workspaceId: wsNoProject.value.id, originProjectId: projectB.id as never });
  const legacy = deriveSession(sessionInput);
  assert.ok(container.ok);
  assert.ok(unowned.ok);
  assert.ok(legacy.ok);
  await world.deps.sessions.save(container.value);
  await world.deps.sessions.save(unowned.value);
  await world.deps.sessions.save(legacy.value);

  const scopedA = api((await mint(david, ['projects:read', 'sessions:read', 'sessions:write', 'workers:read'], { projectIds: [projectA.id] })).token);
  const scopedB = api((await mint(david, ['projects:read', 'sessions:read', 'sessions:write', 'workers:read'], { projectIds: [projectB.id] })).token);
  const path = `/sessions/${container.value.id}`;
  const denied = async (label: string, got: { status: number; text?: string; body?: unknown }) =>
    assert.ok([403, 404].includes(got.status), `${label} 应被项目限定拦下：${got.status} ${JSON.stringify(got.body ?? got.text ?? '')}`);

  await denied('events', await scopedA(`${path}/events`));
  await denied('peers', await scopedA(`${path}/peers`));
  await denied('messages', await scopedA(`${path}/messages`, post({ kind: 'send', body: '你好' })));

  // 对照组：限定在项目 B 的令牌，三条路由都能用。
  assert.equal((await scopedB(`${path}/events`)).status, 200);
  assert.equal((await scopedB(`${path}/peers`)).status, 200);
  const sent = await scopedB(`${path}/messages`, post({ kind: 'send', body: '你好' }));
  assert.equal(sent.status, 201, JSON.stringify(sent.body));

  // 长期空间没有 projectId 也不影响授权：来源项目已经落在会话自己身上。
  const unownedPath = `/sessions/${unowned.value.id}`;
  await denied('events(unowned workspace)', await scopedA(`${unownedPath}/events`));
  await denied('peers(unowned workspace)', await scopedA(`${unownedPath}/peers`));
  await denied('messages(unowned workspace)', await scopedA(`${unownedPath}/messages`, post({ kind: 'send', body: '你好' })));
  assert.equal((await scopedB(`${unownedPath}/events`)).status, 200);

  // 同一来源项目的两条无归属长期空间会话：连线、同伴、消息、断开都要能真正跑通。
  const other = deriveSession({ ...sessionInput, workspaceId: wsNoProject.value.id, originProjectId: projectB.id as never });
  assert.ok(other.ok);
  await world.deps.sessions.save(other.value);
  const linked = await scopedB(`${unownedPath}/links`, post({ otherSessionId: other.value.id }));
  assert.equal(linked.status, 201, JSON.stringify(linked.body));
  const peers = await scopedB(`${unownedPath}/peers`);
  assert.equal(peers.status, 200);
  assert.ok(peers.body.peers.some((peer: { address: string }) => peer.address === `session:${other.value.id}`));
  const unownedSent = await scopedB(`${unownedPath}/messages`, post({ kind: 'send', body: '来自无归属工作空间' }));
  assert.equal(unownedSent.status, 201, JSON.stringify(unownedSent.body));
  assert.equal((await scopedB(`${unownedPath}/unlink`, post({ otherSessionId: other.value.id }))).status, 200);

  // 连线/断开也先按同一来源项目判；旧会话在进用例前就被拒。
  assert.equal((await scopedB(`${path}/unlink`, post({ otherSessionId: legacy.value.id }))).status, 404);
  assert.equal((await scopedB(`${path}/links`, post({ otherSessionId: legacy.value.id }))).status, 404);
  assert.equal((await scopedB(`${unownedPath}/links`, post({ otherSessionId: legacy.value.id }))).status, 404);
  assert.equal((await scopedB(`/sessions/${legacy.value.id}/unlink`, post({ otherSessionId: other.value.id }))).status, 404);
  // 别的项目令牌也不能借同项目会话连线。
  await denied('link(foreign project)', await scopedA(`${unownedPath}/links`, post({ otherSessionId: other.value.id })));

  // 即使长期空间记录了项目 B，也不能据此为旧会话授予权限。
  const legacyPath = `/sessions/${legacy.value.id}`;
  assert.equal((await scopedB(`${legacyPath}/events`)).status, 404);
  assert.equal((await scopedB(`${legacyPath}/peers`)).status, 404);
  assert.equal((await scopedB(`${legacyPath}/messages`, post({ kind: 'send', body: '你好' }))).status, 404);
});

test('session_start：省略 model 按默认 Agent 层级解析；显式传的不被覆盖', async () => {
  const h = await setup();
  const { david, mint, api, app, world } = h;
  const token = (await mint(david, ['projects:read', 'projects:write', 'sessions:read', 'sessions:write'])).token;
  const call = api(token);
  const project = (await call('/projects', post({ name: 'omit-model' }))).body as { id: string };
  const task = (await call('/tasks', post({ projectId: project.id, title: 't', goal: '' }))).body as { id: string };
  // 项目绑一个远端长期工作空间（否则 workspaceForApiStart 会现建本机临时空间，令牌会被 authorizeWorker 403）
  world.workers.push({ workerId: 'w1', label: 'w1', origin: 'remote', state: 'online' } as never);
  const ws = newWorkspace({ projectId: project.id as never, workerId: 'w1', path: '/srv/omit-model', kind: 'long_lived', source: 'linked', now: 1 });
  assert.ok(ws.ok);
  await world.deps.workspaces.save(ws.value);

  // 没有任何默认：省略 model → 明确 400，不写死模型名
  const noDefault = await call('/sessions', post({ taskId: task.id, agentId: 'fake' }));
  assert.equal(noDefault.status, 400, JSON.stringify(noDefault.body));
  assert.match(String(noDefault.body?.error?.message ?? JSON.stringify(noDefault.body)), /默认/);

  // 项目默认生效
  const setProject = await call(`/projects/${project.id}`, { method: 'PATCH', body: JSON.stringify({ defaultAgent: { runtime: 'fake', model: 'project-model' } }) });
  assert.equal(setProject.status, 200, JSON.stringify(setProject.body));
  const viaProject = await call('/sessions', post({ taskId: task.id, agentId: 'fake' }));
  assert.equal(viaProject.status, 201, JSON.stringify(viaProject.body));
  assert.equal(viaProject.body.model, 'project-model');

  // 任务默认盖过项目默认
  const setTask = await call(`/tasks/${task.id}/default-agent`, { method: 'PATCH', body: JSON.stringify({ defaultAgent: { runtime: 'fake', model: 'task-model' } }) });
  assert.equal(setTask.status, 200, JSON.stringify(setTask.body));
  const viaTask = await call('/sessions', post({ taskId: task.id, agentId: 'fake' }));
  assert.equal(viaTask.status, 201, JSON.stringify(viaTask.body));
  assert.equal(viaTask.body.model, 'task-model');

  // 显式传的 model 不被默认覆盖
  const explicit = await call('/sessions', post({ taskId: task.id, agentId: 'fake', model: 'm1' }));
  assert.equal(explicit.status, 201, JSON.stringify(explicit.body));
  assert.equal(explicit.body.model, 'm1');

  // MCP 的 session_start 同一条路：省略 model 也能开会话
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const response = await app.fetch(
      new Request('http://hub/openapi/v1/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
      }),
      { mcpReplays: replayStore(), mcpPolicy: { modules: new Set(['sessions']), readOnly: false, writes: true } }
    );
    return (await response.json().catch(() => null)) as any;
  };
  const started = await rpc('session_start', { taskId: task.id, agentId: 'fake', clientRequestId: 'omit-1' });
  assert.equal(started.result.isError, false, JSON.stringify(started.result));
  const mcpSession = JSON.parse(started.result.content[0].text) as { id: string; model: string };
  assert.equal(mcpSession.model, 'task-model');
  assert.notEqual(mcpSession.id, viaTask.body.id);
});

test('token_revoke：吊销自己正在用的令牌返回成功（MCP/REST 一致），之后请求 401；不存在的令牌仍 404', async () => {
  const { david, mint, api, app } = await setup();

  // REST：令牌吊销自己
  const selfToken = await mint(david, ['tokens:manage', 'projects:read']);
  const callSelf = api(selfToken.token);
  const revoked = await callSelf(`/tokens/${selfToken.info.id}/revoke`, { method: 'POST' });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  assert.equal(revoked.body.id, selfToken.info.id);
  assert.ok(revoked.body.revokedAt, '应返回带 revokedAt 的视图');
  const after = await callSelf('/me');
  assert.equal(after.status, 401, `吊销后再请求应 401：${JSON.stringify(after.body)}`);

  // MCP：token_revoke 吊销当前 Bearer 令牌，结果是成功体而不是 404/401
  const mcpToken = await mint(david, ['tokens:manage']);
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const response = await app.fetch(
      new Request('http://hub/openapi/v1/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${mcpToken.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
      }),
      { mcpReplays: replayStore(), mcpPolicy: { modules: new Set(['tokens']), readOnly: false, writes: true } }
    );
    return (await response.json().catch(() => null)) as any;
  };
  const mcpRevoked = await rpc('token_revoke', { tokenId: mcpToken.info.id, clientRequestId: 'revoke-self-1' });
  assert.equal(mcpRevoked.result.isError, false, JSON.stringify(mcpRevoked));
  const view = JSON.parse(mcpRevoked.result.content[0].text) as { id: string; revokedAt: number | null };
  assert.equal(view.id, mcpToken.info.id);
  assert.ok(view.revokedAt);
  const gone = await api(mcpToken.token)('/me');
  assert.equal(gone.status, 401);

  // 不存在的令牌仍是 404（没误伤）
  const alive = await mint(david, ['tokens:manage', 'projects:read']);
  const missing = await api(alive.token)('/tokens/does-not-exist/revoke', { method: 'POST' });
  assert.equal(missing.status, 404, JSON.stringify(missing.body));
});

test('workspace_diff / workspace_read_file：diff、路径逃逸、敏感文件、超限、越权', async () => {
  const s = await setup();
  const { david, mint, api, world, filesStore, accounts } = s;
  const token = (await mint(david, ['projects:read', 'projects:write', 'sessions:read', 'sessions:write', 'files:read'])).token;
  const call = api(token);
  const project = (await call('/projects', post({ name: 'ws-files' }))).body as { id: string };
  const task = (await call('/tasks', post({ projectId: project.id, title: 't', goal: '' }))).body as { id: string };
  world.workers.push({ workerId: 'w1', label: 'w1', origin: 'remote', state: 'online' } as never);
  const workspace = newWorkspace({ projectId: project.id as never, workerId: 'w1', path: '/srv/ws-files', kind: 'long_lived', source: 'linked', now: 1 });
  assert.ok(workspace.ok);
  await world.deps.workspaces.save(workspace.value);
  const created = await call('/sessions', post({ taskId: task.id, agentId: 'fake', model: 'm1', workspaceId: workspace.value.id }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const sessionId = created.body.id as string;
  const fakeGit = world.git as FakeGit;

  // 空改动：FakeGit 默认干净 → 200 + 空 patch，不是 500
  const empty = await call(`/sessions/${sessionId}/workspace/diff`);
  assert.equal(empty.status, 200, JSON.stringify(empty.body));
  assert.equal(empty.body.patch, '');
  assert.deepEqual(empty.body.files, []);
  assert.equal(empty.body.truncated, false);


  const preview = {
    isGit: true, branch: 'feat', defaultBranch: 'main', remoteUrl: null, upstream: null, ahead: 1, head: 'h1',
    files: [{ path: 'a.ts', status: 'M' }], patch: 'diff --git a/a.ts b/a.ts\n+hello', truncated: false
  };
  fakeGit.previews.set(workspace.value.path, preview as never);
  const diff = await call(`/sessions/${sessionId}/workspace/diff`);
  assert.equal(diff.status, 200, JSON.stringify(diff.body));
  assert.equal(diff.body.patch, preview.patch);
  assert.deepEqual(diff.body.files, preview.files);
  assert.equal(diff.body.branch, 'feat');

  // 敏感文件只有改动时，workspace_diff 不返回路径 / 内容；FakeGit 返回合规标记，领域仍再兜一次。
  fakeGit.previews.set(workspace.value.path, {
    ...preview,
    files: [{ path: '.env', status: 'M' }],
    patch: 'diff --git a/.env b/.env\n+SECRET=not-real-269'
  } as never);
  const hidden = await call(`/sessions/${sessionId}/workspace/diff`);
  assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
  assert.deepEqual(hidden.body.files, []);
  assert.equal(hidden.body.patch, '');
  assert.equal(hidden.body.truncated, false);

  // 旧 Worker 没有合规标记：不能把文本过滤结果当安全内容，整段省略并说清原因。
  fakeGit.legacyPreview = true;
  try {
    const legacy = await call(`/sessions/${sessionId}/workspace/diff`);
    assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
    assert.deepEqual(legacy.body.files, []);
    assert.equal(legacy.body.patch, '');
    assert.equal(legacy.body.truncated, true);
    assert.match(legacy.body.notice, /Worker 版本过旧/);
  } finally {
    fakeGit.legacyPreview = false;
  }
  fakeGit.previews.set(workspace.value.path, preview as never);

  // maxBytes：patch 超限截断并标 truncated
  const small = await call(`/sessions/${sessionId}/workspace/diff?maxBytes=8`);
  assert.equal(small.status, 200);
  assert.equal(small.body.patch, preview.patch.slice(0, 8));
  assert.equal(small.body.truncated, true);
  const tooBig = await call(`/sessions/${sessionId}/workspace/diff?maxBytes=999999999`);
  assert.equal(tooBig.status, 400);

  // 非 git 仓库 → 400 明确报错
  fakeGit.previews.set(workspace.value.path, { ...preview, isGit: false, branch: null } as never);
  const notGit = await call(`/sessions/${sessionId}/workspace/diff`);
  assert.equal(notGit.status, 400, JSON.stringify(notGit.body));

  // read_file：正常读取
  filesStore.files['notes.md'] = { bytes: Buffer.from('hello notes') };
  const read = await call(`/sessions/${sessionId}/workspace/file?path=notes.md`);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(read.body.content, 'hello notes');
  assert.equal(read.body.path, 'notes.md');
  assert.equal(read.body.binary, false);

  // 404：文件不存在
  const missing = await call(`/sessions/${sessionId}/workspace/file?path=nope.md`);
  assert.equal(missing.status, 404, JSON.stringify(missing.body));

  // 路径逃逸：`..` 与绝对路径都 400
  assert.equal((await call(`/sessions/${sessionId}/workspace/file?path=${encodeURIComponent('../../etc/passwd')}`)).status, 400);
  assert.equal((await call(`/sessions/${sessionId}/workspace/file?path=${encodeURIComponent('/etc/passwd')}`)).status, 400);
  assert.equal((await call(`/sessions/${sessionId}/workspace/file?path=${encodeURIComponent('.git/config')}`)).status, 400);

  // 敏感文件：不确认 → 400；确认 → 200
  filesStore.files['.env.local'] = { bytes: Buffer.from('SECRET=1') };
  const unconfirmed = await call(`/sessions/${sessionId}/workspace/file?path=.env.local`);
  assert.equal(unconfirmed.status, 400, JSON.stringify(unconfirmed.body));
  assert.match(String(unconfirmed.body?.error?.message ?? ''), /敏感/);
  const confirmed = await call(`/sessions/${sessionId}/workspace/file?path=.env.local&confirmed=1`);
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.content, 'SECRET=1');
  assert.ok(accounts.auditRows.some((row) => row.action === 'workspace.files.sensitive' && String(row.detail).includes('.env.local')));

  // 超限：> 256KiB 明确报错，不假装成功
  filesStore.files['big.bin'] = { bytes: new Uint8Array(256 * 1024 + 1), binary: true };
  const oversized = await call(`/sessions/${sessionId}/workspace/file?path=big.bin`);
  assert.equal(oversized.status, 400, JSON.stringify(oversized.body));
  assert.match(String(oversized.body?.error?.message ?? ''), /256 KiB/);

  // 越权：令牌没有 sessions:read → 403
  const ro = (await mint(david, ['projects:read'])).token;
  assert.equal((await api(ro)(`/sessions/${sessionId}/workspace/diff`)).status, 403);
  assert.equal((await api(ro)(`/sessions/${sessionId}/workspace/file?path=notes.md`)).status, 403);
});
