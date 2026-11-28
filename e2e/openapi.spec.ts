import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, request as apiRequest, type APIRequestContext } from '@playwright/test';
import { loginByApi } from './login.ts';
import { ensureFakeWorker, FAKE_AGENT_ID, stopFakeWorker } from './fake-worker.ts';

/**
 * 开放 API（ADR 0014）：设置里建令牌（只显示一次）→ Bearer 调 /openapi/v1 → 远程机器上开会话、发消息、读投影事件
 * → MCP 调工具 → 权限不够 403 → 本机 Worker 永远用不了 → 吊销后 401。手机宽度的令牌面板也截图。
 */
const SHOTS = process.env['E2E_SCREENSHOTS'];

async function csrfHeaders(request: APIRequestContext, baseURL: string) {
  const csrf = (await request.storageState()).cookies.find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  return { origin: baseURL, 'x-hub-csrf': csrf };
}

test.afterAll(stopFakeWorker);

test('开放 API：令牌、对话事件投影、MCP、权限拒绝、本机永远不开放、吊销', async ({ page, baseURL }) => {
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
  await page.getByTestId('menu-access').click();
  await expect(page.getByRole('heading', { name: '外部接入（MCP）' })).toBeVisible();
  const name = `e2e-bot-${Date.now().toString(36)}`;
  await page.getByTestId('token-name').fill(name);
  await page.locator('[data-testid="token-preset"][data-preset="delegate"]').click();
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'tokens-create-390.png') });
  await page.getByTestId('token-create').click();
  const value = page.getByTestId('token-value');
  // 明文默认打码，点「显示」才露出来
  await expect(value).toContainText('ahp_');
  await expect(value).toContainText('••••');
  await page.getByTestId('token-reveal').click();
  await expect(value).not.toContainText('••••');
  const token = ((await value.textContent()) ?? '').trim();
  // 接入片段只引用环境变量，不带明文
  await expect(page.getByTestId('mcp-guide-snippet')).not.toContainText(token);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'tokens-fresh-390.png') });
  await page.getByRole('button', { name: '我已保存' }).click();
  await expect(page.getByTestId('token-value')).toHaveCount(0);
  const row = page.locator(`[data-token-name="${name}"]`);
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

  // —— 4. 远程假 ACP 真实执行，外部只读投影，内部保留消息作者 ——
  const workerId = await ensureFakeWorker(page, baseURL!);
  const dir = mkdtempSync(join(tmpdir(), 'hub-e2e-openapi-workdir-'));
  try {
    await expect
      .poll(async () => {
        const list = (await (await bot.get('/openapi/v1/workers')).json()) as { workerId: string; agentIds?: string[]; state: string }[];
        return list.some((entry) => entry.workerId === workerId && entry.state === 'online' && entry.agentIds?.includes(FAKE_AGENT_ID));
      }, { timeout: 30_000 })
      .toBe(true);

    const project = (await (await bot.post('/openapi/v1/projects', { data: { name: `${name} 远程`, rootPath: dir, workerId } })).json()) as { id: string };
    const task = await bot.post('/openapi/v1/tasks', { data: { projectId: project.id, title: '经开放 API 聊一句' } });
    expect(task.status(), await task.text()).toBe(201);
    const taskId = ((await task.json()) as { id: string }).id;
    const started = await bot.post('/openapi/v1/sessions', { data: { taskId, agentId: FAKE_AGENT_ID, model: 'fake/m1', workerId } });
    expect(started.status(), await started.text()).toBe(201);
    const sessionId = ((await started.json()) as { id: string }).id;
    const prompted = await bot.post(`/openapi/v1/sessions/${sessionId}/prompt`, { data: { text: '外部投影测试' } });
    expect(prompted.status(), await prompted.text()).toBe(202);

    const stream = await bot.get(`/openapi/v1/sessions/${sessionId}/stream`);
    expect(stream.status()).toBe(503);
    expect((await stream.json()).error.code).toBe('external_stream_disabled');
    await expect.poll(async () => {
      const response = await bot.get(`/openapi/v1/sessions/${sessionId}/events`);
      expect(response.status()).toBe(200);
      const projected = (await response.json()) as { nextAfter: number; events: { seq: number; event: { kind: string } }[] };
      expect(projected.events.some(({ event }) => event.kind === 'prompt')).toBe(false);
      return projected.events.some(({ seq, event }) => seq > 0 && seq <= projected.nextAfter && event.kind === 'ended');
    }).toBe(true);
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
    stopFakeWorker();
    rmSync(dir, { recursive: true, force: true });
    await page.request.delete(`/api/workers/${workerId}`, { headers }).catch(() => undefined);
    rmSync(localDir, { recursive: true, force: true });
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
  await page.getByTestId('menu-access').click();
  page.once('dialog', (confirm) => void confirm.accept());
  await page.locator(`[data-token-name="${name}"]`).getByTestId('token-revoke').click();
  await expect(page.locator(`[data-token-name="${name}"]`)).toHaveCount(0);
  await expect.poll(async () => (await bot.get('/openapi/v1/me')).status()).toBe(401);
  await page.request.delete(`/api/tokens/${readOnly.info.id}`, { headers });
  expect((await ro.get('/openapi/v1/me')).status()).toBe(401);
  await cleanup();
});
