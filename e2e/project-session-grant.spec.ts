import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';
import { ensureFakeWorker, FAKE_AGENT_ID, stopFakeWorker } from './fake-worker.ts';
import { currentRun } from './run-id.ts';

/**
 * 会话详情 · 项目能力（docs/design/project-session-mcp.md §25-35）。
 *
 * 只跑归属人路径：默认全关 → 逐项打开查看 / 建任务 / 开 worktree / 发交接 / 导入候选 / 改资产（每次 PUT
 * 都是并集）→ 重新托管提示 → 撤销（旧工具令牌也失效）→ 刷新后仍是关的 → 单关一项只发剩下的那一项 →
 * 关掉最后一项走 DELETE，不发空 PUT。项目、任务、会话、授权全部走真实 Hub，没有接口桩，也没有
 * 「没有 Worker 就跳过」：这套专用环境缺后端路由时直接失败。会话种在一个只装假 ACP 的远端 Worker 上
 * （e2e/fake-worker.ts），不依赖宿主机 pi 的就绪探测——探测超时会让 derive 偶发 503，跟授权本身无关。
 * 跑法（AGENTS 要求每轮全新的数据目录）：
 *   E2E_PORT=7899 E2E_DATA_DIR=$(mktemp -d /tmp/agent-hub-e2e-grant-XXXXXX) \
 *     npx playwright test e2e/project-session-grant.spec.ts --reporter=list
 */
const RUN = currentRun().replace(/[^a-z0-9]/gi, '').slice(-8).toLowerCase();
const SHOTS = process.env['E2E_SCREENSHOTS'] ?? '/tmp/opencode/shots/project-grant';

/** 本文件的用例共用一个假 ACP Worker，跑完整个文件再关。 */
test.afterAll(() => {
  stopFakeWorker();
});

async function seed(page: Page, baseURL: string) {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  expect(csrf, '登录后没拿到 hub_csrf，写接口会全部被拦').not.toBe('');
  const headers = { origin: baseURL, 'x-hub-csrf': csrf };

  const workerId = await ensureFakeWorker(page, baseURL);

  // 每次跑都用新的项目根目录，不复用上一轮的临时数据。
  const dir = mkdtempSync(join(tmpdir(), 'e2e-project-grant-'));
  const projectResponse = await page.request.post('/api/projects', {
    headers,
    data: { name: `e2e 项目能力 ${RUN}`, rootPath: dir, workerId }
  });
  expect(projectResponse.status(), await projectResponse.text()).toBe(201);
  const project = (await projectResponse.json()) as { id: string };
  const taskResponse = await page.request.post('/api/tasks', {
    headers,
    data: { projectId: project.id, title: `项目能力 ${RUN}` }
  });
  expect(taskResponse.status(), await taskResponse.text()).toBe(201);
  const task = (await taskResponse.json()) as { id: string };
  const derived = await page.request.post('/api/sessions/derive', {
    headers,
    data: { taskId: task.id, agentId: FAKE_AGENT_ID, model: '' }
  });
  expect(derived.status(), await derived.text()).toBe(201);
  const session = (await derived.json()) as { id: string; workerId: string | null };
  // 会话落在假 ACP 机器上，不是本机：本机 pi 的就绪探测超时不该拖垮这个用例。
  expect(session.workerId, '会话应该落在假 ACP 机器上').toBe(workerId);
  return { project, task, session, headers };
}

async function openDetails(page: Page) {
  const panel = page.getByRole('complementary', { name: '会话详情' });
  await panel.waitFor({ state: 'visible', timeout: 2_000 }).catch(() => undefined);
  if (await panel.isVisible()) return panel;
  const narrow = (page.viewportSize()?.width ?? 1280) < 640;
  if (narrow) {
    await page.getByRole('button', { name: '更多' }).click();
    await page.getByRole('menuitem', { name: '详情' }).click();
  } else {
    await page.getByRole('button', { name: '详情', exact: true }).click();
  }
  await expect(panel).toBeVisible();
  return panel;
}

