import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { loginByApi } from './login.ts';

const SHOTS = process.env['E2E_SCREENSHOTS'];

/**
 * 手机上的专注对话：检查器只在画布里，所以「换个地方继续」要能从对话头部的「⋯」打开。
 * 顺带验证：没说过话的会话停掉后不再挂着 running，项目能直接删。
 */
test('手机专注对话：⋯ 菜单里能换个地方继续；没说过话的会话停掉后项目能删', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginByApi(page);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'hub_csrf')?.value ?? '';
  const headers = { origin: baseURL!, 'x-hub-csrf': csrf };
  const workers = (await (await page.request.get('/api/workers')).json()) as Array<{ agentIds: string[]; state: string }>;
  const agentId = workers.find((worker) => worker.state === 'online')?.agentIds[0];
  test.skip(!agentId, '这台机器上没有可用的 agent');

  const dir = mkdtempSync(join(tmpdir(), 'e2e-focus-'));
  const name = `e2e 手机对话 ${Date.now().toString(36)}`;
  const project = (await (await page.request.post('/api/projects', { data: { name, rootPath: dir }, headers })).json()) as { id: string };
  const task = (await (await page.request.post('/api/tasks', { data: { projectId: project.id, title: '换地方' }, headers })).json()) as { id: string };
  const derived = await page.request.post('/api/sessions/derive', { data: { taskId: task.id, agentId, model: '' }, headers });
  expect(derived.status(), await derived.text()).toBe(201);
  const session = (await derived.json()) as { id: string };

  await page.goto(`/#/p/${project.id}/focus/${session.id}`);
  const menu = page.getByRole('button', { name: '更多' });
  await expect(menu).toBeVisible();
  await menu.click();
  await expect(page.getByRole('menuitem', { name: /换个地方继续/ }), '没说过话：没有可搬的东西').toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);

  // 停掉一条从没说过话的会话：落成 stopped，留下一条 ended 事件
  const stopped = await page.request.post(`/api/sessions/${session.id}/interrupt`, { data: {}, headers });
  expect(stopped.ok(), await stopped.text()).toBe(true);
  await page.reload();
  await menu.click();
  const item = page.getByRole('menuitem', { name: /换个地方继续/ });
  await expect(item).toBeEnabled();
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'mobile-focus-menu.png') });
  await item.click();
  const dialog = page.getByRole('dialog', { name: '换个地方继续' });
  await expect(dialog).toBeVisible();
  const box = (await dialog.boundingBox())!;
  expect(box.x, '对话框在屏幕内').toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390 + 1);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'mobile-focus-continue.png') });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  const deleted = await page.request.delete(`/api/projects/${project.id}`, { data: { confirmName: name }, headers });
  expect(deleted.ok(), `停掉的会话不挡删除：${await deleted.text()}`).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});
