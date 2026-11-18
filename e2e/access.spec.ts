import { join } from 'node:path';
import { test, expect, request as apiRequest, type APIRequestContext } from '@playwright/test';
import { loginByApi } from './login.ts';

/**
 * 外部接入（MCP）页：预设建令牌 + 只给指定项目 → 只显示一次（打码/显示）→ 测试连接数工具
 * → 令牌经 MCP 只看得到选中的项目 → 调用记录里看得到这次调用 → 轮换（旧的 401、新的能用、旧记录留着）
 * → 只读模式（管理员）。桌面 + 手机宽度截图。
 */
const SHOTS = process.env['E2E_SCREENSHOTS'];

async function csrfHeaders(request: APIRequestContext, baseURL: string) {
  const csrf = (await request.storageState()).cookies.find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  return { origin: baseURL, 'x-hub-csrf': csrf };
}

const rpc = (method: string, params: unknown = {}) => ({
  data: { jsonrpc: '2.0', id: 1, method, params },
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
});

async function mcpJson(response: Awaited<ReturnType<APIRequestContext['post']>>) {
  const text = await response.text();
  const line = text.trim().startsWith('{') ? text : (text.split('\n').find((l) => l.startsWith('data:')) ?? '').slice(5);
  return JSON.parse(line) as { result?: { tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean } };
}

