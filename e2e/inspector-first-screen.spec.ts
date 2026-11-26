import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';
import { ensureFakeWorker, FAKE_AGENT_ID, stopFakeWorker } from './fake-worker.ts';
import { currentRun } from './run-id.ts';

/**
 * 会话详情 · 手机首屏与行内写反馈。
 *
 * 这条用例盯的是「手机上第一屏能不能看懂、能不能动手」，以及写失败时人有没有下一步：
 * - 首屏：会话是什么（状态 / agent·模型）、能改什么（项目能力、MCP 的状态摘要）排在诊断和事件流前面。
 * - 写：整表串行，只有被点的那一行显示「保存中 / 已保存 / 没开成 + 再试一次」；
 *   失败后回滚到服务端状态，**其它已开的授权原样保留**，重试发的是并集而不是只有这一项。
 * - 读不到就写读不到：MCP 清单请求失败时不许编数字，也不许把「读不到」说成「机器上没有」。
 *
 * 项目 / 任务 / 会话 / 假 ACP Worker 都走真实 Hub（本机，无外部云、无真 agent）；
 * 只有两个读写端点用 `page.route` 顶掉，好把 pending 和失败稳定造出来。
 *
 * 跑法：
 *   E2E_PORT=7901 E2E_DATA_DIR=$(mktemp -d /tmp/agent-hub-e2e-inspector-XXXXXX) \
 *     npx playwright test e2e/inspector-first-screen.spec.ts --reporter=list
 */
const RUN = currentRun().replace(/[^a-z0-9]/gi, '').slice(-8).toLowerCase();
const SHOTS = process.env['E2E_SCREENSHOTS'] ?? '/tmp/opencode/shots/inspector-first-screen';

test.afterAll(() => {
  stopFakeWorker();
});

async function seed(page: Page, baseURL: string) {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  expect(csrf, '登录后没拿到 hub_csrf，写接口会全部被拦').not.toBe('');
  const headers = { origin: baseURL, 'x-hub-csrf': csrf };

  const workerId = await ensureFakeWorker(page, baseURL);
  const dir = mkdtempSync(join(tmpdir(), 'e2e-inspector-'));
  const projectResponse = await page.request.post('/api/projects', {
    headers,
    data: { name: `e2e 详情首屏 ${RUN}`, rootPath: dir, workerId }
  });
  expect(projectResponse.status(), await projectResponse.text()).toBe(201);
  const project = (await projectResponse.json()) as { id: string };
  const taskResponse = await page.request.post('/api/tasks', {
    headers,
    data: { projectId: project.id, title: `详情首屏 ${RUN}` }
  });
  expect(taskResponse.status(), await taskResponse.text()).toBe(201);
  const task = (await taskResponse.json()) as { id: string };
  const derived = await page.request.post('/api/sessions/derive', {
    headers,
    data: { taskId: task.id, agentId: FAKE_AGENT_ID, model: '' }
  });
  expect(derived.status(), await derived.text()).toBe(201);
  const session = (await derived.json()) as { id: string };
  return { project, session };
}

async function openDetails(page: Page) {
  const panel = page.getByRole('complementary', { name: '会话详情' });
  await panel.waitFor({ state: 'visible', timeout: 2_000 }).catch(() => undefined);
  if (await panel.isVisible()) return panel;
  const narrow = (page.viewportSize()?.width ?? 1280) < 768;
  if (narrow) {
    await page.getByRole('button', { name: '更多' }).click();
    await page.getByTestId('session-more-details').click();
    await page.getByRole('menuitem', { name: '详情' }).click();
  } else {
    await page.getByRole('button', { name: '详情', exact: true }).click();
  }
  await expect(panel).toBeVisible();
  return panel;
}

