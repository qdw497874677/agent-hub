import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { ensureFakeWorker, stopFakeWorker } from './fake-worker.ts';
import { loginByApi } from './login.ts';

const AGENT = 'sidebar-derive-fake';
const TITLE = '很长的侧边栏任务标题'.repeat(8);

test.afterAll(() => stopFakeWorker());

test('任务侧栏和画布打开同一开始会话流程，手机可直接创建', async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  await loginByApi(page);
  const workerId = await ensureFakeWorker(page, baseURL!, AGENT);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  const dir = mkdtempSync(join(tmpdir(), 'e2e-sidebar-derive-'));
  try {
    const created = await page.request.post('/api/projects', { data: { name: `侧栏创建-${Date.now()}`, rootPath: dir, workerId }, headers });
    expect(created.ok(), await created.text()).toBe(true);
    const project = (await created.json()) as { id: string };
    const makeTask = async (title: string) => {
      const response = await page.request.post('/api/tasks', { data: { projectId: project.id, title }, headers });
      expect(response.ok(), await response.text()).toBe(true);
      return (await response.json()) as { id: string };
    };
    const task = await makeTask(TITLE);
    const archived = await makeTask('不应显示的归档任务');
    expect((await page.request.post(`/api/tasks/${archived.id}/archive`, { data: { archived: true }, headers })).ok()).toBe(true);

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/#/p/${project.id}/canvas`);
    const sidebar = page.getByTestId('project-sidebar').filter({ visible: true });
    const create = sidebar.getByRole('button', { name: `为${TITLE}开始会话` });
    await expect(create).toBeVisible(); // 没有会话也可以创建，长标题不能挤掉按钮
    await expect(sidebar.getByRole('button', { name: '为不应显示的归档任务开始会话' })).toHaveCount(0);
    await create.focus();
    await page.keyboard.press('ArrowDown');
    await expect(create).toBeFocused();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: '开始会话' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '取消' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(create).toBeFocused();

    // 画布入口打开同一个对话框，再切到手机侧栏完成真正的派生。
    await page.locator('.react-flow__node-task').filter({ hasText: TITLE }).getByRole('button', { name: '＋ 会话' }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('#derive-agent')).toBeVisible();
    await dialog.getByRole('button', { name: '取消' }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    const menu = page.getByRole('button', { name: '打开侧栏' });
    await menu.click();
    const drawer = page.getByTestId('nav-sheet');
    const mobileCreate = drawer.getByRole('button', { name: `为${TITLE}开始会话` });
    await expect(mobileCreate).toBeVisible();
    // 抽屉入场的 transform 会让 boundingBox 出现浮点误差，校验实际 CSS 触控尺寸。
    await expect(mobileCreate).toHaveCSS('width', '44px');
    await expect(mobileCreate).toHaveCSS('height', '44px');
    await mobileCreate.click();
    await expect(drawer).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect.poll(() => dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await dialog.getByRole('button', { name: '取消' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(menu).toBeFocused();

    await menu.click();
    await page.getByTestId('nav-sheet').getByRole('button', { name: `为${TITLE}开始会话` }).click();
    await expect(dialog).toBeVisible();
    if (!(await dialog.locator('#derive-agent').isVisible())) await dialog.getByTestId('derive-agent-section').locator('summary').click();
    await dialog.locator('#derive-agent').selectOption(AGENT);
    await dialog.getByTestId('ws-new-empty').click();
    const start = dialog.getByRole('button', { name: '开始', exact: true });
    await expect(start).toBeEnabled();
    await start.click();
    await expect(dialog).toHaveCount(0, { timeout: 60_000 });
    await expect.poll(async () => {
      const canvas = await (await page.request.get(`/api/projects/${project.id}/canvas`)).json() as { sessions: Array<{ taskId: string; agentId: string }> };
      return canvas.sessions.some((session) => session.taskId === task.id && session.agentId === AGENT);
    }).toBe(true);
    await expect(page).toHaveURL(/\/focus/);

    // 有会话时，创建按钮不改变任务的展开状态；标题按钮仍可折叠。
    await page.setViewportSize({ width: 1280, height: 900 });
    const titleButton = sidebar.locator('button[data-nav-row][aria-expanded]').filter({ hasText: TITLE });
    await expect(titleButton).toHaveAttribute('aria-expanded', 'true');
    await titleButton.click();
    await expect(titleButton).toHaveAttribute('aria-expanded', 'false');
    await create.click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '取消' }).click();
    await expect(titleButton).toHaveAttribute('aria-expanded', 'false');
    await expect(create).toBeFocused();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
