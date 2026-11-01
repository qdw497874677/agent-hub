import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';

/**
 * PR #156 方案 A：会话头部「对话 / 文件 / 改动」标签切换，手机 390 与桌面 1280 都要好用。
 */
const SHOTS = process.env['E2E_SCREENSHOTS_TABS'] ?? '/workspace/shots/files-tabs';

async function setup(page: Page, baseURL: string) {
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL, 'x-hub-csrf': csrf };
  let agentId: string | undefined;
  for (let i = 0; i < 40 && !agentId; i++) {
    const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ agentIds: string[]; state: string }>;
    agentId = workers.find((worker) => worker.state === 'online')?.agentIds[0];
    if (!agentId) await page.waitForTimeout(500);
  }
  test.skip(!agentId, '这台机器上没有可用的 agent');
  const root = mkdtempSync(join(tmpdir(), 'e2e-tabs-'));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@x', ...args], { cwd: root });
  git('init', '-q');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/app.ts'), 'export const answer = 41;\n');
  writeFileSync(join(root, 'README.md'), '# demo\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 标签 ${Date.now().toString(36)}`, rootPath: root }, headers })).json()) as { id: string };
  const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '标签切换' }, headers })).json()) as { id: string };
  const derived = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId, model: '' }, headers });
  expect(derived.status(), await derived.text()).toBe(201);
  const sid = ((await derived.json()) as { id: string }).id;
  // 会话开始之后才改：对比「会话开始时」应能看到
  writeFileSync(join(root, 'src/app.ts'), 'export const answer = 42;\n');
  return { projectId: project.id, sid, root };
}

for (const [name, width, height] of [['mobile-390', 390, 844], ['desktop-1280', 1280, 800]] as const) {
  test(`会话标签切换：对话 / 文件 / 改动（${name}）`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height });
    const { projectId, sid } = await setup(page, baseURL!);
    await page.goto(`/#/p/${projectId}/focus/${sid}`);
    const tabs = page.getByTestId('session-tabs');
    await expect(tabs).toBeVisible();
    await expect(page.getByTestId('session-tab-chat')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('log', { name: '对话记录' })).toBeVisible();
    await expect(page.getByTestId('session-tab-changes')).toHaveText('改动 1');
    const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    expect(await fits()).toBe(true);
    await page.screenshot({ path: `${SHOTS}/chat-${name}.png` });

    await page.getByTestId('session-tab-files').click();
    const files = page.getByTestId('files-panel-files');
    await expect(page.getByRole('log', { name: '对话记录' })).toBeHidden();
    await files.locator('[data-path="src"]').click();
    await files.locator('[data-path="src/app.ts"]').click();
    await expect(files.getByTestId('file-content')).toContainText('answer = 42');
    expect(await fits()).toBe(true);
    await page.screenshot({ path: `${SHOTS}/files-${name}.png` });
    if (width < 768) {
      await files.getByTestId('files-back').click();
      await expect(files.locator('[data-path="README.md"]')).toBeVisible();
    }

    await page.getByTestId('session-tab-changes').click();
    const changes = page.getByTestId('files-panel-changes');
    await expect(changes.getByTestId('changes-base')).toHaveValue('session');
    await changes.getByTestId('change-row').filter({ hasText: 'src/app.ts' }).click();
    await expect(changes.getByTestId('diff-view')).toContainText('42');
    expect(await fits()).toBe(true);
    await page.screenshot({ path: `${SHOTS}/changes-${name}.png` });

    // 键盘：← 回到文件，再点对话，输入框回来
    await page.getByTestId('session-tab-changes').focus();
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('session-tab-files')).toHaveAttribute('aria-selected', 'true');
    await page.getByTestId('session-tab-chat').click();
    await expect(page.getByRole('log', { name: '对话记录' })).toBeVisible();
    await expect(page.getByTestId('files-panel-files')).toBeHidden();

    // 详情 → 浏览文件：切到会话的「文件」标签页，详情关掉，旧浮层不再出现
    await page.getByRole('button', { name: '详情' }).click();
    await page.getByTestId('open-files').click();
    await expect(page.getByTestId('session-tab-files')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('files-panel-files')).toBeVisible();
    await expect(page.getByTestId('open-files')).toHaveCount(0);
    await expect(page.getByTestId('files-browser')).toHaveCount(0);
    await page.screenshot({ path: `/workspace/shots/details-browse-files/${name}.png` });
  });
}

for (const [name, width, height] of [['mobile-390', 390, 844], ['desktop-1280', 1280, 800]] as const) {
  test(`切回文件 / 改动先显示缓存再刷新，离线仍显示离线（${name}）`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height });
    const { projectId, sid, root } = await setup(page, baseURL!);
    await page.goto(`/#/p/${projectId}/focus/${sid}`);
    await page.getByTestId('session-tab-files').click();
    const files = page.getByTestId('files-panel-files');
    await files.locator('[data-path="src"]').click();
    await files.locator('[data-path="src/app.ts"]').click();
    await expect(files.getByTestId('file-content')).toContainText('answer = 42');
    await page.getByTestId('session-tab-changes').click();
    const changes = page.getByTestId('files-panel-changes');
    await changes.getByTestId('change-row').filter({ hasText: 'src/app.ts' }).click();
    await expect(changes.getByTestId('diff-view')).toContainText('42');

    // 第二次切回：内容立即在，没有「读取中」
    await page.getByTestId('session-tab-chat').click();
    writeFileSync(join(root, 'src/app.ts'), 'export const answer = 43;\n');
    await page.getByTestId('session-tab-files').click();
    await expect(files.getByTestId('file-content')).toBeVisible({ timeout: 300 });
    await expect(files.getByText('读取中…')).toHaveCount(0);
    await expect(files.getByTestId('file-content')).toContainText('answer = 43', { timeout: 15_000 });
    await page.getByTestId('session-tab-changes').click();
    await expect(changes.getByTestId('diff-view')).toBeVisible({ timeout: 300 });
    await expect(changes.getByText('读取中…')).toHaveCount(0);
    await expect(changes.getByTestId('diff-view')).toContainText('43', { timeout: 15_000 });

    // Worker 离线：重读失败就显示离线，不拿缓存冒充当前
    await page.route(`**/api/sessions/${sid}/**`, (route) =>
      /\/(files|git)\b/.test(route.request().url()) ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"worker offline"}' }) : route.fallback()
    );
    await page.getByTestId('session-tab-files').click();
    await expect(files.getByTestId('files-error').first()).toContainText('Worker 离线');
    await expect(files.getByTestId('file-content')).toHaveCount(0);
    await page.getByTestId('session-tab-changes').click();
    await expect(changes.getByTestId('files-error').first()).toContainText('Worker 离线');
    await expect(changes.getByTestId('change-row')).toHaveCount(0);
    await expect(page.getByTestId('session-tab-changes')).toHaveText('改动');
  });
}