/** 手动闸门：用来把请求卡在「进行中」，断言完再放行。 */
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test('首屏：配置摘要在前、诊断收起；写失败回滚并保留其它授权，重试发并集', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const { project, session } = await seed(page, baseURL!);
  await page.setViewportSize({ width: 390, height: 844 });

  // 已有一项无关授权：失败回滚时它必须还在。
  const scopeUrl = `/api/sessions/${session.id}/project-tool-grant`;
  let putMode: 'pending-fail' | 'ok' = 'pending-fail';
  const puts: string[][] = [];
  const putGate = gate();
  await page.route('**/project-tool-grant', async (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      return route.fulfill({ json: { grant: { projectId: project.id, scopes: ['worktree:open'] } } });
    }
    if (method === 'PUT') {
      const body = route.request().postDataJSON() as { scopes?: unknown };
      const scopes = Array.isArray(body.scopes) ? body.scopes.filter((scope): scope is string => typeof scope === 'string') : [];
      puts.push(scopes);
      if (putMode === 'pending-fail') {
        await putGate.promise;
        return route.fulfill({ status: 503, json: { message: '机器不在线，改不了' } });
      }
      return route.fulfill({ json: { grant: { projectId: project.id, scopes } } });
    }
    return route.fulfill({ json: { grant: null } });
  });

  // MCP 清单先卡住，好断言「读取中」不是「没有」；随后失败，断言「读不到」也不编数字。
  const mcpGate = gate();
  await page.route('**/mcp', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await mcpGate.promise;
    return route.fulfill({ status: 500, json: { message: '读不到' } });
  });

  await page.goto(`/#/p/${project.id}/focus/${session.id}`);
  await page.reload();
  const panel = await openDetails(page);
  const section = panel.getByTestId('project-grant');
  await expect(section).toBeVisible({ timeout: 20_000 });

  // ── 首屏：两行摘要（项目能力、MCP）在前，诊断在后；开关和诊断里的能力矩阵都默认收着。
  await expect(section.getByTestId('project-grant-summary')).toHaveText('1 项已开');
  const mcpTop = await panel.getByTestId('session-mcp').boundingBox();
  const grantBox = await section.boundingBox();
  const diag = panel.getByTestId('session-diagnostics');
  const diagBox = await diag.boundingBox();
  expect(grantBox, '项目能力该在面板里').not.toBeNull();
  expect(mcpTop, 'MCP 该在面板里').not.toBeNull();
  expect(diagBox, '诊断该在面板里').not.toBeNull();
  expect(grantBox!.y, '手机上能动手的部分要排在诊断前面').toBeLessThan(diagBox!.y);
  expect(grantBox!.y - (await panel.boundingBox())!.y, '项目能力该在首屏内，不用先滚').toBeLessThan(844 - 140);
  expect(mcpTop!.y, 'MCP 摘要紧跟项目能力').toBeGreaterThan(grantBox!.y);
  expect(mcpTop!.y - (await panel.boundingBox())!.y, 'MCP 摘要也在首屏内').toBeLessThan(844 - 140);
  await expect(panel.locator('[data-testid="project-grant-row"]').first(), '六行开关默认收着').toBeHidden();
  await expect(panel.getByText('能力', { exact: true })).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

  // 点开摘要才是那六项开关。
  await section.locator(':scope > summary').click();
  await expect(panel.locator('[data-testid="project-grant-row"]').first()).toBeVisible();

  // 无关授权保留：worktree:open 是开的，这次不动的其它项都是关的。
  const row = (scope: string) => section.locator(`[data-testid="project-grant-row"][data-scope="${scope}"]`);
  await expect(row('worktree:open')).toHaveAttribute('data-enabled', 'true');
  await expect(row('task:write')).toHaveAttribute('data-enabled', 'false');

  // ── 写：点开一项，请求被卡住 → 只有这一行说「保存中」，其它行暂时锁住；
  //    摘要报的仍是服务端确认的那一项，不许把乐观值当成已生效。
  await row('task:write').getByTestId('project-grant-toggle').click();
  await expect(row('task:write')).toHaveAttribute('data-row-state', 'saving');
  await expect(row('task:write').getByTestId('project-grant-row-status')).toContainText('保存中');
  await expect(section.getByTestId('project-grant-summary')).toHaveText('1 项已开 · 保存中…');
  await expect(row('worktree:open').getByTestId('project-grant-toggle')).toBeDisabled();
  await expect(row('asset:write').getByTestId('project-grant-row-status')).toHaveCount(0);

  // 放行 → 失败：行里给出下一步，状态回到服务端那份（task:write 关着、worktree:open 还开着）。
  putGate.release();
  await expect(row('task:write')).toHaveAttribute('data-row-state', 'failed');
  await expect(row('task:write').getByTestId('project-grant-row-status')).toContainText('没开成');
  await expect(row('task:write').getByTestId('project-grant-row-retry')).toBeVisible();
  await expect(row('task:write')).toHaveAttribute('data-enabled', 'false');
  await expect(row('worktree:open')).toHaveAttribute('data-enabled', 'true');
  await expect(row('worktree:open').getByTestId('project-grant-toggle')).toBeEnabled();
  expect(puts.length, '失败只该发一次').toBe(1);
  await page.screenshot({ path: `${SHOTS}/grant-row-failed-390.png` });

  // 重试成功：发的是「这一项 + 原来那一项」的并集，不是单项覆盖。
  putMode = 'ok';
  await row('task:write').getByTestId('project-grant-row-retry').click();
  await expect(row('task:write')).toHaveAttribute('data-row-state', 'saved');
  await expect(row('task:write').getByTestId('project-grant-row-status')).toContainText('已保存');
  await expect(row('task:write')).toHaveAttribute('data-enabled', 'true');
  await expect(row('worktree:open')).toHaveAttribute('data-enabled', 'true');
  expect(puts.at(-1)).toEqual(['task:write', 'worktree:open']);
  await expect(section.getByTestId('project-grant-summary')).toHaveText('2 项已开');

  // ── MCP：卡住时是「读取中」，失败后是「读不到」，并且没有编出来的行数和「机器上没有」。
  const mcp = panel.getByTestId('session-mcp');
  await expect(mcp.getByTestId('session-mcp-summary')).toHaveText('读取中…');
  mcpGate.release();
  await expect(mcp.getByTestId('session-mcp-summary')).toHaveText('读不到');
  await expect(mcp.getByTestId('session-mcp-row')).toHaveCount(0);
  await expect(mcp.getByTestId('session-mcp-note')).toHaveCount(0);
});