test('外部接入页：限项目令牌、只显示一次、测试连接、调用记录、轮换、只读模式', async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  await loginByApi(page);
  const headers = await csrfHeaders(page.request, baseURL!);
  const tag = Date.now().toString(36);
  // 跨 run 保留的数据目录：清掉以前留下的
  const projects = (await (await page.request.get('/api/projects')).json()) as { id: string; name: string }[];
  for (const project of projects.filter((p) => p.name.startsWith('e2e-acc-')))
    await page.request.delete(`/api/projects/${project.id}`, { data: { confirmName: project.name }, headers });
  const old = (await (await page.request.get('/api/tokens')).json()) as { id: string; name: string; revokedAt: number | null }[];
  for (const token of old.filter((t) => t.name.startsWith('e2e-acc-') && t.revokedAt === null)) await page.request.delete(`/api/tokens/${token.id}`, { headers });
  const mine = (await (await page.request.post('/api/projects', { data: { name: `e2e-acc-${tag}` }, headers })).json()) as { id: string; name: string };
  const other = (await (await page.request.post('/api/projects', { data: { name: `e2e-acc-other-${tag}` }, headers })).json()) as { id: string; name: string };

  // —— 1. 从账号菜单进页面 ——
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: '账号' }).click();
  await page.getByTestId('menu-access').click();
  await expect(page.getByRole('heading', { name: '外部接入（MCP）' })).toBeVisible();
  await expect(page.getByTestId('access-endpoint')).toContainText('/openapi/v1/mcp');
  const skillLink = page.getByTestId('skill-download');
  await expect(skillLink).toBeVisible();
  await expect(skillLink).toHaveAttribute('href', /\/openapi\/v1\/skills\/agent-hub-workbench$/);
  const skill = await page.request.get('/openapi/v1/skills/agent-hub-workbench?format=json');
  expect(skill.ok()).toBeTruthy();
  const manifest = (await skill.json()) as { name: string; files: { path: string; content: string }[] };
  expect(manifest.name).toBe('agent-hub-workbench');
  const skillMd = manifest.files.find((file) => file.path === 'SKILL.md')?.content ?? '';
  expect(skillMd).toContain('session_start');
  expect(skillMd).toContain('primaryRepoId');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'access-1280.png'), fullPage: true });

  // —— 2. 预设「只读」+ 只给指定项目 ——
  const name = `e2e-acc-${tag}`;
  await page.getByTestId('token-name').fill(name);
  await page.locator('[data-testid="token-preset"][data-preset="readonly"]').click();
  await page.getByTestId('token-limit-projects').check();
  await expect(page.getByTestId('token-limit-note')).toContainText('团队资产');
  await page.getByTestId('token-project').filter({ hasText: mine.name }).first().click();
  await expect(page.getByLabel('有效期')).toHaveValue('30');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'access-create-1280.png'), fullPage: true });
  await page.getByTestId('token-create').click();

  // —— 3. 只显示一次：默认打码，点显示才露；测试连接数工具 ——
  const value = page.getByTestId('token-value');
  await expect(value).toContainText('••••');
  await page.getByTestId('token-reveal').click();
  await expect(value).not.toContainText('••••');
  const token = ((await value.textContent()) ?? '').trim();
  expect(token).toMatch(/^ahp_/);
  await page.getByTestId('token-test').click();
  await expect(page.getByTestId('token-test-result')).toContainText(/能用 \d+ 个工具/);
  await page.getByTestId('token-reveal').click();
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'access-fresh-1280.png'), fullPage: true });
  await page.getByRole('button', { name: '我已保存' }).click();
  await expect(page.getByTestId('token-value')).toHaveCount(0);
  const row = page.locator(`[data-testid="token-row"][data-token-name="${name}"]`);
  await expect(row).toContainText(`限 ${mine.name}`);
  await expect(row.getByTestId('token-tools')).toBeVisible();
  await expect(row).not.toContainText(token);
  // 到期是将来时间：写日期「… 到期」，不能是相对时间（以前会显示成「刚刚过期」）
  await expect(row).toContainText('到期');
  await expect(row).not.toContainText('过期');

  // —— 4. 后端强制：经 MCP 只看得到选中的项目；别的项目 404 ——
  const bot = await apiRequest.newContext({ baseURL, extraHTTPHeaders: { authorization: `Bearer ${token}` } });
  const listed = (await (await bot.get('/openapi/v1/projects')).json()) as { id: string }[];
  expect(listed.map((p) => p.id)).toEqual([mine.id]);
  expect((await bot.get(`/openapi/v1/projects/${other.id}`)).status()).toBe(404);
  const tools = await mcpJson(await bot.post('/openapi/v1/mcp', rpc('tools/list')));
  const listTool = tools.result?.tools?.find((t) => /project/.test(t.name) && /list/.test(t.name))?.name;
  expect(listTool, JSON.stringify(tools.result?.tools?.map((t) => t.name))).toBeTruthy();
  const called = await mcpJson(await bot.post('/openapi/v1/mcp', rpc('tools/call', { name: listTool, arguments: {} })));
  expect(called.result?.isError ?? false).toBe(false);
  expect(called.result?.content?.[0]?.text ?? '').not.toContain(other.id);

  // —— 5. 调用记录 ——
  await page.reload();
  await row.getByTestId('token-activity').click();
  await expect(row.getByTestId('token-activity-list')).toContainText(listTool!);
  await row.getByTestId('token-activity-list').scrollIntoViewIfNeeded();
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'access-activity-1280.png'), fullPage: true });

  // —— 6. 轮换：新令牌只显示一次；旧的立刻 401；旧记录进「已吊销」 ——
  page.once('dialog', (dialog) => void dialog.accept());
  await row.getByTestId('token-rotate').click();
  await expect(page.getByTestId('token-value')).toBeVisible();
  await page.getByTestId('token-reveal').click();
  const rotated = ((await page.getByTestId('token-value').textContent()) ?? '').trim();
  expect(rotated).toMatch(/^ahp_/);
  expect(rotated).not.toBe(token);
  expect((await bot.get('/openapi/v1/projects')).status()).toBe(401);
  const fresh = await apiRequest.newContext({ baseURL, extraHTTPHeaders: { authorization: `Bearer ${rotated}` } });
  expect(((await (await fresh.get('/openapi/v1/projects')).json()) as { id: string }[]).map((p) => p.id)).toEqual([mine.id]);
  await page.getByRole('button', { name: '我已保存' }).click();
  await page.getByTestId('access-show-revoked').click();
  await expect(page.getByTestId('access-revoked').locator(`[data-token-name="${name}"]`)).toBeVisible();

  // —— 7. 只读模式（测试账号是集群管理员）：默认按令牌权限放行，打开后写工具消失；最后恢复服务器默认 ——
  try {
    const toggle = page.getByTestId('access-writes-toggle');
    const before = (await toggle.getAttribute('aria-checked')) === 'true';
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', String(!before));
    const names = (await mcpJson(await fresh.post('/openapi/v1/mcp', rpc('tools/list')))).result?.tools?.map((t) => t.name) ?? [];
    // 只读模式下，不管令牌有什么权限都拿不到写工具
    expect(names.some((n) => n.endsWith('_create'))).toBe(false);
    await expect(page.getByTestId('access-writes')).not.toContainText('沿用服务器默认');
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'access-writes-1280.png'), fullPage: true });
  } finally {
    await page.request.put('/api/mcp/access', { data: { readOnly: null }, headers });
  }

  // —— 8. 手机宽度 ——
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole('heading', { name: '外部接入（MCP）' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'access-390.png'), fullPage: true });

  // 清理
  const all = (await (await page.request.get('/api/tokens')).json()) as { id: string; name: string; revokedAt: number | null }[];
  for (const t of all.filter((x) => x.name.startsWith('e2e-acc-') && x.revokedAt === null)) await page.request.delete(`/api/tokens/${t.id}`, { headers });
  for (const project of [mine, other]) await page.request.delete(`/api/projects/${project.id}`, { data: { confirmName: project.name }, headers });
  await Promise.all([bot.dispose(), fresh.dispose()]);
});
