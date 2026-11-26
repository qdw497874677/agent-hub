import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';
import { ensureFakeWorker, FAKE_AGENT_ID, stopFakeWorker } from './fake-worker.ts';
import { backToChat, openSessionTool } from './session-tools.ts';

/**
 * 会话视图切换：手机通过更多菜单，桌面通过标签，390 与 1280 都要好用。
 */
const SHOTS = process.env['E2E_SCREENSHOTS_TABS'] ?? '/tmp/opencode/shots/files-tabs';
test.afterAll(() => stopFakeWorker());

async function setup(page: Page, baseURL: string) {
  await loginByApi(page);
  const workerId = await ensureFakeWorker(page, baseURL);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL, 'x-hub-csrf': csrf };
  const root = mkdtempSync(join(tmpdir(), 'e2e-tabs-'));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@x', ...args], { cwd: root });
  git('init', '-q');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/app.ts'), 'export const answer = 41;\n');
  writeFileSync(join(root, 'README.md'), '# demo\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  const project = (await (await page.request.post('/api/projects', { data: { name: `e2e 标签 ${Date.now().toString(36)}`, rootPath: root, workerId }, headers })).json()) as { id: string };
  const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '标签切换' }, headers })).json()) as { id: string };
  const derived = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId: FAKE_AGENT_ID, model: '' }, headers });
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
    if (width < 768) {
      await expect(tabs).toBeHidden();
      await expect(page.getByTestId('session-back-to-chat')).toHaveCount(0);
      await page.getByTestId('session-more-trigger').click();
      await expect(page.getByTestId('session-more-changes')).toHaveText('改动 1');
      await page.keyboard.press('Escape');
    } else {
      await expect(tabs).toBeVisible();
      await expect(page.getByTestId('session-tab-chat')).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId('session-tab-changes')).toHaveText('改动 1');
    }
    await expect(page.getByRole('log', { name: '会话记录' })).toBeVisible();
    const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    expect(await fits()).toBe(true);
    await page.screenshot({ path: `${SHOTS}/chat-${name}.png` });

    await openSessionTool(page, 'files');
    const files = page.getByTestId('files-panel-files');
    await expect(files).toBeVisible();
    await expect(page.getByRole('log', { name: '会话记录' })).toBeHidden();
    await files.locator('[data-path="src"]').click();
    await files.locator('[data-path="src/app.ts"]').click();
    await expect(files.getByTestId('file-content')).toContainText('answer = 42');
    expect(await fits()).toBe(true);
    await page.screenshot({ path: `${SHOTS}/files-${name}.png` });
    if (width < 768) {
      await files.getByTestId('files-back').click();
      await expect(files.locator('[data-path="README.md"]')).toBeVisible();
    }

    await openSessionTool(page, 'changes');
    const changes = page.getByTestId('files-panel-changes');
    await expect(changes).toBeVisible();
    await expect(changes.getByTestId('changes-base')).toHaveValue('session');
    await changes.getByTestId('change-row').filter({ hasText: 'src/app.ts' }).click();
    await expect(changes.getByTestId('diff-view')).toContainText('42');
    expect(await fits()).toBe(true);
    await page.screenshot({ path: `${SHOTS}/changes-${name}.png` });

    // 手机键盘打开菜单并用 Escape 收起；桌面保留标签的方向键语义。
    if (width < 768) {
      const trigger = page.getByTestId('session-more-trigger');
      await trigger.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('session-more-files')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      await expect(trigger).toBeFocused();
      await openSessionTool(page, 'files');
      await expect(files).toBeVisible();
    } else {
      await page.getByTestId('session-tab-changes').focus();
      await page.keyboard.press('ArrowLeft');
      await expect(page.getByTestId('session-tab-files')).toHaveAttribute('aria-selected', 'true');
    }
    await backToChat(page);
    await expect(page.getByRole('log', { name: '会话记录' })).toBeVisible();
    await expect(page.getByTestId('files-panel-files')).toBeHidden();

    // 详情 → 浏览文件：切到会话的「文件」标签页，详情关掉，旧浮层不再出现
    // 桌面走 header 的「详情」按钮；手机入口在「更多」的「详情」分类。
    if (width < 768) {
      await page.getByTestId('session-more-trigger').click();
      await page.getByTestId('session-more-details').click();
      await page.getByRole('menuitem', { name: /^详情/ }).click();
    } else {
      await page.getByRole('button', { name: '详情' }).click();
    }
    await page.getByTestId('open-files').click();
    if (width < 768) await expect(page.getByTestId('session-back-to-chat')).toBeVisible();
    else await expect(page.getByTestId('session-tab-files')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('files-panel-files')).toBeVisible();
    await expect(page.getByTestId('open-files')).toHaveCount(0);
    await expect(page.getByTestId('files-browser')).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/details-browse-${name}.png` });
  });
}

for (const [name, width, height] of [['mobile-390', 390, 844], ['desktop-1280', 1280, 800]] as const) {
  test(`切回文件 / 改动先显示缓存再刷新，离线仍显示离线（${name}）`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height });
    const { projectId, sid, root } = await setup(page, baseURL!);
    await page.goto(`/#/p/${projectId}/focus/${sid}`);
    await openSessionTool(page, 'files');
    const files = page.getByTestId('files-panel-files');
    await files.locator('[data-path="src"]').click();
    await files.locator('[data-path="src/app.ts"]').click();
    await expect(files.getByTestId('file-content')).toContainText('answer = 42');
    await openSessionTool(page, 'changes');
    const changes = page.getByTestId('files-panel-changes');
    await changes.getByTestId('change-row').filter({ hasText: 'src/app.ts' }).click();
    await expect(changes.getByTestId('diff-view')).toContainText('42');

    // 第二次切回：内容立即在，没有「读取中」
    await backToChat(page);
    writeFileSync(join(root, 'src/app.ts'), 'export const answer = 43;\n');
    await openSessionTool(page, 'files');
    await expect(files.getByTestId('file-content')).toBeVisible({ timeout: 300 });
    await expect(files.getByText('读取中…')).toHaveCount(0);
    await expect(files.getByTestId('file-content')).toContainText('answer = 43', { timeout: 15_000 });
    await openSessionTool(page, 'changes');
    await expect(changes.getByTestId('diff-view')).toBeVisible({ timeout: 300 });
    await expect(changes.getByText('读取中…')).toHaveCount(0);
    await expect(changes.getByTestId('diff-view')).toContainText('43', { timeout: 15_000 });

    // Worker 真不在线：重读失败就显示离线，不拿缓存冒充当前。正文用接口的 { error: { code, message } }。
    await page.route(`**/api/sessions/${sid}/**`, (route) =>
      /\/(files|git)\b/.test(route.request().url())
        ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable', message: 'Worker「e2e」不在线' } }) })
        : route.fallback()
    );
    await openSessionTool(page, 'files');
    await expect(files.getByTestId('files-error').first()).toContainText('机器离线');
    await expect(files.getByTestId('file-content')).toHaveCount(0);
    await openSessionTool(page, 'changes');
    await expect(changes.getByTestId('files-error').first()).toContainText('机器离线');
    await expect(changes.getByTestId('change-row')).toHaveCount(0);
    if (width < 768) {
      await page.getByTestId('session-more-trigger').click();
      await expect(page.getByTestId('session-more-changes')).toHaveText('改动');
    } else {
      await expect(page.getByTestId('session-tab-changes')).toHaveText('改动');
    }
  });
}
