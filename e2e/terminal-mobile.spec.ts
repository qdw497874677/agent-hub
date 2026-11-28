import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { loginByApi } from './login.ts';
import { openDocumentNewMenu } from './document-tabs.ts';
import { ensureFakeWorker, FAKE_AGENT_ID, stopFakeWorker } from './fake-worker.ts';

const SHOTS = process.env['E2E_SCREENSHOTS'];
const checkouts: string[] = [];

test.afterAll(() => {
  stopFakeWorker();
  for (const path of checkouts) rmSync(path, { recursive: true, force: true });
});

async function seedSession(
  page: Page,
  baseURL: string | undefined,
  prefix: string
): Promise<{ id: string; path: string; projectId: string }> {
  const workerId = await ensureFakeWorker(page, baseURL!, FAKE_AGENT_ID, { env: { TERMINAL_SHELL: '/bin/sh' } });
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  const dir = mkdtempSync(join(tmpdir(), `e2e-${prefix}-`));
  checkouts.push(dir);
  const name = `e2e ${prefix} ${Date.now().toString(36)}`;
  const post = async (url: string, data: unknown): Promise<{ id: string }> => {
    const response = await page.request.post(url, { data, headers });
    expect(response.status(), await response.text()).toBe(201);
    return await response.json() as { id: string };
  };
  const project = await post('/api/projects', { name });
  const workspace = await post(`/api/projects/${project.id}/workspaces`, { kind: 'long_lived', mode: 'link', workerId, path: dir });
  const task = await post('/api/tasks', { projectId: project.id, title: '终端' });
  const derived = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId: FAKE_AGENT_ID, model: '', workerId, workspaceId: workspace.id }, headers });
  expect(derived.status(), await derived.text()).toBe(201);
  const session = (await derived.json()) as { id: string };
  return { id: session.id, path: dir, projectId: project.id };
}

async function openTerminalTab(page: Page) {
  await openDocumentNewMenu(page, page.getByTestId('session-document-tabs'), { compact: (page.viewportSize()?.width ?? 1280) < 420 });
  await connectTerminalTab(page);
}

async function connectTerminalTab(page: Page) {
  await newTerminal(page).click();
  await expect(page.getByTestId('terminal-pane')).toBeVisible();
  await expect(page.getByTestId('terminal-status')).toHaveText(/已连接/, { timeout: 30_000 });
}

function newTerminal(page: Page) {
  return page.getByTestId('session-tab-new-terminal');
}

test.describe('触摸设备', () => {
  // 真机是触摸设备：开 hasTouch 才会让 `(pointer: coarse)` 成立，按键条才渲染。
  test.use({ hasTouch: true });

  /**
   * 手机上的会话终端：菜单入口在、终端能连上、底部按键条在且不越界。
   * 手机软键盘上没有 Esc/Tab/Ctrl/方向键，全屏 TUI 全靠这条按键条。
   */
  test('手机终端：入口可见、连上后出现按键条且不越出屏幕', async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginByApi(page);
    const { id, projectId } = await seedSession(page, baseURL, 'term-mobile');
    await page.goto(`/#/p/${projectId}/focus/${id}`);
    await expect(page.getByRole('textbox', { name: '发送消息' })).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('session-more-trigger').click({ timeout: 10_000 });
    await expect(page.getByRole('menu')).toBeVisible();
    await expect(page.getByRole('menu').getByRole('menuitem', { name: /终端/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    const tabs = page.getByTestId('session-document-tabs');
    let release!: () => void;
    const held = new Promise<void>((done) => { release = done; });
    const eligibilityPath = `/api/sessions/${id}/terminal-availability`;
    let reads = 0;
    let sockets = 0;
    await page.route(`**${eligibilityPath}`, async (route) => {
      reads++;
      await held;
      await route.continue();
    });
    page.on('websocket', (socket) => {
      if (new URL(socket.url()).pathname === `/api/sessions/${id}/terminal`) sockets++;
    });
    try {
      await openDocumentNewMenu(page, tabs, { touch: true, compact: true });
      await expect.poll(() => reads).toBe(1);
      await expect(newTerminal(page)).toBeDisabled();
      await expect(page.getByTestId('terminal-pane')).toHaveCount(0);
      expect(sockets).toBe(0);
    } finally {
      release();
    }
    await connectTerminalTab(page);
    expect(sockets).toBe(1);

    const keys = page.getByTestId('terminal-keys');
    await expect(keys).toBeVisible();
    const box = (await keys.boundingBox())!;
    expect(box.x, '按键条在屏幕内').toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, '按键条不越出右边缘').toBeLessThanOrEqual(390 + 1);
    expect(box.y + box.height, '按键条不越出下边缘').toBeLessThanOrEqual(844 + 1);

    for (const id of ['esc', 'tab', 'up', 'down', 'left', 'right', 'ctrl-c']) {
      await expect(page.getByTestId(`terminal-key-${id}`)).toBeVisible();
    }

    // 真发一次：点 Esc 与 Ctrl+C 不应把终端打进断线/失败状态
    await page.getByTestId('terminal-key-esc').click();
    await page.getByTestId('terminal-key-ctrl-c').click();
    await expect(page.getByTestId('terminal-status')).toHaveText(/已连接/, { timeout: 10_000 });

    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'mobile-terminal-keys.png') });

    await tabs.getByTestId('session-tab-trigger').click();
    const legacy = page.getByTestId('session-tab-picker').locator(`[data-testid="session-tab-item"][data-legacy-session-id="${id}"]`);
    await expect(legacy).toHaveText('会话终端');
    await page.getByTestId('session-tab-picker').getByRole('button', { name: '断开会话终端' }).click();
    await expect(page.getByTestId('terminal-pane')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: '发送消息' })).toBeVisible();
  });

  test('键盘弹出时终端仍可用：可视高度变小时不报错', async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 390, height: 500 });
    await loginByApi(page);
    const { id, projectId } = await seedSession(page, baseURL, 'term-short');
    await page.goto(`/#/p/${projectId}/focus/${id}`);
    await openTerminalTab(page);
    await expect(page.getByTestId('terminal-keys')).toBeVisible();
    const keys = (await page.getByTestId('terminal-keys').boundingBox())!;
    expect(keys.y + keys.height, `高度只有 500 时按键条仍在屏幕内：${JSON.stringify(keys)}`).toBeLessThanOrEqual(500 + 1);
    await expect(page.getByTestId('terminal-status')).toHaveText(/已连接/, { timeout: 10_000 });
  });
});

