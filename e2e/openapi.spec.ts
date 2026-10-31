import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, request as apiRequest, type APIRequestContext } from '@playwright/test';
import { loginByApi } from './login.ts';

/**
 * 开放 API（ADR 0014）：设置里建令牌（只显示一次）→ Bearer 调 /openapi/v1 → 远程机器上开会话、发消息、读 SSE 流
 * → MCP 调工具 → 权限不够 403 → 本机 Worker 永远用不了 → 吊销后 401。手机宽度的令牌面板也截图。
 */
const SHOTS = process.env['E2E_SCREENSHOTS'];

async function csrfHeaders(request: APIRequestContext, baseURL: string) {
  const csrf = (await request.storageState()).cookies.find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  return { origin: baseURL, 'x-hub-csrf': csrf };
}

test('开放 API：令牌、对话 + 事件流、MCP、权限拒绝、本机永远不开放、吊销', async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  await loginByApi(page);
  const headers = await csrfHeaders(page.request, baseURL!);
  // e2e 数据目录跨 run 保留：先清掉以前这条用例留下的项目和令牌，别影响别的用例
  const cleanup = async () => {
    const projects = (await (await page.request.get('/api/projects')).json()) as { id: string; name: string }[];
    for (const project of projects.filter((p) => p.name.startsWith('e2e-bot-')))
      await page.request.delete(`/api/projects/${project.id}`, { data: { confirmName: project.name }, headers });
    const tokens = (await (await page.request.get('/api/tokens')).json()) as { id: string; name: string; revokedAt: number | null }[];
    for (const token of tokens.filter((t) => t.name.startsWith('e2e-bot-') && t.revokedAt === null))
      await page.request.delete(`/api/tokens/${token.id}`, { headers });
  };
  await cleanup();

  // —— 1. 设置里建令牌：明文只显示一次（手机宽度） ——
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: '账号' }).click();
  await page.getByRole('button', { name: '访问令牌' }).click();
  const dialog = page.getByRole('dialog', { name: '访问令牌' });
  const name = `e2e-bot-${Date.now().toString(36)}`;
  await dialog.getByTestId('token-name').fill(name);
  for (const label of ['改项目和任务', '发起对话', '看机器']) await dialog.getByText(label, { exact: true }).click();
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'tokens-create-390.png') });
  await dialog.getByTestId('token-create').click();
  const value = dialog.getByTestId('token-value');
  await expect(value).toContainText('ahp_');
  const token = ((await value.textContent()) ?? '').trim();
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'tokens-fresh-390.png') });
  await dialog.getByRole('button', { name: '我已保存' }).click();
  await expect(dialog.getByTestId('token-value')).toHaveCount(0);
  const row = dialog.locator(`[data-token-name="${name}"]`);
  await expect(row).toBeVisible();
  await expect(row).not.toContainText(token);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'tokens-list-390.png') });

  // 只读令牌（经 API 建，后面验 403）
  const readOnly = (await (await page.request.post('/api/tokens', { data: { name: `${name}-ro`, scopes: ['projects:read'] }, headers })).json()) as { token: string; info: { id: string } };

  const bot = await apiRequest.newContext({ baseURL, extraHTTPHeaders: { authorization: `Bearer ${token}` } });
  const ro = await apiRequest.newContext({ baseURL, extraHTTPHeaders: { authorization: `Bearer ${readOnly.token}` } });
  const anon = await apiRequest.newContext({ baseURL });
  expect((await anon.get('/openapi/v1/projects')).status()).toBe(401);
  // 开放 API 不认 cookie
  expect((await page.request.get('/openapi/v1/projects')).status()).toBe(401);
  const me = (await (await bot.get('/openapi/v1/me')).json()) as { token: { name: string } };
  expect(me.token.name).toBe(name);
  // 文档和规范公开
  expect((await anon.get('/openapi/v1/docs')).status()).toBe(200);
  const spec = (await (await anon.get('/openapi/v1/openapi.json')).json()) as { openapi: string; paths: object };
  expect(spec.openapi).toMatch(/^3\.1/);

  // —— 2. 本机 Worker 永远授不出去（测试账号是 hub 管理员也不行） ——
  const workers = (await (await bot.get('/openapi/v1/workers')).json()) as { workerId: string; origin: string }[];
  expect(workers.every((worker) => worker.origin !== 'local')).toBe(true);
  // 在本机目录建项目：令牌碰不到本机
  const localDir = mkdtempSync(join(tmpdir(), 'e2e-openapi-local-'));
  const onLocal = await bot.post('/openapi/v1/projects', { data: { name: `${name} local-dir`, rootPath: localDir } });
  expect(onLocal.status(), await onLocal.text()).toBe(403);
  // 测试账号（hub 管理员）自己在本机建的项目：经令牌在上面开会话也不行
  const localProject = (await (await page.request.post('/api/projects', { data: { name: `${name} local-dir`, rootPath: localDir }, headers })).json()) as { id: string };
  const localTask = (await (await page.request.post('/api/tasks', { data: { projectId: localProject.id, title: '本机？' }, headers })).json()) as { id: string };
  expect((await bot.get(`/openapi/v1/tasks/${localTask.id}`)).status()).toBe(200);
  const browserWorkers = (await (await page.request.get('/api/workers')).json()) as { workerId: string; origin: string; agentIds: string[]; state: string }[];
  const local = browserWorkers.find((worker) => worker.origin === 'local' && worker.state === 'online');
  if (local) {
    const denied = await bot.post('/openapi/v1/sessions', { data: { taskId: localTask.id, agentId: local.agentIds[0] ?? 'pi', model: '', workerId: local.workerId } });
    expect(denied.status(), await denied.text()).toBe(403);
  }

  // —— 3. 权限不够：只读令牌不能写 ——
  const forbidden = await ro.post('/openapi/v1/projects', { data: { name: 'nope' } });
  expect(forbidden.status()).toBe(403);
  expect(((await forbidden.json()) as { error: { code: string } }).error.code).toBe('forbidden');

  // —— 4. 远程机器上对话 + SSE 事件流 ——
  const pairing = (await (await page.request.post('/api/workers/pairing', { headers })).json()) as { code: string };
  const hubUrl = `${baseURL!.replace(/^http/, 'ws')}/worker`;
  const enrolled = spawnSync(process.execPath, ['apps/worker/src/enroll.ts'], {
    env: { PATH: process.env['PATH'] ?? '', HUB_URL: hubUrl, HUB_PAIR: pairing.code, WORKER_LABEL: 'e2e openapi 机器' },
    encoding: 'utf8'
  });
  expect(enrolled.status, enrolled.stderr).toBe(0);
  const [workerId = '', credential = ''] = enrolled.stdout.trim().split('\n');
  const state = mkdtempSync(join(tmpdir(), 'hub-e2e-openapi-worker-'));
  const dir = join(state, 'repo');
  mkdirSync(dir);
  let worker: ChildProcess | null = null;
  try {
    worker = spawn(process.execPath, ['apps/worker/src/main.ts'], {
      env: {
        ...process.env,
        HUB_URL: hubUrl,
        HUB_WORKER_CREDENTIAL: credential,
        WORKER_ID: workerId,
        WORKER_ORIGIN: 'remote',
        WORKER_LABEL: 'e2e openapi 机器',
        WORKER_ROOTS: '/tmp',
        WORKER_STATE_DIR: state
      },
      stdio: 'ignore'
    });
    let remote: { workerId: string; agentIds?: string[]; state: string } | undefined;
    await expect
      .poll(async () => {
        const list = (await (await bot.get('/openapi/v1/workers')).json()) as { workerId: string; agentIds?: string[]; state: string }[];
        remote = list.find((entry) => entry.workerId === workerId && entry.state === 'online');
        return Boolean(remote);
      }, { timeout: 30_000 })
      .toBe(true);
    const agentId = remote?.agentIds?.[0];
    expect(agentId, '远程机器上要有至少一个 agent').toBeTruthy();

    const project = (await (await bot.post('/openapi/v1/projects', { data: { name: `${name} 远程`, rootPath: dir, workerId } })).json()) as { id: string };
    const task = await bot.post('/openapi/v1/tasks', { data: { projectId: project.id, title: '经开放 API 聊一句' } });
    expect(task.status(), await task.text()).toBe(201);
    const taskId = ((await task.json()) as { id: string }).id;
    const started = await bot.post('/openapi/v1/sessions', { data: { taskId, agentId, model: '', workerId } });
    expect(started.status(), await started.text()).toBe(201);
    const sessionId = ((await started.json()) as { id: string }).id;
    const prompted = await bot.post(`/openapi/v1/sessions/${sessionId}/prompt`, { data: { text: '只回复「好」一个字' } });
    expect(prompted.status(), await prompted.text()).toBe(202);

    // SSE：用原生 fetch 读流，至少能拿到带 seq 的 prompt 事件，作者带 via
    const controller = new AbortController();
    const response = await fetch(`${baseURL}/openapi/v1/sessions/${sessionId}/stream`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let text = '';
    const deadline = Date.now() + 20_000;
    while (!text.includes('"kind":"prompt"') && Date.now() < deadline) text += new TextDecoder().decode((await reader.read()).value);
    controller.abort();
    expect(text).toMatch(/event: event\n/);
    expect(text).toContain(`"via":"${name}"`);
    const session = (await (await bot.get(`/openapi/v1/sessions/${sessionId}`)).json()) as { id: string };
    expect(session.id).toBe(sessionId);
    expect(((await (await bot.get(`/openapi/v1/tasks/${taskId}`)).json()) as { sessions: unknown[] }).sessions.length).toBe(1);

    // 审计里显示 via 令牌
    const audit = (await (await page.request.get('/api/admin/audit')).json()) as { action: string; detail: string }[];
    expect(audit.some((entry) => entry.action === 'session.start' && entry.detail.includes(`via 令牌「${name}」`))).toBe(true);

    // 对话页里消息作者旁有 via 标记
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('about:blank');
    await page.goto(`/#/p/${project.id}/canvas`);
    const node = page.locator('.react-flow__node-session');
    await expect(node).toHaveCount(1);
    await node.getByRole('button', { name: '打开' }).click();
    await expect(page.getByTestId('msg-author-via').first()).toContainText(name);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'chat-via-token.png') });
  } finally {
    worker?.kill();
    rmSync(state, { recursive: true, force: true });
    await page.request.delete(`/api/workers/${workerId}`, { headers }).catch(() => undefined);
  }

  // —— 5. MCP：同一个令牌、同一套权限 ——
  const mcp = async (ctx: APIRequestContext, body: unknown) =>
    (await (await ctx.post('/openapi/v1/mcp', { data: body, headers: { accept: 'application/json, text/event-stream' } })).json()) as any;
  await mcp(bot, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } });
  const tools = await mcp(bot, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  expect(tools.result.tools.map((tool: { name: string }) => tool.name)).toContain('list_projects');
  const listed = await mcp(bot, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_projects', arguments: {} } });
  expect(listed.result.isError).toBe(false);
  expect(JSON.stringify(listed.result.structuredContent)).toContain(name);
  const roDenied = await mcp(ro, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'create_project', arguments: { name: 'x' } } });
  expect(roDenied.result.isError).toBe(true);

  // —— 6. 吊销：立刻 401（在 UI 里点） ——
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: '账号' }).click();
  await page.getByRole('button', { name: '访问令牌' }).click();
  page.once('dialog', (confirm) => void confirm.accept());
  await page.getByRole('dialog', { name: '访问令牌' }).locator(`[data-token-name="${name}"]`).getByTestId('token-revoke').click();
  await expect(page.locator(`[data-token-name="${name}"]`)).toHaveCount(0);
  await expect.poll(async () => (await bot.get('/openapi/v1/me')).status()).toBe(401);
  await page.request.delete(`/api/tokens/${readOnly.info.id}`, { headers });
  expect((await ro.get('/openapi/v1/me')).status()).toBe(401);
  await cleanup();
});
