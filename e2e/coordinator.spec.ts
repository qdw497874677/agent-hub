import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';
import { ensureFakeWorker, FAKE_AGENT_ID, stopFakeWorker } from './fake-worker.ts';

/**
 * 项目主会话：人手动开在项目长期工作目录里、暂时没有归属任务的常驻会话。
 *
 * 这一组只测「它能不能被看见、能不能用普通的会话动作、能不能从界面开」，不测派工
 * （那条流程在 workspace-delegation 的专用用例里）。
 *
 * `/api/coordinators` 是必需门禁，不是可选依赖：路由没挂上这里就会红，别用 skip 掩盖。
 * 测试自带远端假 ACP Worker，不依赖本机 agent。
 */

interface Seed {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly name: string;
}

const headers = async (page: Page, baseURL: string | undefined) => {
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  return { origin: baseURL!, 'x-hub-csrf': csrf };
};

test.afterAll(stopFakeWorker);

/** 一个空项目 + 一条长期工作目录：主会话只能开在这种目录里。 */
async function seedProject(page: Page, h: Record<string, string>) {
  const workerId = await ensureFakeWorker(page, h.origin!);
  const dir = mkdtempSync(join(tmpdir(), 'e2e-coordinator-'));
  const name = `e2e 主会话 ${Date.now().toString(36)}`;
  const project = (await (await page.request.post('/api/projects', { data: { name, rootPath: dir, workerId }, headers: h })).json()) as { id: string };
  const workspace = await page.request.post(`/api/projects/${project.id}/workspaces`, {
    // 工作目录不能放在项目根路径里面：服务端按「目录不能互相嵌套」校验（上一轮的同名前缀也会撞上）。
    data: { kind: 'long_lived', mode: 'create', path: mkdtempSync(join(tmpdir(), 'e2e-coordinator-ws-')), workerId },
    headers: h
  });
  expect(workspace.ok(), await workspace.text()).toBeTruthy();
  const created = (await workspace.json()) as { id: string; workerId: string | null };
  expect(created.workerId).toBe(workerId);
  return { projectId: project.id, workspaceId: created.id, workerId, name };
}

async function seedCoordinator(page: Page, h: Record<string, string>): Promise<Seed> {
  const { projectId, workspaceId, name } = await seedProject(page, h);
  const started = await page.request.post('/api/coordinators', {
    data: { projectId, workspaceId, agentId: FAKE_AGENT_ID, model: '' },
    headers: h
  });
  // 路由是必需门禁：这里必须 201，404 说明 hub 没把这个能力挂上。
  expect(started.status(), await started.text()).toBe(201);
  const body = (await started.json()) as { session: { id: string; taskId: string | null }; created: boolean };
  expect(body.session.taskId, '主会话不该被塞进某条任务').toBeNull();
  expect(body.created).toBe(true);
  return { projectId, workspaceId, sessionId: body.session.id, name };
}

/** 主会话在登记表里：界面靠它把「主会话」和 bot / 群开的无任务会话分开。 */
async function registered(page: Page, projectId: string): Promise<Array<{ sessionId: string; workspaceId: string }>> {
  const response = await page.request.get(`/api/coordinators?projectId=${projectId}`);
  expect(response.ok(), await response.text()).toBeTruthy();
  return ((await response.json()) as { coordinators: Array<{ sessionId: string; workspaceId: string }> }).coordinators;
}

test.use({ viewport: { width: 390, height: 844 } });

test('列表视图：工作空间内区分主会话，行上写明「没有任务」，手机可打开', async ({ page, baseURL }, testInfo) => {
  await loginByApi(page);
  const seed = await seedCoordinator(page, await headers(page, baseURL));

  await page.goto(`/#/p/${seed!.projectId}`);
  await page.getByRole('group', { name: '视图' }).getByRole('button', { name: '列表', exact: true }).click();

  // 组头只说组名，不冒充「任务：…」；登记身份落在 data-kind 上，别靠颜色区分。
  const group = page.getByRole('region', { name: '主会话' });
  await expect(group).toBeVisible();
  await expect(group.locator('xpath=ancestor::*[@data-testid="list-workspace-group"][1]')).toBeVisible();
  await expect(group).toHaveAttribute('data-kind', 'coordinator');
  await expect(group.getByTestId('list-session-label')).not.toHaveText('—');
  await expect(group.getByTestId('list-session-meta')).toContainText('没有任务');

  const row = group.getByTestId('list-session-row').first();
  const box = await row.boundingBox();
  expect(box && box.height >= 44 && box.x + box.width <= 390, '手机上这一行要够高、不出屏').toBe(true);
  await page.screenshot({ path: testInfo.outputPath('coordinator-list-390.png') });
});

