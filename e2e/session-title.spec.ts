import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';

const SHOTS = '/workspace/shots/session-title';

async function seed(page: Page, baseURL: string, tag: string) {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((c) => c.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL, 'x-hub-csrf': csrf };
  let agentId: string | undefined;
  for (let i = 0; i < 40 && !agentId; i++) {
    const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ agentIds: string[]; state: string }>;
    agentId = workers.find((w) => w.state === 'online')?.agentIds[0];
    if (!agentId) await page.waitForTimeout(500);
  }
  test.skip(!agentId, '这台机器上没有可用的 agent');
  const dir = mkdtempSync(join(tmpdir(), 'e2e-title-'));
  const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 会话名 ${tag} ${Date.now().toString(36)}`, rootPath: dir }, headers })).json()) as { id: string };
  const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '改名任务' }, headers })).json()) as { id: string };
  const session = (await (await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId, model: '' }, headers })).json()) as { id: string };
  return { project, task, session, headers };
}

async function openList(page: Page, projectId: string) {
  await page.goto(`/#/p/${projectId}`);
  await page.getByRole('button', { name: '列表' }).click();
  return page.getByRole('region', { name: '任务：改名任务' }).getByTestId('list-session-row');
}

test.describe('手机 390', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('会话名：没起名回退「会话 N」+ 任务名；点标题改名；刷新还在；清空回退', async ({ page, baseURL }) => {
    const { project, session } = await seed(page, baseURL!, '390');
    mkdirSync(SHOTS, { recursive: true });
    const rows = await openList(page, project.id);
    await expect(rows.nth(0).getByTestId('list-session-label')).toHaveText('会话 1');

    await page.goto(`/#/p/${project.id}/focus/${session.id}`);
    const title = page.getByTestId('session-title');
    await expect(title).toHaveText('改名任务');
    await page.screenshot({ path: `${SHOTS}/390-before.png` });
    await title.click();
    const input = page.getByTestId('session-title-input');
    await expect(input).toBeFocused();
    const box = await input.boundingBox();
    expect(box && box.x + box.width <= 390).toBe(true);
    await input.fill('查登录 bug');
    await page.screenshot({ path: `${SHOTS}/390-editing.png` });
    await input.press('Enter');
    await expect(title).toHaveText('查登录 bug');

    await page.reload();
    await expect(page.getByTestId('session-title')).toHaveText('查登录 bug');
    await page.screenshot({ path: `${SHOTS}/390-renamed.png` });
    const after = await openList(page, project.id);
    await expect(after.nth(0).getByTestId('list-session-label')).toHaveText('查登录 bug');
    await page.screenshot({ path: `${SHOTS}/390-list.png` });

    // 清空 = 回到默认显示
    await page.goto(`/#/p/${project.id}/focus/${session.id}`);
    await page.getByTestId('session-title').click();
    await page.getByTestId('session-title-input').fill('');
    await page.getByTestId('session-title-input').press('Enter');
    await expect(page.getByTestId('session-title')).toHaveText('改名任务');
    const cleared = await openList(page, project.id);
    await expect(cleared.nth(0).getByTestId('list-session-label')).toHaveText('会话 1');
  });
});

test.describe('桌面 1280', () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test('会话名：⋯ 菜单里「重命名」；Esc 取消；刷新后标题和列表都还在', async ({ page, baseURL }) => {
    const { project, session } = await seed(page, baseURL!, '1280');
    mkdirSync(SHOTS, { recursive: true });
    await page.goto(`/#/p/${project.id}/focus/${session.id}`);
    const title = page.getByTestId('session-title').first();
    await expect(title).toHaveText('改名任务');

    await title.click();
    await page.getByTestId('session-title-input').fill('不要这个');
    await page.getByTestId('session-title-input').press('Escape');
    await expect(title).toHaveText('改名任务');

    const header = page.locator('header', { has: page.getByTestId('session-title') }).first();
    await header.getByRole('button', { name: '更多' }).click();
    await page.getByRole('menuitem', { name: /^重命名/ }).click();
    const input = page.getByTestId('session-title-input');
    await expect(input).toBeFocused();
    await input.fill('桌面上起的名字');
    await page.screenshot({ path: `${SHOTS}/1280-editing.png` });
    await input.press('Enter');
    await expect(title).toHaveText('桌面上起的名字');

    await page.reload();
    await expect(page.getByTestId('session-title').first()).toHaveText('桌面上起的名字');
    await page.screenshot({ path: `${SHOTS}/1280-renamed.png` });
    const rows = await openList(page, project.id);
    await expect(rows.nth(0).getByTestId('list-session-label')).toHaveText('桌面上起的名字');
    await page.screenshot({ path: `${SHOTS}/1280-list.png` });
  });
});
