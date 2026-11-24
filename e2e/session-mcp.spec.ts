import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { loginByApi } from './login.ts';
import { piModel } from './hub-model.ts';
import { currentRun } from './run-id.ts';

/**
 * 会话详情 · MCP 服务器开关。
 *
 * 想走「上传带两个服务器的 mcp.json → 装到本机 → 派生会话 → 详情里两条都在 → 关一条 → 刷新仍关」，
 * 但当前后端的资产预热（`apps/server/src/main.ts:1126-1135`）要求会话候选资产里的每一项都出现在
 * Worker 回报的 `installed` 里，而 `workerAssetManifest` 用 `isFileAssetKind` 把 mcp 资产整类排除了
 * （`packages/domain/src/asset.ts:20`），所以任何带 MCP 资产的会话派生都会被
 * 「资产预热失败：这台机器上没有装上它们」拦下（`e2e/mcp-asset.spec.ts` 现在也是同样的失败）。
 *
 * 于是按退路走：直接 PATCH 造出「关掉的名单」，再验证 UID —— 仍然至少有一条断言经过真实 `GET`：
 * 空名单时整段不渲染、名单里的名字落到「已关掉但这次没出现」、开关能把名字从名单里拿掉。
 * 后端修好后把这里换回真实清单（用例 1）即可。
 */
const RUN = currentRun().replace(/[^a-z0-9]/gi, '').slice(-8).toLowerCase();
const SERVER_A = `echo-a-${RUN}`;
const SERVER_B = `echo-b-${RUN}`;
const SHOTS = process.env['E2E_SCREENSHOTS'] ?? '/tmp/opencode/shots/session-mcp';