test('侧栏：主会话位于自己的工作空间，打开行为不变', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await loginByApi(page);
  const seed = await seedCoordinator(page, await headers(page, baseURL));

  await page.goto(`/#/p/${seed!.projectId}`);
  const group = page.getByTestId('sidebar-coordinators');
  await expect(group).toBeVisible();
  await expect(group.locator('xpath=ancestor::*[@data-testid="sidebar-workspace-group"][1]')).toBeVisible();
  await expect(group).toHaveAttribute('aria-label', '主会话');
  // 同一个桶里的普通无任务会话不会被一起喊成主会话：这里只有登记过的那一条。
  await expect(group.getByTestId('sidebar-session-row')).toHaveCount(1);
  await expect(page.getByTestId('sidebar-unassigned')).toHaveCount(0);

  // 点一下还是走原来那条路：打开会话
  await group.getByTestId('sidebar-session-row').first().click();
  await expect(page.getByTestId('session-title')).toBeVisible({ timeout: 30_000 });
});

test('专注页：标题是「主会话」，缺任务的动作禁用并说清原因', async ({ page, baseURL }) => {
  await loginByApi(page);
  const seed = await seedCoordinator(page, await headers(page, baseURL));

  await page.goto(`/#/p/${seed!.projectId}/focus/${seed!.sessionId}`);
  // 主会话还没有说过话：标题栏用「主会话」，不能出现 null / undefined 这种漏出来的字段名
  const canvas = (await (await page.request.get(`/api/projects/${seed!.projectId}/canvas`)).json()) as {
    sessions: Array<{ id: string; title: string | null }>;
  };
  const own = canvas.sessions.find((session) => session.id === seed!.sessionId);
  const title = page.getByTestId('session-title');
  await expect(title).toBeVisible({ timeout: 30_000 });
  await expect(title).toHaveText(own?.title ?? '主会话');
  await expect(title).not.toContainText('null');

  await page.getByRole('button', { name: '更多' }).click();
  await page.getByTestId('session-more-actions').click();
  const side = page.getByTestId('session-side-open');
  await expect(side).toBeDisabled();
  await expect(side).toContainText('先派工到任务');
  await page.keyboard.press('Escape');

  // 派生要落在任务上：没有任务的会话不提供「发完再开一条」
  await expect(page.getByLabel('发送消息')).toHaveAttribute('aria-keyshortcuts', 'Meta+Enter Control+Enter');
});

test('首页把主会话列出来，标题是「主会话」而不是空字符串', async ({ page, baseURL }) => {
  await loginByApi(page);
  const seed = await seedCoordinator(page, await headers(page, baseURL));

  await page.goto('/');
  const row = page.getByTestId('home-session-row').filter({ hasText: seed!.name }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText('主会话');
  await expect(row).not.toContainText('null');
});

test('侧栏「新开主会话」从界面走同一条 POST：选长期目录 → 直接进会话', async ({ page, baseURL }) => {
  await loginByApi(page);
  const h = await headers(page, baseURL);
  const seeded = await seedProject(page, h);

  await page.goto(`/#/p/${seeded.projectId}`);
  // 手机上侧栏是抽屉：先打开导航再点动作（桌面也渲染一份侧栏，所以限定在抽屉里点）
  await page.getByRole('button', { name: '打开侧栏' }).click();
  await page.getByTestId('nav-sheet').getByTestId('sidebar-new-coordinator').click();

  const dialog = page.getByTestId('coordinator-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('coordinator-agent').selectOption(FAKE_AGENT_ID);
  const machines = dialog.getByRole('radiogroup', { name: '在哪台跑' });
  if (await machines.isVisible()) {
    const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ workerId: string; label: string }>;
    const worker = workers.find((item) => item.workerId === seeded.workerId);
    expect(worker).toBeDefined();
    await machines.getByRole('radio', { name: worker!.label, exact: false }).click();
  }
  // 这条项目只有一条长期目录：它就是这里能选的唯一一行
  await dialog.getByRole('radiogroup', { name: '选择工作目录' }).getByRole('radio').first().click();
  const start = page.getByTestId('coordinator-start');
  await expect(start).toBeEnabled();
  const started = page.waitForResponse((response) => response.url().endsWith('/api/coordinators') && response.request().method() === 'POST');
  await start.click();
  const response = await started;
  expect(response.status(), await response.text()).toBe(201);

  // 开好就进去：登记表里能查到，界面标题是「主会话」
  await expect(page.getByTestId('session-title')).toHaveText('主会话', { timeout: 30_000 });
  const rows = await registered(page, seeded.projectId);
  expect(rows.map((row) => row.workspaceId)).toEqual([seeded.workspaceId]);
  expect(page.url()).toContain(`/focus/${rows[0]!.sessionId}`);
});