test('窄屏但不是触摸设备：不显示按键条（桌面鼠标语义不变）', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginByApi(page);
  const { id, projectId } = await seedSession(page, baseURL, 'term-fine');
  await page.goto(`/#/p/${projectId}/focus/${id}`);
  await openTerminalTab(page);
  await expect(page.getByTestId('terminal-keys')).toHaveCount(0);
});

test('桌面画布只从标签打开旧终端，使用原会话目录且刷新不会自动重连', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  await loginByApi(page);
  const { id, path, projectId } = await seedSession(page, baseURL, 'term-desktop');
  let sockets = 0;
  page.on('websocket', (socket) => {
    if (new URL(socket.url()).pathname === `/api/sessions/${id}/terminal`) sockets++;
  });
  await page.goto(`/#/p/${projectId}/canvas`);
  await page.locator(`.react-flow__node-session[data-id="${id}"]`).getByRole('button', { name: '在画布中展开' }).click();
  const window = page.getByTestId('canvas-window');
  await expect(window.getByRole('textbox', { name: '发送消息' })).toBeVisible();
  const windowId = await window.getAttribute('data-window-id');
  expect(windowId).toBeTruthy();
  await expect(page.getByTestId('session-tab-terminal')).toHaveCount(0);
  expect(sockets).toBe(0);
  await openTerminalTab(page);
  await expect(window).toHaveAttribute('data-window-id', windowId!);
  await window.getByTestId('session-tab-trigger').click({ timeout: 10_000 });
  const picker = page.getByTestId('session-tab-picker');
  await expect(picker.locator(`[data-testid="session-tab-item"][data-legacy-session-id="${id}"]`)).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.insertText('printf "%s\\n" "$PWD" >legacy-terminal-cwd');
  await page.keyboard.press('Enter');
  const proof = join(path, 'legacy-terminal-cwd');
  await expect.poll(() => existsSync(proof)).toBe(true);
  expect(readFileSync(proof, 'utf8').trim()).toBe(path);
  await page.reload();
  await expect(window).toHaveAttribute('data-window-id', windowId!);
  await expect(window.getByRole('textbox', { name: '发送消息' })).toBeVisible();
  await expect(window.getByTestId('terminal-pane')).toHaveCount(0);
  await window.getByTestId('session-tab-trigger').click({ timeout: 10_000 });
  await expect(picker.locator('[data-legacy-session-id]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await openDocumentNewMenu(page, window);
  await expect(newTerminal(page)).toBeEnabled();
  expect(sockets).toBe(1);
});