test('会话详情：关掉的 MCP 服务器单独列出、能打开，刷新后仍保持', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };

  let agentId: string | undefined;
  for (let i = 0; i < 60 && !agentId; i++) {
    const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ agentIds: string[]; state: string }>;
    agentId = workers.find((worker) => worker.state === 'online')?.agentIds[0];
    if (!agentId) await page.waitForTimeout(500);
  }
  expect(agentId, '本机 Worker 必须在线').toBeTruthy();

  const dir = mkdtempSync(join(tmpdir(), 'e2e-mcp-toggle-'));
  const project = (await (
    await page.request.post('/api/projects', { headers, data: { name: `e2e mcp 开关 ${RUN}`, rootPath: dir } })
  ).json()) as { id: string };
  const task = (await (
    await page.request.post('/api/tasks', { headers, data: { projectId: project.id, title: `MCP 开关 ${RUN}` } })
  ).json()) as { id: string };
  const derived = await page.request.post('/api/sessions/derive', {
    headers,
    data: { taskId: task.id, agentId, model: piModel() }
  });
  expect(derived.status(), await derived.text()).toBe(201);
  const sid = ((await derived.json()) as { id: string }).id;

  const readView = async () =>
    (await (await page.request.get(`/api/sessions/${sid}/mcp`)).json()) as {
      servers: Array<{ name: string; transport: string; assetId: string; assetName: string }>;
      disabled: string[];
      note: string | null;
    };

  // 真 GET：这台机器上没有 MCP 资产，清单和名单都是空的，note 说明原因。
  const fresh = await readView();
  expect(fresh.servers).toEqual([]);
  expect(fresh.disabled).toEqual([]);
  expect(fresh.note).toContain('没有 MCP 服务器');

  const openDetails = async () => {
    await page.goto(`/#/p/${project.id}/focus/${sid}`);
    // 只换 hash 的跳转不会真的重载页面（查询缓存还在），这里显式刷新一次：
    // 既保证读到最新的 GET，也顺带验证「刷新后开关状态仍然保持」。
    await page.reload();
    const panel = page.getByRole('complementary', { name: '会话详情' });
    // 详情抽屉开着时会被记住（刷新后自己回来），这时别再点 header 上那颗被遮住的按钮。
    await panel.waitFor({ state: 'visible', timeout: 3_000 }).catch(() => undefined);
    if (!(await panel.isVisible())) await page.getByRole('button', { name: '详情', exact: true }).click();
    return panel;
  };

  // 清单和名单都空：只有标题、说明和那句原因，没有可拨的开关。
  let panel = await openDetails();
  const section = panel.getByTestId('session-mcp');
  await expect(section).toBeVisible({ timeout: 20_000 });
  await expect(section.getByTestId('session-mcp-note')).toContainText('没有 MCP 服务器');
  await expect(section.getByTestId('session-mcp-row')).toHaveCount(0);
  const toggleIn = (name: string) =>
    panel.locator(`[data-testid="session-mcp-row"][data-server="${name}"]`).getByTestId('session-mcp-toggle');

  // 造出「关掉两条」：接口只校验名字格式，不要求在清单里。
  const patched = await page.request.patch(`/api/sessions/${sid}/mcp`, { headers, data: { disabled: [SERVER_A, SERVER_B] } });
  expect(patched.status(), await patched.text()).toBe(200);
  expect(((await patched.json()) as { mcpDisabled: string[] }).mcpDisabled).toEqual([SERVER_A, SERVER_B]);

  // 真 GET：清单仍是空的，名单两条都在。
  const withDisabled = await readView();
  expect(withDisabled.servers).toEqual([]);
  expect(withDisabled.disabled).toEqual([SERVER_A, SERVER_B]);

  panel = await openDetails();
  const listed = panel.getByTestId('session-mcp');
  await expect(listed).toBeVisible({ timeout: 20_000 });
  await expect(listed).toContainText('只影响这条会话启动时下发的服务器');
  const missing = listed.getByTestId('session-mcp-missing');
  await expect(missing).toContainText('已关掉但这次没出现');
  await expect(missing.getByTestId('session-mcp-row')).toHaveCount(2);
  const rowB = panel.locator(`[data-testid="session-mcp-row"][data-server="${SERVER_B}"]`);
  await expect(rowB).toContainText(SERVER_B);
  await expect(toggleIn(SERVER_A)).not.toBeChecked();
  await expect(rowB.getByTestId('session-mcp-toggle')).not.toBeChecked();
  await expect(listed.getByTestId('session-mcp-note')).toContainText('没有 MCP 服务器');
  await listed.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/session-mcp-missing.png` });

  // 界面里打开 A：PATCH 写回会话，这行从「没出现」组里消失。
  // 用 click 而不是 check：拨完这行就被移出列表，check 会一直等它变成勾选态直到超时。
  await toggleIn(SERVER_A).click();
  await expect
    .poll(async () => (await readView()).disabled.join(','), { timeout: 15_000 })
    .toBe(SERVER_B);
  await expect(panel.locator(`[data-testid="session-mcp-row"][data-server="${SERVER_A}"]`)).toHaveCount(0);
  await expect(listed.getByTestId('session-mcp-error')).toHaveCount(0);

  // 刷新：名单以会话为准，只剩 B 还是关着的。
  panel = await openDetails();
  await expect(panel.getByTestId('session-mcp')).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByTestId('session-mcp-row')).toHaveCount(1);
  await expect(
    panel.locator(`[data-testid="session-mcp-row"][data-server="${SERVER_B}"]`).getByTestId('session-mcp-toggle')
  ).not.toBeChecked();
  await expect(panel.getByTestId('session-mcp-row')).toContainText(SERVER_B);

  // 再打开 B：名单空了，没有可拨的开关，只剩那行说明。
  await panel.getByTestId('session-mcp-toggle').click();
  await expect
    .poll(async () => (await readView()).disabled.join(','), { timeout: 15_000 })
    .toBe('');
  await expect(panel.getByTestId('session-mcp-row')).toHaveCount(0);
  await expect(panel.getByTestId('session-mcp-note')).toContainText('没有 MCP 服务器');
  await panel.getByTestId('session-mcp').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/session-mcp-all-on.png` });
  const session = (await (await page.request.get(`/api/sessions/${sid}`)).json()) as { mcpDisabled: string[] };
  expect(session.mcpDisabled).toEqual([]);
});

/**
 * 清单非空时的行样子 + 保存失败回滚。
 *
 * 后端现在派生不出「带 MCP 资产的会话」（见文件开头），所以清单只能拦下 GET 自己造；
 * PATCH 不拦，让它真的打到后端再演一遍失败（把 PATCH 拦成 500），验证错误提示和回滚。
 */