test('320 宽：首屏不横向溢出，诊断与上下文细节默认折叠但可展开', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const { project, session } = await seed(page, baseURL!);
  await page.setViewportSize({ width: 320, height: 720 });

  await page.route('**/project-tool-grant', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: { grant: { projectId: project.id, scopes: [] } } })
      : route.fulfill({ json: { grant: null } })
  );
  // 有清单的 MCP：两行，摘要报数但不夸大（不写「已生效」）。
  await page.route('**/mcp', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          json: {
            servers: [
              { name: 'files', transport: 'stdio', assetId: 'a1', assetName: '本地文件' },
              { name: 'search', transport: 'http', assetId: 'a2', assetName: '检索' }
            ],
            disabled: ['search'],
            note: null
          }
        })
      : route.continue()
  );

  await page.goto(`/#/p/${project.id}/focus/${session.id}`);
  await page.reload();
  const panel = await openDetails(page);
  const grant = panel.getByTestId('project-grant');
  await expect(grant).toBeVisible({ timeout: 20_000 });
  const mcp = panel.getByTestId('session-mcp');

  // 首屏只有两行摘要：点开才看到六项开关和 MCP 清单。
  await expect(grant.getByTestId('project-grant-summary')).toHaveText('默认全关');
  await expect(mcp.getByTestId('session-mcp-summary')).toHaveText('2 个 · 关掉 1 个');
  await expect(panel.locator('[data-testid="project-grant-row"]').first()).toBeHidden();
  await expect(panel.getByTestId('session-mcp-row').first()).toBeHidden();
  const grantBox = await grant.boundingBox();
  const mcpBox = await mcp.boundingBox();
  const panelTop = (await panel.boundingBox())!.y;
  expect(grantBox!.y, '项目能力排在 MCP 前面').toBeLessThan(mcpBox!.y);
  expect(grantBox!.y - panelTop, '项目能力该在首屏内').toBeLessThan(720 - 160);
  expect(mcpBox!.y - panelTop, 'MCP 摘要也在首屏内').toBeLessThan(720 - 160);

  await grant.locator(':scope > summary').click();
  await expect(grant.getByTestId('project-grant-empty')).toBeVisible();
  await mcp.locator(':scope > summary').click();
  await expect(mcp.getByTestId('session-mcp-row')).toHaveCount(2);
  await expect(panel.getByTestId('session-mcp-row').first()).toBeVisible();
  await expect(mcp).toContainText('启动时下发');
  await expect(mcp).not.toContainText('已生效');

  // 会话是什么：agent·模型一行、完整信息默认折叠。
  await expect(panel.getByTestId('session-details-more')).toBeVisible();
  await expect(panel.getByTestId('session-details-ids')).toBeHidden();

  // 上下文：一行估算 + 「细节」折叠；能力矩阵在诊断里，默认收着。
  const context = panel.getByTestId('session-context');
  await expect(context.getByTestId('context-usage')).toBeVisible();
  await expect(context.getByTestId('context-capabilities')).toBeHidden();
  await expect(panel.getByText('能力', { exact: true })).toBeHidden();

  // 320 宽不许横向溢出：包括每个能点的地方都在视口里。
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  for (const id of ['project-grant-toggle', 'session-mcp-toggle']) {
    const boxes = await panel.getByTestId(id).all();
    for (const box of boxes) {
      const rect = await box.boundingBox();
      if (rect === null) continue;
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(320);
    }
  }
  await page.screenshot({ path: `${SHOTS}/first-screen-320.png` });

  // 折叠是真的能展开，不是把内容删了。
  await panel.getByTestId('session-details-more').locator('summary').click();
  await expect(panel.getByTestId('session-details-ids')).toBeVisible();
  await context.getByTestId('context-details').locator('summary').click();
  await expect(context.getByTestId('context-capabilities')).toBeVisible();
  await panel.getByTestId('session-diagnostics').locator('summary').click();
  await expect(panel.getByText('能力', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: '查看事件流' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${SHOTS}/first-screen-320-open.png` });

  // 桌面（≥768px）默认就是摊开的：同样的面板不用先点，开关直接能拨。
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.reload();
  const wide = await openDetails(page);
  await expect(wide.getByTestId('project-grant-summary')).toHaveText('默认全关');
  await expect(wide.locator('[data-testid="project-grant-row"]').first()).toBeVisible();
  await expect(wide.getByTestId('session-mcp-summary')).toHaveText('2 个 · 关掉 1 个');
  await expect(wide.getByTestId('session-mcp-row').first()).toBeVisible();
});