async function gotoSession(page: Page, projectId: string, sessionId: string) {
  await page.goto(`/#/p/${projectId}/focus/${sessionId}`);
  // 只换 hash 不会重新挂载查询；显式刷新一次，保证读到当前授权。
  await page.reload();
}

/** 记录这个授权端点收到的 PUT / DELETE，用来核对「减法」与「最后一项走撤销」。 */
function recordWrites(page: Page, url: string) {
  const writes: { puts: Array<{ scopes: string[]; csrf: string }>; deletes: number } = { puts: [], deletes: 0 };
  page.on('request', (request) => {
    if (!request.url().endsWith(url)) return;
    if (request.method() === 'DELETE') {
      writes.deletes += 1;
      return;
    }
    if (request.method() !== 'PUT') return;
    const body = request.postDataJSON() as { scopes?: unknown } | null;
    if (!Array.isArray(body?.scopes)) return;
    writes.puts.push({
      scopes: body.scopes.filter((scope): scope is string => typeof scope === 'string'),
      csrf: request.headers()['x-hub-csrf'] ?? ''
    });
  });
  return writes;
}

test('项目能力：默认全关、六项独立开启、单关是减法、最后一项走撤销、撤销对旧令牌生效', async ({ page, baseURL }) => {
  test.setTimeout(150_000);
  const { project, session } = await seed(page, baseURL!);
  const url = `/api/sessions/${session.id}/project-tool-grant`;

  // 专用环境不做模拟：路由不存在、返回 HTML 或信封不对都当场失败。
  const probe = await page.request.get(url);
  expect(probe.status(), `GET ${url} 应为 200；后端没装项目授权路由或鉴权失败`).toBe(200);
  expect(probe.headers()['content-type'] ?? '', '项目授权接口返回的不是 JSON').toContain('application/json');
  expect(await probe.json(), 'GET 应该回 { grant: ... } 信封').toHaveProperty('grant');

  // 从真实浏览器请求里核对 PUT 带的是并集而不是单项覆盖，撤销确实只发一次 DELETE。
  const writes = recordWrites(page, url);
  const sentPuts = writes.puts;

  await gotoSession(page, project.id, session.id);
  let panel = await openDetails(page);
  const section = panel.getByTestId('project-grant');
  await expect(section).toBeVisible({ timeout: 20_000 });
  await expect(section).toContainText('默认全关');
  await expect(section.getByTestId('project-grant-empty')).toContainText('没有开启任何项目能力');

  const row = (scope: string) => section.locator(`[data-testid="project-grant-row"][data-scope="${scope}"]`);
  const toggle = (scope: string) => row(scope).getByTestId('project-grant-toggle');
  const taskToggle = toggle('task:write');
  const worktreeToggle = toggle('worktree:open');
  const allScopes = [
    'project:read',
    'task:write',
    'worktree:open',
    'message:send',
    'candidate:import',
    'asset:write'
  ] as const;
  const accessibleNames: Record<(typeof allScopes)[number], string> = {
    'project:read': '查看项目会话（project:read）',
    'task:write': '建任务（task:write）',
    'worktree:open': '开 worktree 会话（worktree:open）',
    'message:send': '发交接消息（message:send）',
    'candidate:import': '导入候选提交（candidate:import）',
    'asset:write': '改项目资产（asset:write）'
  };

  // 默认关：六项都在、都没勾；每行有可读的名字，不只是一个小方块。
  for (const scope of allScopes) {
    await expect(row(scope)).toHaveAttribute('data-enabled', 'false');
    await expect(toggle(scope)).not.toBeChecked();
    await expect(toggle(scope)).toHaveAccessibleName(accessibleNames[scope]);
  }
  await expect(section.getByTestId('project-grant-revoke')).toHaveCount(0);
  await section.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/default-off.png` });

  // 键盘也能开：焦点在开关上按空格。
  await taskToggle.focus();
  await page.keyboard.press('Space');
  await expect(taskToggle).toBeChecked();
  await expect(row('task:write')).toHaveAttribute('data-enabled', 'true');
  await expect(section.getByTestId('project-grant-runtime-note')).toContainText('重新托管');
  await expect(section.getByTestId('project-grant-status')).toContainText('已保存');
  await expect.poll(() => sentPuts.at(-1)?.scopes).toEqual(['task:write']);
  expect(sentPuts.at(-1)?.csrf, '写请求要带 CSRF，和其他会话动作同一套').not.toBe('');

  // 再加一项：PUT 带的是并集，不是把前一项冲掉。
  await worktreeToggle.click();
  await expect(worktreeToggle).toBeChecked();
  await expect(taskToggle).toBeChecked();
  await expect.poll(() => sentPuts.at(-1)?.scopes).toEqual(['task:write', 'worktree:open']);
  await expect(section.getByTestId('project-grant-revoke-note')).toContainText('即使会话进程还拿着之前的工具授权');

  // 查看：只影响自己，已有的两项原样保留。
  await toggle('project:read').click();
  await expect(toggle('project:read')).toBeChecked();
  await expect(toggle('project:read')).toHaveAccessibleName('查看项目会话（project:read）');
  await expect(taskToggle).toBeChecked();
  await expect(worktreeToggle).toBeChecked();
  await expect(toggle('message:send')).not.toBeChecked();
  await expect(toggle('candidate:import')).not.toBeChecked();
  await expect.poll(() => sentPuts.at(-1)?.scopes).toEqual(['project:read', 'task:write', 'worktree:open']);

  // 交接：默认只投递收件箱；开了也不会顺手打开候选导入。
  await toggle('message:send').click();
  await expect(toggle('message:send')).toBeChecked();
  await expect(toggle('candidate:import')).not.toBeChecked();
  await expect.poll(() => sentPuts.at(-1)?.scopes).toEqual(['project:read', 'task:write', 'worktree:open', 'message:send']);

  // 导入候选是独立授权：只影响自己，没开的资产写仍保持关闭。
  await toggle('candidate:import').click();
  for (const scope of ['project:read', 'task:write', 'worktree:open', 'message:send', 'candidate:import'] as const) {
    await expect(toggle(scope)).toBeChecked();
  }
  await expect(toggle('asset:write')).not.toBeChecked();
  await expect.poll(() => sentPuts.at(-1)?.scopes).toEqual([...allScopes.slice(0, 5)]);

  // 资产写是第六项独立授权：只提交/修订待审并管理未来会话启用，不发布、不改上游、不影响运行中会话。
  await toggle('asset:write').click();
  for (const scope of allScopes) await expect(toggle(scope)).toBeChecked();
  await expect(toggle('asset:write')).toHaveAccessibleName('改项目资产（asset:write）');
  await expect.poll(() => sentPuts.at(-1)?.scopes).toEqual([...allScopes]);
  await expect(section.getByTestId('project-grant-runtime-note')).toBeVisible();
  await expect(section.getByTestId('project-grant-revoke-note')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/all-on.png` });

  // 刷新：授权在服务端里，重新打开详情仍是开的。
  await gotoSession(page, project.id, session.id);
  panel = await openDetails(page);
  await expect(panel.getByTestId('project-grant')).toBeVisible({ timeout: 20_000 });
  for (const scope of allScopes) await expect(toggle(scope)).toBeChecked();

  // 撤销是显式两步：先点「撤销全部项目授权」，再确认。
  writes.deletes = 0;
  await panel.getByTestId('project-grant-revoke').click();
  await expect(panel.getByTestId('project-grant-revoke-note')).toContainText('下一次调用也会被拒绝');
  await panel.getByTestId('project-grant-revoke-confirm').click();
  for (const scope of allScopes) await expect(toggle(scope)).not.toBeChecked();
  await expect(panel.getByTestId('project-grant-status')).toContainText('旧令牌也不能再用');
  await expect(panel.getByTestId('project-grant-empty')).toBeVisible();
  await expect.poll(() => writes.deletes, { message: '撤销只该发一次 DELETE' }).toBe(1);
  await page.screenshot({ path: `${SHOTS}/revoked.png` });

  // 撤销后刷新仍是关的：不是前端把勾去掉了、服务端却还留着。
  await gotoSession(page, project.id, session.id);
  panel = await openDetails(page);
  await expect(panel.getByTestId('project-grant')).toBeVisible({ timeout: 20_000 });
  for (const scope of allScopes) await expect(toggle(scope)).not.toBeChecked();

  // 逐项关闭是减法：开两项，单关一项只发剩下的那一项，不发整表、也不撤销整条记录。
  writes.deletes = 0;
  await toggle('task:write').click();
  await expect(toggle('task:write')).toBeChecked();
  await toggle('project:read').click();
  await expect(toggle('project:read')).toBeChecked();
  await expect.poll(() => writes.puts.at(-1)?.scopes).toEqual(['project:read', 'task:write']);

  await toggle('project:read').click();
  await expect(toggle('project:read')).not.toBeChecked();
  await expect(row('project:read')).toHaveAttribute('data-enabled', 'false');
  await expect(toggle('task:write')).toBeChecked();
  await expect.poll(() => writes.puts.at(-1)?.scopes).toEqual(['task:write']);
  await expect(section.getByTestId('project-grant-status')).toContainText('已保存');
  expect(writes.deletes, '只关一项不该走整条撤销').toBe(0);
  await page.screenshot({ path: `${SHOTS}/single-off.png` });

  // 服务端确实只剩那一项：刷新后关掉的仍关着、开着的仍开着。
  await gotoSession(page, project.id, session.id);
  panel = await openDetails(page);
  await expect(panel.getByTestId('project-grant')).toBeVisible({ timeout: 20_000 });
  await expect(toggle('project:read')).not.toBeChecked();
  await expect(toggle('task:write')).toBeChecked();

  // 关掉最后一项：走 DELETE 撤销整条记录（服务端不接受空的 PUT），界面直接回到「一项都没开」。
  const putsBeforeLastOff = writes.puts.length;
  writes.deletes = 0;
  await toggle('task:write').click();
  await expect(toggle('task:write')).not.toBeChecked();
  await expect(panel.getByTestId('project-grant-empty')).toBeVisible();
  await expect(panel.getByTestId('project-grant-status')).toContainText('旧令牌也不能再用');
  await expect.poll(() => writes.deletes, { message: '最后一项关掉时应该发一次 DELETE' }).toBe(1);
  expect(writes.puts.length, '最后一项不该再发 PUT：空授予会被服务端拒绝').toBe(putsBeforeLastOff);
  expect(
    writes.puts.some((put) => put.scopes.length === 0),
    '任何时候都不该发空的 scopes 数组'
  ).toBe(false);

  // 手机 390：详情是底部抽屉；项目能力默认收成一行摘要，点开才是六行开关。
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  panel = await openDetails(page);
  const mobileSection = panel.getByTestId('project-grant');
  await expect(mobileSection).toBeVisible({ timeout: 20_000 });
  await expect(mobileSection.locator(':scope > summary')).toBeVisible();
  await expect(panel.locator('[data-testid="project-grant-row"]').first()).toBeHidden();
  await mobileSection.locator(':scope > summary').click();
  const mobileAsset = mobileSection.locator('[data-testid="project-grant-row"][data-scope="asset:write"]');
  await mobileAsset.scrollIntoViewIfNeeded();
  await expect(mobileAsset.getByTestId('project-grant-toggle')).toBeVisible();
  const toggleBox = await mobileAsset.getByTestId('project-grant-toggle').boundingBox();
  expect(toggleBox).not.toBeNull();
  expect(toggleBox!.x).toBeGreaterThanOrEqual(0);
  expect(toggleBox!.x + toggleBox!.width).toBeLessThanOrEqual(390);
  const rowBox = await mobileAsset.boundingBox();
  expect(rowBox).not.toBeNull();
  expect(rowBox!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: `${SHOTS}/mobile-390.png` });
});