test('清单里两个服务器：名字/transport/来源都对，关掉那行变暗，保存失败要回滚并报错', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };

  let agentId: string | undefined;
  for (let i = 0; i < 60 && !agentId; i++) {
    const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ agentIds: string[]; state: string }>;
    agentId = workers.find((worker) => worker.state === 'online')?.agentIds[0];
    if (!agentId) await page.waitForTimeout(500);
  }
  expect(agentId, '本机 Worker 必须在线').toBeTruthy();

  const dir = mkdtempSync(join(tmpdir(), 'e2e-mcp-rows-'));
  const project = (await (
    await page.request.post('/api/projects', { headers, data: { name: `e2e mcp 行 ${RUN}`, rootPath: dir } })
  ).json()) as { id: string };
  const task = (await (
    await page.request.post('/api/tasks', { headers, data: { projectId: project.id, title: `MCP 行 ${RUN}` } })
  ).json()) as { id: string };
  const derived = await page.request.post('/api/sessions/derive', {
    headers,
    data: { taskId: task.id, agentId, model: piModel() }
  });
  expect(derived.status(), await derived.text()).toBe(201);
  const sid = ((await derived.json()) as { id: string }).id;

  await page.route(`**/api/sessions/${sid}/mcp`, async (route) => {
    if (route.request().method() === 'PATCH') {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'unavailable', message: '机器不在线，改不了' } })
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        servers: [
          { name: SERVER_A, transport: 'stdio', assetId: 'asset-a', assetName: 'echo 工具' },
          { name: SERVER_B, transport: 'http', assetId: 'asset-b', assetName: '内网检索' }
        ],
        disabled: [SERVER_B],
        note: null
      })
    });
  });

  await page.goto(`/#/p/${project.id}/focus/${sid}`);
  await page.reload();
  const panel = page.getByRole('complementary', { name: '会话详情' });
  const section = panel.getByTestId('session-mcp');
  if (!(await section.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: '详情', exact: true }).click();
  }
  await expect(section).toBeVisible({ timeout: 20_000 });

  const rowA = panel.locator(`[data-testid="session-mcp-row"][data-server="${SERVER_A}"]`);
  const rowB = panel.locator(`[data-testid="session-mcp-row"][data-server="${SERVER_B}"]`);
  await expect(panel.getByTestId('session-mcp-row')).toHaveCount(2);
  await expect(rowA).toContainText(SERVER_A);
  await expect(rowA).toContainText('stdio');
  await expect(rowA).toContainText('来自 echo 工具');
  await expect(rowB).toContainText('http');
  await expect(rowB).toContainText('来自 内网检索');
  await expect(section.getByTestId('session-mcp-missing')).toHaveCount(0);
  await expect(section.getByTestId('session-mcp-note')).toHaveCount(0);

  // 关掉的那行整行变暗；开着的那行不透明。
  await expect(rowB).toHaveAttribute('data-disabled', 'true');
  await expect(rowA).toHaveAttribute('data-disabled', 'false');
  expect(await rowB.evaluate((element) => getComputedStyle(element).opacity)).toBe('0.5');
  expect(await rowA.evaluate((element) => getComputedStyle(element).opacity)).toBe('1');
  await expect(rowA.getByTestId('session-mcp-toggle')).toBeChecked();
  await expect(rowB.getByTestId('session-mcp-toggle')).not.toBeChecked();
  await section.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/session-mcp-rows.png` });

  // PATCH 失败：错误原文显示出来，开关回到原来的「开着」。
  await rowA.getByTestId('session-mcp-toggle').click();
  await expect(section.getByTestId('session-mcp-error')).toContainText('机器不在线，改不了');
  await expect(rowA.getByTestId('session-mcp-toggle')).toBeChecked();
  await expect(rowA).toHaveAttribute('data-disabled', 'false');

  // 手机端（<640px）：详情收在「更多」里；MCP 默认是一行摘要，点开才是清单、能拨。
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  const narrow = page.getByRole('complementary', { name: '会话详情' });
  await narrow.waitFor({ state: 'visible', timeout: 3_000 }).catch(() => undefined);
  if (!(await narrow.isVisible())) {
    await page.getByRole('button', { name: '更多' }).click();
    await page.getByRole('menuitem', { name: /^详情/ }).click();
  }
  const narrowMcp = narrow.getByTestId('session-mcp');
  await expect(narrowMcp).toBeVisible({ timeout: 20_000 });
  await expect(narrowMcp.getByTestId('session-mcp-summary')).toHaveText('2 个 · 关掉 1 个');
  await expect(narrow.getByTestId('session-mcp-row')).toHaveCount(2);
  await expect(narrow.getByTestId('session-mcp-row').first()).toBeHidden();
  await narrowMcp.locator(':scope > summary').click();
  await expect(rowB).toBeVisible();
  await expect(rowA.getByTestId('session-mcp-toggle')).toBeVisible();
  await narrowMcp.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/session-mcp-mobile.png` });
});
