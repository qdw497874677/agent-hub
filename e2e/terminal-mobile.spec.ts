import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { loginByApi } from './login.ts';
import { piModel } from './hub-model.ts';

const SHOTS = process.env['E2E_SCREENSHOTS'];

/** 内嵌 worker 起得比 server 慢：等它上线再挑 agent。 */
async function onlineAgent(page: import('@playwright/test').Page): Promise<string | undefined> {
  type Worker = { agentIds: string[]; state: string };
  let agentId: string | undefined;
  for (let attempt = 0; attempt < 40 && agentId === undefined; attempt += 1) {
    const workers = (await (await page.request.get('/api/workers')).json()) as Worker[];
    agentId = workers.find((worker) => worker.state === 'online' && worker.agentIds.length > 0)?.agentIds[0];
    if (agentId === undefined) await page.waitForTimeout(500);
  }
  return agentId;
}

async function openTerminal(
  page: import('@playwright/test').Page,
  baseURL: string | undefined,
  agentId: string,
  prefix: string
): Promise<{ id: string; name: string }> {
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  const dir = mkdtempSync(join(tmpdir(), `e2e-${prefix}-`));
  const name = `e2e ${prefix} ${Date.now().toString(36)}`;
  const project = (await (await page.request.post('/api/projects', { data: { name, rootPath: dir }, headers })).json()) as { id: string };
  const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '终端' }, headers })).json()) as { id: string };
  const derived = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId, model: piModel() }, headers });
  expect(derived.status(), await derived.text()).toBe(201);
  const session = (await derived.json()) as { id: string };
  await page.goto(`/#/p/${project.id}/focus/${session.id}`);
  return { id: session.id, name };
}

test.describe('触摸设备', () => {
  // 真机是触摸设备：开 hasTouch 才会让 `(pointer: coarse)` 成立，按键条才渲染。
  test.use({ hasTouch: true });

  /**
   * 手机上的会话终端：页签在、终端能连上、底部按键条在且不越界。
   * 手机软键盘上没有 Esc/Tab/Ctrl/方向键，全屏 TUI 全靠这条按键条。
   */
  test('手机终端：页签可见、连上后出现按键条且不越出屏幕', async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginByApi(page);
    const agentId = await onlineAgent(page);
    test.skip(!agentId, '这台机器上没有可用的 agent');
    const { name } = await openTerminal(page, baseURL, agentId!, 'term-mobile');

    const tab = page.getByTestId('session-tab-terminal');
    await expect(tab).toBeVisible();
    await tab.click();

    await expect(page.getByTestId('terminal-pane')).toBeVisible();
    // 新建会话要等 worker 登记工作空间，hub 侧会重试最多 10s
    await expect(page.getByTestId('terminal-status')).toHaveText(/已连接/, { timeout: 30_000 });

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

    const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
    const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
    const projects = (await (await page.request.get('/api/projects')).json()) as Array<{ id: string; name: string }>;
    const project = projects.find((candidate) => candidate.name === name);
    if (project) await page.request.delete(`/api/projects/${project.id}`, { data: { confirmName: name }, headers });
  });

  test('键盘弹出时终端仍可用：可视高度变小时不报错', async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 390, height: 500 });
    await loginByApi(page);
    const agentId = await onlineAgent(page);
    test.skip(!agentId, '这台机器上没有可用的 agent');
    await openTerminal(page, baseURL, agentId!, 'term-short');

    await page.getByTestId('session-tab-terminal').click();
    await expect(page.getByTestId('terminal-status')).toHaveText(/已连接/, { timeout: 30_000 });
    await expect(page.getByTestId('terminal-keys')).toBeVisible();
    const keys = (await page.getByTestId('terminal-keys').boundingBox())!;
    expect(keys.y + keys.height, `高度只有 500 时按键条仍在屏幕内：${JSON.stringify(keys)}`).toBeLessThanOrEqual(500 + 1);
    await expect(page.getByTestId('terminal-status')).toHaveText(/已连接/, { timeout: 10_000 });
  });
});

test('窄屏但不是触摸设备：不显示按键条（桌面鼠标语义不变）', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginByApi(page);
  const agentId = await onlineAgent(page);
  test.skip(!agentId, '这台机器上没有可用的 agent');
  await openTerminal(page, baseURL, agentId!, 'term-fine');

  await page.getByTestId('session-tab-terminal').click();
  await expect(page.getByTestId('terminal-status')).toHaveText(/已连接/, { timeout: 30_000 });
  await expect(page.getByTestId('terminal-keys')).toHaveCount(0);
});
